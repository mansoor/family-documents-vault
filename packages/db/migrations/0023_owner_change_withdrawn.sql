-- A request to change who is an owner can end without anybody refusing it.
--
-- Until 0.4.7 every such ending was written down as a refusal: an owner
-- withdrawing the request set refused_at, so its history read "Sam
-- refused" about something Sam never did; so did a restore from a backup
-- (0.4.5, 0.4.6), which withdraws the requests a backup brings back. And a
-- request about somebody who then stepped down of their own accord stayed
-- live: seven days later it could be "carried out", making whatever they
-- had become an adult and telling them they were no longer an owner.
--
-- withdrawn_at records the ending for what it was: withdrawn by an owner,
-- closed because its subject stepped down, or withdrawn by a restore.
alter table owner_change_request
  add column withdrawn_at  timestamptz,
  add column withdrawn_by  uuid references account(id) on delete set null,
  add column withdrawn_why text check (withdrawn_why in ('withdrawn', 'stepped_down', 'restored')),
  add constraint owner_change_withdrawn_why
    check ((withdrawn_at is null) = (withdrawn_why is null));

-- The one-live-request index goes first and comes back last: clearing
-- refused_at below makes a row live under the old predicate for a moment,
-- and a person with a withdrawn request and a later one (withdraw, ask
-- again) would otherwise have two.
drop index owner_change_one_live_per_target;

-- The withdrawals recorded as refusals. The audit log says which they
-- were: each one appended 'owner_change.withdrawn' against its id.
update owner_change_request r
   set withdrawn_at  = r.refused_at,
       withdrawn_by  = a.actor_account_id,
       withdrawn_why = 'withdrawn',
       refused_at    = null
  from audit_event a
 where a.action = 'owner_change.withdrawn'
   and a.object_id = r.id
   and r.refused_at is not null;

-- The ones a restore ended: a refusal no audit event accounts for. Every
-- refusal appends 'owner_change.refused', and every withdrawal was
-- reclassified just above; only the restore wrote refused_at silently.
update owner_change_request r
   set withdrawn_at  = r.refused_at,
       withdrawn_why = 'restored',
       refused_at    = null
 where r.refused_at is not null
   and not exists (
     select 1 from audit_event a
      where a.object_id = r.id
        and a.action in ('owner_change.refused', 'owner_change.withdrawn'));

-- Requests still live about somebody who is no longer an owner: stepping
-- down is the only way that happens, so they are closed as that.
update owner_change_request r
   set withdrawn_at  = now(),
       withdrawn_by  = r.target_account,
       withdrawn_why = 'stepped_down'
 where r.refused_at is null and r.completed_at is null and r.lapsed_at is null
   and r.withdrawn_at is null
   and r.lapses_at > now()
   and not exists (
     select 1 from account_household ah
      where ah.account_id = r.target_account
        and ah.household_id = r.household_id
        and ah.role = 'owner');

create unique index owner_change_one_live_per_target
  on owner_change_request (household_id, target_account)
  where refused_at is null and completed_at is null and lapsed_at is null
    and withdrawn_at is null;
