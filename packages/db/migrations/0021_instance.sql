-- Which vault this is.
--
-- One row, made once when the database is, and never changed: a random
-- identifier for this installation. The capability document carries it
-- (instance_id), so a phone that was told once that it may reach this
-- vault over plain http on the home network can tell, next time, whether
-- it is talking to the same vault or to something else answering at the
-- same address — a different vault on another network, or an impostor.
--
-- It is not a secret (anyone who can reach /capabilities sees it) and it
-- is not tenant data, so it has no row-level security; the application
-- role may read it and nothing more. The grant is written out, as every
-- other migration's is, rather than left to 0001's default privileges: a
-- database that has lost those (loaded from a dump without privileges)
-- would otherwise give the application a table it cannot read.
create table instance (
  singleton   boolean primary key default true check (singleton),
  instance_id uuid not null default gen_random_uuid(),
  created_at  timestamptz not null default now()
);
insert into instance default values;
grant select on instance to fdv_app;
revoke insert, update, delete on instance from fdv_app;
