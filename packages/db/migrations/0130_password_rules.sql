-- Password rules an owner sets, in Settings → Security.
--
-- What a sign-in password must be whenever one is set: changed by the
-- person, set from a reset link, chosen as an invitation is accepted, and
-- the first owner's at setup. Passwords already set are never asked again;
-- a link's or a request's password is not a sign-in password.
--
--   household.password_min_length   At least this many characters: 10 to
--                       64; 10 unless an owner chose more.
--   household.password_refuse_common   Refuse common and easily guessed
--                       passwords — found in the list the vault keeps, or
--                       just the person's own email address or name. On
--                       unless an owner turned it off.
--   household.password_needs_upper, _lower, _number, _symbol   An uppercase
--                       letter, a lowercase letter, a number, a symbol: each
--                       off unless an owner turned it on.
--
-- An owner's to change (household_password_rules_rule, as 0128's), the vault
-- itself, or the owning role (a restore). Read by whoever the household's row
-- is read by: everybody signed in, and the pages that set a password without
-- a sign-in (a reset link, an invitation), which the API shows the rules
-- alone.
--
-- A migration is nobody's edit: no audit event is written.

alter table household
  add column password_min_length smallint not null default 10
    constraint household_password_min_length check (password_min_length between 10 and 64),
  add column password_refuse_common boolean not null default true,
  add column password_needs_upper boolean not null default false,
  add column password_needs_lower boolean not null default false,
  add column password_needs_number boolean not null default false,
  add column password_needs_symbol boolean not null default false;

create function household_password_rules_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if (new.password_min_length is distinct from old.password_min_length
      or new.password_refuse_common is distinct from old.password_refuse_common
      or new.password_needs_upper is distinct from old.password_needs_upper
      or new.password_needs_lower is distinct from old.password_needs_lower
      or new.password_needs_number is distinct from old.password_needs_number
      or new.password_needs_symbol is distinct from old.password_needs_symbol)
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner sets the household''s password rules'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger household_password_rules_rule before update on household
  for each row execute function household_password_rules_rule();
