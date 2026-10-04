-- The restriction, enforced by the database (iteration 5.32, D6, A56–A59).
--
-- An owner may limit what a viewer sees: an accountant given one person's
-- tax papers, an attorney given the will. 5.33 gives owners the screens and
-- the API; this is the database's half, so that a forgotten WHERE clause, a
-- raw id or a worker's digest cannot reach outside what was granted.
--
-- A restriction is keyed on the person (`member_id`), not on their sign-in
-- and not on account_household: taking a sign-in away deletes that row
-- (co-owners.ts removeSignIn) and giving it back inserts a new one, so a
-- restriction hanging off it would vanish with it, and the person would come
-- back seeing everything. Given back — or their role changed — it asks the
-- owners to confirm it again (`reconfirm_since`, which 5.33's screens read
-- and clear).
--
-- What a restricted person sees (A56–A59):
--
--   the ceiling   the household's documents; Adults only ones when an owner
--                 allows it (`include_adults_only`, D6); and the person's
--                 own Only me ones. Another person's Only me: never.
--   within it     their own documents; those that match the people, if any
--                 are named, and the kinds, if any are named — "Ahmed's tax
--                 documents"; and those in a granted collection, while it is
--                 not deleted and is for Everyone (A17). A document that
--                 belongs to nobody (the house deed) only with
--                 `include_no_person_docs`, whichever way in.
--   expired       nothing at all, their own included: a restriction past its
--                 `expires_at` is still a restriction (app_restricted() stays
--                 true), and its grant is empty. It fails closed.
--
-- So an empty restriction sees nothing of anybody else's, and deleting a
-- granted collection, a person or a kind only narrows. The rows naming whom
-- and which hang off the restriction and go with it.
--
-- The rules. Every rule here is RESTRICTIVE: it narrows what the rules
-- already give (0030's for each kind of caller, the household's wall), and
-- nothing is widened. Each reads `not (select app_restricted()) or …`: an
-- unrestricted caller pays one look at a primary key per statement (an
-- InitPlan) and nothing more, and every caller but somebody signed in — the
-- vault itself, a link, an upload link — names no member, so is never
-- restricted.
--
-- For a restricted caller the grant is worked out once per statement, not
-- once per row: app_grant() reads their restriction, and what it names, into
-- one value; doc_in_grant() is the rule, written once, applied to that value
-- and one document; app_granted_documents() is the set of the household's
-- documents it gives. A per-row lookup of the restriction cost a third of a
-- millisecond a document, and a per-row subquery on every table that hangs
-- off a document made the planner's estimates large enough to switch on JIT
-- for everybody; a set, asked once and hashed, costs neither.
--
--   document                 doc_in_grant(), on the row
--   what hangs off one       its document among app_granted_documents():
--                            its versions (and their page previews, 0027's
--                            columns), its text, sealed or not, its reminders
--                            and their deliveries, its links to other
--                            documents (both ends), its share links and their
--                            items, sessions' uses and pages, its place in
--                            collections, its phone copies, who was told it is
--                            Only me, a capture's retry guard, and a file sent
--                            in once it points at a document; and a line in
--                            the activity log about a document or a reminder
--   a document removed       its tombstone, by doc_in_grant() on what it keeps
--                            (no kind, no collection: it fails closed)
--   people                   themselves, the people granted, and the owners of
--                            the documents they are given; photos follow them
--   collections              granted ones, and their own
--   identity details         their own only
--   the household's answers  none
--   kinds of document        the built-ins, those granted, and those of the
--                            documents they are given
--
-- Restrictions apply to viewers (A58; guests are viewers too, 5.34): a new
-- one for anybody signed in with another role is refused here. One left on
-- somebody whose role changed since stays, and keeps narrowing: it fails
-- closed until an owner removes it.
--
-- Restricting somebody who keeps Only me documents asks an owner to confirm
-- (A59), and the person is told (the service, household/restrictions.ts):
-- otherwise an owner could demote an adult to viewer and restrict them, and
-- cut them off like a lock without 5.28's guard rails. The database refuses
-- such a restriction without `private_confirmed_at`.
--
-- Every function here that runs with the owner's rights puts pg_temp last in
-- its path, and is granted to the application role in privileges.ts too.

-- ------------------------------------------------------------- the tables

create table access_restriction (
  member_id              uuid primary key,
  household_id           uuid not null references household(id) on delete cascade,
  -- D6: an owner's alone (5.33), per viewer, and only within the rest.
  include_adults_only    boolean not null default false,
  -- A57: documents that belong to nobody, off by default.
  include_no_person_docs boolean not null default false,
  -- Past this, nothing is visible (5.33's "expiry leaves nothing visible").
  expires_at             timestamptz,
  created_by             uuid references account(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  updated_by             uuid references account(id) on delete set null,
  -- An owner confirmed restricting somebody who keeps Only me documents (A59).
  private_confirmed_at   timestamptz,
  private_confirmed_by   uuid references account(id) on delete set null,
  -- Their sign-in was given back, or their role changed, since: an owner
  -- confirms the restriction again (5.33's screens read and clear it).
  reconfirm_since        timestamptz,
  constraint access_restriction_member_household unique (member_id, household_id),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);

-- The people whose documents it gives.
create table access_restriction_member (
  restricted_member_id uuid not null,
  household_id         uuid not null references household(id) on delete cascade,
  member_id            uuid not null,
  primary key (restricted_member_id, member_id),
  foreign key (restricted_member_id, household_id)
    references access_restriction (member_id, household_id) on delete cascade,
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create index access_restriction_member_person_idx on access_restriction_member (member_id);

-- The kinds of document it gives: a built-in's key, or the household's own.
create table access_restriction_type (
  restricted_member_id uuid not null,
  household_id         uuid not null references household(id) on delete cascade,
  type_key             text not null references document_type(key) on delete cascade,
  primary key (restricted_member_id, type_key),
  foreign key (restricted_member_id, household_id)
    references access_restriction (member_id, household_id) on delete cascade
);
create index access_restriction_type_key_idx on access_restriction_type (type_key);

-- The collections it gives (A17: only one for Everyone counts).
create table access_restriction_collection (
  restricted_member_id uuid not null,
  household_id         uuid not null references household(id) on delete cascade,
  collection_id        uuid not null,
  primary key (restricted_member_id, collection_id),
  foreign key (restricted_member_id, household_id)
    references access_restriction (member_id, household_id) on delete cascade,
  foreign key (collection_id, household_id)
    references doc_collection (id, household_id) on delete cascade
);
create index access_restriction_collection_idx on access_restriction_collection (collection_id);

-- Which kinds a document has, in the Trash too: a restricted reader's kinds
-- (below) ask it of every type. The live documents' own index (0031) leaves
-- the Trash out.
create index document_type_key_idx on document (household_id, type_key);

-- ------------------------------------------------- who reads and writes them

alter table access_restriction enable row level security;
create policy access_restriction_tenant on access_restriction
  using (household_id = app_household()) with check (household_id = app_household());
alter table access_restriction_member enable row level security;
create policy access_restriction_member_tenant on access_restriction_member
  using (household_id = app_household()) with check (household_id = app_household());
alter table access_restriction_type enable row level security;
create policy access_restriction_type_tenant on access_restriction_type
  using (household_id = app_household()) with check (household_id = app_household());
alter table access_restriction_collection enable row level security;
create policy access_restriction_collection_tenant on access_restriction_collection
  using (household_id = app_household()) with check (household_id = app_household());

-- Read by the owners, and by the person their own; and by the vault. A
-- share link, an upload link, a signed-out page and a caller who says
-- nothing read none of it.
create policy access_restriction_actor on access_restriction as restrictive
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
                               or coalesce(member_id = app_member(), false)
           when 'system' then true
           else false
         end);
create policy access_restriction_member_actor on access_restriction_member as restrictive
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
                               or coalesce(restricted_member_id = app_member(), false)
           when 'system' then true
           else false
         end);
create policy access_restriction_type_actor on access_restriction_type as restrictive
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
                               or coalesce(restricted_member_id = app_member(), false)
           when 'system' then true
           else false
         end);
create policy access_restriction_collection_actor on access_restriction_collection as restrictive
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
                               or coalesce(restricted_member_id = app_member(), false)
           when 'system' then true
           else false
         end);

-- Written by an owner, or the vault itself (5.33's invitation accept): the
-- person reads theirs, and changes none of it.
create policy access_restriction_writer_insert on access_restriction as restrictive for insert
  with check (case app_actor()
                when 'account' then case app_role() when 'owner' then true else false end
                when 'system' then true
                else false
              end);
create policy access_restriction_writer_update on access_restriction as restrictive for update
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
           when 'system' then true
           else false
         end);
create policy access_restriction_writer_delete on access_restriction as restrictive for delete
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
           when 'system' then true
           else false
         end);
create policy access_restriction_member_writer_insert on access_restriction_member as restrictive for insert
  with check (case app_actor()
                when 'account' then case app_role() when 'owner' then true else false end
                when 'system' then true
                else false
              end);
create policy access_restriction_member_writer_update on access_restriction_member as restrictive for update
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
           when 'system' then true
           else false
         end);
create policy access_restriction_member_writer_delete on access_restriction_member as restrictive for delete
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
           when 'system' then true
           else false
         end);
create policy access_restriction_type_writer_insert on access_restriction_type as restrictive for insert
  with check (case app_actor()
                when 'account' then case app_role() when 'owner' then true else false end
                when 'system' then true
                else false
              end);
create policy access_restriction_type_writer_update on access_restriction_type as restrictive for update
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
           when 'system' then true
           else false
         end);
create policy access_restriction_type_writer_delete on access_restriction_type as restrictive for delete
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
           when 'system' then true
           else false
         end);
create policy access_restriction_collection_writer_insert on access_restriction_collection as restrictive for insert
  with check (case app_actor()
                when 'account' then case app_role() when 'owner' then true else false end
                when 'system' then true
                else false
              end);
create policy access_restriction_collection_writer_update on access_restriction_collection as restrictive for update
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
           when 'system' then true
           else false
         end);
create policy access_restriction_collection_writer_delete on access_restriction_collection as restrictive for delete
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
           when 'system' then true
           else false
         end);

-- ------------------------------------------------------------ the guards

-- What a restriction may be, whoever writes it but the owning role (the
-- migrations, a restore):
--  - a new one is for a viewer, or somebody with no sign-in (A58): an owner
--    restricts no owner, adult or teen, nor themselves;
--  - one for somebody who keeps Only me documents, in the Trash too, is
--    made only once an owner has confirmed it (A59), as themselves;
--  - who made it, and when it last changed, are the database's to say.
-- With the owner's rights: it counts Only me documents nobody asking may see.
create function access_restriction_guard() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if exists (select 1 from account_household a
                where a.member_id = new.member_id
                  and a.household_id = new.household_id
                  and a.role is distinct from 'viewer') then
      raise exception 'only a viewer is restricted'
        using errcode = 'check_violation';
    end if;
    if new.private_confirmed_at is null
       and exists (select 1 from document d
                    where d.household_id = new.household_id
                      and d.owner_member_id = new.member_id
                      and d.visibility = 'private') then
      raise exception 'restricting somebody who keeps Only me documents asks an owner to confirm'
        using errcode = 'check_violation';
    end if;
    new.created_by := app_account();
    new.created_at := now();
    new.reconfirm_since := null;
  elsif new.member_id is distinct from old.member_id
        or new.household_id is distinct from old.household_id then
    raise exception 'a restriction stays its person''s'
      using errcode = 'check_violation';
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  if new.private_confirmed_at is not null
     and (tg_op = 'INSERT' or old.private_confirmed_at is null) then
    if app_actor() = 'account' and app_role() is distinct from 'owner' then
      raise exception 'only an owner confirms a restriction'
        using errcode = 'insufficient_privilege';
    end if;
    new.private_confirmed_at := now();
    new.private_confirmed_by := app_account();
  elsif tg_op = 'UPDATE' then
    new.private_confirmed_at := old.private_confirmed_at;
    new.private_confirmed_by := old.private_confirmed_by;
  end if;
  new.updated_at := now();
  new.updated_by := app_account();
  return new;
end $$;

create trigger access_restriction_guard before insert or update on access_restriction
  for each row execute function access_restriction_guard();

-- A kind granted is a built-in, or one of the restriction's own household:
-- the foreign key to document_type is checked without row-level security.
create function access_restriction_type_household() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  if not exists (select 1 from document_type t
                  where t.key = new.type_key
                    and (t.household_id is null or t.household_id = new.household_id)) then
    raise exception 'a kind granted is the household''s own, or a built-in'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger access_restriction_type_household before insert or update on access_restriction_type
  for each row execute function access_restriction_type_household();

-- A restricted person's sign-in given back, or their role changed: the
-- restriction stays (it is the person's) and asks the owners to confirm it
-- again. With the owner's rights: an invitation accepted, or a sign-in given
-- back, is not a caller who may write a restriction.
create function account_household_restriction_reconfirm() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.role is distinct from old.role then
    update access_restriction
       set reconfirm_since = now()
     where member_id = new.member_id
       and household_id = new.household_id;
  end if;
  return null;
end $$;

create trigger account_household_restriction_reconfirm
  after insert or update of role on account_household
  for each row execute function account_household_restriction_reconfirm();

-- ------------------------------------------------------------ the helpers

-- Whether the caller is a restricted member of this household: a
-- restriction of theirs is there, past its end or not. Nobody else is: the
-- vault itself, a link and an upload link name no member.
create function app_restricted() returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select exists (select 1 from access_restriction r
                     where r.member_id = app_member()
                       and r.household_id = app_household()) $$;
grant execute on function app_restricted() to fdv_app;

-- A restriction as the rule reads it: whether it is still running, whose it
-- is, its checkboxes, the people and kinds it names, and the documents of
-- the collections it grants while each is not deleted and is for Everyone
-- (A17).
create type access_grant as (
  live                   boolean,
  member_id              uuid,
  include_adults_only    boolean,
  include_no_person_docs boolean,
  people                 uuid[],
  types                  text[],
  collection_documents   uuid[]
);

-- The caller's restriction, read once: null for somebody with none. With
-- the owner's rights, since it names people and collections the caller may
-- not read.
create function app_grant() returns access_grant
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
$$ select row(r.expires_at is null or r.expires_at > now(),
              r.member_id,
              r.include_adults_only,
              r.include_no_person_docs,
              array(select m.member_id from access_restriction_member m
                     where m.restricted_member_id = r.member_id),
              array(select t.type_key from access_restriction_type t
                     where t.restricted_member_id = r.member_id),
              array(select i.document_id
                      from access_restriction_collection g
                      join doc_collection c on c.id = g.collection_id
                      join doc_collection_item i on i.collection_id = g.collection_id
                     where g.restricted_member_id = r.member_id
                       and c.deleted_at is null
                       and c.audience = 'everyone'))::access_grant
     from access_restriction r
    where r.member_id = app_member()
      and r.household_id = app_household() $$;
grant execute on function app_grant() to fdv_app;

-- The rule, once: whether a grant gives a document. False for no grant, and
-- for one that has run out.
--
--   the ceiling (D6, A59)  household; Adults only with the checkbox; Only me
--                          only one's own — never somebody else's;
--   within it              one's own; the people named and the kinds named,
--                          together (A56) — a document of nobody's only with
--                          the checkbox (A57), and with no person named a
--                          person's only when kinds are; or in a granted
--                          collection, a separate way in (A56), nobody's
--                          again only with the checkbox.
--
-- A pure function of what it is handed: it reads no table. In PL/pgSQL,
-- whose one expression is evaluated without a plan of its own: a row costs a
-- few microseconds.
create function doc_in_grant(g access_grant, p_doc uuid, p_visibility visibility,
                             p_owner uuid, p_type text)
  returns boolean
  language plpgsql immutable parallel safe
  set search_path = pg_catalog, public, pg_temp as
$$
begin
  return coalesce(
    g.live
    and case p_visibility
          when 'household' then true
          when 'adults' then g.include_adults_only
          when 'private' then p_owner = g.member_id
          else false
        end
    and (p_owner = g.member_id
         or ((case
                when p_owner is null then g.include_no_person_docs
                when cardinality(g.people) > 0 then p_owner = any(g.people)
                else cardinality(g.types) > 0
              end)
             and (cardinality(g.types) = 0 or p_type = any(g.types)))
         or ((p_owner is not null or g.include_no_person_docs)
             and p_doc = any(g.collection_documents))),
    false);
end
$$;
grant execute on function doc_in_grant(access_grant, uuid, visibility, uuid, text) to fdv_app;

-- The household's documents the caller's grant gives (none without one),
-- asked once a statement and hashed by the rules below.
create function app_granted_documents() returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
$$ with mine as materialized (select app_grant() as g)
   select d.id
     from mine, document d
    where d.household_id = app_household()
      and doc_in_grant(mine.g, d.id, d.visibility, d.owner_member_id, d.type_key) $$;
grant execute on function app_granted_documents() to fdv_app;

-- The people the caller is given: themselves; while the grant runs, those it
-- names, and the owners of the documents it gives.
create function app_granted_people() returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
$$ with mine as materialized (select app_grant() as g)
   select app_member() where app_member() is not null
   union
   select unnest((mine.g).people) from mine where (mine.g).live
   union
   select d.owner_member_id
     from document d
    where d.id in (select app_granted_documents())
      and d.owner_member_id is not null $$;
grant execute on function app_granted_people() to fdv_app;

-- The collections the caller is given while the grant runs: those it
-- grants, while each is for Everyone and not deleted, and their own.
create function app_granted_collections() returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
$$ with mine as materialized (select app_grant() as g)
   select c.id
     from mine, doc_collection c
    where (mine.g).live
      and c.household_id = app_household()
      and ((c.audience = 'everyone'
            and c.deleted_at is null
            and exists (select 1 from access_restriction_collection g
                         where g.restricted_member_id = (mine.g).member_id
                           and g.collection_id = c.id))
           or c.owner_member_id = (mine.g).member_id) $$;
grant execute on function app_granted_collections() to fdv_app;

-- The household's kinds of document the caller is given while the grant
-- runs: those it names, and those of the documents it gives.
create function app_granted_types() returns setof text
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
$$ with mine as materialized (select app_grant() as g)
   select unnest((mine.g).types) from mine where (mine.g).live
   union
   select d.type_key
     from document d
    where d.id in (select app_granted_documents())
      and d.type_key is not null $$;
grant execute on function app_granted_types() to fdv_app;

-- --------------------------------------------------------- the document

create policy document_restricted on document as restrictive
  using (not (select app_restricted())
         or doc_in_grant((select app_grant()), id, visibility, owner_member_id, type_key));

-- ------------------------------------------- what hangs off a document

create policy document_version_restricted on document_version as restrictive
  using (not (select app_restricted())
         or document_id in (select app_granted_documents()));

create policy document_text_restricted on document_text as restrictive
  using (not (select app_restricted())
         or document_id in (select app_granted_documents()));

create policy document_text_sealed_restricted on document_text_sealed as restrictive
  using (not (select app_restricted())
         or document_id in (select app_granted_documents()));

create policy upload_idempotency_restricted on upload_idempotency as restrictive
  using (not (select app_restricted())
         or document_id in (select app_granted_documents()));

-- Both ends: a link names the other document.
create policy document_link_restricted on document_link as restrictive
  using (not (select app_restricted())
         or (a in (select app_granted_documents()) and b in (select app_granted_documents())));

create policy reminder_restricted on reminder as restrictive
  using (not (select app_restricted())
         or document_id in (select app_granted_documents()));

-- A delivery, as its reminder is given.
create policy reminder_delivery_restricted on reminder_delivery as restrictive
  using (not (select app_restricted())
         or reminder_id in (select r.id from reminder r));

create policy private_notice_restricted on private_notice as restrictive
  using (not (select app_restricted())
         or document_id in (select app_granted_documents()));

-- A phone's copy of a version, as the version is given.
create policy offline_fill_restricted on offline_fill as restrictive
  using (not (select app_restricted())
         or version_id in (select v.id from document_version v));

-- A link out of the house: to a document, or to a collection, each as the
-- caller is given it.
create policy share_link_restricted on share_link as restrictive
  using (not (select app_restricted())
         or case
              when document_id is not null then document_id in (select app_granted_documents())
              when collection_id is not null then collection_id in (select app_granted_collections())
              else false
            end);

create policy share_link_item_restricted on share_link_item as restrictive
  using (not (select app_restricted())
         or document_id in (select app_granted_documents()));

create policy share_session_use_restricted on share_session_use as restrictive
  using (not (select app_restricted())
         or document_id in (select app_granted_documents()));

create policy share_page_restricted on share_page as restrictive
  using (not (select app_restricted())
         or document_id in (select app_granted_documents()));

create policy share_page_failure_restricted on share_page_failure as restrictive
  using (not (select app_restricted())
         or document_id in (select app_granted_documents()));

create policy doc_collection_item_restricted on doc_collection_item as restrictive
  using (not (select app_restricted())
         or document_id in (select app_granted_documents()));

-- A file sent in, once it points at a document (5.23).
create policy incoming_file_restricted on incoming_file as restrictive
  using (not (select app_restricted())
         or document_id is null
         or document_id in (select app_granted_documents()));

-- A document removed for good (5.24): what its tombstone keeps — no kind,
-- no collection — so only the people named, or their own, give it.
create policy document_tombstone_restricted on document_tombstone as restrictive
  using (not (select app_restricted())
         or doc_in_grant((select app_grant()), id, visibility, owner_member_id, null));

-- A line in the activity log about a document, as its row or its tombstone
-- is given; about a reminder, as the reminder is. Read only: every caller
-- writes its own lines as before.
create policy audit_event_restricted on audit_event as restrictive for select
  using (not (select app_restricted())
         or case object_type
              when 'document' then object_id in (select app_granted_documents())
                                   or object_id in (select t.id from document_tombstone t)
              when 'reminder' then object_id in (select r.id from reminder r)
              else true
            end);

-- ------------------------------------------------- the rest of the family

-- People: themselves, those granted, and the owners of what they are given.
-- Their photos follow them.
create policy member_restricted on member as restrictive
  using (not (select app_restricted())
         or id in (select app_granted_people()));

create policy member_photo_restricted on member_photo as restrictive
  using (not (select app_restricted())
         or member_id in (select app_granted_people()));

-- Collections: those granted, and their own.
create policy doc_collection_restricted on doc_collection as restrictive
  using (not (select app_restricted())
         or id in (select app_granted_collections()));

-- Identity details: their own only.
create policy member_identity_restricted on member_identity as restrictive
  using (not (select app_restricted())
         or coalesce(member_id = app_member(), false));

-- The household's answers: none.
create policy household_profile_restricted on household_profile as restrictive
  using (not (select app_restricted()));

-- Kinds of document: the built-ins, those granted, and those of what they
-- are given.
create policy document_type_restricted on document_type as restrictive for select
  using (household_id is null
         or not (select app_restricted())
         or key in (select app_granted_types()));
