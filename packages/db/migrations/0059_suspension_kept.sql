-- A lock, or a restore's pause, outlives a sign-in taken away (the Phase 5
-- exit's review, E541-01).
--
-- A suspension lives on the sign-in (account_household, 0051). Taking the
-- sign-in away deleted the row, and giving it back made a fresh one: an
-- owner with only a password — who may not unlock anybody (A54) — could lift
-- a lock, or a restore's pause (A55), by taking the sign-in away and giving
-- it back, with nobody but the person told. Now:
--
-- * member.former_suspended_* keep the suspension of a sign-in taken away
--   while it was in effect, as member.former_account_id keeps the account;
--   giving the sign-in back puts it back on the new row (the API), so the
--   person is still locked or paused, and only an owner power ends it.
-- * Only an owner signed in, the vault itself or the owning role changes
--   what is kept — as only they change a suspension (0051).
-- * The last wall: a sign-in whose suspension is in effect is not deleted
--   by anybody signed in unless its member keeps that same suspension. The
--   vault itself (system) and the owning role (a restore, maintenance) are
--   not held to it.
-- * A restore pauses a sign-in that was taken away when the backup was made
--   too (the worker's restore): given back afterwards, it waits for an owner
--   like every other.
--
-- Both functions put pg_temp last in their path.

alter table member
  add column former_suspended_at    timestamptz,
  add column former_suspended_by    uuid references account(id) on delete set null,
  add column former_suspended_until timestamptz,
  add column former_suspend_reason  text,
  add column former_suspend_note    text,
  add constraint member_former_suspend_reason
    check (former_suspend_reason in ('locked', 'restored')),
  add constraint member_former_suspended
    check ((former_suspended_at is null) = (former_suspend_reason is null)),
  add constraint member_former_suspended_detail
    check (former_suspended_at is not null
           or (former_suspended_by is null and former_suspended_until is null
               and former_suspend_note is null)),
  add constraint member_former_suspend_note
    check (char_length(former_suspend_note) <= 500);

create function member_former_suspension() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if (new.former_suspended_at, new.former_suspended_by, new.former_suspended_until,
      new.former_suspend_reason, new.former_suspend_note)
       is distinct from
     (old.former_suspended_at, old.former_suspended_by, old.former_suspended_until,
      old.former_suspend_reason, old.former_suspend_note)
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner keeps or gives back a sign-in''s lock'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger member_former_suspension before update on member
  for each row execute function member_former_suspension();

create function account_household_keep_suspension() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if suspension_in_effect(old.suspended_at, old.suspended_until)
     and app_actor() is not null and app_actor() <> 'system'
     and not exists (
       select 1 from member m
        where m.id = old.member_id
          and m.former_suspended_at is not distinct from old.suspended_at
          and m.former_suspend_reason is not distinct from old.suspend_reason
          and m.former_suspended_until is not distinct from old.suspended_until) then
    raise exception 'a locked or paused sign-in is taken away only with its lock kept'
      using errcode = 'FDV05';
  end if;
  return old;
end $$;

create trigger account_household_keep_suspension before delete on account_household
  for each row execute function account_household_keep_suspension();
