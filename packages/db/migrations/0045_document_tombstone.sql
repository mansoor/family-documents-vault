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
-- A removal, in one transaction (apps/api/src/documents/purge.ts): every
-- object the document owns is deleted from storage first — each version's
-- file, its thumbnail, its page previews and any link's pages, a missing
-- one being fine — then the tombstone below is written and the row
-- deleted, every foreign key to it cascading (fk-cascade.test.ts holds them
-- to that), then the line in the activity log. A crash leaves the row, to
-- be removed again, never files that nothing names.
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
-- object is not where it is kept: removed for good after the backup was
-- made. Nothing else writes it.
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
