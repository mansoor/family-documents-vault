-- A password reset the owner starts (iteration 5.29, D5, A48–A50).
--
-- 0018 left an owner out of resets on purpose: an owner who could set
-- another adult's password could sign in as them and read what is theirs
-- alone. That stays true. What changes is that an owner may now *start* a
-- reset for somebody who is not an owner, and it goes one of three ways:
--
--   1. whoever runs the server has given it a mail server (FDV_SMTP_URL):
--      the link goes to the person's own sign-in address, by that server
--      alone, as their own "forgotten password" would (passwords.ts). No
--      owner sees it;
--   2. there is none, and the person keeps nothing private — nothing under
--      their member key, and nothing only they can see
--      (member_holds_private(), below): the owner is shown a one-time link
--      to hand over, an hour long (`handover`). It stops working if they
--      gain something private before it is spent: asked again as it is;
--   3. anybody else: no owner's way at all. Whoever runs the server runs
--      `cli reset-password`, as before.
--
-- No owner ever holds a working credential for somebody with anything
-- private, waiting or not.
--
-- password_reset (0018) gains:
--
--   issued_by          `owner`, beside `self` and `operator`;
--   household_id       the household whose owner made it (an owner's only);
--   issued_by_account  that owner (null once their account is gone);
--   handover           made to be handed over (2.), not mailed (1.);
--   told_at            when the person saw that an owner made one for them:
--                      they are told at their next sign-in until they have.
--
-- And account gains handover_spent_at: when a link an owner was handed for
-- this sign-in was last spent. Whoever spent it chose the password, and could
-- add a passkey or two-step sign-in, or make a share link, as the person; so
-- every password change after it takes away each passkey and two-step
-- sign-in added since that moment and ends each share link made since, and
-- every reset does the same — but two-step sign-in turned on after a change
-- of the password, which account.password_changed_at records, a reset leaves
-- (passwords.ts). The person is told which there are.

alter table password_reset drop constraint password_reset_issued_by_check;
alter table password_reset
  add constraint password_reset_issued_by_check
    check (issued_by in ('self', 'operator', 'owner')),
  add column household_id      uuid references household(id) on delete cascade,
  add column issued_by_account uuid references account(id) on delete set null,
  add column handover          boolean not null default false,
  add column told_at           timestamptz,
  -- An owner's reset is their household's; nobody else's is any household's.
  add constraint password_reset_owner_household
    check ((issued_by = 'owner') = (household_id is not null)),
  -- Only an owner's is handed over, and only one handed over is told of.
  add constraint password_reset_handover_owner check (not handover or issued_by = 'owner'),
  add constraint password_reset_told_handover check (told_at is null or handover);

alter table account
  add column handover_spent_at   timestamptz,
  add column password_changed_at timestamptz;

-- Reset links belong to no household (0018), and every caller but a link
-- read them (0042, 0044). Somebody signed in now reaches their own, and an
-- owner those of the people of their household — to make one, and to use
-- them up with a lock (5.28) — and no other. The callers that sign nobody
-- in (a sign-in page, the command line, the vault itself) are as they were.
create policy password_reset_account on password_reset as restrictive
  using (case app_actor()
           when 'account' then account_id = app_account()
                               or (app_role() = 'owner'
                                   and exists (select 1 from account_household a
                                                where a.account_id = password_reset.account_id
                                                  and a.household_id = app_household()))
           else true
         end);

-- And an owner's reset is their household's: a caller in another household,
-- whoever it is, reads none of them. A caller that names no household — a
-- signed-out page before it knows whose a link is, the command line — reads
-- them as it reads every reset (0018).
create policy password_reset_household on password_reset as restrictive
  using (household_id is null or app_household() is null or household_id = app_household());

-- ------------------------------------------------------ the session asking
--
-- Which session a signed-in caller asks from: set with the rest of the
-- caller's settings (withPrincipal), empty when it is not known.
create function app_session() returns uuid
  language sql stable parallel safe
  set search_path = pg_catalog, public, pg_temp as
  $$ select nullif(current_setting('app.session_id', true), '')::uuid $$;

-- ---------------------------------------------------- nothing private
--
-- Whether somebody keeps anything private: anything under their member key,
-- or that only they can see. The one place this is asked, by an owner
-- starting a reset (path 2 or 3) and again as a hand-over link is spent.
-- With the owner's rights, because it counts what the owner may not see —
-- and so it answers only yes or no, never what it found:
--
--   an Only me document of theirs, in the Trash too, and with it its sealed
--     notes and details (0033 keeps those on Only me documents alone);
--   one removed for good, whose title their activity log still names (0045);
--   an Only me identity part, whatever it holds — a label is theirs alone
--     too — under their key (0050);
--   a request to send documents that they alone review, in any state — its
--     title, message and who it went to stay theirs alone (A43) until the
--     worker removes it — and any file sent through one that is still kept,
--     under their key, while it is still theirs to review: one moved to the
--     owners (0047) is theirs no more (0044, 0047);
--   an export that has not run out, under their key (0008);
--   an Only me collection, deleted too: its name stays in their activity
--     log alone (0036, 0039).
--
-- Asked only by an owner signed in, of somebody in their household, or by
-- the reset being spent for that very account (a signed-out page, which says
-- whose it is); anybody else is refused, never told "nothing". Somebody of
-- no household of the asker's is refused too.
create function member_holds_private(p_account uuid) returns boolean
  language plpgsql stable security definer
  set search_path = pg_catalog, public, pg_temp as $$
declare
  hh uuid := app_household();
  m uuid;
begin
  -- Unset is no answer: a caller who says nothing is refused (coalesce).
  if not coalesce((app_actor() = 'account' and app_role() = 'owner')
                  or (app_actor() = 'anonymous' and app_account() = p_account), false) then
    raise exception 'only an owner, or the reset itself, asks what somebody keeps private'
      using errcode = 'insufficient_privilege';
  end if;
  select a.member_id into m
    from account_household a
   where a.account_id = p_account and a.household_id = hh;
  if m is null then
    raise exception 'nobody of this household'
      using errcode = 'insufficient_privilege';
  end if;
  return exists (select 1 from document d
                  where d.household_id = hh and d.owner_member_id = m
                    and d.visibility = 'private')
      or exists (select 1 from document_tombstone t
                  where t.household_id = hh and t.owner_member_id = m
                    and t.visibility = 'private')
      or exists (select 1 from member_identity i
                  where i.household_id = hh and i.member_id = m
                    and i.part = 'only_me')
      or exists (select 1 from upload_request r
                  where r.household_id = hh and r.requester_member_id = m
                    and r.review_by = 'me')
      or exists (select 1 from incoming_file f
                  where f.household_id = hh and f.requester_member_id = m
                    and f.scope = 'member' and f.review_by = 'me')
      or exists (select 1 from export e
                  where e.requested_by = p_account and e.state <> 'failed'
                    and (e.expires_at is null or e.expires_at > now()))
      or exists (select 1 from doc_collection c
                  where c.household_id = hh and c.owner_member_id = m
                    and c.audience = 'only_me');
end $$;
grant execute on function member_holds_private(uuid) to fdv_app;

-- Every reset now ends the person's exports, whoever started it: their own,
-- an owner's, the command line's. A reset is spent by a signed-out page,
-- which reads no export (0030); so this does it with the owner's rights, for
-- that page alone, and only for the account whose reset this very
-- transaction spent. How many it ended, for the log.
create function password_reset_expire_exports(p_account uuid) returns integer
  language plpgsql volatile security definer
  set search_path = pg_catalog, public, pg_temp as $$
declare
  n integer;
begin
  if not coalesce(app_actor() = 'anonymous' and app_account() = p_account
                  and exists (select 1 from password_reset r
                               where r.account_id = p_account and r.used_at = now()), false) then
    raise exception 'only a reset spent now ends these exports'
      using errcode = 'insufficient_privilege';
  end if;
  update export set expires_at = now()
   where requested_by = p_account
     and (expires_at is null or expires_at > now());
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function password_reset_expire_exports(uuid) to fdv_app;

-- The share links made as somebody since a link an owner was handed for
-- their sign-in was spent, ended (5.29): whoever spent it could make a link
-- as them, and a link lives while its maker can see what it is to — Only me
-- documents they make later included. Ended by every change of the password
-- and every reset, each one still live (one run out, or locked by ten wrong
-- tries, is left as it ended), its address cleared and its open sessions
-- ended. With the owner's rights, as a reset is spent by a signed-out page,
-- which reads no link (0030): only by the account itself signed in, or by
-- the reset of that account this very transaction spent. Returns what it
-- ended, for the log.
create function handover_links_end(p_account uuid)
  returns table (id uuid, document_id uuid, collection_id uuid, permission text)
  language plpgsql volatile security definer
  set search_path = pg_catalog, public, pg_temp as $$
declare
  since timestamptz;
begin
  if not coalesce((app_actor() = 'account' and app_account() = p_account)
                  or (app_actor() = 'anonymous' and app_account() = p_account
                      and exists (select 1 from password_reset r
                                   where r.account_id = p_account and r.used_at = now())),
                  false) then
    raise exception 'only the account itself, or its reset spent now, ends these links'
      using errcode = 'insufficient_privilege';
  end if;
  select a.handover_spent_at into since from account a where a.id = p_account;
  if since is null then
    return;
  end if;
  return query
    with ended as (
      update share_link s
         set revoked_at = now(), revoked_by = p_account, code_email = null
       where s.created_by = p_account
         and s.household_id = app_household()
         and s.created_at > since
         and s.revoked_at is null
         and s.expires_at > now()
         and s.attempts < 10
      returning s.id, s.document_id, s.collection_id, s.permission::text),
    sessions as (
      delete from share_session
       where share_session.id in (select x.id from share_session x
                                   where x.share_id in (select e.id from ended e)
                                   for update skip locked))
    select e.id, e.document_id, e.collection_id, e.permission from ended e;
end $$;
grant execute on function handover_links_end(uuid) to fdv_app;

-- ------------------------------------------------ gaining something private
--
-- A hand-over link is checked as it is spent, holding the person's
-- membership (FOR NO KEY UPDATE, the first lock a reset takes). Whatever
-- makes somebody keep something private — each kind above but a removal,
-- which follows a document already counted — holds the same membership FOR
-- SHARE as it is written, so the two wait for each other: the reset sees
-- what was made before it, and what is made after it waits for the reset.
-- What waited, made by a session the reset ended meanwhile (it ends them
-- all), is refused: a request that began before a reset gains nothing for
-- whoever holds its link. A lock (5.28) ends sessions the same way. The
-- refusal is SQLSTATE FDV01, the vault's own, with why the session ended as
-- its detail: the API answers it, and nothing else, as the session's end.
--
-- One function, by table; each trigger fires on what can make a row
-- private. With the owner's rights: a sender's upload reads no membership.
create function member_private_gained() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
declare
  who uuid;
  acct uuid;
  ended text;
begin
  if tg_table_name = 'document' then
    if new.visibility = 'private' and new.owner_member_id is not null
       and (tg_op = 'INSERT' or old.visibility is distinct from 'private'
            or old.owner_member_id is distinct from new.owner_member_id) then
      who := new.owner_member_id;
    end if;
  elsif tg_table_name = 'doc_collection' then
    if new.audience = 'only_me' and new.owner_member_id is not null and new.deleted_at is null
       and (tg_op = 'INSERT' or old.audience is distinct from 'only_me'
            or old.owner_member_id is distinct from new.owner_member_id) then
      who := new.owner_member_id;
    end if;
  elsif tg_table_name = 'member_identity' then
    if new.part = 'only_me'
       and (tg_op = 'INSERT' or old.part is distinct from 'only_me'
            or old.member_id is distinct from new.member_id) then
      who := new.member_id;
    end if;
  elsif tg_table_name = 'upload_request' then
    if new.review_by = 'me'
       and (tg_op = 'INSERT' or old.review_by is distinct from 'me'
            or old.requester_member_id is distinct from new.requester_member_id) then
      who := new.requester_member_id;
    end if;
  elsif tg_table_name = 'incoming_file' then
    if new.scope = 'member'
       and (tg_op = 'INSERT' or old.scope is distinct from 'member'
            or old.requester_member_id is distinct from new.requester_member_id) then
      who := new.requester_member_id;
    end if;
  elsif tg_table_name = 'export' then
    if tg_op = 'INSERT' then
      acct := new.requested_by;
    end if;
  end if;
  if who is null and acct is null then
    return new;
  end if;
  if who is not null then
    perform 1 from account_household a
     where a.member_id = who and a.household_id = new.household_id
       for share;
  else
    perform 1 from account_household a
     where a.account_id = acct and a.household_id = new.household_id
       for share;
  end if;
  -- The session asking, ended since it was let in (a reset ends them all;
  -- a lock, sign-out everywhere): it gains nothing private now.
  if app_actor() = 'account' then
    select coalesce(s.revoked_reason, '') into ended
      from session s
     where s.id = app_session() and s.revoked_at is not null;
    if found then
      raise exception 'this sign-in has ended'
        using errcode = 'FDV01', detail = ended;
    end if;
  end if;
  return new;
end $$;

create trigger document_private_gained
  before insert or update of visibility, owner_member_id on document
  for each row execute function member_private_gained();
create trigger doc_collection_private_gained
  before insert or update of audience, owner_member_id on doc_collection
  for each row execute function member_private_gained();
create trigger member_identity_private_gained
  before insert or update of part, member_id on member_identity
  for each row execute function member_private_gained();
create trigger upload_request_private_gained
  before insert or update of review_by, requester_member_id on upload_request
  for each row execute function member_private_gained();
create trigger incoming_file_private_gained
  before insert or update of scope, requester_member_id on incoming_file
  for each row execute function member_private_gained();
create trigger export_private_gained
  before insert on export
  for each row execute function member_private_gained();
