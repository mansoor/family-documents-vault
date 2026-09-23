-- Passkeys (SEC-03's better half, and decision: passkeys are the primary
-- credential, password the fallback).

-- What the browser told us about the authenticator, so the device list can
-- say "a phone" or "this computer" rather than a hash.
alter table credential add column transports text[] not null default '{}';
alter table credential add column backed_up boolean;
alter table credential add column aaguid text;

-- A passkey is identified by its credential id, which must be unique
-- across accounts: it is what a sign-in presents before we know who it is.
create unique index credential_passkey_id_idx
  on credential (credential_id) where kind = 'passkey';

-- WebAuthn challenges. The server invents one, the authenticator signs it,
-- and the server must recognise it exactly once — so this is a table and
-- not a token: a signed token that is valid until it expires can be
-- replayed until it expires, and single use is the property that matters.
create table webauthn_challenge (
  id          uuid primary key default gen_random_uuid(),
  challenge   bytea not null,
  purpose     text not null check (purpose in ('register', 'authenticate')),
  -- Known for registration and for a sign-in that named an account;
  -- null for a sign-in that let the authenticator choose (SEC: a
  -- discoverable credential does not reveal who is signing in first).
  account_id  uuid references account(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index webauthn_challenge_expiry_idx on webauthn_challenge (expires_at);

-- Neither table is tenant-scoped: an account is global and a challenge is
-- answered before the household is known. They are reached only by the
-- API's own auth service, which is why the grants are narrow.
grant select, insert, update, delete on webauthn_challenge to fdv_app;
