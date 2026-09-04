import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  enforceDatabaseRateLimit,
  genericErrorBody,
  hmacIdentifier,
  isHoneypotTriggered,
  QuoteSecurityError,
  runIdempotentQuote,
} from "../supabase/functions/send-quote-email/quote-security.mjs";

const root = new URL("../", import.meta.url);
const migrationUrl = new URL(
  "../supabase/migrations/20260904183807_secure_public_quote_submissions.sql",
  import.meta.url,
);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("public form contains no photo chooser or upload promise", async () => {
  const [html, browserScript] = await Promise.all([
    source("index.html"),
    source("submit-v2.js"),
  ]);

  assert.doesNotMatch(html, /type=["']file["']/iu);
  assert.doesNotMatch(html, /upload.{0,20}(photo|file)|(?:photo|file).{0,20}upload/iu);
  assert.doesNotMatch(browserScript, /jobPhoto|FormData|FileReader|\.files|storage\.from|upload/iu);
});

test("database-backed rate limit rejects over-limit requests", async () => {
  let calls = 0;
  await assert.rejects(
    enforceDatabaseRateLimit(async () => {
      calls += 1;
      return { allowed: false, current_count: 6, retry_after_seconds: 300 };
    }, {
      subjectHash: "a".repeat(64),
      reference: "QF-TESTREFERENCE",
    }),
    (error) => error instanceof QuoteSecurityError
      && error.status === 429
      && error.code === "rate_limited",
  );
  assert.equal(calls, 1);
});

test("network identifier is HMACed and raw IP storage is absent", async () => {
  const [migration, edgeFunction] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    source("supabase/functions/send-quote-email/index.ts"),
  ]);
  const rawIp = "203.0.113.42";
  const digest = await hmacIdentifier(rawIp, "test-only-secret");

  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(digest, /203\.0\.113\.42/u);
  assert.match(migration, /subject_hash text not null/iu);
  assert.doesNotMatch(migration, /\b(raw_ip|ip_address|client_ip)\b/iu);
  assert.match(edgeFunction, /hmacIdentifier\(clientIp, rateLimitSecret\)/u);
  assert.doesNotMatch(edgeFunction, /console\.(?:log|error|warn)\([^)]*clientIp/iu);
});

test("honeypot rejects nonempty automation input", () => {
  assert.equal(isHoneypotTriggered({ website: "" }), false);
  assert.equal(isHoneypotTriggered({ website: "   " }), false);
  assert.equal(isHoneypotTriggered({ website: "https://spam.example" }), true);
  assert.equal(isHoneypotTriggered({ website: { automated: true } }), true);
});

test("honeypot fails before database or email work is initialized", async () => {
  const edgeFunction = await source("supabase/functions/send-quote-email/index.ts");
  const honeypotCheck = edgeFunction.indexOf("isHoneypotTriggered(payload)");
  const databaseClient = edgeFunction.indexOf("createClient(supabaseUrl, serviceRoleKey)");
  const resendCall = edgeFunction.indexOf('fetch("https://api.resend.com/emails"');

  assert.ok(honeypotCheck >= 0);
  assert.ok(honeypotCheck < databaseClient);
  assert.ok(honeypotCheck < resendCall);
});

test("duplicate retry returns the durable original result without repeating work", async () => {
  const durableResult = {
    success: true,
    message: "Emails sent to office and customer successfully",
    request_reference: "QF-ORIGINAL123",
  };
  let attempts = 0;
  let jobs = 0;
  let officeEmails = 0;

  const claim = async () => {
    attempts += 1;
    return attempts === 1
      ? { kind: "owner", reference: durableResult.request_reference }
      : { kind: "replay", result: durableResult };
  };
  const execute = async () => {
    jobs += 1;
    officeEmails += 1;
    return durableResult;
  };

  const first = await runIdempotentQuote({ claim, execute });
  const retry = await runIdempotentQuote({ claim, execute });

  assert.deepEqual(first, durableResult);
  assert.deepEqual(retry, durableResult);
  assert.equal(jobs, 1);
  assert.equal(officeEmails, 1);
});

test("Edge Function wires one job, one office email, and durable replay", async () => {
  const edgeFunction = await source("supabase/functions/send-quote-email/index.ts");
  const rateLimitCall = edgeFunction.indexOf('admin.rpc("consume_quote_form_rate_limit"');
  const guardInsert = edgeFunction.indexOf('.from("quote_form_submission_guards")\n        .insert(');

  assert.equal(
    (edgeFunction.match(/\.from\("jobs"\)[\s\S]{0,100}?\.insert\(/gu) || []).length,
    1,
  );
  assert.equal(
    (edgeFunction.match(/const internalResponse = await fetch\("https:\/\/api\.resend\.com\/emails"/gu) || []).length,
    1,
  );
  assert.match(edgeFunction, /runIdempotentQuote/gu);
  assert.match(edgeFunction, /state === "completed" && existingGuard\.result/gu);
  assert.match(edgeFunction, /consume_quote_form_rate_limit/gu);
  assert.ok(rateLimitCall >= 0 && rateLimitCall < guardInsert);
});

test("browser and server errors are generic and contain safe references", async () => {
  const [browserScript, edgeFunction] = await Promise.all([
    source("submit-v2.js"),
    source("supabase/functions/send-quote-email/index.ts"),
  ]);
  const body = genericErrorBody("QF-SAFE123456");

  assert.deepEqual(body, {
    success: false,
    error: "We could not submit your request. Please try again.",
    reference: "QF-SAFE123456",
  });
  assert.doesNotMatch(browserScript, /errText|Submission failed:|Unexpected error:/u);
  assert.doesNotMatch(edgeFunction, /details\s*:/u);
  assert.doesNotMatch(edgeFunction, /console\.(?:log|error|warn)\([^)]*payload/iu);
});

test("existing successful quote behavior and recipients remain intact", async () => {
  const [browserScript, edgeFunction] = await Promise.all([
    source("submit-v2.js"),
    source("supabase/functions/send-quote-email/index.ts"),
  ]);

  assert.match(browserScript, /Quote request submitted successfully!/u);
  assert.match(edgeFunction, /"johnniesue@a-1affordableplumbingservices\.com"/u);
  assert.match(edgeFunction, /"johnniesue@gmail\.com"/u);
  assert.match(edgeFunction, /to: \[email\]/u);
  assert.match(edgeFunction, /message: "Emails sent to office and customer successfully"/u);
});

test("migration keeps rate and idempotency tables private", async () => {
  const migration = await readFile(migrationUrl, "utf8");

  assert.match(migration, /alter table public\.quote_form_rate_limits enable row level security/iu);
  assert.match(migration, /alter table public\.quote_form_submission_guards enable row level security/iu);
  assert.match(migration, /revoke all on table public\.quote_form_rate_limits from public, anon, authenticated/iu);
  assert.match(migration, /revoke all on function public\.consume_quote_form_rate_limit[\s\S]*from public, anon, authenticated/iu);
  assert.match(migration, /grant execute on function public\.consume_quote_form_rate_limit[\s\S]*to service_role/iu);
  assert.match(migration, /on conflict \(organization_id, subject_hash, window_started_at\)[\s\S]*request_count = public\.quote_form_rate_limits\.request_count \+ 1/iu);
});
