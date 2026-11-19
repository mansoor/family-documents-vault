-- Two-step sign-in for adults (0.9.0, security before launch).
--
--   household.require_two_step_adults   Whether every adult of the household
--                       must have two-step sign-in — a code from an
--                       authenticator app, or a passkey — before a password
--                       sign-in opens anything but setting it up. Owners
--                       always must, whatever this says. On for every
--                       household made from now on; off for every household
--                       there already is, whose adults may have neither and
--                       would otherwise find themselves stopped at their next
--                       sign-in without warning. An owner's to change (the
--                       rule below), the vault itself, or the owning role (a
--                       restore).
--
--   credential.user_verified   A passkey that asked for a PIN, a
--                       fingerprint or a face. Every passkey made from now on
--                       must (the vault asks for it), and one made before is
--                       marked the first time it is used with one. Only such
--                       a passkey counts as two-step sign-in: one made before,
--                       on a security key with no PIN, does not, and its
--                       owner is asked to set up one that does.
--
-- A migration is nobody's edit: no audit event is written.

alter table household add column require_two_step_adults boolean not null default false;
-- Every household made after this runs.
alter table household alter column require_two_step_adults set default true;

create function household_two_step_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.require_two_step_adults is distinct from old.require_two_step_adults
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner chooses whether adults must use two-step sign-in'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger household_two_step_rule before update on household
  for each row execute function household_two_step_rule();

alter table credential add column user_verified boolean not null default false;
