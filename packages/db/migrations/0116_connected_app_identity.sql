-- A connected app acts as itself, with a person to review what it sends
-- (0.9.0-dev.65, APP8).
--
-- Until now an app acted as one person of the family, its "acting member":
-- that person's Inbox took what nothing routed, their name was on what it
-- did ("Ahmed via Acme Money sent …"), and their role, lock and pause were
-- asked on every request. From now an app an owner connects acts as itself
-- by default (connected_app.acts_as = 'app'): no person, and no hidden
-- account standing in for one, so nothing of it shows up in the family's
-- lists, counts or pickers. The activity log names the app ("Acme Money
-- sent a file to Sara's Inbox"). Its own rows (its caps, what became of
-- each send, its lines in the log) are the vault's to write on its behalf.
--
-- What it sends that is about a person still goes to that person's Inbox
-- (0113's routing). What nothing routes goes to the Inbox of the app's
-- reviewer (reviewer_member_id): an owner or an adult with a sign-in,
-- chosen by an owner, by default the owner who connected it. While it has
-- none, or the one it has cannot take it now, such a send is refused for a
-- moment (the API's 503 busy) and the owners are told once to choose
-- another (reviewer_told_at). A reviewer who leaves, loses their sign-in or
-- whose role drops below adult is let go of here, in the same transaction;
-- the app is not removed.
--
-- What an owner set up still ends with them, as it did when an app acted
-- as its owner: as they leave, stop being an owner or are stopped, the apps
-- acting as themselves they connected are removed, and the API keys they
-- generated for such apps revoked.
--
-- An owner may still choose that it acts as a person (acts_as = 'person',
-- member_id and account_id theirs), themselves included: everything as it
-- was, and another adult turns it on themselves. Every app connected
-- before keeps acting as its person.
--
-- What it reads it reads by its grants and its own documents alone, as an
-- app acting as an adult would: never more.
--
-- A file it sent, filed by whoever's Inbox it was in, names the app as its
-- uploader (document_version.uploaded_by_app), not a person: the person
-- column is null then.

-- ------------------------------------------------------------ the app

alter table connected_app
  -- Every app there now acts as its person: nothing changes for them.
  add column acts_as text not null default 'person'
    constraint connected_app_acts_as check (acts_as in ('app', 'person')),
  -- Who reviews what nothing routes, when it acts as itself.
  add column reviewer_member_id uuid,
  -- When the owners were told it needs another reviewer: once, until one
  -- is chosen or takes a send again.
  add column reviewer_told_at timestamptz,
  add constraint connected_app_reviewer_fkey
    foreign key (reviewer_member_id, household_id) references member (id, household_id)
    on delete set null (reviewer_member_id);
-- An app connected from now on acts as itself.
alter table connected_app alter column acts_as set default 'app';
alter table connected_app
  alter column account_id drop not null,
  alter column member_id drop not null,
  -- A person's sign-in and member for a person, nobody's for itself; a
  -- reviewer only for an app acting as itself.
  add constraint connected_app_acts_as_person check (
    (acts_as = 'person') = (member_id is not null)
    and (member_id is null) = (account_id is null)
    and (acts_as = 'app' or reviewer_member_id is null));
create index connected_app_reviewer_idx on connected_app (reviewer_member_id)
  where reviewer_member_id is not null;

-- Connected by an owner, as themselves: turned on already when it acts as
-- itself or as them; another adult turns on their own.
drop policy connected_app_actor_insert on connected_app;
create policy connected_app_actor_insert on connected_app as restrictive for insert
  with check (case app_actor()
                when 'account' then app_role() = 'owner' and created_by = app_account()
                                    and (approval = 'waiting' or acts_as = 'app'
                                         or member_id = app_member())
                when 'system' then true
                else false
              end);

-- 0109's, and (APP8) whom an app acts as may change — by an owner, and to
-- another adult only waiting for them to turn it on; its reviewer let go of
-- by the foreign key or as they leave, and nothing else.
create or replace function connected_app_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  fixed constant text[] := array['id', 'household_id', 'created_by', 'created_at'];
  movable constant text[] := array['approval', 'approved_at', 'revoked_at', 'revoked_by',
                                   'revoked_reason', 'last_used_at', 'use_day', 'files_today',
                                   'bytes_today', 'refused_on', 'refused_today', 'last_refusal',
                                   'checked_line_at'];
begin
  if pg_trigger_depth() > 1
     and old.revoked_by is not null and new.revoked_by is null
     and (to_jsonb(new) - 'revoked_by') = (to_jsonb(old) - 'revoked_by') then
    return new;
  end if;
  if pg_trigger_depth() > 1
     and old.created_by is not null and new.created_by is null
     and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by') then
    return new;
  end if;
  if pg_trigger_depth() > 1
     and old.reviewer_member_id is not null and new.reviewer_member_id is null
     and (to_jsonb(new) - 'reviewer_member_id') = (to_jsonb(old) - 'reviewer_member_id') then
    return new;
  end if;
  if old.revoked_at is not null then
    raise exception 'a revoked app never changes' using errcode = 'insufficient_privilege';
  end if;
  if (select jsonb_object_agg(k, to_jsonb(new) -> k) from unnest(fixed) k)
     is distinct from (select jsonb_object_agg(k, to_jsonb(old) -> k) from unnest(fixed) k) then
    raise exception 'who connected an app, and when, never change'
      using errcode = 'insufficient_privilege';
  end if;
  -- Acting as another adult, from now: they turn it on themselves.
  if app_actor() = 'account'
     and (new.acts_as, new.account_id, new.member_id)
         is distinct from (old.acts_as, old.account_id, old.member_id)
     and new.acts_as = 'person' and new.member_id is distinct from app_member()
     and new.approval = 'approved' then
    raise exception 'an app acting as another adult waits for them'
      using errcode = 'insufficient_privilege';
  end if;
  -- Only its person turns on an app acting as them.
  if app_actor() = 'account' and old.approval = 'waiting' and new.approval = 'approved'
     and new.acts_as = 'person' and new.member_id is distinct from app_member() then
    raise exception 'only its person turns an app on' using errcode = 'insufficient_privilege';
  end if;
  -- Its person, an adult, turns it on, removes it, and has its use noted:
  -- what it may do is an owner's to change.
  if app_actor() = 'account' and app_role() is distinct from 'owner'
     and (to_jsonb(new) - movable) is distinct from (to_jsonb(old) - movable) then
    raise exception 'only an owner changes what an app may do'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- ------------------------------------------------------- what it sent

-- Nobody's, for an app acting as itself: the vault's alone to read and
-- write, on its behalf.
alter table connected_app_intake alter column member_id drop not null;

-- Whether a send was the app's own, acting as itself, as it was sent: a file
-- of it filed names the app as its uploader by this, never by whom the app
-- acts as by the time it is filed.
alter table connected_app_intake add column as_itself boolean not null default false;

-- Whose its sends are follows whom it acts as, once that is in effect: the
-- person it acts as reads what it sent before (and its state answers the
-- app as it did) only once they have turned it on — never while it waits
-- for them — and nobody's, as the vault's, once it acts as itself.
create function connected_app_person_moves() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.approval = 'approved'
     and (new.member_id is distinct from old.member_id or old.approval is distinct from 'approved') then
    update connected_app_intake set member_id = new.member_id
     where app_id = new.id and household_id = new.household_id
       and member_id is distinct from new.member_id;
  end if;
  return null;
end $$;

create trigger connected_app_person_moves after update of member_id, approval on connected_app
  for each row execute function connected_app_person_moves();

-- ------------------------------------------------- who connected it

-- An API key reads "revoked: its creator went" too.
alter table connected_app_key drop constraint connected_app_key_revoked_reason;
alter table connected_app_key add constraint connected_app_key_revoked_reason
  check (revoked_reason in ('owner', 'app_removed', 'restore', 'creator'));

-- An app acting as itself acts as nobody, so nobody's leaving revokes it as
-- a person's leaving revokes an app acting as them. What an owner put in
-- place still ends with them, as before APP8: the apps acting as themselves
-- they connected are removed, and every live API key they generated for
-- another owner's such app is revoked — as their sign-in goes, their role
-- drops below owner, or the emergency controls stop them. In the
-- caller's transaction, before anything of the account could go.
create function connected_apps_of_creator_end(p_household uuid, p_account uuid, p_reason text,
                                              p_by uuid)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  update connected_app set revoked_at = now(), revoked_by = p_by, revoked_reason = p_reason
   where household_id = p_household and acts_as = 'app' and created_by = p_account
     and revoked_at is null;
  update connected_app_key k set revoked_at = now(), revoked_by = p_by, revoked_reason = 'creator'
    from connected_app a
   where a.id = k.app_id and a.household_id = p_household and a.acts_as = 'app'
     and k.household_id = p_household and k.created_by = p_account and k.revoked_at is null;
end $$;
revoke execute on function connected_apps_of_creator_end(uuid, uuid, text, uuid) from public;

-- ------------------------------------------------- leaving with a role

-- 0109's, and (APP8) only the apps acting as that person are revoked; an
-- app they reviewed lets go of them as its reviewer, and stays; and what
-- they connected to act as itself ends with them leaving, or their role
-- dropping below owner.
create or replace function connected_apps_leave_with_role() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    update connected_app set revoked_at = now(), revoked_reason = 'sign_in_removed'
     where household_id = old.household_id and account_id = old.account_id
       and acts_as = 'person' and revoked_at is null;
    update connected_app set reviewer_member_id = null
     where household_id = old.household_id and reviewer_member_id = old.member_id;
    perform connected_apps_of_creator_end(old.household_id, old.account_id, 'sign_in_removed',
                                          null);
    return null;
  end if;
  if new.role::text not in ('owner', 'adult')
     and old.role::text in ('owner', 'adult') then
    update connected_app set revoked_at = now(), revoked_reason = 'cannot_act'
     where household_id = new.household_id and account_id = new.account_id
       and acts_as = 'person' and revoked_at is null;
    update connected_app set reviewer_member_id = null
     where household_id = new.household_id and reviewer_member_id = new.member_id;
  end if;
  if old.role::text = 'owner' and new.role::text <> 'owner' then
    perform connected_apps_of_creator_end(new.household_id, new.account_id, 'cannot_act', null);
  end if;
  return null;
end $$;

-- 0109's emergency controls, and (APP8) what that person connected to act
-- as itself, and the keys they generated for such apps: stopped with them.
-- Answers each app removed, and each key revoked by its client ID.
drop function connected_apps_revoke_for(uuid, text);
create function connected_apps_revoke_for(p_account uuid, p_reason text)
  returns table (id uuid, member_id uuid, name text, client_id text)
  language plpgsql volatile security definer
  set search_path = pg_catalog, public, pg_temp as $$
#variable_conflict use_column
begin
  if p_reason is null or p_reason not in ('signed_out', 'owner_stopped') then
    raise exception 'not a reason an app is stopped for' using errcode = 'insufficient_privilege';
  end if;
  if not coalesce(app_actor() = 'account'
                  and (app_account() = p_account or app_role() = 'owner'), false) then
    raise exception 'only its person or an owner stops somebody''s apps'
      using errcode = 'insufficient_privilege';
  end if;
  return query
    update connected_app a
       set revoked_at = now(), revoked_by = app_account(), revoked_reason = p_reason
     where a.household_id = app_household()
       and ((a.acts_as = 'person' and a.account_id = p_account)
            or (a.acts_as = 'app' and a.created_by = p_account))
       and a.revoked_at is null
    returning a.id, a.member_id, a.name, null::text;
  return query
    update connected_app_key k
       set revoked_at = now(), revoked_by = app_account(), revoked_reason = 'creator'
      from connected_app a
     where a.id = k.app_id and a.household_id = app_household() and a.acts_as = 'app'
       and k.household_id = app_household() and k.created_by = p_account
       and k.revoked_at is null
    returning a.id, a.member_id, a.name, k.client_id;
end $$;
revoke execute on function connected_apps_revoke_for(uuid, text) from public;
grant execute on function connected_apps_revoke_for(uuid, text) to fdv_app;

-- ------------------------------------------------- its reviewer

-- Somebody who may review it, as it is chosen: an owner or an adult of the
-- family with a sign-in in this household. Whether they can take a send
-- now (a lock, a pause) is asked as each comes.
create function connected_app_reviewer_check() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.reviewer_member_id is not null
     and (tg_op = 'INSERT' or new.reviewer_member_id is distinct from old.reviewer_member_id)
     and not exists (select 1
                       from account_household ah
                       join member m on m.id = ah.member_id and m.household_id = ah.household_id
                      where ah.household_id = new.household_id
                        and ah.member_id = new.reviewer_member_id
                        and m.kind = 'family'
                        and ah.role::text in ('owner', 'adult')) then
    raise exception 'an app''s reviewer is an owner or an adult of the family who signs in'
      using errcode = 'check_violation', constraint = 'connected_app_reviewer';
  end if;
  return new;
end $$;

create trigger connected_app_reviewer_check before insert or update of reviewer_member_id
  on connected_app for each row execute function connected_app_reviewer_check();

-- ------------------------------------------------- whose Inbox it fills

-- 0113's, and (APP8) an app acting as itself fills its reviewer's Inbox,
-- while they are an owner or an adult of the family with a sign-in here.
create or replace function connected_app_inbox(p_app uuid, p_member uuid) returns boolean
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1
      from connected_app a
     where a.id = p_app and a.household_id = app_household()
       and a.revoked_at is null and a.paused_reason is null and a.approval = 'approved'
       and ((a.acts_as = 'person' and a.member_id = p_member)
            or ((a.route_to_person
                 or (a.acts_as = 'app' and a.reviewer_member_id = p_member))
                and exists (select 1
                              from account_household ah
                              join member m on m.id = ah.member_id
                                           and m.household_id = ah.household_id
                             where ah.household_id = a.household_id
                               and ah.member_id = p_member
                               and m.kind = 'family'
                               and ah.role::text in ('owner', 'adult')))))
$$;

-- 0113's, and (APP8) whether the send was the app's own, acting as itself,
-- as it was sent: a file of it filed names the app, not a person, as its
-- uploader.
drop function connected_app_items(uuid[]);
create function connected_app_items(p_items uuid[])
  returns table (incoming_file_id uuid, app_id uuid, app_name text, allowed_kinds text[],
                 hints_sealed bytea, state text, auto_file_held boolean, by_app boolean)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as $$
  select f.id, a.id, a.name, a.allowed_kinds, i.hints_sealed, i.state, i.auto_file_held,
         coalesce(i.as_itself, false)
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

-- An app's name, by its id, for whoever reads a file it added (a version's
-- history): the name and nothing else of it, of this household's apps,
-- removed ones too.
create function connected_app_names(p_apps uuid[])
  returns table (id uuid, name text)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as $$
  select a.id, a.name
    from connected_app a
   where a.id = any (p_apps)
     and a.household_id = app_household()
     and app_actor() in ('account', 'system')
$$;
revoke execute on function connected_app_names(uuid[]) from public;
grant execute on function connected_app_names(uuid[]) to fdv_app;

-- ------------------------------------------------------- what it reads

-- 0114's, word for word, but (APP8) an app acting as itself has no person
-- to ask: it reads as an app acting as an adult would, by its grants and
-- what it made — never anything Only me, whoever's, as before.
create or replace function connected_app_documents(p_app uuid) returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as $$
  with app as (
    select a.id, a.household_id
      from connected_app a
     where a.id = p_app and a.household_id = app_household()
       and a.revoked_at is null and a.paused_reason is null and a.approval = 'approved'
       and (a.acts_as = 'app'
            or exists (select 1 from account_household ah
                        where ah.account_id = a.account_id and ah.household_id = a.household_id
                          and ah.member_id = a.member_id
                          and ah.role::text in ('owner', 'adult')))
  ), z as (
    select coalesce(nullif(current_setting('app.zone', true), ''), 'UTC') as zone
  ), docs as (
    select d.id, d.type_key, d.sensitive, t.category as kind_category,
           coalesce(s.sensitive_default, t.sensitive_default) as kind_sensitive,
           coalesce(s.usually_essential, t.usually_essential) as kind_essential,
           connected_app_paper_date(d.issued_on, d.extra, d.created_at, z.zone) as paper_date,
           (now() at time zone z.zone)::date as today
      from app
      join document d on d.household_id = app.household_id
      cross join z
      join document_type t on t.key = d.type_key
       and (t.household_id is null or t.household_id = d.household_id)
      left join document_type_setting s
        on t.household_id is null and s.household_id = d.household_id and s.type_key = t.key
     where d.deleted_at is null
       and d.visibility::text in ('household', 'adults')
       and not d.is_essential
       and d.sensitive is distinct from true
       and d.type_key <> 'note'
       and d.category in ('financial', 'tax', 'bills', 'insurance', 'work', 'property', 'other')
       and t.category in ('financial', 'tax', 'bills', 'insurance', 'work', 'property', 'other')
  )
  select docs.id
    from docs
   where exists (select 1 from connected_app_intake i
                  where i.app_id = p_app and i.document_id = docs.id
                    and i.state = 'filed' and i.unlinked_at is null and i.made_document)
      or (docs.kind_essential is false
          and exists (select 1 from connected_app_grant g
                       where g.app_id = p_app
                         and (g.kind_key = docs.type_key or g.category = docs.kind_category)
                         and docs.paper_date
                             >= (docs.today - make_interval(months => g.lookback_months))::date
                         and (docs.sensitive is false or docs.kind_sensitive is false
                              or docs.type_key = any (g.sensitive_kinds))))
$$;

-- 0113's, word for word, but (APP8) its person asked only when it acts as one.
create or replace function connected_app_sent_versions(p_app uuid) returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as $$
  select v.id
    from connected_app a
    join connected_app_intake i on i.app_id = a.id and i.household_id = a.household_id
    join document_version v on v.id = i.version_id and v.document_id = i.document_id
    join document d on d.id = v.document_id and d.household_id = a.household_id
    join document_type t on t.key = d.type_key
     and (t.household_id is null or t.household_id = d.household_id)
   where a.id = p_app and a.household_id = app_household()
     and a.revoked_at is null and a.paused_reason is null and a.approval = 'approved'
     and (a.acts_as = 'app'
          or exists (select 1 from account_household ah
                      where ah.account_id = a.account_id and ah.household_id = a.household_id
                        and ah.member_id = a.member_id
                        and ah.role::text in ('owner', 'adult')))
     and i.state = 'filed' and i.unlinked_at is null
     and v.file_removed_at is null
     and d.deleted_at is null
     and d.visibility::text in ('household', 'adults')
     and d.category in ('financial', 'tax', 'bills', 'insurance', 'work', 'property', 'other')
     and t.category in ('financial', 'tax', 'bills', 'insurance', 'work', 'property', 'other')
$$;

-- ------------------------------------------------- a file it added

-- The app that added a version, when it acted as itself: the version's
-- person (uploaded_by) is null then. Set as the file is filed, by whoever's
-- Inbox it was in (or as it is filed automatically), and only for that very
-- file — an item of that app's, sent as itself, waiting in their own Inbox
-- with the same bytes. Who added a version never changes after.
alter table document_version
  add column uploaded_by_app uuid,
  add constraint document_version_uploaded_by_app_fkey
    foreign key (uploaded_by_app, household_id) references connected_app (id, household_id)
    on delete set null (uploaded_by_app),
  add constraint document_version_uploaded_by_one
    check (uploaded_by_app is null or uploaded_by is null);

create policy document_version_by_app on document_version as restrictive for insert
  with check (uploaded_by_app is null
              or app_actor() = 'system'
              or (uploaded_by is null
                  and exists (select 1
                                from incoming_file f
                                join intake_batch b on b.id = f.batch_id
                                                   and b.household_id = f.household_id
                               where b.app_id = document_version.uploaded_by_app
                                 and b.household_id = document_version.household_id
                                 and b.member_id = app_member()
                                 and f.state = 'received'
                                 and f.sha256 = document_version.sha256
                                 and exists (select 1 from connected_app_items(array[f.id]) x
                                              where x.by_app))));

create function document_version_uploader_fixed() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  -- An account or an app gone: the foreign key's own, and nothing else.
  if pg_trigger_depth() > 1
     and (new.uploaded_by is not distinct from old.uploaded_by or new.uploaded_by is null)
     and (new.uploaded_by_app is not distinct from old.uploaded_by_app
          or new.uploaded_by_app is null) then
    return new;
  end if;
  if new.uploaded_by is distinct from old.uploaded_by
     or new.uploaded_by_app is distinct from old.uploaded_by_app then
    raise exception 'who added a version never changes' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger document_version_uploader_fixed before update of uploaded_by, uploaded_by_app
  on document_version for each row execute function document_version_uploader_fixed();

-- 0071's, word for word, but (APP8) the version an item is filed as may
-- name the app that sent it as its uploader, in place of the person filing
-- it — the app of that item's own batch, and a version made just now.
create or replace function incoming_file_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  decision constant text[] := array['state', 'decided_by', 'decided_at', 'document_id',
                                    'version_id', 'original_name', 'sender_note', 'sha256',
                                    'proposals_sealed', 'text_sealed', 'undo_until',
                                    'as_version', 'prior_sealed', 'folder_sealed'];
  arrival constant text[] := array['state', 'mime', 'byte_size', 'sha256', 'cipher_bytes',
                                   'cipher_sha256', 'received_at', 'submitted_at'];
  reread constant text[] := array['read_state', 'read_failure', 'read_started_at',
                                  'read_attempts', 'read_not_before', 'read_waits',
                                  'read_waited_since', 'text_sealed', 'proposals_sealed'];
  undone constant text[] := array['state', 'decided_by', 'decided_at', 'document_id',
                                  'version_id', 'undo_until', 'object_removed_at', 'storage_key',
                                  'preview_state', 'preview_requested_at', 'preview_pages',
                                  'read_state', 'read_failure', 'read_started_at',
                                  'read_attempts', 'read_not_before', 'read_waits',
                                  'read_waited_since', 'text_sealed', 'proposals_sealed',
                                  'as_version', 'prior_sealed'];
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  -- A sender's session ended: the foreign key's own cascade, and nothing else.
  if pg_trigger_depth() > 1
     and old.session_id is not null and new.session_id is null
     and (to_jsonb(new) - 'session_id') = (to_jsonb(old) - 'session_id') then
    return new;
  end if;
  -- An item's bytes arrived (I1): finished once, by its uploader.
  if old.batch_id is not null and old.state = 'uploading'
     and old.requester_member_id is not distinct from app_member()
     and new.state = 'received'
     and new.received_at is not null and new.submitted_at is not null
     and (to_jsonb(new) - arrival) = (to_jsonb(old) - arrival) then
    return new;
  end if;
  -- Decided already, and its object gone: said once.
  if old.state in ('accepted', 'rejected')
     and old.object_removed_at is null and new.object_removed_at is not null
     and (to_jsonb(new) - 'object_removed_at') = (to_jsonb(old) - 'object_removed_at') then
    return new;
  end if;
  -- Decided: a file sent and waiting, once, by whoever is asking; what was
  -- read of it, and proposed for it, goes with the decision.
  if old.state = 'received' and old.submitted_at is not null
     and new.decided_by is not distinct from app_account()
     and new.decided_at is not null
     and new.proposals_sealed is null
     and new.text_sealed is null
     and (to_jsonb(new) - decision) = (to_jsonb(old) - decision)
     and (
       -- Filed: as the version made of it just now, by them, in that document;
       -- a batch's item, until a moment from now, to be taken back (I3) —
       -- a new version of a document there before saying so (S1). Where it
       -- came from is kept, as its name is (S2).
       (new.state = 'accepted'
        and new.original_name is not distinct from old.original_name
        and new.sender_note is not distinct from old.sender_note
        and new.sha256 is not distinct from old.sha256
        and new.folder_sealed is not distinct from old.folder_sealed
        and (new.undo_until is null
             or (old.batch_id is not null
                 and new.undo_until > now()
                 and new.undo_until <= now() + interval '5 minutes 30 seconds'))
        and exists (select 1 from document_version v
                     where v.id = new.version_id
                       and v.document_id = new.document_id
                       and (v.uploaded_by = app_account()
                            or (v.uploaded_by is null
                                and v.uploaded_by_app is not null
                                and v.uploaded_by_app = (select b.app_id from intake_batch b
                                                          where b.id = old.batch_id)))
                       and v.xmin = pg_current_xact_id()::xid)
        and (new.prior_sealed is null or new.as_version)
        and (old.batch_id is null and not new.as_version
             or old.batch_id is not null
                and new.as_version = exists (select 1 from document d
                                              where d.id = new.document_id
                                                and d.created_at <> now())))
       -- Refused, or removed: nothing filed; its name, its note, its hash
       -- and where it came from (S2) go.
       or (new.state = 'rejected'
           and new.document_id is null and new.version_id is null
           and new.undo_until is null
           and not new.as_version and new.prior_sealed is null
           and new.original_name is null and new.sender_note is null
           and new.sha256 is null
           and new.folder_sealed is null)
     ) then
    return new;
  end if;
  -- Taken back (I3): accepted by Accept all Ready, or added as a version
  -- (S1), by its uploader, in time; waiting again at a new object of its
  -- batch, to be drawn and read again. That the document it became — or
  -- the version it added — goes in the same transaction is held at commit
  -- (incoming_file_undone_document_gone, below).
  if old.batch_id is not null and old.state = 'accepted'
     and old.undo_until is not null and old.undo_until > now()
     and old.decided_by is not distinct from app_account()
     and old.requester_member_id is not distinct from app_member()
     and new.state = 'received'
     and new.decided_by is null and new.decided_at is null
     and new.document_id is null and new.version_id is null
     and new.undo_until is null and new.object_removed_at is null
     and not new.as_version and new.prior_sealed is null
     and new.preview_state = 'none' and new.preview_requested_at is null
     and new.preview_pages is null
     and new.read_state = 'waiting' and new.read_failure is null
     and new.read_started_at is null and new.read_attempts = 0
     and new.read_not_before is null
     and new.read_waits = 0 and new.read_waited_since is null
     and new.text_sealed is null and new.proposals_sealed is null
     and new.storage_key <> old.storage_key
     and starts_with(new.storage_key, old.household_id || '/batches/' || old.batch_id || '/')
     and exists (select 1 from intake_batch b where b.id = old.batch_id and b.ends_at > now())
     and (to_jsonb(new) - undone) = (to_jsonb(old) - undone) then
    return new;
  end if;
  -- Read again (I4, Forget all): an item of its uploader's, waiting, read or
  -- being read, back to be read from nought — what was read of it, and
  -- proposed, let go — and nothing else changed.
  if old.batch_id is not null and old.state = 'received'
     and old.read_state in ('read', 'reading')
     and old.requester_member_id is not distinct from app_member()
     and new.read_state = 'waiting' and new.read_failure is null
     and new.read_started_at is null and new.read_attempts = 0
     and new.read_not_before is null
     and new.read_waits = 0 and new.read_waited_since is null
     and new.text_sealed is null and new.proposals_sealed is null
     and (to_jsonb(new) - reread) = (to_jsonb(old) - reread) then
    return new;
  end if;
  raise exception 'a reviewer may only file or refuse a file waiting for review'
    using errcode = 'insufficient_privilege';
end $$;
