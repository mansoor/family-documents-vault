-- Invitations (SHR-02): a link and a code.
--
-- Two secrets, because they travel by different routes. The link can be
-- pasted into a message; the code is meant to be said out loud, or typed
-- into a text, or written on a note left on the kitchen table. Someone who
-- intercepts one of them has nothing.
--
-- The link secret is long and random, so its hash is a plain SHA-256 and
-- the lookup is an index scan. The code is short enough to be said, so it
-- is hashed with Argon2 by the application and guarded by an attempt
-- counter: those two together are what make eight characters defensible.

create table invitation (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  -- The person this sign-in will belong to. Always set: inviting someone
  -- new creates their member row first, so an invitation never has to
  -- invent a person at the moment it is accepted.
  member_id     uuid not null references member(id) on delete cascade,
  email         citext not null,
  role          text not null check (role in ('owner', 'adult', 'teen', 'viewer')),
  token_hash    bytea not null unique,
  code_hash     text not null,
  invited_by    uuid not null references account(id),
  attempts      int not null default 0,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  accepted_by   uuid references account(id),
  revoked_at    timestamptz,
  revoked_by    uuid references account(id)
);
create index invitation_household_idx on invitation (household_id, created_at desc);

-- One live invitation per person. A second one replaces the first, which
-- is what "resend" means: the old link stops working the moment a new one
-- is made, and nobody has two valid ways in.
create unique index invitation_one_live_per_member
  on invitation (member_id)
  where accepted_at is null and revoked_at is null;

alter table invitation enable row level security;
create policy invitation_tenant on invitation
  using (household_id = app_household()) with check (household_id = app_household());

-- Accepting happens before the invitee belongs to anything, so the
-- application cannot set app.household_id before it has looked the
-- invitation up. This answers that one question with the owner's rights
-- and nothing else: given the hash of a link secret somebody is holding,
-- which household does it belong to? Everything after this runs inside
-- that household's scope like any other request.
create function invitation_household(p_token_hash bytea) returns uuid
  language sql stable security definer set search_path = public as
  $$ select household_id from invitation where token_hash = p_token_hash $$;

grant select, insert, update, delete on invitation to fdv_app;
grant execute on function invitation_household(bytea) to fdv_app;
