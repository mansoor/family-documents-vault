-- Extensions the data model relies on.
create extension if not exists citext;     -- case-insensitive email columns
create extension if not exists pgcrypto;   -- gen_random_uuid()

-- The application role. It must NOT own any table, otherwise row-level
-- security is bypassed for it. Tables are created by the migration role
-- (the connection running this file); the application role is granted
-- access to them, never ownership. The role is created here so that a
-- database provisioned by hand still ends up with the right shape; its
-- password is set by the deployment (see docker/postgres/init.sh).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fdv_app') then
    create role fdv_app login;
  end if;
end $$;

grant usage on schema public to fdv_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to fdv_app;
alter default privileges in schema public
  grant usage, select on sequences to fdv_app;
