-- Tenancy: the household is the tenant. Every tenant-scoped table carries
-- household_id and is protected by row-level security keyed on the
-- transaction-local setting app.household_id (see withHousehold()).

create table household (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  active_vault_id   uuid,                     -- fk added with the vault table
  protection_mode   text not null default 'standard'
                      check (protection_mode in ('standard', 'private')),
  plan              text not null default 'self_hosted',
  plan_state        text not null default 'active'
                      check (plan_state in ('active', 'read_only', 'export_only')),
  plan_state_since  timestamptz,
  settings          jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create table member (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  display_name  text not null,
  date_of_birth date,
  relationship  text,
  is_deceased   boolean not null default false,
  colour        smallint not null default 0,   -- avatar tint index, from the prototype
  created_at    timestamptz not null default now()
);
create index member_household_idx on member (household_id);

-- Accounts are global: one login may belong to several households.
create table account (
  id            uuid primary key default gen_random_uuid(),
  email         citext not null unique,
  password_hash text,                        -- null when passkey-only
  totp_secret   bytea,
  created_at    timestamptz not null default now(),
  disabled_at   timestamptz
);

create table account_household (
  account_id   uuid not null references account(id) on delete cascade,
  household_id uuid not null references household(id) on delete cascade,
  member_id    uuid not null references member(id) on delete cascade,
  role         text not null check (role in ('owner', 'adult', 'teen', 'viewer')),
  joined_at    timestamptz not null default now(),
  primary key (account_id, household_id),
  unique (household_id, member_id)
);

create table credential (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references account(id) on delete cascade,
  kind           text not null check (kind in ('passkey', 'totp', 'recovery_share')),
  public_key     bytea,
  credential_id  bytea,
  sign_count     bigint,
  label          text,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);
create index credential_account_idx on credential (account_id);

-- One row per signed-in device. The refresh token is stored hashed; each
-- refresh rotates it. A rotated token presented again means theft, and the
-- whole session is revoked.
create table session (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references account(id) on delete cascade,
  household_id  uuid not null references household(id) on delete cascade,
  refresh_hash  bytea not null unique,
  prev_refresh_hash bytea,                   -- the token this one replaced; presenting it again = theft
  user_agent    text,
  ip            inet,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  revoked_reason text
);
create index session_account_idx on session (account_id, revoked_at);

create table household_profile (
  household_id  uuid primary key references household(id) on delete cascade,
  owns_home     boolean,
  rents_home    boolean,
  vehicle_count smallint,
  has_pets      boolean,
  has_business  boolean,
  country       text,
  answered_at   timestamptz,
  extra         jsonb not null default '{}'
);

-- Append-only, hash-chained audit log. hash covers the previous row's hash,
-- so editing or deleting any row breaks the chain from that point on.
create table audit_event (
  id               bigserial primary key,
  household_id     uuid not null references household(id) on delete cascade,
  actor_account_id uuid references account(id),
  actor_label      text,
  action           text not null,
  object_type      text,
  object_id        uuid,
  detail           jsonb not null default '{}',
  ip               inet,
  at               timestamptz not null default now(),
  prev_hash        bytea,
  hash             bytea not null
);
create index audit_event_household_idx on audit_event (household_id, id);

-- Nobody updates or deletes audit rows, not even the owning role.
create function audit_event_immutable() returns trigger as $$
begin
  raise exception 'audit_event is append-only';
end $$ language plpgsql;
create trigger audit_event_no_update before update or delete on audit_event
  for each row execute function audit_event_immutable();

-- ---------------------------------------------------------------- RLS
-- The application role is not the owner, so these policies apply to it.
-- current_setting(..., true) returns NULL when unset, and NULL = anything
-- is false: a connection that forgot to set the household sees nothing.

create function app_household() returns uuid
  language sql stable parallel safe as
  $$ select nullif(current_setting('app.household_id', true), '')::uuid $$;

alter table household enable row level security;
create policy household_tenant on household
  using (id = app_household()) with check (id = app_household());

alter table member enable row level security;
create policy member_tenant on member
  using (household_id = app_household()) with check (household_id = app_household());

-- Sign-in has to list an account's households before any household is
-- chosen, so membership rows are also visible to their own account.
create function app_account() returns uuid
  language sql stable parallel safe as
  $$ select nullif(current_setting('app.account_id', true), '')::uuid $$;

alter table account_household enable row level security;
create policy account_household_tenant on account_household
  using (household_id = app_household() or account_id = app_account())
  with check (household_id = app_household());

alter table session enable row level security;
create policy session_tenant on session
  using (household_id = app_household()) with check (household_id = app_household());

alter table household_profile enable row level security;
create policy household_profile_tenant on household_profile
  using (household_id = app_household()) with check (household_id = app_household());

alter table audit_event enable row level security;
create policy audit_event_tenant on audit_event
  using (household_id = app_household()) with check (household_id = app_household());

-- account and credential are global (keyed by account, not household) and
-- are reached only through code paths that already hold an account id.
-- Sign-in must find an account by email before any household is known, so
-- they carry no tenant policy.

-- First-run detection. The application role cannot count households under
-- RLS before it has one, so this runs with the owner's rights and answers
-- only yes or no.
create function setup_complete() returns boolean
  language sql stable security definer set search_path = public as
  $$ select exists (select 1 from household where deleted_at is null) $$;

-- The name shown on the sign-in screen, before anyone is signed in. A
-- self-hosted install has one household; the hosted edition never calls this.
create function vault_display_name() returns text
  language sql stable security definer set search_path = public as
  $$ select name from household where deleted_at is null order by created_at limit 1 $$;

-- The application role may use the tables the migration just created.
grant select, insert, update, delete on all tables in schema public to fdv_app;
grant usage, select on all sequences in schema public to fdv_app;
revoke update, delete on audit_event from fdv_app;
