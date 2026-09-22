-- Devices that accepted push, and the household's own email settings.

-- One row per browser or phone that turned notifications on (REM-05).
-- The endpoint is the push service's URL; p256dh and auth are the
-- subscription's keys. All three come from the browser and are useless
-- to anyone but the push service.
create table device (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  account_id    uuid not null references account(id) on delete cascade,
  kind          text not null default 'web_push' check (kind in ('web_push', 'apns', 'fcm')),
  endpoint      text not null,
  p256dh        text,
  auth          text,
  label         text,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  failed_at     timestamptz,
  fail_reason   text,
  unique (endpoint)
);
create index device_household_idx on device (household_id, failed_at);

-- Where the household's own email comes from (STO-09, decision 13).
-- Credentials are encrypted under a master-derived key, like vault keys.
create table smtp_settings (
  household_id       uuid primary key references household(id) on delete cascade,
  provider           text,                  -- preset key: 'gmail', 'fastmail', 'ses' ...
  host               text not null,
  port               int not null default 587,
  secure             boolean not null default false,   -- true = implicit TLS (465)
  username           text,
  password_encrypted bytea,
  from_name          text not null default 'Family Document Vault',
  from_email         text not null,
  status             text not null default 'untested'
                       check (status in ('untested', 'ok', 'failed')),
  last_verified_at   timestamptz,
  last_error         text,
  updated_at         timestamptz not null default now()
);

-- Who wants what. Per account, so one adult can have the weekly digest
-- and another only push.
create table notification_preference (
  account_id    uuid not null references account(id) on delete cascade,
  household_id  uuid not null references household(id) on delete cascade,
  daily_push    boolean not null default true,
  daily_email   boolean not null default false,
  weekly_email  boolean not null default true,
  primary key (account_id, household_id)
);

alter table device enable row level security;
create policy device_tenant on device
  using (household_id = app_household()) with check (household_id = app_household());
alter table smtp_settings enable row level security;
create policy smtp_settings_tenant on smtp_settings
  using (household_id = app_household()) with check (household_id = app_household());
alter table notification_preference enable row level security;
create policy notification_preference_tenant on notification_preference
  using (household_id = app_household()) with check (household_id = app_household());

grant select, insert, update, delete on device, smtp_settings, notification_preference to fdv_app;

-- The weekly digest is its own kind in notification_digest.
alter table notification_digest drop constraint if exists notification_digest_kind_check;
