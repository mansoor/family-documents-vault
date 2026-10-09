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
--    ended; at a new object of its own batch; undrawn and unread, with
--    nothing of an earlier read kept — its words, its proposals, why it
--    failed, its takings, its waits on the vault (0063's `read_waits`,
--    `read_waited_since`): counted from nought again; and only
--    if, when the transaction commits, the document it became is gone
--    (`incoming_file_undone_document_gone`, deferred: the row must let go
--    of the document before the document goes, or the document's removal
--    would take the row with it, 0047).
--  - Its uploader writes down what is left of that document to delete, as
--    an owner does, while the item still names it (purge_leftover) — and
--    only that document's own objects: its versions' files and what was
--    drawn beside them, an upload to it never finished, and the item's own
--    old object and its pages, each in the place it is kept (the I3
--    review, P-I3-3).
--  - Whether the document has reached anybody else — a link, a page drawn,
--    a line in the log by somebody else or from outside, somebody else's
--    collection or reminder, a document linked to it — is asked of the
--    database with its owner's rights, by its uploader only, about an item
--    they may still take back (`incoming_file_document_reached`): what a
--    teen is not given still counts, and nothing is said to anybody else
--    (the I3 review, P-I3-1, P-I3-2). One that has is kept.

alter table incoming_file
  add column undo_until timestamptz,
  add constraint incoming_file_undo_accepted
    check (undo_until is null or (state = 'accepted' and batch_id is not null));

-- 0063's, as it stands (its insert policy is untouched, and keeps accounts
-- off every read column): what somebody signed in may change on a file
-- they are given. The same, word for word; an accept may say until when it
-- may be taken back; and an item accepted so goes back to waiting, by its
-- uploader, in time, read from nought again. Nobody signed in reads an
-- item, says it was read, or counts its takings or its waits.
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
                                  'read_attempts', 'read_not_before', 'read_waits',
                                  'read_waited_since', 'text_sealed', 'proposals_sealed'];
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
     and new.read_waits = 0 and new.read_waited_since is null
     and new.text_sealed is null and new.proposals_sealed is null
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

-- Whether a document Accept all Ready filed has reached anybody but its
-- uploader: for the uploader alone, about an item of theirs still to be
-- taken back (null to anybody else, or about anything else). Asked with the
-- document held FOR UPDATE by the caller; this then holds, in one order,
-- every row that goes with it — what a writer of one of them holds before
-- the log, as a snooze holds its reminder — and only then the household's
-- log (appendAudit's lock): nothing that names the document, and no line
-- about it, comes in before the caller commits, and no writer is left
-- holding one of them while it waits for the log the caller holds (the I3
-- check, N2).
create function incoming_file_document_reached(p_document uuid) returns boolean
  language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  hh constant uuid := app_household();
  acct constant uuid := app_account();
  born timestamptz;
begin
  if app_actor() is distinct from 'account'
     or not exists (select 1 from incoming_file f
                     where f.household_id = hh
                       and f.document_id = p_document
                       and f.state = 'accepted'
                       and f.batch_id is not null
                       and f.undo_until > now()
                       and f.decided_by = acct
                       and f.requester_member_id = app_member()) then
    return null;
  end if;
  select d.created_at into born from document d where d.id = p_document;
  -- Every row its removal would take, held first, each table in its key's order.
  perform 1 from document_version where document_id = p_document order by id for update;
  perform 1 from reminder where document_id = p_document order by id for update;
  perform 1 from doc_collection_item where document_id = p_document
   order by collection_id for update;
  perform 1 from share_link_item where document_id = p_document order by share_id for update;
  perform 1 from share_page where document_id = p_document
   order by share_id, version_id, n for update;
  perform 1 from share_page_failure where document_id = p_document
   order by share_id, version_id for update;
  perform 1 from share_session_use where document_id = p_document
   order by session_id, kind for update;
  perform 1 from document_link where a = p_document or b = p_document order by a, b for update;
  perform 1 from private_notice where document_id = p_document order by member_id for update;
  perform 1 from document_text where document_id = p_document order by version_id for update;
  perform 1 from document_text_sealed where document_id = p_document
   order by version_id for update;
  perform 1 from offline_fill o
   where o.version_id in (select v.id from document_version v where v.document_id = p_document)
   order by o.session_id, o.version_id for update;
  perform 1 from upload_idempotency where document_id = p_document
   order by idempotency_key for update;
  -- Then the log, as appendAudit takes it.
  perform pg_advisory_xact_lock(hashtext('audit:' || hh::text));
  return exists (select 1 from share_link l where l.document_id = p_document)
      or exists (select 1 from share_link_item t
                  where t.document_id = p_document and t.kind <> 'left_out')
      or exists (select 1 from share_page s where s.document_id = p_document)
      or exists (select 1 from share_page_failure s where s.document_id = p_document)
      or exists (select 1 from audit_event e
                  where e.household_id = hh
                    and e.object_type = 'document' and e.object_id = p_document
                    and (e.actor_account_id is distinct from acct or e.actor_label is not null))
      -- Its reminders snoozed or acknowledged by somebody else (N2).
      or exists (select 1 from audit_event e
                  where e.household_id = hh
                    and e.object_type = 'reminder'
                    and e.object_id in (select m.id from reminder m
                                         where m.document_id = p_document)
                    and (e.actor_account_id is distinct from acct or e.actor_label is not null))
      or exists (select 1 from doc_collection_item i
                  where i.document_id = p_document and i.added_by is distinct from acct)
      or exists (select 1 from reminder m
                  where m.document_id = p_document and m.created_by is not null
                    and m.created_by <> acct)
      or exists (select 1 from document_link k where k.a = p_document or k.b = p_document)
      -- An export of the vault by somebody else, begun since it was filed:
      -- it may hold the document (the I3 check, N8).
      or exists (select 1 from export x
                  where x.household_id = hh
                    and x.requested_by is distinct from acct
                    and x.created_at >= born);
end $$;

-- Its uploader's Undo asks it, through the application role alone: never
-- anybody else (the I3 check, N5).
revoke execute on function incoming_file_document_reached(uuid) from public;
grant execute on function incoming_file_document_reached(uuid) to fdv_app;

-- 0045's: what is left of a removal, written down and cleared by an owner
-- removing a document, and the vault itself. And (I3) the uploader taking
-- back a document Accept all Ready filed, in time, while its item still
-- names it: that document's own objects alone, each where it is kept — a
-- version's file and what is drawn beside it (its pages, its thumbnail, a
-- link's pages), a file of the document's own, an upload to it never
-- finished, and the item's own old object and its pages.
drop policy purge_leftover_actor on purge_leftover;
create policy purge_leftover_actor on purge_leftover as restrictive
  using (case app_actor()
           when 'account' then
             app_role() = 'owner'
             or exists (
               select 1 from incoming_file f
                where f.document_id = purge_leftover.removed_document
                  and f.state = 'accepted'
                  and f.batch_id is not null
                  and f.undo_until > now()
                  and f.decided_by = app_account()
                  and f.requester_member_id = app_member()
                  and (
                    (purge_leftover.vault_id = f.vault_id
                     and (purge_leftover.object_key = f.storage_key
                          or starts_with(purge_leftover.object_key, f.storage_key || '.p')))
                    or exists (select 1 from document_version v
                                where v.document_id = f.document_id
                                  and v.vault_id = purge_leftover.vault_id
                                  and (starts_with(purge_leftover.object_key, v.storage_key)
                                       or purge_leftover.object_key = v.thumbnail_key
                                       or starts_with(purge_leftover.object_key,
                                                      f.household_id || '/' || f.document_id
                                                        || '/')))
                    or exists (select 1 from upload_idempotency u
                                where u.document_id = f.document_id
                                  and u.temp_key = purge_leftover.object_key
                                  and u.temp_vault_id = purge_leftover.vault_id)))
           when 'system' then true
           when 'upload' then false
           else false
         end);
