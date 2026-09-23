-- The moment a document is marked private (SEC-19).
--
-- "Only you can open this. Nobody can open it after you, unless you leave
-- a key." That is a guarantee rather than a setting, so the product has to
-- say it at the moment it becomes true — and then never nag about it
-- again for that document, which is what this table is for.
--
-- It is also the list Phase 5's annual review reads: every private
-- document whose owner was told, and has still left no key.

create table private_notice (
  household_id uuid not null references household(id) on delete cascade,
  document_id  uuid not null references document(id) on delete cascade,
  member_id    uuid not null references member(id) on delete cascade,
  shown_at     timestamptz not null default now(),
  primary key (document_id, member_id)
);

alter table private_notice enable row level security;
create policy private_notice_tenant on private_notice
  using (household_id = app_household()) with check (household_id = app_household());

grant select, insert, update, delete on private_notice to fdv_app;
