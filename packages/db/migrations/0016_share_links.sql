-- Share links (SHR-05).
--
-- Sending the landlord a lease or the accountant a W-2 makes a read-only
-- link that expires, can carry a PIN, and can be taken back. No account at
-- the other end: the whole point is that the recipient does not have to
-- join anything to look at one document.
--
-- The link secret is never stored, only its SHA-256. A PIN is short enough
-- to be said over the phone, so it is hashed with Argon2 and guarded by an
-- attempt counter, exactly like an invitation code.

create table share_link (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references household(id) on delete cascade,
  document_id     uuid not null references document(id) on delete cascade,
  token_hash      bytea not null unique,
  pin_hash        text,
  recipient_label text,
  created_by      uuid not null references account(id),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  revoked_by      uuid references account(id),
  open_count      int not null default 0,
  last_opened_at  timestamptz,
  attempts        int not null default 0
);
create index share_link_household_idx on share_link (household_id, created_at desc);
create index share_link_document_idx on share_link (document_id);

alter table share_link enable row level security;
create policy share_link_tenant on share_link
  using (household_id = app_household()) with check (household_id = app_household());

-- Opening a link happens before any household is known, so the lookup has
-- to answer one question with the owner's rights and nothing else: which
-- household does this secret belong to? Everything after runs in scope.
create function share_link_household(p_token_hash bytea) returns uuid
  language sql stable security definer set search_path = public as
  $$ select household_id from share_link where token_hash = p_token_hash $$;

grant select, insert, update, delete on share_link to fdv_app;
grant execute on function share_link_household(bytea) to fdv_app;
