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
-- back seeing everything. Given back, it asks the owners to confirm it again
-- (`reconfirm_since`, which 5.33's screens read and clear).
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
-- granted collection, person or kind only narrows: whether people, or kinds,
-- are named at all is kept on the restriction (`limits_people`,
-- `limits_types`), apart from the rows naming them, which go with what they
-- name. A restriction that named only kinds that are gone gives nothing but
-- the person's own.
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
-- documents it gives, found by the indexes on who a document belongs to and
-- its kind. A per-row lookup of the restriction cost a third of a
-- millisecond a document, and a per-row subquery on every table that hangs
-- off a document made the planner's estimates large enough to switch on JIT
-- for everybody; a set, asked once and hashed, costs neither.
--
--   document                 doc_in_grant(), on the row
--   what hangs off one       its document among app_granted_documents():
--                            its versions (and their page previews, 0027's
--                            columns), its text, sealed or not, its reminders
--                            and their deliveries, its links to other
--                            documents (both ends), its share links (and their
--                            items, sessions and their uses, pages), its place
--                            in collections, its phone copies, who was told it
--                            is Only me, a capture's retry guard, and a file
--                            sent in once it points at a document
--   a document removed       its tombstone, by doc_in_grant() on what it keeps
--                            (no kind, no collection: it fails closed)
--   people                   themselves, the people granted, and the owners of
--                            the documents they are given; and what hangs off
--                            a person follows them: photos, sign-ins (and
--                            their accounts), invitations, keys and dismissed
--                            suggestions; sessions, devices, known devices
--                            and notification settings only their own
--   collections              granted ones, and their own
--   identity details         their own only
--   the household's answers  none
--   kinds of document        the built-ins, those granted, and those of the
--                            documents they are given
--   exports                  their own only
--   the activity log         a line about a document, a reminder, a person, a
--                            kind or a collection as that is given; any other
--                            line only their own (the 5.32 review, R532-05)
--
-- And a link lends no more than its maker may see now (the 5.32 review,
-- R532-03): a restricted maker's link gives only what their own grant gives
-- (maker_lends(), asked by app_shared_document(), app_live_share() and
-- app_link_documents()).
--
-- Restrictions are for viewers (A58; guests are viewers too, 5.34), and a
-- restriction never stands beside another role: a new one for anybody
-- signed in with another role is refused, and so is any role but viewer —
-- a change, a sign-in given back, an invitation accepted — for somebody
-- restricted. Their limits come off first.
--
-- Restricting somebody who keeps Only me documents asks an owner to confirm
-- (A59), and the person is told (the service, household/restrictions.ts):
-- otherwise an owner could demote an adult to viewer and restrict them, and
-- cut them off like a lock without 5.28's guard rails. The database refuses
-- such a restriction without `private_confirmed_at`.
--
-- Every function here that runs with the owner's rights puts pg_temp last in
-- its path. Those the rules ask are granted to the application role, in
-- privileges.ts too; app_grant_of() and maker_lends(), which read anybody's
-- grant, are granted to nobody.

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
  -- Whether it names people, or kinds, at all: kept apart from the rows that
  -- name them, so that a person or a kind deleted since, whose row goes with
  -- it, leaves "these only" meaning none of them — never "anybody's" or "any
  -- kind" (the 5.32 review, R532-01).
  limits_people          boolean not null default false,
  limits_types           boolean not null default false,
  created_by             uuid references account(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  updated_by             uuid references account(id) on delete set null,
  -- An owner confirmed restricting somebody who keeps Only me documents (A59).
  private_confirmed_at   timestamptz,
  private_confirmed_by   uuid references account(id) on delete set null,
  -- Their sign-in was given back since: an owner confirms the restriction
  -- again (5.33's screens read and clear it).
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

-- A restricted person's sign-in given back: the restriction stays (it is
-- the person's) and asks the owners to confirm it again. With the owner's
-- rights: an owner giving it back is not who writes the flag, the vault is.
create function account_household_restriction_reconfirm() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  update access_restriction
     set reconfirm_since = now()
   where member_id = new.member_id
     and household_id = new.household_id;
  return null;
end $$;

create trigger account_household_restriction_reconfirm
  after insert on account_household
  for each row execute function account_household_restriction_reconfirm();

-- A restriction never stands beside a role but viewer's (A58; the 5.32
-- review): nobody restricted is made an adult, a teen or an owner — by a
-- change of role, a sign-in given back, an invitation accepted — until an
-- owner has taken their limits off. Whoever asks but the owning role (a
-- restore, a migration). Its own SQLSTATE, FDV02, which the API answers as
-- `409 restricted`. With the owner's rights: the caller may not read the
-- restriction it asks about (an invitation accepted, an adult's request).
create function account_household_restricted_role() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is null then
    return new;
  end if;
  if new.role is distinct from 'viewer'
     and (tg_op = 'INSERT' or new.role is distinct from old.role)
     and exists (select 1 from access_restriction r
                  where r.member_id = new.member_id
                    and r.household_id = new.household_id) then
    raise exception 'their access is limited: an owner removes their limits first'
      using errcode = 'FDV02';
  end if;
  return new;
end $$;

create trigger account_household_restricted_role
  before insert or update of role on account_household
  for each row execute function account_household_restricted_role();

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
-- is, its checkboxes, whether it names people and kinds at all, the people
-- and kinds it names, and the documents of the collections it grants while
-- each is not deleted and is for Everyone (A17).
create type access_grant as (
  live                   boolean,
  member_id              uuid,
  include_adults_only    boolean,
  include_no_person_docs boolean,
  limits_people          boolean,
  limits_types           boolean,
  people                 uuid[],
  types                  text[],
  collection_documents   uuid[]
);

-- Somebody's restriction in this household, read once: null for somebody
-- with none. With the owner's rights; granted to nobody, as it reads
-- anybody's (app_grant() is the caller's own, maker_lends() a link's maker's).
create function app_grant_of(p_member uuid) returns access_grant
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
$$ select row(r.expires_at is null or r.expires_at > now(),
              r.member_id,
              r.include_adults_only,
              r.include_no_person_docs,
              r.limits_people,
              r.limits_types,
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
    where r.member_id = p_member
      and r.household_id = app_household() $$;
revoke execute on function app_grant_of(uuid) from public;

-- The caller's own restriction, read once a statement.
create function app_grant() returns access_grant
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select app_grant_of(app_member()) $$;
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
-- People, or kinds, are named when the restriction says it limits them or
-- when any row names one: named, and every one of them gone since, they
-- match nothing (R532-01).
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
                when g.limits_people or cardinality(g.people) > 0 then p_owner = any(g.people)
                else g.limits_types or cardinality(g.types) > 0
              end)
             and (not (g.limits_types or cardinality(g.types) > 0) or p_type = any(g.types)))
         or ((p_owner is not null or g.include_no_person_docs)
             and p_doc = any(g.collection_documents))),
    false);
end
$$;
grant execute on function doc_in_grant(access_grant, uuid, visibility, uuid, text) to fdv_app;

-- The household's documents the caller's grant gives (none without one),
-- asked once a statement and hashed by the rules below. Found the way the
-- grant names them — their own, the people's, nobody's, the kinds' when no
-- person is named, the collections' — each by an index, then each judged
-- by the rule: the cost follows the grant, not the household.
create function app_granted_documents() returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
$$ with mine as materialized (select app_grant() as g),
   found as (
     select d.id, d.visibility, d.owner_member_id, d.type_key
       from mine, document d
      where d.household_id = app_household()
        and d.owner_member_id = (mine.g).member_id
     union
     select d.id, d.visibility, d.owner_member_id, d.type_key
       from mine, document d
      where d.household_id = app_household()
        and d.owner_member_id = any((mine.g).people)
     union
     select d.id, d.visibility, d.owner_member_id, d.type_key
       from mine, document d
      where (mine.g).include_no_person_docs
        and d.household_id = app_household()
        and d.owner_member_id is null
     union
     select d.id, d.visibility, d.owner_member_id, d.type_key
       from mine, document d
      where not ((mine.g).limits_people or cardinality((mine.g).people) > 0)
        and d.household_id = app_household()
        and d.type_key = any((mine.g).types)
     union
     select d.id, d.visibility, d.owner_member_id, d.type_key
       from mine, document d
      where d.id = any((mine.g).collection_documents)
        and d.household_id = app_household())
   select found.id
     from mine, found
    where doc_in_grant(mine.g, found.id, found.visibility, found.owner_member_id, found.type_key) $$;
grant execute on function app_granted_documents() to fdv_app;

-- Whether a link's maker lends this document now (R532-03): anybody
-- unrestricted lends what their role lets them; a restricted maker only what
-- their own grant gives, and nothing once it has run out. With the owner's
-- rights; granted to nobody: the link's rules below ask it.
create function maker_lends(p_maker uuid, p_doc uuid, p_visibility visibility,
                            p_owner uuid, p_type text)
  returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
$$ select not exists (select 1 from access_restriction r
                       where r.member_id = p_maker
                         and r.household_id = app_household())
          or doc_in_grant(app_grant_of(p_maker), p_doc, p_visibility, p_owner, p_type) $$;
revoke execute on function maker_lends(uuid, uuid, visibility, uuid, text) from public;

-- Whether a link of this household lends what it was made for, as far as
-- its maker's restriction goes (R532-03): a document's, while the document
-- is in their grant; a collection's, while they are not restricted. For
-- the list of links, which shows one that does not as paused, and for
-- ShareService.live(). Yes for a link it cannot find: other checks end
-- those.
create function share_link_lends(p_share uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
$$ select coalesce((
     select case
              when s.document_id is not null then
                (select maker_lends(m.member_id, d.id, d.visibility, d.owner_member_id, d.type_key)
                   from document d where d.id = s.document_id)
              else not exists (select 1 from access_restriction r
                                where r.member_id = m.member_id
                                  and r.household_id = s.household_id)
            end
       from share_link s
       join account_household m on m.account_id = s.created_by and m.household_id = s.household_id
      where s.id = p_share
        and s.household_id = app_household()), true) $$;
grant execute on function share_link_lends(uuid) to fdv_app;

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

-- ------------------------------------------------ what a link lends now
--
-- A link lends no more than its maker may see now (R532-03): an adult made
-- a viewer and restricted keeps the links they made while they could see
-- more, and those reach only what their restriction gives (maker_lends()).
-- Each function below is the one before it, with that one check added; this
-- migration owns them from here. ShareService.live() asks the same
-- (share_link_lends()); change them together.

-- 0051's document for a link, and its maker's grant.
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
            end
        and maker_lends(maker.member_id, d.id, d.visibility, d.owner_member_id, d.type_key) $$;

-- 0051's live link: a collection's lends nothing while its maker is
-- restricted (a document's asks app_shared_document(), above).
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
                        or coalesce(c.owner_member_id = maker.member_id, false))
                   and not exists (select 1 from access_restriction r
                                    where r.member_id = maker.member_id
                                      and r.household_id = s.household_id))
              else false
            end $$;

-- 0045's documents of a link, each as its maker lends it now.
create or replace function app_link_documents() returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.document_id
       from share_link s
      where s.id = app_live_share()
        and s.document_id is not null
     union
     select d.id
       from share_link s
       join doc_collection c on c.id = s.collection_id and c.household_id = s.household_id
       join account_household maker
         on maker.account_id = s.created_by and maker.household_id = s.household_id
       join share_link_item t on t.share_id = s.id and t.kind in ('ticked', 'followed')
       join doc_collection_item i on i.collection_id = c.id and i.document_id = t.document_id
       join document d on d.id = t.document_id and d.household_id = s.household_id
      where s.id = app_live_share()
        and d.deleted_at is null
        and case d.visibility
              when 'household' then true
              when 'adults' then maker.role in ('owner', 'adult')
              when 'private' then coalesce(d.owner_member_id = maker.member_id, false)
              else false
            end
        and coalesce((select v.file_removed_at is null
                         from document_version v
                        where v.document_id = d.id
                        order by v.version_no desc
                        limit 1), false)
        and (t.kind = 'ticked'
             or (collection_audience_sees(c.audience, d.visibility::text)
                 and collection_audience_sees(s.follow_audience, d.visibility::text)))
        and maker_lends(maker.member_id, d.id, d.visibility, d.owner_member_id, d.type_key) $$;

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
              -- About a person, a kind or a collection, as that is given
              -- (the 5.32 review, R532-05): names, labels and recipients of
              -- what is not given are not read here either.
              when 'member' then object_id in (select app_granted_people())
              when 'document_type' then (detail ->> 'key') in (select t.key from document_type t)
              when 'collection' then object_id in (select app_granted_collections())
              when 'list' then object_id in (select app_granted_collections())
              -- Anything else, only what they did themselves.
              else coalesce(actor_account_id = app_account(), false)
            end);

-- A share link's sessions, as the link is given; and somebody's exports,
-- their own only (R532-06): an owner's holds the whole archive, and the key.
create policy share_session_restricted on share_session as restrictive
  using (not (select app_restricted())
         or share_id in (select s.id from share_link s));

create policy export_restricted on export as restrictive
  using (not (select app_restricted())
         or coalesce(requested_by = app_account(), false));

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

-- What hangs off a person follows them (the 5.32 review, R532-04): the
-- people's sign-ins (who, in which role, and any lock on them), and their
-- invitations, keys and dismissed suggestions, as the person is given; the
-- accounts of those sign-ins and their own; and whose sessions, devices,
-- known devices and notification settings — only their own. Their own
-- sign-ins in other households stay theirs to list. A caller not yet known
-- (sign-in, a refresh, an invitation's page) names no member, so is never
-- restricted.
create policy account_household_restricted on account_household as restrictive
  using (not (select app_restricted())
         or coalesce(account_id = app_account(), false)
         or member_id in (select app_granted_people()));

create policy invitation_restricted on invitation as restrictive
  using (not (select app_restricted())
         or member_id in (select app_granted_people()));

create policy scope_key_restricted on scope_key as restrictive
  using (not (select app_restricted())
         or member_id is null
         or member_id in (select app_granted_people()));

create policy suggestion_dismissal_restricted on suggestion_dismissal as restrictive
  using (not (select app_restricted())
         or member_id is null
         or member_id in (select app_granted_people()));

create policy account_restricted on account as restrictive
  using (not (select app_restricted())
         or coalesce(id = app_account(), false)
         or id in (select ah.account_id from account_household ah));

create policy session_restricted on session as restrictive
  using (not (select app_restricted())
         or coalesce(account_id = app_account(), false));

create policy device_restricted on device as restrictive
  using (not (select app_restricted())
         or coalesce(account_id = app_account(), false));

create policy known_device_restricted on known_device as restrictive
  using (not (select app_restricted())
         or coalesce(account_id = app_account(), false));

create policy notification_preference_restricted on notification_preference as restrictive
  using (not (select app_restricted())
         or coalesce(account_id = app_account(), false));
