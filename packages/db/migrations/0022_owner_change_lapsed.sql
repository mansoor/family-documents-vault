-- A request to change who is an owner lapses when nobody carries it out
-- in thirty days (lapses_at). Until 0.4.6 nothing recorded that it had:
-- it was neither refused nor completed, so it stayed "live" for ever. It
-- kept its place in the one-live-request index below, and asking again
-- was refused with "somebody has already asked for this" — about a
-- request nobody could see any more, and nobody could withdraw.
--
-- lapsed_at records it. The service sets it when somebody asks again; the
-- index leaves lapsed requests out, as it does refused and completed ones.
-- (An index predicate cannot say "lapses_at < now()": it must be the same
-- answer tomorrow.)
alter table owner_change_request add column lapsed_at timestamptz;

update owner_change_request
   set lapsed_at = lapses_at
 where refused_at is null and completed_at is null and lapses_at <= now();

drop index owner_change_one_live_per_target;
create unique index owner_change_one_live_per_target
  on owner_change_request (household_id, target_account)
  where refused_at is null and completed_at is null and lapsed_at is null;
