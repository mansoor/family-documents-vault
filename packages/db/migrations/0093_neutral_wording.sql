-- Neutral wording in notifications and email (0.9.0, H2 of the health plan;
-- the owner's change of 22 Oct 2026, and Health documents only of 13 Nov).
--
-- What leaves the vault about a document — a digest's lines by email, a
-- browser's push, the reminder email — may name it, or say only "A reminder
-- about a document" (no title, kind, person, note or the date it is about;
-- when it falls due may stay). Only me documents stay "One of your private
-- documents" on every channel, whatever is chosen.
--
--   household.neutral_wording   The household's choice, an owner's, of
--                       which documents are not named: 'off' (none: titles
--                       as before), 'health' (Health documents only — a
--                       document whose category, its own or else its kind's,
--                       is Medical), 'sensitive' (Sensitive documents only —
--                       a document sensitiveOf says is, by its own choice or
--                       its kind's default) or 'all'. 'sensitive' for new
--                       households and for every household today: nothing
--                       more is named than before, and a sensitive paper's
--                       title stops going. Who changes it: an owner signed in
--                       (the API asks first, and a step-up for a change that
--                       names any document the old choice did not), the
--                       vault itself, or the owning role (a restore) —
--                       household_neutral_wording_rule, as 0081's and 0092's.
--   notification_preference.neutral_wording   Each person's own, for what is
--                       sent to them: null as the household says, or
--                       'health', 'sensitive' or 'all' besides it. A line is
--                       neutral when the household's choice or theirs says
--                       so (neutralUnder, @fdv/shared), so no value here can
--                       name what the household's hides. Written, and
--                       deleted, by the person alone, or the vault — and a
--                       row goes with its account or household by the
--                       foreign keys' own cascade —
--                       notification_preference_wording_rule.
--
-- A migration is nobody's edit: no audit event is written.

alter table household add column neutral_wording text not null default 'sensitive'
  constraint household_neutral_wording check (neutral_wording in ('off', 'health', 'sensitive', 'all'));

create function household_neutral_wording_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.neutral_wording is distinct from old.neutral_wording
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner chooses how notifications name documents'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger household_neutral_wording_rule before update on household
  for each row execute function household_neutral_wording_rule();

alter table notification_preference add column neutral_wording text
  constraint notification_preference_neutral_wording
  check (neutral_wording in ('health', 'sensitive', 'all'));

-- Somebody signed in chooses their own wording, and nobody else's, nor
-- takes it away by deleting their row. Their choice only ever adds to the
-- household's, so another's could not name what they are sent; it is still
-- theirs to make. A row deleted by a foreign key's cascade (its account or
-- household gone) runs inside the cascade's own trigger, and goes.
create function notification_preference_wording_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1
       and old.neutral_wording is not null
       and app_actor() is not null and app_actor() <> 'system'
       and (app_actor() <> 'account' or old.account_id is distinct from app_account()) then
      raise exception 'somebody chooses how what is sent to them names documents, for themselves'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;
  if app_actor() is not null and app_actor() <> 'system'
     and (case tg_op when 'INSERT' then new.neutral_wording is not null
                     else new.neutral_wording is distinct from old.neutral_wording end)
     and (app_actor() <> 'account' or new.account_id is distinct from app_account()) then
    raise exception 'somebody chooses how what is sent to them names documents, for themselves'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger notification_preference_wording_rule
  before insert or update or delete on notification_preference
  for each row execute function notification_preference_wording_rule();
