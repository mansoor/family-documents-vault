-- The review queue: Accept all Ready, and taking it back (Phase 6, I3).
--
-- Accept all Ready files every item of a batch that is Ready now, each in
-- a transaction of its own, as a single accept does (0062, 0063): the item
-- accepted, its document and version made by its uploader, its words and
-- proposals let go. And for ACCEPT_UNDO_MINUTES (5) its uploader may take
-- it back into the queue: `undo_until`, stamped by that accept alone.
--
-- Taking it back is one transaction (apps/api/src/uploads/batches.ts):
--
--  1. The item's file copied back, out of the transaction, from the
--     version's object (the same encrypted bytes: filing never encrypts
--     again) to a new object of its batch; its key is still wrapped under
--     the uploader's own member key, bound to the item.
--  2. Held: the item; the document's links and their sessions and pages;
--     the document; its versions. Kept, and said so, if anybody has changed
--     it, made a link to it, added a copy or moved it to the Trash since.
--  3. Every object the document owns written down to be deleted
--     (purge_leftover, 0045), as a removal for good writes them.
--  4. The item waiting again, at its new object: not drawn, not read — the
--     worker draws and reads it again — its decision gone.
--  5. The document's row deleted, everything that names it cascading. No
--     tombstone is written: its lines in the activity log ("added …", into
--     a collection) have neither a row nor a tombstone to be shown by, so
--     they are nobody's (0045's rule, failing closed) — the hashed log keeps
--     them, and shows them to no one. The line saying it was taken back
--     (`batch.accept_undone`) has no audience either.
--
-- What the database holds to, whatever the API asks:
--
--  - `undo_until` only on an accepted item of a batch, set only as it is
--    accepted, by whoever accepts it, at most five minutes (and a little)
--    ahead of the database's clock.
--  - An item goes back to waiting only by its uploader, who accepted it,
--    before `undo_until` on the database's clock, while its batch has not
--    ended; at a new object of its own batch; undrawn and unread; and only
--    if, when the transaction commits, the document it became is gone
--    (`incoming_file_undone_document_gone`, deferred: the row must let go
--    of the document before the document goes, or the document's removal
--    would take the row with it, 0047).
--  - Its uploader writes down what is left of that document to delete, as
--    an owner does, while the item still names it (purge_leftover).

alter table incoming_file
  add column undo_until timestamptz,
  add constraint incoming_file_undo_accepted
    check (undo_until is null or (state = 'accepted' and batch_id is not null));

-- 0063's: what somebody signed in may change on a file they are given. The
-- same; an accept may say until when it may be taken back; and an item
-- accepted so goes back to waiting, by its uploader, in time.
create or replace function incoming_file_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  decision constant text[] := array['state', 'decided_by', 'decided_at', 'document_id',
                                    'version_id', 'original_name', 'sender_note', 'sha256',
                                    'proposals_sealed', 'text_sealed', 'undo_until'];
  arrival constant text[] := array['state', 'mime', 'byte_size', 'sha256', 'cipher_bytes',
                                   'cipher_sha256', 'received_at', 'submitted_at'];
  undone constant text[] := array['state', 'decided_by', 'decided_at', 'document_id',
                                  'version_id', 'undo_until', 'object_removed_at', 'storage_key',
                                  'preview_state', 'preview_requested_at', 'preview_pages',
                                  'read_state', 'read_failure', 'read_started_at',
                                  'read_attempts', 'read_not_before'];
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
       -- a batch's item, until a moment from now, to be taken back (I3).
       (new.state = 'accepted'
        and new.original_name is not distinct from old.original_name
        and new.sender_note is not distinct from old.sender_note
        and new.sha256 is not distinct from old.sha256
        and (new.undo_until is null
             or (old.batch_id is not null
                 and new.undo_until > now()
                 and new.undo_until <= now() + interval '5 minutes 30 seconds'))
        and exists (select 1 from document_version v
                     where v.id = new.version_id
                       and v.document_id = new.document_id
                       and v.uploaded_by = app_account()
                       and v.xmin = pg_current_xact_id()::xid))
       -- Refused, or removed: nothing filed; its name, its note and its hash go.
       or (new.state = 'rejected'
           and new.document_id is null and new.version_id is null
           and new.undo_until is null
           and new.original_name is null and new.sender_note is null
           and new.sha256 is null)
     ) then
    return new;
  end if;
  -- Taken back (I3): accepted by Accept all Ready, by its uploader, in time;
  -- waiting again at a new object of its batch, to be drawn and read again.
  -- That the document it became goes in the same transaction is held at
  -- commit (incoming_file_undone_document_gone, below).
  if old.batch_id is not null and old.state = 'accepted'
     and old.undo_until is not null and old.undo_until > now()
     and old.decided_by is not distinct from app_account()
     and old.requester_member_id is not distinct from app_member()
     and new.state = 'received'
     and new.decided_by is null and new.decided_at is null
     and new.document_id is null and new.version_id is null
     and new.undo_until is null and new.object_removed_at is null
     and new.preview_state = 'none' and new.preview_requested_at is null
     and new.preview_pages is null
     and new.read_state = 'waiting' and new.read_failure is null
     and new.read_started_at is null and new.read_attempts = 0
     and new.read_not_before is null
     and new.storage_key <> old.storage_key
     and starts_with(new.storage_key, old.household_id || '/batches/' || old.batch_id || '/')
     and exists (select 1 from intake_batch b where b.id = old.batch_id and b.ends_at > now())
     and (to_jsonb(new) - undone) = (to_jsonb(old) - undone) then
    return new;
  end if;
  raise exception 'a reviewer may only file or refuse a file waiting for review'
    using errcode = 'insufficient_privilege';
end $$;

-- An item taken back lets go of the document it became, and the document
-- goes in the same transaction: held at commit, so a document is never
-- kept beside the item waiting to be filed again. The vault's own sweeps
-- never take an item back.
create function incoming_file_undone_document_gone() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if old.state = 'accepted' and new.state <> 'accepted' and old.document_id is not null
     and exists (select 1 from document d where d.id = old.document_id) then
    raise exception 'an item taken back must take its document with it'
      using errcode = 'insufficient_privilege';
  end if;
  return null;
end $$;

create constraint trigger incoming_file_undone_document_gone
  after update of state on incoming_file
  deferrable initially deferred
  for each row execute function incoming_file_undone_document_gone();

-- 0045's: what is left of a removal, written down and cleared by an owner
-- removing a document, and the vault itself. And (I3) the uploader taking
-- back a document Accept all Ready filed, in time: its own, while its item
-- still names it.
drop policy purge_leftover_actor on purge_leftover;
create policy purge_leftover_actor on purge_leftover as restrictive
  using (case app_actor()
           when 'account' then
             app_role() = 'owner'
             or exists (select 1 from incoming_file f
                         where f.document_id = purge_leftover.removed_document
                           and f.state = 'accepted'
                           and f.batch_id is not null
                           and f.undo_until > now()
                           and f.decided_by = app_account()
                           and f.requester_member_id = app_member())
           when 'system' then true
           when 'upload' then false
           else false
         end);
