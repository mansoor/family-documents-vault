-- Lock (0.9.0-dev.86).
--
-- Somebody stepping away from the vault in a browser locks it: the session
-- stays signed in, and answers nothing but the few routes that draw the lock
-- screen, unlock it, or sign out (`423 session_locked`) until a credential
-- is presented again. A lock kept only by the page would go with a reload,
-- or with the browser's developer tools, so the server keeps it, on the
-- session.
--
--   session.locked_at   When this session was locked; null while it is not.
--                       Per session: another device of the same person,
--                       their phone among them, is not locked by it. A
--                       refresh renews the same session row, so a renewed
--                       access token is as locked as the one before it.
--                       session_tenant (0003) and session_link (0042) hold
--                       it, as they hold the rest of the row.

alter table session add column locked_at timestamptz;
