-- Where a household's files are kept (design, Storage). Several rows may
-- exist: one primary, optionally a mirror, optionally a migration target.
-- Credentials are encrypted under a key derived from the master key.
create table vault (
  id                    uuid primary key default gen_random_uuid(),
  household_id          uuid not null references household(id) on delete cascade,
  kind                  text not null check (kind in ('local', 's3')),
  provider              text,                      -- preset key: 'b2', 'aws', 'minio' ...
  label                 text not null,             -- what the person sees: 'This computer', 'Backblaze B2'
  endpoint              text,
  bucket                text,
  region                text,
  prefix                text,
  path_style            boolean not null default false,
  credentials_encrypted bytea,
  role                  text not null default 'primary'
                          check (role in ('primary', 'mirror', 'migration_target')),
  status                text not null default 'untested'
                          check (status in ('untested', 'ok', 'failed')),
  last_verified_at      timestamptz,
  last_error            text,
  created_at            timestamptz not null default now()
);
create index vault_household_idx on vault (household_id);

alter table household
  add constraint household_active_vault_fk
  foreign key (active_vault_id) references vault(id) on delete set null;

alter table vault enable row level security;
create policy vault_tenant on vault
  using (household_id = app_household()) with check (household_id = app_household());

grant select, insert, update, delete on vault to fdv_app;
