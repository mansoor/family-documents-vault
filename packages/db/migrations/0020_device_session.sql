-- A push device belongs to a sign-in, not only to an account.
--
-- Until 0.4.2 a device row lived until somebody deleted it by hand. Signing
-- out, a password change, a reset, taking a sign-in away — none of them
-- touched it, so a browser that had once turned notifications on kept
-- receiving that person's digest (their own private titles included) after
-- they had signed out of it, and a browser somebody else had used with a
-- stolen session kept receiving it after the password was changed.
--
-- Now each device names the session that registered it, and the worker
-- pushes only to devices whose session is still live. Rows registered
-- before this migration have no session; they are sent to only while the
-- account has some live session, and are removed by a password change.
alter table device
  add column session_id uuid references session(id) on delete cascade;
create index device_session_idx on device (session_id);
