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
  'Rate-limit counters keyed by an HMAC of the platform-provided requester address; raw network addresses are never stored.';

create table if not exists public.quote_form_submission_guards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  idempotency_key_hash text not null,
  request_fingerprint text not null,
  state text not null default 'processing',
  request_reference text not null,
  lease_token uuid not null default gen_random_uuid(),
  lease_expires_at timestamptz not null default (now() + interval '2 minutes'),
  attempt_count integer not null default 1,
  customer_id uuid references public.customers(id) on delete set null,
  property_id uuid references public.properties(id) on delete set null,
  address_id uuid references public.addresses(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  office_email_status text not null default 'pending',
  office_email_attempted_at timestamptz,
  customer_email_status text not null default 'pending',
  customer_email_attempted_at timestamptz,
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
  constraint quote_form_submission_guards_attempt_count_check
    check (attempt_count > 0),
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
  'Durable quote-form idempotency state with bounded recovery leases, delivery state, hashes, safe references, and linked record IDs.';

create index if not exists quote_form_rate_limits_expires_at_idx
  on public.quote_form_rate_limits (expires_at);

create index if not exists quote_form_submission_guards_expires_at_idx
  on public.quote_form_submission_guards (expires_at);

create index if not exists quote_form_submission_guards_lease_expires_at_idx
  on public.quote_form_submission_guards (lease_expires_at)
  where state <> 'completed';

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

create or replace function public.claim_quote_form_submission(
  p_organization_id uuid,
  p_idempotency_key_hash text,
  p_request_fingerprint text,
  p_request_reference text,
  p_lease_token uuid,
  p_lease_seconds integer default 120
)
returns table (
  outcome text,
  guard_id uuid,
  request_reference text,
  lease_token uuid,
  state text,
  customer_id uuid,
  property_id uuid,
  address_id uuid,
  job_id uuid,
  office_email_status text,
  office_email_attempted_at timestamptz,
  customer_email_status text,
  customer_email_attempted_at timestamptz,
  created_at timestamptz,
  result jsonb
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_guard public.quote_form_submission_guards%rowtype;
  v_inserted_count integer := 0;
begin
  if p_idempotency_key_hash !~ '^[0-9a-f]{64}$'
    or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or p_lease_seconds < 30
    or p_lease_seconds > 600 then
    raise exception 'invalid claim input' using errcode = '22023';
  end if;

  delete from public.quote_form_submission_guards
  where organization_id = p_organization_id
    and idempotency_key_hash = p_idempotency_key_hash
    and expires_at <= v_now;

  insert into public.quote_form_submission_guards (
    organization_id,
    idempotency_key_hash,
    request_fingerprint,
    request_reference,
    lease_token,
    lease_expires_at
  ) values (
    p_organization_id,
    p_idempotency_key_hash,
    p_request_fingerprint,
    p_request_reference,
    p_lease_token,
    v_now + make_interval(secs => p_lease_seconds)
  )
  on conflict (organization_id, idempotency_key_hash) do nothing;
  get diagnostics v_inserted_count = row_count;

  select guard.* into v_guard
  from public.quote_form_submission_guards as guard
  where guard.organization_id = p_organization_id
    and guard.idempotency_key_hash = p_idempotency_key_hash
  for update;

  if v_guard.request_fingerprint <> p_request_fingerprint then
    outcome := 'conflict';
  elsif v_guard.state = 'completed' and v_guard.result is not null then
    outcome := 'replay';
  elsif v_inserted_count = 1 then
    outcome := 'owner';
  elsif v_guard.state = 'failed' or v_guard.lease_expires_at <= v_now then
    update public.quote_form_submission_guards as guard
    set state = 'processing',
        lease_token = p_lease_token,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        attempt_count = guard.attempt_count + 1,
        error_reference = null,
        updated_at = v_now
    where guard.id = v_guard.id
    returning guard.* into v_guard;
    outcome := 'owner';
  else
    outcome := 'busy';
  end if;

  guard_id := v_guard.id;
  request_reference := v_guard.request_reference;
  lease_token := v_guard.lease_token;
  state := v_guard.state;
  customer_id := v_guard.customer_id;
  property_id := v_guard.property_id;
  address_id := v_guard.address_id;
  job_id := v_guard.job_id;
  office_email_status := v_guard.office_email_status;
  office_email_attempted_at := v_guard.office_email_attempted_at;
  customer_email_status := v_guard.customer_email_status;
  customer_email_attempted_at := v_guard.customer_email_attempted_at;
  created_at := v_guard.created_at;
  result := v_guard.result;
  return next;
end;
$$;

create or replace function public.prepare_quote_form_job(
  p_guard_id uuid,
  p_organization_id uuid,
  p_lease_token uuid,
  p_first_name text,
  p_last_name text,
  p_email text,
  p_phone_number text,
  p_address text,
  p_city text,
  p_state text,
  p_zip text,
  p_problem_description text
)
returns table (
  customer_id uuid,
  property_id uuid,
  address_id uuid,
  job_id uuid
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_guard public.quote_form_submission_guards%rowtype;
  v_customer_id uuid;
  v_property_id uuid;
  v_address_id uuid;
  v_job_id uuid;
begin
  select guard.* into v_guard
  from public.quote_form_submission_guards as guard
  where guard.id = p_guard_id
    and guard.organization_id = p_organization_id
    and guard.lease_token = p_lease_token
    and guard.lease_expires_at > clock_timestamp()
  for update;

  if not found then
    raise exception 'quote submission lease unavailable' using errcode = '55000';
  end if;

  if v_guard.job_id is not null then
    return query select
      v_guard.customer_id,
      v_guard.property_id,
      v_guard.address_id,
      v_guard.job_id;
    return;
  end if;

  select customer.id into v_customer_id
  from public.customers as customer
  where customer.organization_id = p_organization_id
    and customer.mobile_phone = p_phone_number
  order by customer.id
  limit 1;

  if v_customer_id is null then
    select customer.id into v_customer_id
    from public.customers as customer
    where customer.organization_id = p_organization_id
      and customer.email = p_email
    order by customer.id
    limit 1;
  end if;

  if v_customer_id is null then
    insert into public.customers (
      first_name,
      last_name,
      mobile_phone,
      email,
      lead_source,
      organization_id
    ) values (
      p_first_name,
      p_last_name,
      p_phone_number,
      p_email,
      'website_quote_form',
      p_organization_id
    )
    returning id into v_customer_id;
  end if;

  insert into public.properties (
    customer_id,
    organization_id,
    name,
    address,
    city,
    state,
    zip,
    is_primary
  ) values (
    v_customer_id,
    p_organization_id,
    'Primary Property',
    p_address,
    p_city,
    p_state,
    p_zip,
    true
  )
  returning id into v_property_id;

  insert into public.addresses (
    customer_id,
    organization_id,
    address,
    street1,
    city,
    state,
    zip,
    address_type,
    is_primary
  ) values (
    v_customer_id,
    p_organization_id,
    p_address,
    p_address,
    p_city,
    p_state,
    p_zip,
    'service',
    true
  )
  returning id into v_address_id;

  insert into public.jobs (
    customer_id,
    property_id,
    address_id,
    organization_id,
    job_type,
    priority_level,
    job_status,
    assigned_technician,
    scheduled_date,
    job_notes
  ) values (
    v_customer_id,
    v_property_id,
    v_address_id,
    p_organization_id,
    'other',
    'Normal',
    'Leads',
    'Unassigned',
    null,
    p_problem_description
  )
  returning id into v_job_id;

  update public.quote_form_submission_guards as guard
  set customer_id = v_customer_id,
      property_id = v_property_id,
      address_id = v_address_id,
      job_id = v_job_id,
      updated_at = clock_timestamp()
  where guard.id = p_guard_id
    and guard.lease_token = p_lease_token;

  return query select v_customer_id, v_property_id, v_address_id, v_job_id;
end;
$$;

revoke all on function public.consume_quote_form_rate_limit(uuid, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.claim_quote_form_submission(uuid, text, text, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.prepare_quote_form_job(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.consume_quote_form_rate_limit(uuid, text, integer, integer)
  to service_role;
grant execute on function public.claim_quote_form_submission(uuid, text, text, text, uuid, integer)
  to service_role;
grant execute on function public.prepare_quote_form_job(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text)
  to service_role;
