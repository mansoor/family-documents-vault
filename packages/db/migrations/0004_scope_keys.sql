-- The key hierarchy (SEC-12, SEC-14; data model section 1).
--
--   master key (outside the database)
--    ├── household key   wraps file keys for visibility = 'household'
--    ├── adults key      wraps file keys for visibility = 'adults'
--    └── member key × N  wraps file keys for visibility = 'private'
--         └── also wrapped by that member's credential-derived key
--
-- A file key is wrapped by exactly one scope key. Changing a document's
-- visibility rewraps 32 bytes; the object in storage is untouched.

create type scope_kind as enum ('household', 'adults', 'member');

create table scope_key (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references household(id) on delete cascade,
  kind             scope_kind not null,
  member_id        uuid references member(id) on delete cascade,  -- set iff kind = 'member'
  key_wrapped      bytea not null,       -- wrapped by the master key (KEK)
  key_wrapped_cred bytea,                -- member scope only: wrapped by Argon2id(credential)
  kdf_params       jsonb,                -- salt, memory, iterations, parallelism
  created_at       timestamptz not null default now(),
  rotated_at       timestamptz,
  constraint member_scope_has_member
    check ((kind = 'member') = (member_id is not null)),
  constraint cred_wrap_only_for_members
    check ((kind = 'member') or (key_wrapped_cred is null and kdf_params is null))
);
-- One key per (household, kind, member). NULLs are distinct in a unique
-- index, so the household and adults keys need their own guard.
create unique index scope_key_member_uniq on scope_key (household_id, kind, member_id)
  where member_id is not null;
create unique index scope_key_shared_uniq on scope_key (household_id, kind)
  where member_id is null;

alter table scope_key enable row level security;
create policy scope_key_tenant on scope_key
  using (household_id = app_household()) with check (household_id = app_household());

grant select, insert, update, delete on scope_key to fdv_app;

-- Master-key rotation touches every household's wrapped keys and therefore
-- runs with the owning role; it never reads file content.
