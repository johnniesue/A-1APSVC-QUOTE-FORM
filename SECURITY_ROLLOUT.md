# Public quote-form security rollout

This pull request prepares the approved correction but does not change Production.

## Required deployment order after separate approval

1. Apply only `supabase/migrations/20260904183807_secure_public_quote_submissions.sql` to Supabase project `zzigzylypifjokskehkn`.
2. Verify both new tables have RLS enabled, no `anon` or `authenticated` privileges, and the rate-limit function is executable only by `service_role`.
3. Add a new strong random Edge Function secret named `QUOTE_RATE_LIMIT_SECRET`. Do not expose or reuse the service-role or Resend secrets.
4. Deploy `send-quote-email` with `quote-security.mjs` and keep JWT verification enabled.
5. Verify unauthorized requests are rejected before database or Resend activity.
6. Deploy the static quote form through the normal Vercel Production workflow.
7. Perform one separately approved synthetic submission and retry the same idempotency key. Confirm one job, one office email request, one customer confirmation request, and the same response reference.

## Runtime behavior

- Limit: five newly claimed quote submissions per hashed network identifier per 15-minute window.
- Raw network addresses are held only in function memory long enough to create an HMAC and are never logged or stored.
- Idempotency keys are stored as SHA-256 hashes, and request contents are represented only by a keyed HMAC fingerprint. Durable rows store a safe reference, processing status, linked record IDs, and the final non-sensitive response.
- Completed retries return the stored original result without repeating database creation or email calls.
- A nonempty hidden `website` field is rejected before rate-limit, record, or email activity.
- Browser-facing failures contain only a generic message and safe reference.

## Rollback

- Roll back the website and Edge Function together before removing database objects.
- The migration is additive. After confirming no deployed function depends on it, revoke the function, then drop `consume_quote_form_rate_limit`, `quote_form_submission_guards`, and `quote_form_rate_limits` in that dependency-safe order.
- This rollout does not read, modify, or delete the existing `job-photos` bucket or its objects.
