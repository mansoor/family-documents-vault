-- A push address whose sign-in has ended is free again (the Phase 5 exit's
-- second round, C-01).
--
-- Since the first round (E541-02) nobody takes over a push address another
-- sign-in registered: 409 device_taken. But a shared browser or phone keeps
-- its address when its sign-in ends without signing out — the 30-day idle
-- end, a restore — and the row stays: it is never pushed to again (the
-- worker's liveDevice), so never answered 410, so never deleted. The next
-- person to sign in there could never turn notifications on.
--
-- Now a row whose sign-in is no longer live goes first, as the worker
-- judges it: its session revoked or ended, or, for a row from before 0.4.2
-- naming no session, no live session of its account in its household.
-- Anybody signed in asks, for an address they hold; it is done with the
-- vault's rights, as a limited caller's rules cannot see another account's
-- row or session. A live row of somebody else's is left, and still 409.
-- Whether it removed one is all it says.

create function device_release_stale(p_endpoint text) returns boolean
  language sql volatile security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ with gone as (
       delete from device d
        where d.endpoint = p_endpoint
          and app_account() is not null
          and d.account_id is distinct from app_account()
          and not (
            (d.session_id is not null and exists (
               select 1 from session s
                where s.id = d.session_id and s.revoked_at is null and s.expires_at > now()))
            or (d.session_id is null and exists (
               select 1 from session s
                where s.account_id = d.account_id and s.household_id = d.household_id
                  and s.revoked_at is null and s.expires_at > now())))
       returning 1)
     select exists (select 1 from gone) $$;

revoke all on function device_release_stale(text) from public;
grant execute on function device_release_stale(text) to fdv_app;
