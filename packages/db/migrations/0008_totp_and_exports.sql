-- Two-step sign-in state and the export jobs (STO-07).
alter table account add column totp_confirmed_at timestamptz;

create table export (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  requested_by  uuid not null references account(id),
  state         text not null default 'queued'
                  check (state in ('queued', 'running', 'done', 'failed')),
  document_count int,
  byte_size     bigint,
  storage_key   text,
  vault_id      uuid references vault(id),
  file_key_wrapped bytea,
  wrapped_by_scope uuid references scope_key(id),
  error         text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  expires_at    timestamptz
);
create index export_household_idx on export (household_id, created_at desc);
alter table export enable row level security;
create policy export_tenant on export
  using (household_id = app_household()) with check (household_id = app_household());
grant select, insert, update, delete on export to fdv_app;
