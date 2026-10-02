-- Removing a document for good (iteration 5.24).
--
-- Nothing empties the Trash by itself (5.1, D1). An owner may remove a
-- document in it for good: at once, one they filed (created_by) or one that
-- belongs to them (owner_member_id); anybody else's only 24 hours after
-- whoever filed it was told, and only while it is still in the Trash. The
-- first call asks, and the filer and the other owners are told then:
-- purge_requested_at and purge_requested_by, below, which Bring it back
-- clears. The 24 hours count from that moment, on the database's clock —
-- never from before this upgrade, so a document trashed long before it
-- lands cannot be removed by another owner the moment it does.
--
-- A removal (apps/api/src/documents/purge.ts) is one transaction: every
-- object the document owns — each version's file, its thumbnail, its page
-- previews and any link's pages — is written down to be deleted
-- (purge_leftover, below), the tombstone is written and the row deleted,
-- every foreign key to it cascading (fk-cascade.test.ts holds them to
-- that), then the line in the activity log. The objects are deleted after,
-- each row going with its object, a missing one being fine. A crash leaves
-- those rows, to be finished, never files that nothing names.
--
-- The tombstone. A line in the activity log about a document is shown to
-- whoever may see the document now, as its live row says (5.6). With the
-- row gone nothing would say, and the log — append-only, hashed — keeps
-- every line about it: "made a link to … for the divorce lawyer". So the
-- row leaves behind who could see it, its visibility and its owner, and the
-- collections' links whose snapshot named it (a collection's link is told
-- of only to whoever can see everything it was made with, 5.19). Written by
-- the removing owner in the same transaction, while the row is there to be
-- checked against; never changed or removed after, but with its household.
-- A line about a document with neither a row nor a tombstone is nobody's.
--
-- And a backup holds only the database (backup.ts): restoring one made
-- before a removal brings back rows whose files are gone. The restore marks
-- each such version (file_removed_at), lists them, and the document says
-- "The file was removed for good" rather than failing.
--
-- No new index: the Trash is read by document_household_idx (0006), and a
-- household's tombstones are few.

-- ------------------------------------------------------- the request

alter table document
  add column purge_requested_at timestamptz,
  add column purge_requested_by uuid references account(id),
  add constraint document_purge_request_whole
    check ((purge_requested_at is null) = (purge_requested_by is null)),
  -- Asked of a document in the Trash, and only while it is there: bringing
  -- it back clears the request, or is refused.
  add constraint document_purge_request_in_trash
    check (purge_requested_at is null or deleted_at is not null);

-- Who may ask, as the database holds it: somebody signed in asks only as an
-- owner, in their own name, and now — the time the 24 hours count from is
-- the moment they asked, never one written in. Clearing it is whoever may
-- bring the document back. The vault itself is not asked.
create function document_purge_request_owner() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  asked boolean;
begin
  if tg_op = 'INSERT' then
    asked := new.purge_requested_at is not null;
  else
    asked := new.purge_requested_at is not null
             and (new.purge_requested_at is distinct from old.purge_requested_at
                  or new.purge_requested_by is distinct from old.purge_requested_by);
  end if;
  if asked and app_actor() = 'account'
     and (app_role() is distinct from 'owner'
          or new.purge_requested_by is distinct from app_account()
          or new.purge_requested_at is distinct from now()) then
    raise exception 'only an owner asks, as themselves and now, to remove a document for good'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger document_purge_request_owner before insert or update on document
  for each row execute function document_purge_request_owner();

-- --------------------------------------- a file a restore found gone

-- Set by a restore (apps/worker/src/jobs/restore.ts) on a version whose
-- object is not where it is kept, in a place that clearly holds the rest:
-- removed for good after the backup was made. Cleared once the object is
-- there again: by the worker's recheck-files, or by a removal that looks
-- for it first (removed-files.ts, purge.ts).
alter table document_version add column file_removed_at timestamptz;

-- --------------------------------------------------------- the tombstone

create table document_tombstone (
  -- The document's own id. No foreign key: it outlives the row.
  id              uuid primary key,
  household_id    uuid not null references household(id) on delete cascade,
  visibility      visibility not null,
  owner_member_id uuid references member(id) on delete set null,
  -- The collections' links whose snapshot named it, ticked or followed.
  link_ids        uuid[] not null default '{}',
  removed_at      timestamptz not null default now()
);

alter table document_tombstone enable row level security;
create policy document_tombstone_tenant on document_tombstone
  using (household_id = app_household()) with check (household_id = app_household());

-- Read by the family, as the document's own rows are (0030): the activity
-- log and the list of links decide, line by line, whom it allows. The vault
-- itself reads it. A share link, an upload link, a signed-out page and a
-- caller who says nothing read none of it.
create policy document_tombstone_actor on document_tombstone as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

-- Written by an owner, of a document in the Trash that is still there to be
-- checked against: its visibility and its owner as the row has them, and at
-- least every collection's link whose snapshot names it — more only hides
-- more, never less. The vault itself may. Nobody else writes one.
create policy document_tombstone_actor_insert on document_tombstone as restrictive for insert
  with check (case app_actor()
                when 'account' then
                  app_role() = 'owner'
                  and exists (select 1 from document d
                               where d.id = document_tombstone.id
                                 and d.household_id = document_tombstone.household_id
                                 and d.deleted_at is not null
                                 and d.visibility = document_tombstone.visibility
                                 and d.owner_member_id is not distinct from
                                       document_tombstone.owner_member_id)
                  and document_tombstone.link_ids @> array(
                        select t.share_id from share_link_item t
                         where t.document_id = document_tombstone.id
                           and t.kind in ('ticked', 'followed'))
                when 'system' then true
                else false
              end);

-- Never changed, never removed: the household's own going takes them.
revoke update, delete on document_tombstone from fdv_app;

-- ------------------------------------------- what is still to be deleted
--
-- A removal deletes the document's rows in one transaction, and with them
-- writes down here every object they owned; the objects are deleted after,
-- each row going as its object does (the 5.24 review, M524-2). A removal
-- that stops part-way — storage out of reach, a crash — leaves rows here to
-- finish, never a document that can be brought back with half its files.
-- The worker's `purge.leftovers` finishes them: when a removal could not,
-- and every night. The object's key is all that is kept: its file key went
-- with the document, so what is left in storage cannot be read.

create table purge_leftover (
  id               bigserial primary key,
  household_id     uuid not null references household(id) on delete cascade,
  vault_id         uuid not null references vault(id) on delete cascade,
  object_key       text not null,
  -- The document removed. No foreign key: it is gone.
  removed_document uuid not null,
  created_at       timestamptz not null default now(),
  tries            int not null default 0,
  last_error       text,
  unique (vault_id, object_key)
);

alter table purge_leftover enable row level security;
create policy purge_leftover_tenant on purge_leftover
  using (household_id = app_household()) with check (household_id = app_household());

-- An owner removing a document writes down, and clears, its own; the vault
-- itself finishes the rest. Nobody else reads or writes a row of it.
create policy purge_leftover_actor on purge_leftover as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);

-- --------------------------------- what a collection's link gives now

-- 0042's app_link_documents(), as it was, but for one thing: a document of
-- a collection's link has a file to give only when its newest version's
-- file is there — not one a restore found removed for good (the 5.24
-- check, N524S-01). The API's liveItems decides the same. Once
-- recheck-files finds the file back, it is given again.
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
        -- What followed was decided as it was put in; now it may only be
        -- taken away: it must still be for the whole of the audience the
        -- link was made for, and of the collection's now.
        and (t.kind = 'ticked'
             or (collection_audience_sees(c.audience, d.visibility::text)
                 and collection_audience_sees(s.follow_audience, d.visibility::text))) $$;
