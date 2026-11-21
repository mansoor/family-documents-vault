-- Functions that run with the owner's rights, held to one rule
-- (0.9.0-dev.77).
--
-- A SECURITY DEFINER function runs as the role that owns the tables, past
-- every row-level policy. Two things keep that narrow:
--
--   search_path   pg_catalog first and pg_temp last, so nothing a caller
--                 creates in its own temporary schema can stand in for a
--                 table or an operator the function names.
--   EXECUTE       nobody's by default. PostgreSQL gives every new function
--                 to PUBLIC; each definer function is granted to the role
--                 that calls it (fdv_app, the role the vault serves the
--                 family with) and to nobody else; the owning role may
--                 always call its own. Trigger functions are granted to nobody:
--                 a trigger fires whoever wrote the row, and only creating
--                 one asks for EXECUTE.
--
-- The four first-run and link lookups from 0003, 0014 and 0016 are written
-- again with that search_path (0030 had already changed it in place); their
-- bodies are unchanged. Every other definer function already had it; the
-- loop below takes EXECUTE from PUBLIC on all of them. privileges.ts does the
-- same on every start, since a backup loads without privileges and gives
-- every function back to PUBLIC.

-- First-run detection, asked by the API before anybody is signed in.
create or replace function setup_complete() returns boolean
  language sql stable security definer set search_path = pg_catalog, public, pg_temp as
  $$ select exists (select 1 from household where deleted_at is null) $$;

-- The name on the sign-in screen, asked by the API before anybody is signed in.
create or replace function vault_display_name() returns text
  language sql stable security definer set search_path = pg_catalog, public, pg_temp as
  $$ select name from household where deleted_at is null order by created_at limit 1 $$;

-- Which household an invitation link's secret belongs to.
create or replace function invitation_household(p_token_hash bytea) returns uuid
  language sql stable security definer set search_path = pg_catalog, public, pg_temp as
  $$ select household_id from invitation where token_hash = p_token_hash $$;

-- Which household a share link's secret belongs to.
create or replace function share_link_household(p_token_hash bytea) returns uuid
  language sql stable security definer set search_path = pg_catalog, public, pg_temp as
  $$ select household_id from share_link where token_hash = p_token_hash $$;

revoke execute on function setup_complete() from public;
revoke execute on function vault_display_name() from public;
revoke execute on function invitation_household(bytea) from public;
revoke execute on function share_link_household(bytea) from public;
grant execute on function setup_complete() to fdv_app;
grant execute on function vault_display_name() to fdv_app;
grant execute on function invitation_household(bytea) to fdv_app;
grant execute on function share_link_household(bytea) to fdv_app;

-- Every other definer function: pg_temp last if it were ever missing, and
-- EXECUTE taken from PUBLIC. Those fdv_app calls were granted to it by name
-- when they were made; trigger functions need no grant.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
  loop
    if not exists (
      select 1
        from pg_catalog.pg_proc p, unnest(coalesce(p.proconfig, '{}')) c
       where p.oid = f and c like 'search_path=%pg_temp'
    ) then
      execute format('alter function %s set search_path = pg_catalog, public, pg_temp', f);
    end if;
    execute format('revoke execute on function %s from public', f);
  end loop;
end $$;
