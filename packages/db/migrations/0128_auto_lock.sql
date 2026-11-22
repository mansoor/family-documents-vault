-- Lock by itself after a while away (0.9.0-dev.87).
--
-- A browser left signed in, with nobody using it, is locked by the vault as
-- Lock locks it (0126): the session stays, and answers `423 session_locked`
-- until it is confirmed to be them.
--
--   household.auto_lock_minutes   After how many minutes with nobody using
--                       it: 5, 10, 15, 30 or 60, or null for Off. 15 for
--                       every household. An owner's to change
--                       (household_auto_lock_rule, as 0106's), the vault
--                       itself, or the owning role (a restore).
--   account_household.auto_lock_minutes   A person's own time, shorter than
--                       the household's: one of the same, or null for "as
--                       the household says". Whichever is shorter is in
--                       effect. Written by the person alone, or the vault
--                       (account_household_auto_lock_rule); the API holds it
--                       to no longer than the household's.
--   session.in_browser  Whether the session is a browser's: signed in by
--                       the vault's own page (its refresh token kept in a
--                       cookie), with no app installation. Only a browser's
--                       session is ever locked so: a phone's, and anything
--                       else, never.
--   session.last_active_at   When it was last used: a request that was not
--                       marked as made by the page by itself, or the page
--                       saying somebody is still there. A request past the
--                       time in effect locks the session first.
--
-- A migration is nobody's edit: no audit event is written. Sessions open as
-- it runs are not a browser's, as far as it can tell: they are never locked
-- so, and end as they always would.

alter table household add column auto_lock_minutes smallint default 15
  constraint household_auto_lock_minutes check (auto_lock_minutes in (5, 10, 15, 30, 60));

create function household_auto_lock_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.auto_lock_minutes is distinct from old.auto_lock_minutes
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner chooses when the vault locks itself for the family'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger household_auto_lock_rule before update on household
  for each row execute function household_auto_lock_rule();

alter table account_household add column auto_lock_minutes smallint
  constraint account_household_auto_lock_minutes check (auto_lock_minutes in (5, 10, 15, 30, 60));

create function account_household_auto_lock_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.auto_lock_minutes is distinct from old.auto_lock_minutes
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or old.account_id is distinct from app_account()) then
    raise exception 'somebody chooses when the vault locks itself for them, for themselves'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger account_household_auto_lock_rule before update on account_household
  for each row execute function account_household_auto_lock_rule();

alter table session add column in_browser boolean not null default false;
alter table session add column last_active_at timestamptz not null default now();
