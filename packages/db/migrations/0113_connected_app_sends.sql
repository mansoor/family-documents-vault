-- Connected apps: an app re-downloads what it sent, and the vault picks
-- whose Inbox a send goes to (0.9.0, APP5).
--
-- An app may always download the exact file it sent, by its own external
-- id, while that file is still one of the vault's versions, its document is
-- out of the Trash, not Only me, and still of a category an app may ever be
-- given (never identity, legal or medical) — even once the file was filed into a
-- family paper as a new version, or a newer family file came after it.
-- Nothing else of the document is read so: the version the app sent, and
-- no other. Written once, here (connected_app_sent_versions), and kept by
-- the database: a transaction acting for an app is given those versions
-- beside the current files of the documents it may read.
--
-- And an app may send each paper to the Inbox of the person it is about
-- (connected_app.route_to_person): when the app names somebody (by id, or
-- a name that matches one person of the family), and that person is an
-- owner or an adult of the household with a sign-in who may act now, the
-- item goes to their Inbox, as their own upload; otherwise to the app's
-- person's, as before. On for an app connected from now on; an app
-- connected before keeps what it did (off). Whose Inbox it went to is kept
-- on the send (inbox_member_id), never told to the app.

-- ------------------------------------------------------------ the app

alter table connected_app
  -- Off for every app there now: it keeps what it did.
  add column route_to_person boolean not null default false;
-- On for every app connected from now on.
alter table connected_app alter column route_to_person set default true;

-- ------------------------------------------------------- its sends

alter table connected_app_intake
  -- Whose Inbox it went to: the app's person's, or the person it is about
  -- (null for a send from before, which went to the app's person's).
  add column inbox_member_id uuid,
  add constraint connected_app_intake_inbox_fkey
    foreign key (inbox_member_id, household_id) references member (id, household_id)
    on delete set null (inbox_member_id);

-- ------------------------------------------- a batch an app a person a day

-- One batch an app a household day for each person it sends to, and a part
-- more past 200 files: what it sends to two people never shares a batch.
alter table intake_batch drop constraint intake_batch_app_day_key;
alter table intake_batch
  add constraint intake_batch_app_day_key unique (app_id, member_id, app_day, app_part);

-- Whose Inbox an app may fill: a live, approved, unpaused app of this
-- household, for its own person — or, when it sends each paper to the
-- person it is about, for an owner or an adult of the household with a
-- sign-in. With the vault's rights, so the person it sends to need not see
-- the app's row to be sent to.
create function connected_app_inbox(p_app uuid, p_member uuid) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1
      from connected_app a
     where a.id = p_app and a.household_id = app_household()
       and a.revoked_at is null and a.paused_reason is null and a.approval = 'approved'
       and (a.member_id = p_member
            or (a.route_to_person
                and exists (select 1
                              from account_household ah
                              join member m on m.id = ah.member_id
                                           and m.household_id = ah.household_id
                             where ah.household_id = a.household_id
                               and ah.member_id = p_member
                               and m.kind = 'family'
                               and ah.role::text in ('owner', 'adult')))))
$$;
revoke execute on function connected_app_inbox(uuid, uuid) from public;
grant execute on function connected_app_inbox(uuid, uuid) to fdv_app;

drop policy intake_batch_app_insert on intake_batch;
create policy intake_batch_app_insert on intake_batch as restrictive for insert
  with check (app_id is null or connected_app_inbox(app_id, member_id));

-- What a connected app sent, as the Inbox it is in shows it: the app's
-- name and kinds, its hints (sealed under the item's own key) and where
-- the send stands. For somebody signed in, items of their own batches
-- alone — the person an app sent to sees what it said of their items, and
-- nothing else of the app; for the vault, any of the household's.
create function connected_app_items(p_items uuid[])
  returns table (incoming_file_id uuid, app_id uuid, app_name text, allowed_kinds text[],
                 hints_sealed bytea, state text, auto_file_held boolean)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as $$
  select f.id, a.id, a.name, a.allowed_kinds, i.hints_sealed, i.state, i.auto_file_held
    from incoming_file f
    join intake_batch b on b.id = f.batch_id and b.household_id = f.household_id
    join connected_app a on a.id = b.app_id and a.household_id = b.household_id
    left join connected_app_intake i on i.incoming_file_id = f.id and i.app_id = a.id
   where f.id = any (p_items)
     and f.household_id = app_household()
     and case app_actor()
           when 'account' then b.member_id = app_member()
           when 'system' then true
           else false
         end
$$;
revoke execute on function connected_app_items(uuid[]) from public;
grant execute on function connected_app_items(uuid[]) to fdv_app;

-- ------------------------------------------------- what it sent, again

-- The versions an app sent that it may download again: a send of its
-- filed (not let go of), its version still the vault's and its file kept,
-- its document out of the Trash and seen by Everyone or Adults only (never
-- Only me, whoever's it is), and still of a category an app may ever be
-- given (a paper the family made an identity, legal or medical one since
-- is never an app's again); the app live, on and turned on, its person an
-- owner or an adult. Nothing else of the document: not its other files.
create function connected_app_sent_versions(p_app uuid) returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as $$
  select v.id
    from connected_app a
    join account_household ah
      on ah.account_id = a.account_id and ah.household_id = a.household_id
     and ah.member_id = a.member_id
    join connected_app_intake i on i.app_id = a.id and i.household_id = a.household_id
    join document_version v on v.id = i.version_id and v.document_id = i.document_id
    join document d on d.id = v.document_id and d.household_id = a.household_id
    join document_type t on t.key = d.type_key
     and (t.household_id is null or t.household_id = d.household_id)
   where a.id = p_app and a.household_id = app_household()
     and a.revoked_at is null and a.paused_reason is null and a.approval = 'approved'
     and ah.role::text in ('owner', 'adult')
     and i.state = 'filed' and i.unlinked_at is null
     and v.file_removed_at is null
     and d.deleted_at is null
     and d.visibility::text in ('household', 'adults')
     and d.category in ('financial', 'tax', 'bills', 'insurance', 'work', 'property', 'other')
     and t.category in ('financial', 'tax', 'bills', 'insurance', 'work', 'property', 'other')
$$;
revoke execute on function connected_app_sent_versions(uuid) from public;
grant execute on function connected_app_sent_versions(uuid) to fdv_app;

create function app_connected_app_sent_versions() returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select connected_app_sent_versions(app_connected_app()) $$;
revoke execute on function app_connected_app_sent_versions() from public;
grant execute on function app_connected_app_sent_versions() to fdv_app;

-- 0110's, and (APP5) the versions it sent beside the current files of what
-- it may read.
drop policy document_version_actor on document_version;
create policy document_version_actor on document_version as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then id in (select app_link_versions())
           when 'connected_app' then id in (select app_connected_app_versions())
                                     or id in (select app_connected_app_sent_versions())
           else false
         end);
