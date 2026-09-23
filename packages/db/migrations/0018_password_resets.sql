-- Forgotten passwords.
--
-- A member key is wrapped twice: by the master key, and by a key derived
-- from the member's own password (migration 0004). The second wrap is why
-- a password change has to rewrap it; the first is why a reset is
-- possible at all without losing the archive, which the design counts as
-- one of the things backend encryption buys.
--
-- Who may start one is the load-bearing decision, and it is a short list:
-- the account holder, by email to their own address; and whoever runs the
-- server, from the command line. Deliberately *not* an owner, because an
-- owner who could reset another adult's password could then sign in as
-- them and read their private documents — which is the one thing the
-- whole privacy wall exists to prevent.

create table password_reset (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references account(id) on delete cascade,
  token_hash  bytea not null unique,
  -- 'self' (asked for it on the sign-in page) or 'operator' (the command
  -- line). Recorded because the two mean different things afterwards.
  issued_by   text not null check (issued_by in ('self', 'operator')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  ip          inet
);
create index password_reset_account_idx on password_reset (account_id, created_at desc);
create index password_reset_expiry_idx on password_reset (expires_at);

-- Not tenant-scoped: an account is global, and a reset is asked for and
-- answered before any household is known. Reached only by the API's own
-- auth service, like `account` and `webauthn_challenge`.
grant select, insert, update, delete on password_reset to fdv_app;
