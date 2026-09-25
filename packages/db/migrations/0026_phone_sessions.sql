-- Sessions a phone can live with (iteration 4.6).
--
-- A phone keeps one session for months, on a network that drops answers
-- on the floor. Three things change for it — and for browsers too:
--
-- * Which installation a session belongs to: the app sends a random id
--   (X-FDV-Installation) with every sign-in and refresh. New-device alerts
--   key on it, so an app update is not a new device and a second phone on
--   the same version is.
-- * A refresh whose answer was lost can be replayed, once, within 30
--   seconds, from the same installation — instead of ending the session.
--   rotated_at says when the token was last replaced; grace_used_at that
--   the one replay has been spent since. Every token a replay touched —
--   the one replayed, the one it displaced — is kept in grace_hashes for
--   the session's life: presented again, at any time, it ends the session,
--   however many rotations later.
-- * Sessions slide: each refresh keeps a session for 30 more days of
--   use, but never past 180 days from the sign-in (absolute_expires_at).
--   Sessions already open get their 180 days from when they began.

alter table session add column installation_id uuid;
alter table session add column rotated_at timestamptz;
alter table session add column grace_used_at timestamptz;
alter table session add column absolute_expires_at timestamptz;
alter table session add column grace_hashes bytea[] not null default '{}';

update session set absolute_expires_at = created_at + interval '180 days';
alter table session alter column absolute_expires_at set not null;
-- A session made without saying (a restored vault's, a fixture's) gets its 180 days too.
alter table session alter column absolute_expires_at set default now() + interval '180 days';

create index session_installation_idx on session (account_id, installation_id) where revoked_at is null;
