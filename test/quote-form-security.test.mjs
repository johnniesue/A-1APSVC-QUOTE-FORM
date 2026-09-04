import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canSafelyRetryEmail,
  createResendIdempotencyKeys,
  deriveLegacyIdempotencyKey,
  enforceDatabaseRateLimit,
  escapeHtml,
  genericErrorBody,
  getPlatformClientAddress,
  hmacIdentifier,
  QuoteSecurityError,
  sha256Hex,
  validateQuotePayload,
} from "../supabase/functions/send-quote-email/quote-security.mjs";

const root = new URL("../", import.meta.url);
const migrationUrl = new URL(
  "../supabase/migrations/20260904183807_secure_public_quote_submissions.sql",
  import.meta.url,
);

const validPayload = {
  full_name: "Synthetic Customer",
  email: "synthetic@example.com",
  phone_number: "(469) 555-0100",
  address: "100 Test Only Lane",
  city: "Lucas",
  state: "TX",
  zip: "75002",
  property_type: "Residential",
  problem_start_date: "2026-09-04",
  problem_description: "Synthetic quote request only.",
  website: "",
  idempotency_key: "b7ff24be-9623-4773-807b-1cc28e13fead",
};

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

test("all customer values used in email HTML are escaped", async () => {
  const edgeFunction = await source("supabase/functions/send-quote-email/index.ts");
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('x')"> & text`),
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; text",
  );
  for (const mapping of [
    "fullName: escapeHtml(quote.full_name)",
    "email: escapeHtml(quote.email)",
    "phoneNumber: escapeHtml(quote.phone_number)",
    "address: escapeHtml(quote.address)",
    "city: escapeHtml(quote.city)",
    "state: escapeHtml(quote.state)",
    "zip: escapeHtml(quote.zip)",
    "propertyType: escapeHtml(quote.property_type)",
    'startDate: escapeHtml(quote.problem_start_date ?? "N/A")',
    "description: escapeHtml(quote.problem_description)",
  ]) {
    assert.ok(edgeFunction.includes(mapping), `missing escaped mapping: ${mapping}`);
  }
  const internalHtmlSection = edgeFunction.slice(
    edgeFunction.indexOf("const internalHtml"),
    edgeFunction.indexOf('if (claim.office_email_status !== "sent")'),
  );
  const customerHtmlSection = edgeFunction.slice(
    edgeFunction.indexOf("const confirmationBody"),
    edgeFunction.indexOf("const confirmationHtml"),
  );
  for (const htmlSection of [internalHtmlSection, customerHtmlSection]) {
    assert.doesNotMatch(htmlSection, /\$\{quote\.(?:full_name|email|phone_number|address|city|state|zip|property_type|problem_start_date|problem_description)\}/u);
  }
});

test("customer lookup uses SQL parameters and no raw PostgREST or expression", async () => {
  const [edgeFunction, migration] = await Promise.all([
    source("supabase/functions/send-quote-email/index.ts"),
    readFile(migrationUrl, "utf8"),
  ]);
  assert.doesNotMatch(edgeFunction, /\.or\s*\(/u);
  assert.match(migration, /customer\.mobile_phone = p_phone_number/u);
  assert.match(migration, /customer\.email = p_email/u);
  assert.throws(
    () => validateQuotePayload({
      ...validPayload,
      email: "victim@example.com,mobile_phone.eq.attacker",
    }),
    QuoteSecurityError,
  );
});

test("server rejects invalid field types and formats", () => {
  for (const payload of [
    { ...validPayload, full_name: { value: "Name" } },
    { ...validPayload, email: "not-an-email" },
    { ...validPayload, phone_number: "123" },
    { ...validPayload, state: "Texas" },
    { ...validPayload, zip: "75O02" },
    { ...validPayload, property_type: "Industrial" },
    { ...validPayload, problem_start_date: "09/04/2026" },
    { ...validPayload, address: "Street\r\nInjected: value" },
  ]) {
    assert.throws(() => validateQuotePayload(payload), QuoteSecurityError);
  }
});

test("server rejects oversized and unexpected fields", () => {
  assert.throws(
    () => validateQuotePayload({ ...validPayload, problem_description: "x".repeat(4001) }),
    QuoteSecurityError,
  );
  assert.throws(
    () => validateQuotePayload({ ...validPayload, admin_override: true }),
    (error) => error instanceof QuoteSecurityError && error.code === "unexpected_fields",
  );
});

test("honeypot rejects nonempty automation input", () => {
  assert.throws(
    () => validateQuotePayload({ ...validPayload, website: "https://spam.example" }),
    (error) => error instanceof QuoteSecurityError && error.code === "honeypot_triggered",
  );
});

test("rate-limit identity trusts only the platform Cloudflare header", () => {
  const headers = new Headers({
    "cf-connecting-ip": "203.0.113.9",
    "x-forwarded-for": "198.51.100.77",
    "x-real-ip": "198.51.100.88",
  });
  assert.equal(getPlatformClientAddress(headers), "203.0.113.9");
  assert.throws(
    () => getPlatformClientAddress(new Headers({
      "x-forwarded-for": "198.51.100.77",
      "x-real-ip": "198.51.100.88",
    })),
    (error) => error instanceof QuoteSecurityError
      && error.code === "network_identity_unavailable",
  );
});

test("network identity is HMACed and raw addresses are not stored or logged", async () => {
  const [migration, edgeFunction] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    source("supabase/functions/send-quote-email/index.ts"),
  ]);
  const digest = await hmacIdentifier("203.0.113.42", "test-only-secret");
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(digest, /203\.0\.113\.42/u);
  assert.match(migration, /subject_hash text not null/iu);
  assert.doesNotMatch(migration, /\b(raw_ip|ip_address|client_ip)\b/iu);
  assert.doesNotMatch(edgeFunction, /console\.(?:log|error|warn)\([^)]*platformAddress/iu);
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

test("office and customer Resend keys are deterministic and separate", () => {
  const guardId = "8b1f53e9-95b4-4e06-8380-6f923aa10ced";
  const first = createResendIdempotencyKeys(guardId);
  const retry = createResendIdempotencyKeys(guardId);
  assert.deepEqual(first, retry);
  assert.notEqual(first.office, first.customer);
  assert.match(first.office, /^quote-office\//u);
  assert.match(first.customer, /^quote-customer\//u);
});

test("interrupted Resend retry causes one delivery per deterministic key", async () => {
  const keys = createResendIdempotencyKeys("8b1f53e9-95b4-4e06-8380-6f923aa10ced");
  const accepted = new Set();
  let deliveries = 0;
  const fakeResend = async (key) => {
    if (!accepted.has(key)) {
      accepted.add(key);
      deliveries += 1;
    }
    return { ok: true };
  };

  await fakeResend(keys.office); // Accepted, then the function is interrupted.
  await fakeResend(keys.office); // Recovery uses the identical provider key.
  await fakeResend(keys.customer);
  assert.equal(deliveries, 2);
});

test("stale processing and failed guards are recoverable by a bounded lease", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /lease_expires_at timestamptz not null default \(now\(\) \+ interval '2 minutes'\)/iu);
  assert.match(migration, /v_guard\.state = 'failed' or v_guard\.lease_expires_at <= v_now/iu);
  assert.match(migration, /attempt_count = guard\.attempt_count \+ 1/iu);
  assert.equal(canSafelyRetryEmail("sending", "2026-09-04T00:00:00Z", Date.parse("2026-09-04T22:00:00Z")), true);
  assert.equal(canSafelyRetryEmail("sending", "2026-09-04T00:00:00Z", Date.parse("2026-09-05T00:00:01Z")), false);
});

test("job creation and guard linking are one recoverable transaction", async () => {
  const [migration, edgeFunction] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    source("supabase/functions/send-quote-email/index.ts"),
  ]);
  const functionBody = migration.slice(
    migration.indexOf("create or replace function public.prepare_quote_form_job"),
    migration.indexOf("revoke all on function public.consume_quote_form_rate_limit"),
  );
  assert.equal((functionBody.match(/insert into public\.jobs/gu) || []).length, 1);
  assert.match(functionBody, /if v_guard\.job_id is not null then[\s\S]*return query/iu);
  assert.match(functionBody, /update public\.quote_form_submission_guards[\s\S]*job_id = v_job_id/iu);
  assert.equal((edgeFunction.match(/deliveryKeys\.office,/gu) || []).length, 1);
  assert.equal((edgeFunction.match(/deliveryKeys\.customer,/gu) || []).length, 1);
});

test("cached old frontend submission without idempotency key stays compatible", async () => {
  const legacyPayload = {
    ...validPayload,
    issue_types: [validPayload.problem_description],
  };
  delete legacyPayload.idempotency_key;
  const quote = validateQuotePayload(legacyPayload);
  assert.equal(quote.is_legacy_request, true);
  const fingerprint = await hmacIdentifier(JSON.stringify(quote), "test-only-secret");
  const subjectHash = await hmacIdentifier("203.0.113.9", "test-only-secret");
  const first = await sha256Hex(deriveLegacyIdempotencyKey(fingerprint, subjectHash));
  const retry = await sha256Hex(deriveLegacyIdempotencyKey(fingerprint, subjectHash));
  assert.equal(first, retry);
});

test("browser and server errors are generic and contain safe references", async () => {
  const [browserScript, edgeFunction] = await Promise.all([
    source("submit-v2.js"),
    source("supabase/functions/send-quote-email/index.ts"),
  ]);
  assert.deepEqual(genericErrorBody("QF-SAFE123456"), {
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
  assert.match(edgeFunction, /to: \[quote\.email\]/u);
  assert.match(edgeFunction, /message: "Emails sent to office and customer successfully"/u);
});

test("migration keeps every security object private", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /alter table public\.quote_form_rate_limits enable row level security/iu);
  assert.match(migration, /alter table public\.quote_form_submission_guards enable row level security/iu);
  assert.match(migration, /revoke all on table public\.quote_form_rate_limits from public, anon, authenticated/iu);
  for (const functionName of [
    "consume_quote_form_rate_limit",
    "claim_quote_form_submission",
    "prepare_quote_form_job",
    "cleanup_quote_form_security_records",
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${functionName}`, "iu"));
  }
  assert.doesNotMatch(migration, /security definer/iu);
  assert.match(migration, /on conflict \(organization_id, subject_hash, window_started_at\)[\s\S]*request_count = public\.quote_form_rate_limits\.request_count \+ 1/iu);
});

test("retention cleanup removes only expired security rows in bounded batches", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const cleanupBody = migration.slice(
    migration.indexOf("create or replace function public.cleanup_quote_form_security_records"),
    migration.indexOf("revoke all on function public.consume_quote_form_rate_limit"),
  );

  assert.match(cleanupBody, /p_batch_size < 1 or p_batch_size > 500/iu);
  assert.equal((cleanupBody.match(/limit p_batch_size/gu) || []).length, 2);
  assert.equal((cleanupBody.match(/for update skip locked/gu) || []).length, 2);
  assert.equal((cleanupBody.match(/expires_at <= v_now/gu) || []).length, 2);
  assert.equal((cleanupBody.match(/delete from public\.quote_form_submission_guards/gu) || []).length, 1);
  assert.equal((cleanupBody.match(/delete from public\.quote_form_rate_limits/gu) || []).length, 1);
  assert.match(cleanupBody, /set statement_timeout = '10s'/iu);
  assert.doesNotMatch(
    cleanupBody,
    /(?:delete|update|insert)\s+(?:from|into)?\s*public\.(?:customers|properties|addresses|jobs|emails)|storage\.|job-photos/iu,
  );
});

test("retention cleanup is owner-only and scheduled through Supabase Cron", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /create extension if not exists pg_cron/iu);
  assert.match(
    migration,
    /revoke all on function public\.cleanup_quote_form_security_records\(integer\)\s+from public, anon, authenticated, service_role/iu,
  );
  assert.match(
    migration,
    /select cron\.schedule\(\s*'cleanup-quote-form-security-records',\s*'17 \* \* \* \*',\s*\$cron\$select public\.cleanup_quote_form_security_records\(500\);\$cron\$\s*\)/iu,
  );
  assert.match(migration, /quote_form_submission_guards_expires_at_idx/iu);
  assert.match(migration, /quote_form_rate_limits_expires_at_idx/iu);
  assert.doesNotMatch(migration, /grant execute on function public\.cleanup_quote_form_security_records/iu);
});
