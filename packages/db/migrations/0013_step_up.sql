-- Step-up authentication (SEC-17): consequential actions need a fresh
-- credential, not just a live session.
--
-- When the session last saw a credential presented — a password, a code
-- from an authenticator app, or a passkey. A session is "fresh" for five
-- minutes afterwards. Sessions that predate this column count as never
-- verified, which is the safe way round: the first consequential action
-- asks.
alter table session add column verified_at timestamptz;
