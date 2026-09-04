# Public quote-form security rollout

This pull request prepares the approved correction but does not change Production.

## Required deployment order after separate approval

1. Deploy the static quote form through the normal Vercel Production workflow. The currently deployed Edge Function ignores the added honeypot and idempotency fields, so this order cannot break submissions.
2. Apply only `supabase/migrations/20260904183807_secure_public_quote_submissions.sql` to Supabase project `zzigzylypifjokskehkn`.
3. Verify both new tables have RLS enabled, no `anon` or `authenticated` privileges, the three intake functions are executable only by `service_role`, and the cleanup function is executable only by its database owner.
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

## Retention cleanup

- The same additive migration enables Supabase Cron (`pg_cron`) and schedules `cleanup-quote-form-security-records` at minute 17 of every hour (UTC). It calls a database function directly; no external scheduler, new account, secret, Edge Function invocation, or additional paid service is required. The work uses the database resources already included with the Supabase project.
- Each run deletes only rows whose `expires_at` has passed, with a maximum of 500 submission guards and 500 rate-limit counters. The queries use the existing expiration indexes, lock only the selected rows, skip rows already locked by intake work, and stop after 10 seconds. Customer, property, address, job, email, and Storage records—including `job-photos`—are outside the function.
- Confirm the job is active in Supabase Dashboard **Integrations → Cron → Jobs**. Monitor its **History** after rollout, or read `cron.job_run_details`, and investigate any status other than `succeeded`. The returned two counts show how many guard and rate-limit rows were deleted.
- A failed or timed-out run rolls back safely and is retried by the next hourly run. The function is idempotent and bounded, so an authorized database operator can also retry `select public.cleanup_quote_form_security_records(500);` in the SQL Editor. Do not raise the 500-row limit; repeat bounded runs instead if a backlog exists.
- `public`, `anon`, `authenticated`, and `service_role` cannot execute the cleanup function. The scheduled database-owner job is the only routine caller.

## Remaining recovery boundary

If an email attempt remains ambiguous for more than 23 hours, automatic resend stops and returns the safe reference for manual office review. This avoids a duplicate after Resend's 24-hour idempotency retention expires.

## Rollback

- Roll back the website and Edge Function together before removing database objects.
- The migration is additive. Before removing database objects, unschedule `cleanup-quote-form-security-records` with `cron.unschedule`. After confirming no deployed function depends on it, revoke and drop `cleanup_quote_form_security_records`, `prepare_quote_form_job`, `claim_quote_form_submission`, and `consume_quote_form_rate_limit`, then drop `quote_form_submission_guards` and `quote_form_rate_limits` in that dependency-safe order. Do not disable `pg_cron`, because other project jobs may use it.
- This rollout does not read, modify, or delete the existing `job-photos` bucket or its objects.
