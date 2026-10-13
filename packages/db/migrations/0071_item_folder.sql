-- Folder names → suggested details (0.8.0, S2; CAP-11).
--
-- A batch's item may say where it came from under the folder it was added
-- from — a folder chosen or dropped on Add → Many documents, a subfolder of
-- the scanner folder (0068), a computer's watched folder — without the
-- file's own name: "Passports/Ahmed". That says whose a paper is, and what,
-- as plainly as its pages do, so it is kept as they are (0063):
--
--   folder_sealed  the path, sealed under the item's own file key (itself
--                  wrapped under its uploader's member key) and bound to the
--                  item (@fdv/crypto itemFolderBinding): never in a plain
--                  column, the search index or a log. Set where the item's
--                  row is made, and never changed after.
--
-- What it suggests — a kind, whose it is, tags — is worked out as the item
-- is asked for, for its uploader alone, from the kinds, the people and the
-- tags they are given then (@fdv/shared suggestFromFolder): nothing of it is
-- stored. It is shown to its uploader alone, as the item is (0062).
--
-- Accepted, the item keeps it, as it keeps its name, until its batch goes:
-- an Undo (0064, 0067) puts the item back as it was, folder and all.
-- Removed — by its uploader, with its batch, or refused — it goes with the
-- name and the hash.

alter table incoming_file
  add column folder_sealed bytea,
  -- A batch's items only.
  add constraint incoming_file_folder_batch check (folder_sealed is null or batch_id is not null),
  -- Gone once an item is removed.
  add constraint incoming_file_folder_kept
    check (folder_sealed is null or state in ('uploading', 'received', 'accepted')),
  -- A path of 512 characters at most, sealed: bounded here too.
  add constraint incoming_file_folder_size
    check (folder_sealed is null or octet_length(folder_sealed) <= 4096);

-- 0067's, as it stands, word for word; and (S2) where an item came from is
-- kept as it is filed — and taken back with it, as its name is — and let go
-- of with its name as it is removed. Nobody signed in changes it otherwise:
-- every other change compares every column but those it names.
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
                       and v.uploaded_by = app_account()
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
