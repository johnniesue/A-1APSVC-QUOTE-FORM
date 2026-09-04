create table if not exists public.quote_form_rate_limits (
  organization_id uuid not null,
  subject_hash text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, subject_hash, window_started_at),
  constraint quote_form_rate_limits_subject_hash_check
    check (subject_hash ~ '^[0-9a-f]{64}$'),
  constraint quote_form_rate_limits_request_count_check
    check (request_count > 0)
);

alter table public.quote_form_rate_limits enable row level security;
revoke all on table public.quote_form_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.quote_form_rate_limits to service_role;

comment on table public.quote_form_rate_limits is
  'Rate-limit counters keyed by an HMAC of the requester address; raw network addresses are never stored.';

create table if not exists public.quote_form_submission_guards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  idempotency_key_hash text not null,
  request_fingerprint text not null,
  state text not null default 'processing',
  request_reference text not null,
  customer_id uuid references public.customers(id) on delete set null,
  property_id uuid references public.properties(id) on delete set null,
  address_id uuid references public.addresses(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  office_email_status text not null default 'pending',
  customer_email_status text not null default 'pending',
  result jsonb,
  error_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  constraint quote_form_submission_guards_key_hash_check
    check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  constraint quote_form_submission_guards_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint quote_form_submission_guards_state_check
    check (state in ('processing', 'completed', 'failed')),
  constraint quote_form_submission_guards_office_email_check
    check (office_email_status in ('pending', 'sending', 'sent', 'failed')),
  constraint quote_form_submission_guards_customer_email_check
    check (customer_email_status in ('pending', 'sending', 'sent', 'failed')),
  unique (organization_id, idempotency_key_hash)
);

alter table public.quote_form_submission_guards enable row level security;
revoke all on table public.quote_form_submission_guards from public, anon, authenticated;
grant select, insert, update, delete on table public.quote_form_submission_guards to service_role;

comment on table public.quote_form_submission_guards is
  'Durable quote-form idempotency state. Stores hashes, safe references, delivery state, and linked record IDs only.';

create index if not exists quote_form_rate_limits_expires_at_idx
  on public.quote_form_rate_limits (expires_at);

create index if not exists quote_form_submission_guards_expires_at_idx
  on public.quote_form_submission_guards (expires_at);

create or replace function public.consume_quote_form_rate_limit(
  p_organization_id uuid,
  p_subject_hash text,
  p_limit integer default 5,
  p_window_seconds integer default 900
)
returns table (
  allowed boolean,
  current_count integer,
  retry_after_seconds integer
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window_started_at timestamptz;
  v_count integer;
begin
  if p_subject_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid subject hash' using errcode = '22023';
  end if;
  if p_limit < 1 or p_limit > 100 then
    raise exception 'invalid rate limit' using errcode = '22023';
  end if;
  if p_window_seconds < 60 or p_window_seconds > 86400 then
    raise exception 'invalid rate window' using errcode = '22023';
  end if;

  v_window_started_at := to_timestamp(
    floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds
  );

  delete from public.quote_form_rate_limits
  where organization_id = p_organization_id
    and subject_hash = p_subject_hash
    and expires_at <= v_now;

  insert into public.quote_form_rate_limits (
    organization_id,
    subject_hash,
    window_started_at,
    request_count,
    expires_at,
    updated_at
  ) values (
    p_organization_id,
    p_subject_hash,
    v_window_started_at,
    1,
    v_window_started_at + make_interval(secs => p_window_seconds * 2),
    v_now
  )
  on conflict (organization_id, subject_hash, window_started_at)
  do update set
    request_count = public.quote_form_rate_limits.request_count + 1,
    updated_at = excluded.updated_at
  returning request_count into v_count;

  return query select
    v_count <= p_limit,
    v_count,
    greatest(
      1,
      ceil(extract(epoch from (v_window_started_at + make_interval(secs => p_window_seconds) - v_now)))::integer
    );
end;
$$;

revoke all on function public.consume_quote_form_rate_limit(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_quote_form_rate_limit(uuid, text, integer, integer)
  to service_role;
