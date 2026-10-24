-- The family's time zone, set in Settings, with the server's default
-- (0.9.0, TZ; the owner's ask of 23 Oct 2026).
--
-- `household.timezone` (0009) has been "the household's clock" since
-- reminders: not null, 'UTC' unless an owner set another by
-- PUT /profile {timezone}. Now whoever runs the vault sets a default for
-- every household, FDV_TIMEZONE in the .env, and an owner may choose the
-- family's own in Settings, or clear it back to that default. So the column
-- tells "never chosen" from "chosen": null is never chosen (the server's
-- default applies, else UTC), and a name is an owner's choice. The API and
-- the worker read it through one function, householdZone (@fdv/db), and
-- never alone.
--
-- What was 'UTC' was either the default never touched, or an owner who
-- chose UTC. The activity log tells them apart: every PUT /profile that
-- sent a time zone wrote `household.profile_updated` with 'timezone' among
-- its fields, and the log is never changed or emptied (0003). So a
-- household whose log has such a line keeps 'UTC' as its owner's choice;
-- any other 'UTC' becomes null, the server's default — which is UTC until
-- FDV_TIMEZONE says otherwise, so nothing it shows moves until then. A
-- household with any other zone had it chosen, and keeps it.
--
-- Who changes it: an owner signed in (the API asks first, and this holds it
-- for whatever else writes), the vault itself, or the owning role (a
-- restore, the migrations) — household_timezone_rule, as 0061's rule for
-- Only me documents is held. A migration is nobody's edit: no audit event
-- is written.

alter table household
  alter column timezone drop not null,
  alter column timezone drop default,
  add constraint household_timezone_name
    check (timezone is null or (length(timezone) between 1 and 64));

update household h
   set timezone = null
 where h.timezone = 'UTC'
   and not exists (
     select 1
       from audit_event e
      where e.household_id = h.id
        and e.action = 'household.profile_updated'
        and coalesce(e.detail->'fields', '[]'::jsonb) ? 'timezone');

create function household_timezone_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.timezone is distinct from old.timezone
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner changes the family''s time zone'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger household_timezone_rule before update on household
  for each row execute function household_timezone_rule();
