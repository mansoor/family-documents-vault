-- Incoming: look before it is filed (iteration 5.23).
--
-- A file sent through a request (0044) waits in incoming_file until
-- somebody who may review it looks at it and decides: filed, as a new
-- document or a new version of one (`accepted`, with the version it
-- became), or refused (`rejected`). Nothing is searched, listed, reminded
-- or counted until then: a file waiting is not a document.
--
-- What this adds:
--
--   previews        the worker draws a waiting file's pages, as it draws a
--                   version's (0027), under the same ImageMagick limits,
--                   encrypted under the file's own key beside its object
--                   (`<storage_key>.p<n>.enc`). Only once `scan_state` is no
--                   longer `pending`: this vault scans for nothing (A42), so
--                   the worker writes `unscanned` and the reviewer is told.
--   its object      gone once the file is decided, or purged: filed, its
--                   bytes are copied to the version's own object first.
--                   `object_removed_at` says it is gone, so a removal that
--                   failed is made good by the daily sweep.
--   the owners      a requester who can no longer review (made a teen or a
--                   viewer, their sign-in taken away; locked, from 5.28)
--                   leaves files nobody may open: a review-by-me request's
--                   are its requester's alone (A43). The worker moves them
--                   to the owners: each file's key rewrapped from the
--                   requester's own key to the adults key, the request's
--                   reviewers made `adults` (its files follow, by its key),
--                   and both marked as the owners' alone.
--
-- Every rule here is one of its own, beside 0044's, which it does not
-- change: a rule for each kind of caller that narrows, never widens.

alter table incoming_file
  -- Not drawn yet; being drawn, by one job at a time (since
  -- preview_requested_at: one that died is taken over after an hour);
  -- drawn; a kind the vault does not draw; or drawing failed.
  add column preview_state text not null default 'none'
    constraint incoming_file_preview_state
    check (preview_state in ('none', 'drawing', 'ready', 'unsupported', 'failed')),
  add column preview_requested_at timestamptz,
  -- How many pages were drawn: 30 at most (PREVIEW_MAX_PAGES), as a version's.
  add column preview_pages smallint
    constraint incoming_file_preview_pages check (preview_pages between 0 and 30),
  add column object_removed_at timestamptz,
  -- Moved to the owners from a requester who can no longer review.
  add column owners_only boolean not null default false,
  -- When its reviewers were told it is waiting: told once, by whichever job
  -- gets there (a scan, or the daily sweep after a scan that stopped).
  add column told_at timestamptz,
  -- Only a decided file's object goes while its row stays: a waiting one's
  -- goes with its row.
  add constraint incoming_file_removed_decided
    check (object_removed_at is null or state in ('accepted', 'rejected'));

-- A file refused keeps no name, no note and no fingerprint of what was in
-- it: what stays is that a file of that kind and size came through that
-- request, and who refused it when. (0044 held every file received whole
-- to its hash; one refused is held to the rest.)
alter table incoming_file alter column original_name drop not null;
alter table incoming_file
  add constraint incoming_file_named check (original_name is not null or state = 'rejected'),
  drop constraint incoming_file_received_whole,
  add constraint incoming_file_received_whole
    check (state = 'uploading'
           or (mime is not null and byte_size is not null
               and (sha256 is not null or state = 'rejected')
               and cipher_bytes is not null and cipher_sha256 is not null
               and received_at is not null));

-- What a file filed became goes with it: a document removed for good (5.24)
-- takes the row of the file it was filed from, its name and its note, in
-- the same statement — not a row pointing at nothing. (0044 let go of them,
-- `on delete set null`.)
alter table incoming_file
  drop constraint incoming_file_document_id_fkey,
  add constraint incoming_file_document_id_fkey
    foreign key (document_id) references document (id) on delete cascade,
  drop constraint incoming_file_version_id_fkey,
  add constraint incoming_file_version_id_fkey
    foreign key (version_id) references document_version (id) on delete cascade;

-- A version came from one file at most: a document's history asks which.
create unique index incoming_file_version_key on incoming_file (version_id)
  where version_id is not null;

alter table upload_request
  -- When its files were moved to the owners (and the request with them).
  add column moved_to_owners_at timestamptz;

-- ------------------------------------------------------- the walls

-- A request moved to the owners, and every file of it, are the owners'
-- alone: another adult is not given what was somebody else's to review.
-- Every other caller keeps exactly what 0044 gives it.
create policy upload_request_moved on upload_request as restrictive
  using (case app_actor()
           when 'account' then moved_to_owners_at is null or app_role() = 'owner'
           else true
         end);
create policy incoming_file_moved on incoming_file as restrictive
  using (case app_actor()
           when 'account' then not owners_only or app_role() = 'owner'
           else true
         end);

-- A reviewer never removes a file: refusing one keeps its row, for what the
-- request received and for the activity log. The vault removes them (the
-- daily sweep), and a sender its own before Finish (0044).
create policy incoming_file_account_delete on incoming_file as restrictive for delete
  using (case app_actor() when 'account' then false else true end);

-- What somebody signed in may change on a file they are given:
--
--   deciding it   a waiting one, once, as themselves: filed as the version
--                 this very transaction made of it, in that version's
--                 document, uploaded by them — never pointed at another; or
--                 refused, naming nothing, its name, note and hash let go of;
--   its object    once decided, that its object is gone, said once;
--   a session     the database letting go of a sender's session as it ends
--                 (`on delete set null`: a request taken back, or its
--                 requester demoted, ends them) — only through that
--                 cascade, which fires this from inside another trigger,
--                 never written by hand.
--
-- Nothing else, and never afterwards: where a filed file went is fixed once
-- it is written (a document removed for good takes the row with it). Whose
-- key, who reviews it, what it is, where it is kept, its previews, its scan
-- and its telling are the vault's. A rule cannot say which columns change,
-- so a trigger does, comparing every column but those, so a column added
-- later is the vault's.
create function incoming_file_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  decision constant text[] := array['state', 'decided_by', 'decided_at', 'document_id',
                                    'version_id', 'original_name', 'sender_note', 'sha256'];
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
  -- Decided already, and its object gone: said once.
  if old.state in ('accepted', 'rejected')
     and old.object_removed_at is null and new.object_removed_at is not null
     and (to_jsonb(new) - 'object_removed_at') = (to_jsonb(old) - 'object_removed_at') then
    return new;
  end if;
  -- Decided: a file sent and waiting, once, by whoever is asking.
  if old.state = 'received' and old.submitted_at is not null
     and new.decided_by is not distinct from app_account()
     and new.decided_at is not null
     and (to_jsonb(new) - decision) = (to_jsonb(old) - decision)
     and (
       -- Filed: as the version made of it just now, by them, in that document.
       (new.state = 'accepted'
        and new.original_name is not distinct from old.original_name
        and new.sender_note is not distinct from old.sender_note
        and new.sha256 is not distinct from old.sha256
        and exists (select 1 from document_version v
                     where v.id = new.version_id
                       and v.document_id = new.document_id
                       and v.uploaded_by = app_account()
                       and v.xmin = pg_current_xact_id()::xid))
       -- Refused: nothing filed; its name, its note and its hash go.
       or (new.state = 'rejected'
           and new.document_id is null and new.version_id is null
           and new.original_name is null and new.sender_note is null
           and new.sha256 is null)
     ) then
    return new;
  end if;
  raise exception 'a reviewer may only file or refuse a file waiting for review'
    using errcode = 'insufficient_privilege';
end $$;

create trigger incoming_file_account_writes before update on incoming_file
  for each row execute function incoming_file_account_writes();

-- A decided file's row going while its bytes are not known to be gone — a
-- document filed from it removed for good (5.24) before its own copy was
-- removed — leaves them, and every page drawn of it, to be removed with the
-- rest of what a removal owns (purge_leftover, 0045). Whoever's removal it
-- is: with the owner's rights, as the row is the vault's to account for.
create function incoming_file_leaves_bytes() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if old.state in ('accepted', 'rejected') and old.object_removed_at is null then
    insert into purge_leftover (household_id, vault_id, object_key, removed_document)
    select old.household_id, old.vault_id, k.key, coalesce(old.document_id, old.id)
      from (select old.storage_key as key
            union all
            select old.storage_key || '.p' || n || '.enc' from generate_series(1, 30) n) k
    on conflict (vault_id, object_key) do nothing;
  end if;
  return old;
end $$;

create trigger incoming_file_leaves_bytes before delete on incoming_file
  for each row execute function incoming_file_leaves_bytes();
