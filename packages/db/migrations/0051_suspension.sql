-- Lock a sign-in (iteration 5.28).
--
-- An owner can lock somebody's sign-in (A51, A52): never their own, never
-- another owner's (A50). Locked, the person cannot sign in — the vault says
-- so only once their password, code or passkey is proven — their sessions
-- end, and what they lent outside the family stops answering: their share
-- links and their requests to send documents pause, or with "end them for
-- good" are taken back. A lock may end by itself on a set date.
--
-- And a restore pauses every sign-in but the owners' (A55): a backup cannot
-- know of a lock made after it, so each person waits for an owner to turn
-- their sign-in back on.
--
-- Both live on the person's membership:
--
--   suspended_at     since when;
--   suspended_by     the owner who locked it (null for the vault itself, and
--                    once that account is gone);
--   suspended_until  a lock that ends by itself then; null, until an owner
--                    unlocks it. A pause after a restore has none;
--   suspend_reason   `locked`, or `restored`;
--   suspend_note     the owner's note, for the owners.
--
-- A lock past its end is over, whoever reads it: the reads ask
-- suspension_in_effect(), and nothing has to run at that moment for the
-- person to sign in again, or for their links to work again. Nothing is
-- written when a lock ends by itself; the next lock writes over it.
--
-- What pauses is not written onto the links and requests: each is live only
-- while its maker's sign-in is not suspended, asked on every open and every
-- request of a session (app_shared_document(), app_live_share() and
-- app_live_upload_request() below, and the API's own checks beside them).
-- So unlocking gives them back as they were, a recipient's open page stops
-- at its next request, and a restore — which pauses every link for an owner
-- (0037) — finds nothing of a lock's to undo.

alter table account_household
  add column suspended_at    timestamptz,
  add column suspended_by    uuid references account(id) on delete set null,
  add column suspended_until timestamptz,
  add column suspend_reason  text,
  add column suspend_note    text,
  add constraint account_household_suspend_reason
    check (suspend_reason in ('locked', 'restored')),
  add constraint account_household_suspended
    check ((suspended_at is null) = (suspend_reason is null)),
  -- Nothing about a suspension that is not there.
  add constraint account_household_suspended_detail
    check (suspended_at is not null
           or (suspended_by is null and suspended_until is null and suspend_note is null)),
  -- Only a lock ends by itself, and after it began.
  add constraint account_household_suspended_until
    check (suspended_until is null
           or (suspend_reason = 'locked' and suspended_until > suspended_at)),
  add constraint account_household_suspend_note
    check (char_length(suspend_note) <= 500);

-- Whether a suspension is in effect now: there, and not past its end. Every
-- read of one asks this, so a lock past its date is over everywhere at once.
-- suspensionInEffect() (packages/shared/src/wire.ts) says the same; change
-- them together.
create function suspension_in_effect(p_at timestamptz, p_until timestamptz) returns boolean
  language sql stable parallel safe
  set search_path = pg_catalog, public, pg_temp as
  $$ select p_at is not null and (p_until is null or p_until > now()) $$;

-- ------------------------------------------------------ the owner floor
--
-- 0015's rule that a household keeps an owner, as 0023 serialised it, now
-- asks for an owner who can sign in: one whose sign-in is not locked or
-- paused. This migration owns assert_owner_remains() from here; its body is
-- 0023's with that one condition added, and its search_path 0030's, pg_temp
-- last. The trigger (owner_floor, 0015) fires on every update of a
-- membership, so a suspension written by any path — the API, the vault
-- itself, a restore, a statement typed by hand — is judged at commit.
create or replace function assert_owner_remains() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  hh uuid := coalesce(old.household_id, new.household_id);
begin
  perform pg_advisory_xact_lock(hashtext('owner_floor'), hashtext(hh::text));
  if not exists (
    select 1 from account_household
     where household_id = hh
       and role = 'owner'
       and not suspension_in_effect(suspended_at, suspended_until)
  ) then
    raise exception 'a household must keep at least one owner who can sign in'
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

-- ----------------------------------------------- who locks, and whom
--
-- A rule cannot say which columns change, so a trigger does. A suspension
-- is changed only by an owner signed in, and never their own (A52); by the
-- vault itself; or by the owning role, which says nobody (the migrations,
-- a restore). An owner signed in does not lock another owner (A50): ask
-- them to become an adult first, with its seven days' notice. And nobody
-- whose sign-in is suspended is made an owner, by anybody signed in: an
-- owner unlocks them first. Somebody made an owner whose lock has run out
-- by itself — nothing is written when it does — has what is left of it
-- cleared, whoever makes them one: a lock's columns never reach an owner,
-- where nobody could clear them (an owner is never unlocked) and a restore
-- would find them. The owner floor (above) still judges every path at
-- commit, the vault's own included.
create function account_household_suspension() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if (new.suspended_at, new.suspended_by, new.suspended_until, new.suspend_reason, new.suspend_note)
       is distinct from
     (old.suspended_at, old.suspended_by, old.suspended_until, old.suspend_reason, old.suspend_note)
     and app_actor() is not null and app_actor() <> 'system' then
    if app_actor() <> 'account' or app_role() is distinct from 'owner' then
      raise exception 'only an owner locks or unlocks a sign-in'
        using errcode = 'insufficient_privilege';
    end if;
    if new.account_id = app_account() then
      raise exception 'nobody locks or unlocks their own sign-in'
        using errcode = 'insufficient_privilege';
    end if;
    if new.role = 'owner' and suspension_in_effect(new.suspended_at, new.suspended_until) then
      raise exception 'an owner does not lock another owner'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  if new.role = 'owner' and old.role is distinct from 'owner'
     and suspension_in_effect(new.suspended_at, new.suspended_until)
     and app_actor() is not null and app_actor() <> 'system' then
    raise exception 'somebody whose sign-in is locked or paused is not made an owner'
      using errcode = 'check_violation';
  end if;
  if new.role = 'owner' and old.role is distinct from 'owner'
     and new.suspended_at is not null
     and not suspension_in_effect(new.suspended_at, new.suspended_until) then
    new.suspended_at := null;
    new.suspended_by := null;
    new.suspended_until := null;
    new.suspend_reason := null;
    new.suspend_note := null;
  end if;
  return new;
end $$;

create trigger account_household_suspension before update on account_household
  for each row execute function account_household_suspension();

-- ------------------------------------------- what a locked sharer lends
--
-- 0037's document for a link (as 0030 made it), with one more check: its
-- maker's sign-in not suspended. This migration owns app_shared_document()
-- from here; the rest is as it was. ShareService.live() (shares.ts) asks
-- the same; change them together.
create or replace function app_shared_document() returns uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.document_id
       from share_link s
       join document d on d.id = s.document_id
       join account_household maker
         on maker.account_id = s.created_by and maker.household_id = s.household_id
      where s.id = app_share()
        and s.household_id = app_household()
        and s.revoked_at is null
        and s.paused_at is null
        and s.expires_at > now()
        and s.attempts < 10
        and d.deleted_at is null
        and not suspension_in_effect(maker.suspended_at, maker.suspended_until)
        and case d.visibility
              when 'household' then true
              when 'adults' then maker.role in ('owner', 'adult')
              when 'private' then d.owner_member_id = maker.member_id
              else false
            end $$;

-- 0042's live link, with the same check for a collection's: its sharer's
-- sign-in not suspended (a document's asks app_shared_document(), above).
-- This migration owns app_live_share() from here; the rest is as it was.
-- Everything a link reaches asks it — its documents, their files, its
-- collection, its sharer — so a locked sharer's link reaches nothing.
create or replace function app_live_share() returns uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.id
       from share_link s
      where s.id = app_share()
        and s.household_id = app_household()
        and case
              when s.document_id is not null then app_shared_document() is not null
              when s.collection_id is not null then exists (
                select 1
                  from doc_collection c
                  join account_household maker
                    on maker.account_id = s.created_by and maker.household_id = s.household_id
                 where c.id = s.collection_id
                   and c.household_id = s.household_id
                   and s.revoked_at is null
                   and s.paused_at is null
                   and s.expires_at > now()
                   and s.attempts < 10
                   and c.deleted_at is null
                   and c.audience in ('everyone', 'teens', 'adults')
                   and maker.role in ('owner', 'adult')
                   and not suspension_in_effect(maker.suspended_at, maker.suspended_until)
                   and (collection_audience_has(maker.role, c.audience)
                        or coalesce(c.owner_member_id = maker.member_id, false)))
              else false
            end $$;

-- --------------------------------------- what a locked requester asks
--
-- 0044's live request, with one more check: its requester's sign-in not
-- suspended. A locked requester's link opens nothing — the sender is told
-- the link is not valid, as for any request that has stopped — and it opens
-- again once they are unlocked. This migration owns app_live_upload_request()
-- from here; the rest is as it was. UploadRequestService.live()
-- (requests.ts) leaves this to the database, as an upload link reads
-- nothing of who signs in (A74).
create or replace function app_live_upload_request() returns uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select r.id
       from upload_request r
       join account_household asker
         on asker.account_id = r.created_by
        and asker.household_id = r.household_id
        and asker.member_id = r.requester_member_id
      where r.id = app_upload_request()
        and r.household_id = app_household()
        and r.revoked_at is null
        and r.closed_at is null
        and r.paused_at is null
        and r.expires_at > now()
        and r.attempts < 10
        and asker.role in ('owner', 'adult')
        and not suspension_in_effect(asker.suspended_at, asker.suspended_until) $$;

-- A lock that ends their links for good ends their requests too (A51): each
-- still live — not closed, not run out, not locked by ten wrong tries; one
-- that has ended already is left as it is — is taken back by the owner
-- locking them, its address cleared
-- (upload_request_forgets_address, 0044), and its sessions and codes ended.
-- With the owner's rights, as upload_requests_close_lost() asks: a
-- review-by-me request is its requester's alone, so the owner may not see
-- it. Only for an owner signed in, and only for somebody locked in their
-- household this moment — the lock is written first, in the same
-- transaction. Returns the ids it took back, for the log.
create function upload_requests_end_for_lock(p_account uuid) returns setof uuid
  language sql volatile security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ with ended as (
       update upload_request r
          set revoked_at = now(), revoked_by = app_account()
        where r.household_id = app_household()
          and r.created_by = p_account
          and r.revoked_at is null
          and r.closed_at is null
          and r.expires_at > now()
          and r.attempts < 10
          and app_actor() = 'account'
          and app_role() = 'owner'
          and exists (select 1 from account_household a
                       where a.account_id = p_account
                         and a.household_id = r.household_id
                         and a.suspend_reason = 'locked'
                         and suspension_in_effect(a.suspended_at, a.suspended_until))
       returning r.id),
     -- A session in use this moment is passed over, never waited on, as
     -- upload_requests_close_lost() does: its request finds the request
     -- ended as it finishes.
     sessions as (delete from upload_session
                   where id in (select s.id from upload_session s
                                 where s.request_id in (select id from ended)
                                 for update skip locked)),
     codes as (delete from upload_code where request_id in (select id from ended))
     select id from ended $$;
grant execute on function upload_requests_end_for_lock(uuid) to fdv_app;
