-- A requester's requests closed, as many as were live (iteration 5.30; its
-- review, S530-2).
--
-- A requester who can no longer ask — made a teen or a viewer, their
-- sign-in taken away — loses their requests (A39, 0044): each still open is
-- closed, its address cleared, and its sessions and codes ended. Since 5.30
-- a role change says how many ("Their 2 requests to send documents
-- closed") and writes a line, and the ids returned here are what it counts,
-- and what gets an `upload_request.closed` line each. One that had already
-- run out, or locked itself after ten wrong tries, had stopped working for
-- good: it is still closed, as before, but not returned — no line says a
-- dead request was closed, as no line says a dead link was taken back
-- (5.28, E528-4; upload_requests_end_for_lock, 0051).
--
-- The same function, the same rights and grant (create or replace keeps
-- them): only what it returns is narrower.
create or replace function upload_requests_close_lost() returns setof uuid
  language sql volatile security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ with lost as (
       update upload_request r
          set closed_at = now(), closed_reason = 'requester_lost_right', recipient_email = null
        where r.household_id = app_household()
          and r.closed_at is null
          and r.revoked_at is null
          and not exists (select 1 from account_household a
                           where a.account_id = r.created_by
                             and a.household_id = r.household_id
                             and a.member_id = r.requester_member_id
                             and a.role in ('owner', 'adult'))
       returning r.id, (r.expires_at > now() and r.attempts < 10) as live),
     -- A session in use this moment is passed over, never waited on (as
     -- 5.19's endSessions): its request finds the request ended as it
     -- finishes (requests.ts inSession), and its next is refused.
     sessions as (delete from upload_session
                   where id in (select s.id from upload_session s
                                 where s.request_id in (select id from lost)
                                 for update skip locked)),
     codes as (delete from upload_code where request_id in (select id from lost))
     select id from lost where live $$;
