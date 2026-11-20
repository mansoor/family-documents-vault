-- Failed sign-ins counted, and a code from an authenticator app used once
-- (0.9.0-dev.75).
--
--   sign_in_failure   One row per subject, an HMAC under a key derived for
--                     this alone, never the address or the account itself.
--                     Not tenant data: the installation's, as watch_dir is,
--                     so no row-level security. A subject is one of:
--
--                     - an account, for tries from a device it does not
--                       know (the account-wide count);
--                     - an account and one device that signed in to it
--                       before (a known device: its own count, so that
--                       whoever keeps failing elsewhere never makes the
--                       person's own phone or browser wait);
--                     - an address with no account, counted and answered
--                       exactly as one with an account is;
--                     - a session, for confirming it's you and changing
--                       the password (only somebody signed in reaches it);
--                     - an account's notices: its lines in Activity, ten an
--                       hour at most, and its alerts, once an incident.
--
--                     Each try is reserved before it is checked (`inflight`),
--                     so tries at the same moment cannot pass the limit:
--                     five failures and signing in waits a minute, then
--                     five, then fifteen, never longer. The count starts
--                     again 24 hours after the first failure it counts, or
--                     when a try succeeds. A row quiet for a day is deleted.
--
--   account.totp_last_step   The time step (30 seconds each, since 1970) of
--                     the last code from an authenticator app the vault
--                     took. A code at or before it is refused: one seen
--                     over a shoulder, or passed on by a copy of the
--                     sign-in page, does not work a second time. Null until
--                     a code is taken, and again whenever a new
--                     authenticator is set up.
--
-- A migration is nobody's edit: no audit event is written.

create table sign_in_failure (
  subject           bytea primary key
                      constraint sign_in_failure_subject check (octet_length(subject) = 32),
  -- Failures counted since window_started_at.
  failures          integer not null default 0
                      constraint sign_in_failure_failures check (failures >= 0),
  window_started_at timestamptz not null default now(),
  -- Tries reserved and not yet settled, as of inflight_at (a reservation a
  -- crash left behind is let go after a minute).
  inflight          integer not null default 0
                      constraint sign_in_failure_inflight check (inflight >= 0),
  inflight_at       timestamptz,
  -- Whether any failure counted was a second step (the password was right).
  second_step       boolean not null default false,
  last_failed_at    timestamptz not null default now(),
  -- A sign-in by password or code is refused until then.
  throttled_until   timestamptz,
  -- An account's notices: lines written this hour, at most ten; and
  -- whether this incident (until 24 hours without a failure) was told.
  audited           integer not null default 0
                      constraint sign_in_failure_audited check (audited >= 0),
  audited_since     timestamptz not null default now(),
  incident_told     boolean not null default false,
  owners_told       boolean not null default false
);
create index sign_in_failure_quiet on sign_in_failure (last_failed_at);

alter table account add column totp_last_step integer;
