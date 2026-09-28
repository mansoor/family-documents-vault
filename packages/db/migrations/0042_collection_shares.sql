-- Share a collection (iteration 5.19).
--
-- A link can now be made to a collection as well as to one document. What
-- goes out is exactly what its sharer ticked (share_link_item, the
-- snapshot), and each request checks all of it again as it is now:
--
--   the link    not taken back, paused, run out or locked, as before;
--   the sharer  still in the household, still somebody who may share
--               (an owner or an adult: a teen never sends a document out
--               of the house, A18), and still able to see the collection;
--   the collection
--               not deleted and not Only me: narrowing it to its maker
--               alone, or deleting it, ends its links;
--   each item   still in the collection, out of the Trash, with a file, and
--               one the sharer can see now. One that fails is simply not
--               given: nothing says it was there.
--
-- A link that follows its collection (follow_collection, A19) also gives
-- what is put in the collection after it was made. Whether a document
-- follows is decided once, as it is put in (the 5.19 review), and written
-- into the link's snapshot as `followed` — never worked out again at each
-- request, where narrowing the collection or widening a document would
-- send out what was held back. It follows only when an owner or an adult
-- puts it in (a teen's never go outside, A18), it is not private, the whole
-- of the audience the link was made for (follow_audience) and of the
-- collection's audience now may see it, and it was not in the collection
-- when the link was made (what the sharer left unticked is kept as
-- `left_out`, and never follows, however it is taken out and put back).
-- Every request still checks each one as it is now, and a later change only
-- ever takes away. Such a link lasts 30 days at most.
--
-- The same rules are ShareService's (apps/api/src/documents/shares.ts);
-- this is the second wall under them, as 0030 is for a document's link.
--
-- And, from the 5.6 review: a link reaches only what its page needs, in
-- every table. Until now the household's other tables — the people, who
-- signs in, the activity log — answered a link through the tenant rule
-- alone. Here each of them gets a rule that takes rows away from a link and
-- from nobody else (`case app_actor() when 'link' then … else true end`:
-- every other caller keeps exactly what it had). A link reads its
-- household (the page names it), its sharer's member and membership (the
-- page names them, and the check reads the sharer's role), the keys and
-- the places that hold its files, and nothing else; and writes only its
-- own lines in the activity log, whose chain it reads through
-- audit_chain_head() rather than by reading the log.

-- ------------------------------------------------------------- the link

alter table share_link alter column document_id drop not null;

alter table share_link
  add column collection_id uuid,
  -- A19: what is put in the collection later goes out too.
  add column follow_collection boolean not null default false,
  -- The audience the collection had when a following link was made: what
  -- follows must fit it as well as the collection's now, so narrowing can
  -- only take away (the 5.19 review).
  add column follow_audience text,
  -- Why a collection's link ended without anybody taking it back: its
  -- collection made Only me, or deleted (the family's list says which).
  add column revoked_why text;

alter table share_link
  add constraint share_link_collection_fkey
    foreign key (collection_id, household_id)
    references doc_collection (id, household_id) on delete cascade,
  -- A link is to one document or to one collection, never both or neither.
  add constraint share_link_one_target
    check ((document_id is null) <> (collection_id is null)),
  -- A collection's link is a v2 link's option, as 0037 said it would be.
  add constraint share_link_collection_v2 check (flow = 'v2' or collection_id is null),
  add constraint share_link_follow_v2 check (flow = 'v2' or not follow_collection),
  -- Only a collection's link has anything to follow, and it lasts 30 days at most.
  add constraint share_link_follow_collection check (collection_id is not null or not follow_collection),
  add constraint share_link_follow_30_days
    check (not follow_collection or expires_at <= created_at + interval '30 days'),
  add constraint share_link_follow_audience
    check ((follow_audience is not null) = follow_collection
           and (follow_audience is null or follow_audience in ('everyone', 'teens', 'adults'))),
  add constraint share_link_revoked_why
    check (revoked_why is null
           or (revoked_at is not null and collection_id is not null
               and revoked_why in ('collection_only_me', 'collection_deleted')));

create index share_link_collection_idx on share_link (collection_id) where collection_id is not null;

-- What a link's snapshot names: this link, its household, and its collection.
alter table share_link add constraint share_link_id_household_collection_key
  unique (id, household_id, collection_id);

-- What a link is to, and whether it follows, is fixed when it is made: a
-- link to the lease does not become a link to the will, nor a snapshot a
-- link that follows. Whoever asks, the vault included.
create function share_link_target_fixed() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.document_id is distinct from old.document_id
     or new.collection_id is distinct from old.collection_id
     or new.follow_collection is distinct from old.follow_collection
     or new.follow_audience is distinct from old.follow_audience then
    raise exception 'a link keeps what it was made for'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger share_link_target_fixed before update on share_link
  for each row execute function share_link_target_fixed();

-- ----------------------------------------------------------- the snapshot
--
-- What a collection's link gives, a document at a time, in the collection's
-- order:
--
--   ticked     what its sharer ticked as they made it;
--   followed   what was put in the collection later and was decided, as
--              it was put in, to follow (a link that keeps up with it);
--   left_out   for a link that keeps up with its collection, what was in
--              the collection as it was made and not ticked — so that it
--              never follows, however it is taken out and put back.
--
-- A link reads only the rows of what it gives now (its rule below): what
-- was left out, and what it no longer gives, is not there for it, nor how
-- many there are. A document taken out of the collection is not given (the
-- live check), and one removed from the vault goes from here too.

create table share_link_item (
  share_id      uuid not null,
  household_id  uuid not null references household(id) on delete cascade,
  collection_id uuid not null,
  document_id   uuid not null,
  position      int not null,
  kind          text not null default 'ticked'
    constraint share_link_item_kind check (kind in ('ticked', 'followed', 'left_out')),
  primary key (share_id, document_id),
  foreign key (share_id, household_id, collection_id)
    references share_link (id, household_id, collection_id) on delete cascade,
  foreign key (document_id, household_id) references document (id, household_id) on delete cascade
);
create index share_link_item_document_idx on share_link_item (document_id);

alter table share_link_item enable row level security;
create policy share_link_item_tenant on share_link_item
  using (household_id = app_household()) with check (household_id = app_household());

-- ------------------------------------------ pages that could not be drawn
--
-- 0041 kept, on a view-only link, the one version whose pages the worker's
-- last try could not draw, and when (pages_failed_version, pages_failed_at):
-- said to both ends as "could not be drawn" rather than "being drawn" for
-- ever, and asked for again an hour later. A collection's link has pages of
-- several documents, and any of them can fail while the rest are drawn. So
-- the same record is kept a version at a time, for every view-only link, a
-- document's as well: one row for each version that failed, and when. Its
-- rules are 0041's, now for each version: an hour later it is asked for
-- again; a newer version, an owner turning the link back on, and drawing
-- them, clear it; the version's own previews failing is for good (that is
-- the version's, not this). What 0041's columns held moves here, and they go.

create table share_page_failure (
  household_id uuid not null references household(id) on delete cascade,
  share_id     uuid not null,
  permission   text not null default 'view'
    constraint share_page_failure_view_only check (permission = 'view'),
  document_id  uuid not null references document(id) on delete cascade,
  version_id   uuid not null references document_version(id) on delete cascade,
  failed_at    timestamptz not null default now(),
  primary key (share_id, version_id),
  foreign key (share_id, household_id, permission)
    references share_link (id, household_id, permission) on delete cascade
);
create index share_page_failure_document_idx on share_page_failure (document_id);

alter table share_page_failure enable row level security;
create policy share_page_failure_tenant on share_page_failure
  using (household_id = app_household()) with check (household_id = app_household());

insert into share_page_failure (household_id, share_id, document_id, version_id, failed_at)
select s.household_id, s.id, v.document_id, s.pages_failed_version, coalesce(s.pages_failed_at, now())
  from share_link s
  join document_version v on v.id = s.pages_failed_version
 where s.pages_failed_version is not null and s.permission = 'view';

alter table share_link drop constraint share_link_pages_view_only;
alter table share_link drop column pages_failed_version, drop column pages_failed_at;

-- --------------------------------------------------- the rules, as SQL

-- Whether every one of a collection's audience may see a document of this
-- visibility: withinCollectionAudience in packages/shared/src/shares.ts.
-- Change them together; a test holds them equal. What a link that follows
-- its collection sends later must pass it, and a private document never
-- does. An audience or a visibility this has never heard of is nobody's.
create function collection_audience_sees(aud text, vis text) returns boolean
  language sql immutable parallel safe
  set search_path = pg_catalog, public, pg_temp as
  $$ select case aud
              when 'everyone' then coalesce(vis = 'household', false)
              when 'teens' then coalesce(vis = 'household', false)
              when 'adults' then coalesce(vis in ('household', 'adults'), false)
              else false
            end $$;

-- The asking link, while it may be used at all; otherwise null. A
-- document's link: app_shared_document()'s checks (0037). A collection's:
-- live, its sharer an owner or an adult still in the household who can see
-- the collection, and the collection neither deleted nor Only me. These
-- are ShareService.live()'s checks (shares.ts); change them together. It
-- reads with the owner's rights, as app_shared_document() does.
create function app_live_share() returns uuid
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
                   and (collection_audience_has(maker.role, c.audience)
                        or coalesce(c.owner_member_id = maker.member_id, false)))
              else false
            end $$;
grant execute on function app_live_share() to fdv_app;

-- The documents the asking link gives now. A document's link: its document.
-- A collection's: each document of its snapshot, ticked or followed, that
-- is in the collection now, out of the Trash, has a file, and is one its
-- sharer can see (canSee, with the roles of document.see_adults); one that
-- followed, only while it is still for the whole of the audience the link
-- was made for and of the collection's now (collection_audience_sees).
-- Nothing is decided here that was not decided before: this only takes
-- away. ShareService.liveItems() asks the same; change them together.
create function app_link_documents() returns setof uuid
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
        and exists (select 1 from document_version v where v.document_id = d.id)
        -- What followed was decided as it was put in; now it may only be
        -- taken away: it must still be for the whole of the audience the
        -- link was made for, and of the collection's now.
        and (t.kind = 'ticked'
             or (collection_audience_sees(c.audience, d.visibility::text)
                 and collection_audience_sees(s.follow_audience, d.visibility::text))) $$;
grant execute on function app_link_documents() to fdv_app;

-- The newest version of each of them: the file the page gives.
create function app_link_versions() returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select distinct on (v.document_id) v.id
       from document_version v
      where v.document_id in (select app_link_documents())
      order by v.document_id, v.version_no desc $$;
grant execute on function app_link_versions() to fdv_app;

-- A collection's link, while live: its collection. The page names it.
create function app_link_collection() returns uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.collection_id from share_link s where s.id = app_live_share() $$;
grant execute on function app_link_collection() to fdv_app;

-- Whoever made the asking link, while live: the page names them, and the
-- check reads their role.
create function app_link_sharer() returns uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.created_by from share_link s where s.id = app_live_share() $$;
grant execute on function app_link_sharer() to fdv_app;

-- The name the asking link writes its lines in the activity log under:
-- 'shared link', or 'shared link (<whom it is for>)' — shares.ts record().
-- Asked of the link whether or not it is live: its lock is written as it
-- stops (the 5.19 review).
create function app_link_label() returns text
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select case when nullif(s.recipient_label, '') is null then 'shared link'
                 else 'shared link (' || s.recipient_label || ')' end
       from share_link s
      where s.id = app_share() and s.household_id = app_household() $$;
grant execute on function app_link_label() to fdv_app;

-- Whether a line the asking link writes may be about this: its own document
-- or collection, whether or not it is live (a lock is written as it stops),
-- or a document it gives now (a download, a look at the pages).
create function app_link_may_name(p_type text, p_id uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce((
       select case p_type
                when 'document' then p_id = s.document_id
                                     or p_id in (select app_link_documents())
                when 'collection' then p_id = s.collection_id
                else false
              end
         from share_link s
        where s.id = app_share() and s.household_id = app_household()), false) $$;
grant execute on function app_link_may_name(text, uuid) to fdv_app;

-- The last hash of the caller's own household's activity log, which the
-- next line is chained to (packages/db/src/audit.ts). With the owner's
-- rights, so that a caller who may not read the log — a link — can still
-- write its own line to it; and only for the household the caller is in.
create function audit_chain_head(p_household uuid) returns bytea
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select e.hash
       from audit_event e
      where e.household_id = p_household
        and p_household = app_household()
      order by e.id desc
      limit 1 $$;
grant execute on function audit_chain_head(uuid) to fdv_app;

-- --------------------------------------- the document tables (0030, 0037)

alter policy document_actor on document
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then id in (select app_link_documents())
           else false
         end);

alter policy document_version_actor on document_version
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then id in (select app_link_versions())
           else false
         end);

-- A link sees its own share while it may be used, and no other.
alter policy share_link_actor on share_link
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then id = (select app_live_share())
           else false
         end);

-- Its own pages, of the documents it gives now (0041).
alter policy share_page_actor on share_page
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then share_id = app_share()
                            and document_id in (select app_link_documents())
           else false
         end);

-- The kind of each document it gives: the page names it (0031).
alter policy document_type_actor on document_type
  using (household_id is null
         or case app_actor()
              when 'account' then true
              when 'system' then true
              when 'link' then key in (select d.type_key from document d
                                        where d.id in (select app_link_documents()))
              else false
            end);

-- Its snapshot: read by its own link, while live, and only the rows of what
-- it gives now — not what it was made without, and not what it no longer
-- gives, nor how many (the 5.19 review); made by somebody signed in.
create policy share_link_item_actor on share_link_item as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then share_id = (select app_live_share())
                            and document_id in (select app_link_documents())
           else false
         end);
create policy share_link_item_actor_insert on share_link_item as restrictive for insert
  with check (case app_actor() when 'account' then true when 'system' then true else false end);
create policy share_link_item_actor_update on share_link_item as restrictive for update
  using (case app_actor() when 'account' then true when 'system' then true else false end);
create policy share_link_item_actor_delete on share_link_item as restrictive for delete
  using (case app_actor() when 'account' then true when 'system' then true else false end);

-- Its pages that could not be drawn: read by its own link, of the documents
-- it gives now, while live (its page says so); written by the vault (the
-- worker), and cleared by an owner turning it back on.
create policy share_page_failure_actor on share_page_failure as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then share_id = (select app_live_share())
                            and document_id in (select app_link_documents())
           else false
         end);
create policy share_page_failure_actor_insert on share_page_failure as restrictive for insert
  with check (case app_actor() when 'account' then true when 'system' then true else false end);
create policy share_page_failure_actor_update on share_page_failure as restrictive for update
  using (case app_actor() when 'account' then true when 'system' then true else false end);
create policy share_page_failure_actor_delete on share_page_failure as restrictive for delete
  using (case app_actor() when 'account' then true when 'system' then true else false end);

-- ---------------------------------------------- the collection (0036, 0039)

-- Its link reads the collection (the page names it) and the documents in
-- it that it gives, and changes neither.
alter policy doc_collection_actor on doc_collection
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then id = (select app_link_collection())
           else false
         end);
create policy doc_collection_actor_insert on doc_collection as restrictive for insert
  with check (case app_actor() when 'account' then true when 'system' then true else false end);

alter policy doc_collection_item_actor on doc_collection_item
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then collection_id = (select app_link_collection())
                            and document_id in (select app_link_documents())
           else false
         end);
create policy doc_collection_item_actor_insert on doc_collection_item as restrictive for insert
  with check (case app_actor() when 'account' then true when 'system' then true else false end);
create policy doc_collection_item_actor_update on doc_collection_item as restrictive for update
  using (case app_actor() when 'account' then true when 'system' then true else false end);
create policy doc_collection_item_actor_delete on doc_collection_item as restrictive for delete
  using (case app_actor() when 'account' then true when 'system' then true else false end);

-- ------------------------------------ the household's other tables (5.6)
--
-- Each rule here takes rows away from a link, and from nobody else.

-- What the page names: the household (its tenant rule gives only its own),
-- whoever made the link, and their membership. Read, never written.
create policy household_link_insert on household as restrictive for insert
  with check (case app_actor() when 'link' then false else true end);
create policy household_link_update on household as restrictive for update
  using (case app_actor() when 'link' then false else true end);
create policy household_link_delete on household as restrictive for delete
  using (case app_actor() when 'link' then false else true end);

create policy account_household_link on account_household as restrictive
  using (case app_actor()
           when 'link' then account_id = (select app_link_sharer())
           else true
         end);
create policy account_household_link_insert on account_household as restrictive for insert
  with check (case app_actor() when 'link' then false else true end);
create policy account_household_link_update on account_household as restrictive for update
  using (case app_actor() when 'link' then false else true end);
create policy account_household_link_delete on account_household as restrictive for delete
  using (case app_actor() when 'link' then false else true end);

create policy member_link on member as restrictive
  using (case app_actor()
           when 'link' then id in (select ah.member_id from account_household ah
                                    where ah.account_id = (select app_link_sharer()))
           else true
         end);
create policy member_link_insert on member as restrictive for insert
  with check (case app_actor() when 'link' then false else true end);
create policy member_link_update on member as restrictive for update
  using (case app_actor() when 'link' then false else true end);
create policy member_link_delete on member as restrictive for delete
  using (case app_actor() when 'link' then false else true end);

-- What opens its files: the key each is wrapped under, and the place it is
-- kept. Read, never written.
create policy scope_key_link on scope_key as restrictive
  using (case app_actor()
           when 'link' then id in (select v.wrapped_by_scope from document_version v
                                    where v.id in (select app_link_versions()))
           else true
         end);
create policy scope_key_link_insert on scope_key as restrictive for insert
  with check (case app_actor() when 'link' then false else true end);
create policy scope_key_link_update on scope_key as restrictive for update
  using (case app_actor() when 'link' then false else true end);
create policy scope_key_link_delete on scope_key as restrictive for delete
  using (case app_actor() when 'link' then false else true end);

create policy vault_link on vault as restrictive
  using (case app_actor()
           when 'link' then id in (select v.vault_id from document_version v
                                    where v.id in (select app_link_versions()))
           else true
         end);
create policy vault_link_insert on vault as restrictive for insert
  with check (case app_actor() when 'link' then false else true end);
create policy vault_link_update on vault as restrictive for update
  using (case app_actor() when 'link' then false else true end);
create policy vault_link_delete on vault as restrictive for delete
  using (case app_actor() when 'link' then false else true end);

-- The activity log: a link reads none of it, and writes only its own
-- lines — somebody opened it, looked, downloaded, or it locked — each
-- naming its own share and nobody signed in.
create policy audit_event_link on audit_event as restrictive for select
  using (case app_actor() when 'link' then false else true end);
-- Its own lines, and only as its own (the 5.19 review): about its own
-- document or collection, or a document it gives; under its own name; and
-- chained to the log's head, as appendAudit chains every line, within a
-- few minutes of now.
create policy audit_event_link_insert on audit_event as restrictive for insert
  with check (case app_actor()
                when 'link' then actor_account_id is null
                                 and action in ('share.opened', 'share.viewed',
                                                'share.downloaded', 'share.locked')
                                 and detail->>'share_id' = app_share()::text
                                 and actor_label is not distinct from app_link_label()
                                 and object_type in ('document', 'collection')
                                 and app_link_may_name(object_type, object_id)
                                 and prev_hash is not distinct from audit_chain_head(household_id)
                                 and at between clock_timestamp() - interval '15 minutes'
                                            and clock_timestamp() + interval '15 minutes'
                else true
              end);

-- None of the rest is a link's, to read or to write.
create policy session_link on session as restrictive
  using (case app_actor() when 'link' then false else true end);
create policy household_profile_link on household_profile as restrictive
  using (case app_actor() when 'link' then false else true end);
create policy invitation_link on invitation as restrictive
  using (case app_actor() when 'link' then false else true end);
create policy owner_change_request_link on owner_change_request as restrictive
  using (case app_actor() when 'link' then false else true end);
create policy known_device_link on known_device as restrictive
  using (case app_actor() when 'link' then false else true end);
create policy notification_digest_link on notification_digest as restrictive
  using (case app_actor() when 'link' then false else true end);
create policy device_link on device as restrictive
  using (case app_actor() when 'link' then false else true end);
create policy smtp_settings_link on smtp_settings as restrictive
  using (case app_actor() when 'link' then false else true end);
create policy notification_preference_link on notification_preference as restrictive
  using (case app_actor() when 'link' then false else true end);
create policy suggestion_dismissal_link on suggestion_dismissal as restrictive
  using (case app_actor() when 'link' then false else true end);
create policy client_event_receipt_link on client_event_receipt as restrictive
  using (case app_actor() when 'link' then false else true end);

-- ------------------------------------------ the sign-ins, which no link needs
--
-- Accounts, their credentials, reset links and passkey challenges belong
-- to no household, so they had no rule at all: every caller read them.
-- Every caller still does, but a link.

alter table account enable row level security;
create policy account_not_a_link on account
  using (case app_actor() when 'link' then false else true end);

alter table credential enable row level security;
create policy credential_not_a_link on credential
  using (case app_actor() when 'link' then false else true end);

alter table password_reset enable row level security;
create policy password_reset_not_a_link on password_reset
  using (case app_actor() when 'link' then false else true end);

alter table webauthn_challenge enable row level security;
create policy webauthn_challenge_not_a_link on webauthn_challenge
  using (case app_actor() when 'link' then false else true end);
