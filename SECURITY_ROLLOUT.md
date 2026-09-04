# Public quote-form security rollout

This pull request prepares the approved correction but does not change Production.

## Required deployment order after separate approval

1. Deploy the static quote form through the normal Vercel Production workflow. The currently deployed Edge Function ignores the added honeypot and idempotency fields, so this order cannot break submissions.
2. Apply only `supabase/migrations/20260904183807_secure_public_quote_submissions.sql` to Supabase project `zzigzylypifjokskehkn`.
3. Verify both new tables have RLS enabled, no `anon` or `authenticated` privileges, and all three quote-security functions are executable only by `service_role`.
4. Add a new strong random Edge Function secret named `QUOTE_RATE_LIMIT_SECRET`. Do not expose or reuse the service-role or Resend secrets.
5. Deploy `send-quote-email` with `quote-security.mjs` and keep JWT verification enabled. The function temporarily derives a deterministic fallback for cached older frontend submissions that omit `idempotency_key` and accepts only the old, matching `issue_types` value as a legacy field.
6. Verify unauthorized requests are rejected before database or Resend activity.
7. Perform one separately approved synthetic submission and retry the same idempotency key. Confirm one job, one office email request, one customer confirmation request, and the same response reference.

## Runtime behavior

- Limit: five newly claimed quote submissions per hashed network identifier per 15-minute window.
- The rate-limit identity uses only Cloudflare's platform-supplied `cf-connecting-ip` header. Caller-supplied forwarding headers are ignored. Raw network addresses are held only in function memory long enough to create an HMAC and are never logged or stored.
- Idempotency keys are stored as SHA-256 hashes, and request contents are represented only by a keyed HMAC fingerprint. Durable rows store a safe reference, processing status, linked record IDs, and the final non-sensitive response.
- A two-minute database lease permits one active worker. Failed or expired leases can be reclaimed, and record creation plus guard linking is one database transaction.
- Office and customer Resend calls use separate deterministic idempotency keys. Interrupted calls can be retried safely during Resend's 24-hour retention period; the code uses a conservative 23-hour retry window.
- Completed retries return the stored original result without repeating database creation or email calls.
- A nonempty hidden `website` field is rejected before rate-limit, record, or email activity.
- Every accepted field is type-, format-, and length-checked; unknown fields are rejected. Every customer value inserted into email HTML is escaped.
- Browser-facing failures contain only a generic message and safe reference.

## Remaining recovery boundary

If an email attempt remains ambiguous for more than 23 hours, automatic resend stops and returns the safe reference for manual office review. This avoids a duplicate after Resend's 24-hour idempotency retention expires.

## Rollback

- Roll back the website and Edge Function together before removing database objects.
- The migration is additive. After confirming no deployed function depends on it, revoke and drop `prepare_quote_form_job`, `claim_quote_form_submission`, and `consume_quote_form_rate_limit`, then drop `quote_form_submission_guards` and `quote_form_rate_limits` in that dependency-safe order.
- This rollout does not read, modify, or delete the existing `job-photos` bucket or its objects.
