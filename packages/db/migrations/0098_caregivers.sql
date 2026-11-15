-- Turning 18, and a caregiver for somebody's medical papers (0.9.0, H1b of
-- the health plan; the owner's decisions of 14 Nov 2026).
--
-- A caregiver
-- -----------
-- A person names somebody of the family to see their medical papers ("Let
-- Ahmed see my medical papers"); an owner may name one for somebody with no
-- sign-in. The caregiver then reads that person's Medical papers, their Only
-- me ones included, and nothing else of theirs. It is a new, narrow
-- exception to who can see a document, and it is the only one:
--
--   whose        documents about the person (`owner_member_id`);
--   which        those whose own category is Medical (never their kind's,
--                so changing a kind widens no grant), never a note;
--   which more   only those the caregiver could not see already: the
--                person's Only me ones. Everyone's and Adults only ones a
--                caregiver (an owner or an adult) sees anyway;
--   by whom      the caregiver signed in as an owner or an adult — never a
--                teen, a viewer or a guest, nor the vault on their behalf,
--                nor a link;
--   while        the grant is live (not revoked: a revoke takes effect with
--                the next statement), the household's protection mode is
--                'standard' (below), and the person has said so themselves
--                (`person_confirmed_at`): a grant they made, or one an owner
--                named for them that they kept once they could sign in;
--   how          read-only. Nothing of the document is written through the
--                grant — its row, its versions and words, its links to
--                other papers, its reminders, a link outside the family or a
--                collection's place for it (a rule or a trigger on each).
--
-- `caregiver_reads()` is the rule, written once; the API's every reading of
-- a document asks it beside the visibility rule it has always had. The
-- write rules below ask it too, and refuse.
--
-- Protection mode. Under 'standard', the only mode the vault has, every
-- member's scope key is wrapped by the master key (0004), so the vault opens
-- an Only me file for whoever may read it; nothing is rewrapped or copied for
-- a grant. Under 'private' (reserved: `features.private_mode`), the vault
-- could not open a member's key without their credential: there the grant
-- gives no Only me paper at all (it fails closed) rather than keep a copy of
-- the key. It never weakens the mode.
--
-- An owner-named grant. An owner may name a caregiver for somebody with no
-- sign-in, but that alone opens nothing more than the caregiver already sees
-- (such a person has no Only me papers of their own making). Should the
-- person have Only me papers — a sign-in taken away left them so, or they
-- sign in later and make some — an owner's grant does not reach them until
-- the person, signed in, keeps it: otherwise an owner could take a sign-in
-- away and name themselves to read what was kept from them.
--
-- Every grant, revoke and give-up goes in the activity log (the API); every
-- look a caregiver takes at a paper the grant gave them goes in
-- caregiver_view, which the person reads.
--
-- Turning 18
-- ----------
-- grown_up_question is the one question somebody is asked as they turn 18,
-- when they have Medical papers the family can see: keep them visible to the
-- family, or make them Only me. Made by the vault (the worker's daily
-- reminders.tick), answered once — by the person, or by an owner on behalf
-- of somebody who cannot answer themselves, who may only keep — and final.
-- For somebody with no sign-in the owners are reminded to ask them in person:
-- a reminder about a person, as turning 13 is (0066), kind 'turned_18'.
--
-- A migration is nobody's edit: no audit event is written.

-- ---------------------------------------------------------- the grants

create table caregiver_grant (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references household(id) on delete cascade,
  -- Whose medical papers.
  person_member_id    uuid not null,
  -- Who may read them.
  caregiver_member_id uuid not null,
  granted_by          uuid references account(id) on delete set null,
  granted_at          timestamptz not null default now(),
  -- The person's own say: as they granted it, or as they kept one an owner
  -- named for them. Until then the grant reaches none of their Only me papers.
  person_confirmed_at timestamptz,
  revoked_at          timestamptz,
  -- Who ended it: the person, an owner, the caregiver giving it up, or null
  -- for the vault (the caregiver's role or sign-in gone).
  revoked_by          uuid references account(id) on delete set null,
  constraint caregiver_grant_not_self check (person_member_id <> caregiver_member_id),
  constraint caregiver_grant_revoker check (revoked_at is not null or revoked_by is null),
  foreign key (person_member_id, household_id) references member (id, household_id) on delete cascade,
  foreign key (caregiver_member_id, household_id) references member (id, household_id) on delete cascade
);

-- One live grant a person and caregiver; the history stays.
create unique index caregiver_grant_live
  on caregiver_grant (household_id, person_member_id, caregiver_member_id)
  where revoked_at is null;
create index caregiver_grant_caregiver_idx
  on caregiver_grant (household_id, caregiver_member_id)
  where revoked_at is null;

alter table caregiver_grant enable row level security;

create policy caregiver_grant_tenant on caregiver_grant
  using (household_id = app_household()) with check (household_id = app_household());

-- Who is given a grant: the person, the caregiver, the owners, and the
-- vault. Nobody else signed in, and no other kind of caller.
create policy caregiver_grant_actor on caregiver_grant as restrictive
  using (case app_actor()
           when 'account' then person_member_id = app_member()
                               or caregiver_member_id = app_member()
                               or app_role() = 'owner'
           when 'system' then true
           else false
         end);

-- Whether somebody of the household signs in with a role that may answer
-- for their own papers (an owner, an adult or a teen), with the owner's
-- rights: the rules below ask it of somebody the caller may not be.
create function member_answers_for_self(p_member uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select exists (select 1 from account_household ah
                     where ah.member_id = p_member
                       and ah.household_id = app_household()
                       and ah.role in ('owner', 'adult', 'teen')) $$;
revoke execute on function member_answers_for_self(uuid) from public;
grant execute on function member_answers_for_self(uuid) to fdv_app;

-- Whether somebody may be a caregiver now: signed in here as an owner or an
-- adult, and not locked or paused (0051).
create function member_may_give_care(p_member uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select exists (select 1 from account_household ah
                     where ah.member_id = p_member
                       and ah.household_id = app_household()
                       and ah.role in ('owner', 'adult')
                       and not suspension_in_effect(ah.suspended_at, ah.suspended_until)) $$;
revoke execute on function member_may_give_care(uuid) from public;
grant execute on function member_may_give_care(uuid) to fdv_app;

-- Made by the person themselves (an owner, an adult or a teen), confirmed as
-- it is made; or by an owner for somebody who cannot answer for themselves,
-- unconfirmed. The caregiver is somebody who may be one. By the vault: as
-- it is written.
create policy caregiver_grant_insert on caregiver_grant as restrictive for insert
  with check (case app_actor()
                when 'account' then
                  revoked_at is null
                  and granted_by = app_account()
                  and member_may_give_care(caregiver_member_id)
                  and ((person_member_id = app_member()
                        and app_role() in ('owner', 'adult', 'teen')
                        and person_confirmed_at is not null)
                       or (app_role() = 'owner'
                           and person_member_id <> app_member()
                           and not member_answers_for_self(person_member_id)
                           and person_confirmed_at is null))
                when 'system' then true
                else false
              end);

-- Changed (kept, revoked, given up) by the person; by the caregiver; by an
-- owner while the person cannot answer for themselves. What may change, and
-- by whom, the trigger below says.
create policy caregiver_grant_update on caregiver_grant as restrictive for update
  using (case app_actor()
           when 'account' then person_member_id = app_member()
                               or caregiver_member_id = app_member()
                               or (app_role() = 'owner'
                                   and not member_answers_for_self(person_member_id))
           when 'system' then true
           else false
         end);

-- History: never removed by anybody signed in.
create policy caregiver_grant_delete on caregiver_grant as restrictive for delete
  using (case app_actor() when 'system' then true else false end);

-- A grant's who and when never change; it is kept by its person alone; it
-- is revoked once, and a revoked grant is history. The caregiver may only
-- give it up.
create function caregiver_grant_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  -- A sign-in's account going (on delete set null, a foreign key's own
  -- cascade) clears who named or revoked it, and is the one change to a
  -- grant's who, or to a revoked grant, there is.
  if pg_trigger_depth() > 1
     and (new.granted_by is null or new.granted_by = old.granted_by)
     and (new.revoked_by is null or new.revoked_by = old.revoked_by)
     and (new.id, new.household_id, new.person_member_id, new.caregiver_member_id,
          new.granted_at, new.person_confirmed_at, new.revoked_at)
         is not distinct from
         (old.id, old.household_id, old.person_member_id, old.caregiver_member_id,
          old.granted_at, old.person_confirmed_at, old.revoked_at)
     and (new.granted_by is distinct from old.granted_by
          or new.revoked_by is distinct from old.revoked_by) then
    return new;
  end if;
  if (new.id, new.household_id, new.person_member_id, new.caregiver_member_id,
      new.granted_by, new.granted_at)
     is distinct from
     (old.id, old.household_id, old.person_member_id, old.caregiver_member_id,
      old.granted_by, old.granted_at) then
    raise exception 'a caregiver grant names its person and caregiver once'
      using errcode = 'insufficient_privilege';
  end if;
  -- Revoked: history, every column of it.
  if old.revoked_at is not null then
    if to_jsonb(new) is distinct from to_jsonb(old) then
      raise exception 'a revoked caregiver grant is history'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  -- The vault's, and a sign-in's role or removal ending it (below).
  if app_actor() is distinct from 'account' or pg_trigger_depth() > 1 then
    return new;
  end if;
  -- Kept: by the person alone, and never taken back but by a revoke.
  if new.person_confirmed_at is distinct from old.person_confirmed_at
     and (new.person_member_id is distinct from app_member()
          or new.person_confirmed_at is null) then
    raise exception 'only its person keeps a caregiver grant'
      using errcode = 'insufficient_privilege';
  end if;
  -- Revoked, or given up, as whoever does it: never in somebody else's name.
  if new.revoked_at is not null and new.revoked_by is distinct from app_account() then
    raise exception 'a caregiver grant is revoked in the name of whoever revokes it'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger caregiver_grant_rule before update on caregiver_grant
  for each row execute function caregiver_grant_rule();

-- A caregiver whose role moves outside an owner's or an adult's, or whose
-- sign-in is taken away, is no longer one: their grants end, by the vault.
-- (caregiver_reads() asks the caller's role as well, so nothing waits on
-- this; it keeps the list true, and a sign-in given back gives nothing back.)
create function account_household_ends_care() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  update caregiver_grant g
     set revoked_at = now(), revoked_by = null
   where g.caregiver_member_id = old.member_id
     and g.household_id = old.household_id
     and g.revoked_at is null
     and (tg_op = 'DELETE'
          or new.member_id is distinct from old.member_id
          or new.role not in ('owner', 'adult'));
  return null;
end $$;

create trigger account_household_ends_care
  after update of role, member_id or delete on account_household
  for each row execute function account_household_ends_care();

grant select, insert, update, delete on caregiver_grant to fdv_app;

-- ------------------------------------------------------------- the rule

-- Whether the caller, signed in, reads a document about `p_owner`, of kind
-- `p_type` and its own category `p_category`, as that person's caregiver:
-- the exception above, and only it. False for the person themselves (the
-- visibility rule gives them their own), for anybody but an owner or an
-- adult signed in, for anything not Medical, for a note, outside 'standard'
-- protection, and without a live grant the person has kept. With the
-- owner's rights: document's rules read nothing of caregiver_grant's, and a
-- caregiver reads their grant only as a caregiver.
create function caregiver_reads(p_owner uuid, p_type text, p_category text) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce(
       app_actor() = 'account'
       and app_role() in ('owner', 'adult')
       and p_owner is not null
       and p_owner <> app_member()
       and p_type is distinct from 'note'
       -- The paper's own category alone: a kind's is never asked, so changing
       -- a kind can widen nobody's grant (every paper with a kind has its
       -- kind's category written on it as it is filed; the backfill below
       -- writes it on any older one that has none).
       and p_category = 'medical'
       and exists (select 1 from household h
                    where h.id = app_household() and h.protection_mode = 'standard')
       and exists (select 1 from caregiver_grant g
                    where g.household_id = app_household()
                      and g.person_member_id = p_owner
                      and g.caregiver_member_id = app_member()
                      and g.revoked_at is null
                      and g.person_confirmed_at is not null),
       false) $$;
revoke execute on function caregiver_reads(uuid, text, text) from public;
grant execute on function caregiver_reads(uuid, text, text) to fdv_app;

-- The same, of a document by its id: whether the caller reads it only as a
-- caregiver — an Only me document of somebody else's, given by a grant.
create function caregiver_only_document(p_document uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce((select d.visibility = 'private'
                             and caregiver_reads(d.owner_member_id, d.type_key, d.category)
                        from document d
                       where d.id = p_document and d.household_id = app_household()), false) $$;
revoke execute on function caregiver_only_document(uuid) from public;
grant execute on function caregiver_only_document(uuid) to fdv_app;

-- --------------------------------------------- read-only, in the database

-- Nothing is written through a grant: a document a caller reads only as a
-- caregiver is not changed, removed, given a new version, linked, reminded
-- of, put in a collection or sent outside the family by them. (The API
-- refuses each first; these hold whatever it forgets.)
--
-- The document's own row by a trigger, not a rule for updates: a rule for
-- updates is asked of every row a reader holds (FOR KEY SHARE, as a page
-- view or a download holds its document for the log), and a caregiver's
-- look must still be held and written down.
create function document_not_by_caregiver() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  -- A foreign key's own cascade (a person removed) is not a caregiver's write.
  if app_actor() = 'account'
     and pg_trigger_depth() = 1
     and old.visibility = 'private'
     and caregiver_reads(old.owner_member_id, old.type_key, old.category) then
    raise exception 'a caregiver reads their person''s papers, and changes none of them'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create trigger document_not_by_caregiver before update or delete on document
  for each row execute function document_not_by_caregiver();

-- Each rule below asks only of somebody signed in (a grant is theirs alone):
-- the vault, a link and an upload are passed as they were. A rule for
-- updates is asked of a row held FOR UPDATE or FOR SHARE too, and no reader
-- holds a row of these: a page view's queueing of its preview writes
-- nothing for a caregiver, and its job, the vault's, draws the pages.
create function not_by_caregiver(p_document uuid) returns boolean
  language sql stable parallel safe
  set search_path = pg_catalog, public, pg_temp as
  $$ select case app_actor()
              when 'account' then p_document is null or not caregiver_only_document(p_document)
              else true
            end $$;
revoke execute on function not_by_caregiver(uuid) from public;
grant execute on function not_by_caregiver(uuid) to fdv_app;

-- A version: added, changed (its file key, its details) or removed.
create policy document_version_not_by_caregiver_insert on document_version as restrictive for insert
  with check (not_by_caregiver(document_id));
create policy document_version_not_by_caregiver_update on document_version as restrictive for update
  using (not_by_caregiver(document_id));
create policy document_version_not_by_caregiver_delete on document_version as restrictive for delete
  using (not_by_caregiver(document_id));

-- Its words, plain or sealed.
create policy document_text_not_by_caregiver_write on document_text as restrictive for update
  using (not_by_caregiver(document_id));
create policy document_text_sealed_not_by_caregiver_write on document_text_sealed
  as restrictive for update
  using (not_by_caregiver(document_id));

-- A link between two papers: made or taken away.
create policy document_link_not_by_caregiver_insert on document_link as restrictive for insert
  with check (not_by_caregiver(a) and not_by_caregiver(b));
create policy document_link_not_by_caregiver_delete on document_link as restrictive for delete
  using (not_by_caregiver(a) and not_by_caregiver(b));

-- A reminder of it: set, changed (snoozed, done) or removed.
create policy reminder_not_by_caregiver_insert on reminder as restrictive for insert
  with check (not_by_caregiver(document_id));
create policy reminder_not_by_caregiver_update on reminder as restrictive for update
  using (not_by_caregiver(document_id));
create policy reminder_not_by_caregiver_delete on reminder as restrictive for delete
  using (not_by_caregiver(document_id));

-- Its place in a collection: put in or taken out.
create policy doc_collection_item_not_by_caregiver_insert on doc_collection_item
  as restrictive for insert
  with check (not_by_caregiver(document_id));
create policy doc_collection_item_not_by_caregiver_delete on doc_collection_item
  as restrictive for delete
  using (not_by_caregiver(document_id));

-- A link outside the family: made, or changed (taken back, paused, renewed).
create policy share_link_not_by_caregiver_insert on share_link as restrictive for insert
  with check (not_by_caregiver(document_id));
create policy share_link_not_by_caregiver_update on share_link as restrictive for update
  using (not_by_caregiver(document_id));

-- --------------------------------------------------------- their looks

create table caregiver_view (
  id                  bigint generated always as identity primary key,
  household_id        uuid not null references household(id) on delete cascade,
  grant_id            uuid not null references caregiver_grant(id) on delete cascade,
  person_member_id    uuid not null,
  caregiver_member_id uuid not null,
  -- Removed for good, the paper takes its looks with it, as every row that
  -- names a document goes with it (5.24).
  document_id         uuid not null references document(id) on delete cascade,
  action              text not null
                        constraint caregiver_view_action
                        check (action in ('opened', 'downloaded', 'previewed')),
  at                  timestamptz not null default now(),
  foreign key (person_member_id, household_id) references member (id, household_id) on delete cascade
);
create index caregiver_view_person_idx on caregiver_view (household_id, person_member_id, at desc);

alter table caregiver_view enable row level security;

create policy caregiver_view_tenant on caregiver_view
  using (household_id = app_household()) with check (household_id = app_household());

-- The person whose papers were looked at, the owners (the owner's decision
-- of 14 Nov 2026: who looked, never which Only me paper — the API names
-- none of them to an owner), and the vault: nobody else, another adult, a
-- teen and the caregiver included.
create policy caregiver_view_actor on caregiver_view as restrictive
  using (case app_actor()
           when 'account' then person_member_id = app_member() or app_role() = 'owner'
           when 'system' then true
           else false
         end);

-- Written only by record_caregiver_view() below, which runs with the
-- owner's rights, and removed with its paper, its grant or its person:
-- nobody signed in writes, changes or removes a look, the person included.
create policy caregiver_view_insert on caregiver_view as restrictive for insert
  with check (case app_actor() when 'system' then true else false end);
create policy caregiver_view_update on caregiver_view as restrictive for update
  using (case app_actor() when 'system' then true else false end);
create policy caregiver_view_delete on caregiver_view as restrictive for delete
  using (case app_actor() when 'system' then true else false end);

grant select, insert, update, delete on caregiver_view to fdv_app;

-- A caregiver's look at a paper a grant gave them: written for the caller,
-- signed in, only while they read that document only as its person's
-- caregiver; nothing for anybody else, nor for anything else. Once a
-- sitting: the same look at the same paper within ten minutes (a preview's
-- every page, a thumbnail drawn again) is the one already written, as the
-- activity log keeps a sitting with a document to one line. Returns whether
-- one was written.
create function record_caregiver_view(p_document uuid, p_action text) returns boolean
  language sql volatile security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ with written as (
       insert into caregiver_view
         (household_id, grant_id, person_member_id, caregiver_member_id, document_id, action)
       select d.household_id, g.id, g.person_member_id, g.caregiver_member_id, d.id, p_action
         from document d
         join caregiver_grant g
           on g.household_id = d.household_id
          and g.person_member_id = d.owner_member_id
          and g.caregiver_member_id = app_member()
          and g.revoked_at is null
          and g.person_confirmed_at is not null
        where d.id = p_document
          and d.household_id = app_household()
          and d.visibility = 'private'
          and caregiver_reads(d.owner_member_id, d.type_key, d.category)
          and not exists (select 1 from caregiver_view v
                           where v.grant_id = g.id
                             and v.document_id = d.id
                             and v.action = p_action
                             and v.at > now() - interval '10 minutes')
        limit 1
       returning 1)
     select exists (select 1 from written) $$;
revoke execute on function record_caregiver_view(uuid, text) from public;
grant execute on function record_caregiver_view(uuid, text) to fdv_app;

-- ------------------------------------------------------------ turning 18

-- Whether somebody signs in here as an owner or an adult: who answers the
-- question themselves. With the owner's rights, as the rules above.
create function member_signs_in_grown_up(p_member uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select exists (select 1 from account_household ah
                     where ah.member_id = p_member
                       and ah.household_id = app_household()
                       and ah.role in ('owner', 'adult')) $$;
revoke execute on function member_signs_in_grown_up(uuid) from public;
grant execute on function member_signs_in_grown_up(uuid) to fdv_app;

-- Whether somebody has a sign-in here at all, whatever its role: an owner
-- answers Keep only for somebody with none.
create function member_has_sign_in(p_member uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select exists (select 1 from account_household ah
                     where ah.member_id = p_member
                       and ah.household_id = app_household()) $$;
revoke execute on function member_has_sign_in(uuid) from public;
grant execute on function member_has_sign_in(uuid) to fdv_app;

-- The one-off catch-up (the owner's decision of 14 Nov 2026): the first
-- time the vault's job runs for a household, everybody already 18 or over
-- with Medical papers the family can see is asked too. When it ran; null
-- until then — so a household restored from before this release is caught
-- up as it starts again, and one restored after it is not asked twice.
alter table household add column grown_ups_asked_at timestamptz;

create table grown_up_question (
  household_id  uuid not null references household(id) on delete cascade,
  member_id     uuid not null,
  -- Their 18th birthday, on the household's calendar.
  turned_on     date not null,
  asked_at      timestamptz not null default now(),
  answered_at   timestamptz,
  answer        text constraint grown_up_question_answer check (answer in ('keep', 'only_me')),
  answered_by   uuid references account(id) on delete set null,
  -- How many papers the answer made Only me.
  made_private  integer not null default 0 constraint grown_up_question_made check (made_private >= 0),
  primary key (household_id, member_id),
  constraint grown_up_question_answered check ((answered_at is null) = (answer is null)),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);

alter table grown_up_question enable row level security;

create policy grown_up_question_tenant on grown_up_question
  using (household_id = app_household()) with check (household_id = app_household());

-- The person, the owners (who ask somebody with no sign-in in person), and
-- the vault.
create policy grown_up_question_actor on grown_up_question as restrictive
  using (case app_actor()
           when 'account' then member_id = app_member() or app_role() = 'owner'
           when 'system' then true
           else false
         end);

-- Asked by the vault alone, and never taken away by anybody signed in.
create policy grown_up_question_insert on grown_up_question as restrictive for insert
  with check (case app_actor() when 'system' then true else false end);
create policy grown_up_question_delete on grown_up_question as restrictive for delete
  using (case app_actor() when 'system' then true else false end);

-- Answered once, and final. Only me only by the person themselves; an
-- owner answers only for somebody who cannot answer for themselves.
create function grown_up_question_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if (new.household_id, new.member_id, new.turned_on, new.asked_at)
     is distinct from (old.household_id, old.member_id, old.turned_on, old.asked_at) then
    raise exception 'a question once asked is not changed'
      using errcode = 'insufficient_privilege';
  end if;
  if old.answered_at is not null then
    if (new.answered_at, new.answer, new.made_private)
       is distinct from (old.answered_at, old.answer, old.made_private) then
      raise exception 'that question has been answered'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if app_actor() is distinct from 'account' or new.answered_at is null then
    return new;
  end if;
  -- Answered as whoever answers it; Keep makes nothing Only me.
  if new.answered_by is distinct from app_account()
     or (new.answer = 'keep' and new.made_private <> 0) then
    raise exception 'an answer is written as it is, by whoever gives it'
      using errcode = 'insufficient_privilege';
  end if;
  if new.member_id = app_member() then
    if app_role() not in ('owner', 'adult') then
      raise exception 'only somebody signed in as a grown-up answers for their own papers'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  -- An owner, Keep only, for somebody with no sign-in at all.
  if app_role() = 'owner' and new.answer = 'keep'
     and not member_has_sign_in(new.member_id) then
    return new;
  end if;
  raise exception 'only the person answers for their own papers'
    using errcode = 'insufficient_privilege';
end $$;

create trigger grown_up_question_rule before update on grown_up_question
  for each row execute function grown_up_question_rule();

grant select, insert, update, delete on grown_up_question to fdv_app;

-- The owners' reminder to ask somebody with no sign-in in person: about a
-- person, as turning 13 is (0066). One for each person, ever.
alter table reminder drop constraint reminder_kind_check;
alter table reminder
  add constraint reminder_kind_check
  check (kind in ('derived', 'manual', 'turned_13', 'turned_18'));

alter table reminder drop constraint reminder_about_one;
alter table reminder
  add constraint reminder_about_one check (
    case kind
      when 'turned_13' then document_id is null and member_id is not null
      when 'turned_18' then document_id is null and member_id is not null
      else document_id is not null and member_id is null
    end);

create unique index reminder_turned_18 on reminder (household_id, member_id)
  where kind = 'turned_18';

-- Every paper with a kind has its kind's category written on it as it is
-- filed (documents/service.ts columns); one from before that, or brought in
-- some other way, may have none. caregiver_reads() asks the paper's own
-- category alone, so it is written on each such paper here, once, from its
-- kind as the vault has it now. Nothing else of the paper changes.
update document d
   set category = t.category
  from document_type t
 where t.key = d.type_key
   and d.category is null;
