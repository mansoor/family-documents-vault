-- Co-owners (SHR-09, SHR-10).
--
-- Several accounts may hold the owner role with identical powers, because
-- two spouses are genuinely equal and the incapacity of one should change
-- nothing about how the household runs. Two rules make that safe.

-- 1. At least one owner must always remain. This is a database rule and
--    not an application one: the application can be wrong, and a household
--    with no owner cannot appoint one — it is the one state from which
--    there is no way back short of the recovery kit.
--
--    Deferred, so a transaction may move the role from one account to
--    another in either order and be judged only on where it ends up.
create function assert_owner_remains() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from account_household
     where household_id = coalesce(old.household_id, new.household_id)
       and role = 'owner'
  ) then
    raise exception 'a household must keep at least one owner'
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger owner_floor
  after update or delete on account_household
  deferrable initially deferred
  for each row execute function assert_owner_remains();

-- 2. Taking the owner role off somebody else is a request, not an act.
--    A shared vault during a bad divorce is a real scenario, and a one-tap
--    lockout of a spouse would be a weapon rather than a feature. Seven
--    days' notice, and the affected owner can refuse in that time.
--    Promotion has no notice period: it only adds powers.
create table owner_change_request (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references household(id) on delete cascade,
  target_account uuid not null references account(id) on delete cascade,
  requested_by   uuid not null references account(id) on delete cascade,
  action         text not null check (action in ('promote', 'demote')),
  requested_at   timestamptz not null default now(),
  -- requested_at + seven days for a demotion.
  opens_at       timestamptz not null,
  -- A request nobody completes does not hang over the household forever.
  lapses_at      timestamptz not null,
  refused_at     timestamptz,
  completed_at   timestamptz,
  completed_by   uuid references account(id)
);
create index owner_change_household_idx on owner_change_request (household_id, requested_at desc);

-- One live request per person: asking twice does not start the clock again.
create unique index owner_change_one_live_per_target
  on owner_change_request (household_id, target_account)
  where refused_at is null and completed_at is null;

alter table owner_change_request enable row level security;
create policy owner_change_tenant on owner_change_request
  using (household_id = app_household()) with check (household_id = app_household());

-- New-device alerts (SEC-11). A session records the device it was opened
-- from; this remembers which devices an account has used before, so the
-- second sign-in from a laptop is quiet and the first one from somewhere
-- else is not.
create table known_device (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references account(id) on delete cascade,
  household_id uuid not null references household(id) on delete cascade,
  -- sha256 of the user agent, which is all a browser tells us. It is a
  -- weak signal on purpose: it errs towards telling you about a sign-in
  -- you already knew about, never towards silence.
  fingerprint  bytea not null,
  label        text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create unique index known_device_unique on known_device (account_id, household_id, fingerprint);

alter table known_device enable row level security;
create policy known_device_tenant on known_device
  using (household_id = app_household()) with check (household_id = app_household());

grant select, insert, update, delete on owner_change_request to fdv_app;
grant select, insert, update, delete on known_device to fdv_app;
