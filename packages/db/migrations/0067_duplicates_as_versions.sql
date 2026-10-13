-- Duplicates as versions (0.8.0, S1; CAP-08).
--
-- A batch's item may be filed as a new version of a document its uploader
-- may change — the same paper, or its renewal — instead of as a new
-- document. Which documents are near matches is worked out as the item is
-- asked for, from what its pages proposed (sealed, 0063) and the documents
-- the uploader can see: nothing of it is stored. What is stored is only
-- what an Undo needs (0064's, for ACCEPT_UNDO_MINUTES):
--
--   as_version    the item was filed into a document that was there
--                 before: an Undo takes back its version, never the
--                 document;
--   prior_sealed  what that accept changed on the document — its number and
--                 dates as they were, which of its reminders it resolved and
--                 how its derived ones stood — sealed under the item's own
--                 file key, bound to the item and the version it added
--                 (@fdv/crypto itemPriorBinding). Never plain; and let go by
--                 the worker's nightly sweep once its Undo can no longer be
--                 asked (`undo_until` passed).
--
-- What the database holds to, whatever the API asks:
--
--  - `as_version` is true exactly when the document filed into was there
--    before the transaction that files it (its `created_at` is not this
--    transaction's): an item filed into somebody's document is never taken
--    back as if it had made it, which would remove the whole document.
--  - `prior_sealed` only beside `as_version`.
--  - Taken back, an item filed as a version lets go of it, and its version
--    goes in the same transaction (incoming_file_undone_document_gone, at
--    commit) — the document stays.
--  - Its uploader writes down only that version's own objects to delete —
--    its file and what was drawn beside it — and the item's own old object
--    (purge_leftover_actor): never another version's, nor the document's.
--  - Whether that version has reached anybody but its uploader since it was
--    filed is asked of the database with its owner's rights
--    (`incoming_file_version_reached`), as 0064's is for a document.

alter table incoming_file
  add column as_version boolean not null default false,
  add column prior_sealed bytea,
  add constraint incoming_file_as_version_accepted
    check (not as_version or (state = 'accepted' and batch_id is not null)),
  add constraint incoming_file_prior_with_version
    check (prior_sealed is null or as_version);

-- 0065's, as it stands, word for word; and (S1) an accept says whether it
-- filed a new version of a document that was there before — the database
-- checks it — with what it changed on it, sealed; an Undo lets go of both.
create or replace function incoming_file_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  decision constant text[] := array['state', 'decided_by', 'decided_at', 'document_id',
                                    'version_id', 'original_name', 'sender_note', 'sha256',
                                    'proposals_sealed', 'text_sealed', 'undo_until',
                                    'as_version', 'prior_sealed'];
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
       -- a new version of a document there before saying so (S1).
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
                       and v.xmin = pg_current_xact_id()::xid)
        and (new.prior_sealed is null or new.as_version)
        and (old.batch_id is null and not new.as_version
             or old.batch_id is not null
                and new.as_version = exists (select 1 from document d
                                              where d.id = new.document_id
                                                and d.created_at <> now())))
       -- Refused, or removed: nothing filed; its name, its note and its hash go.
       or (new.state = 'rejected'
           and new.document_id is null and new.version_id is null
           and new.undo_until is null
           and not new.as_version and new.prior_sealed is null
           and new.original_name is null and new.sender_note is null
           and new.sha256 is null)
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

-- An item taken back lets go of what it became, and that goes in the same
-- transaction: the document it made (0064), or the version it added to a
-- document that was there before (S1), whose document stays. Held at
-- commit, so neither is ever kept beside the item waiting to be filed
-- again. The vault's own sweeps never take an item back.
create or replace function incoming_file_undone_document_gone() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if old.state = 'accepted' and new.state <> 'accepted' then
    if old.as_version then
      if old.version_id is not null
         and exists (select 1 from document_version v where v.id = old.version_id) then
        raise exception 'an item taken back must take its version with it'
          using errcode = 'insufficient_privilege';
      end if;
    elsif old.document_id is not null
          and exists (select 1 from document d where d.id = old.document_id) then
      raise exception 'an item taken back must take its document with it'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return null;
end $$;

-- 0064's, as it stands, but never about an item filed as a version (S1):
-- that one's document stays, and is asked about by the function below.
create or replace function incoming_file_document_reached(p_document uuid) returns boolean
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
                       and not f.as_version
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

-- Whether a version added from a batch (S1) has reached anybody but its
-- uploader since: for the uploader alone, about an item of theirs filed as
-- that version and still to be taken back (null to anybody else, or about
-- anything else). Asked with the item, the document's links and pages, the
-- document and its versions held by the caller (as 0064's); this then holds
-- every row that goes with the version, and the document's reminders, in
-- one order, and only then the household's log (appendAudit's lock).
--
-- Since it was filed — after the line that says it was added — anything
-- about the document by anybody else, or from outside; a link made to it,
-- or used on it; a page of the version a link drew, or tried to; a phone of
-- somebody else's that kept the version; somebody else putting it in a
-- collection, or making a reminder of it, or answering one; an export of
-- the vault by somebody else, begun since or still going.
create function incoming_file_version_reached(p_version uuid) returns boolean
  language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  hh constant uuid := app_household();
  acct constant uuid := app_account();
  doc uuid;
  since timestamptz;
  since_line bigint;
  no int;
begin
  if app_actor() is distinct from 'account' then
    return null;
  end if;
  select f.document_id, f.decided_at into doc, since
    from incoming_file f
   where f.household_id = hh
     and f.version_id = p_version
     and f.state = 'accepted'
     and f.batch_id is not null
     and f.as_version
     and f.undo_until > now()
     and f.decided_by = acct
     and f.requester_member_id = app_member();
  if doc is null then
    return null;
  end if;
  select v.version_no into no from document_version v where v.id = p_version;
  -- Every row that goes with the version, held first; and the document's reminders.
  perform 1 from reminder where document_id = doc order by id for update;
  perform 1 from share_page where version_id = p_version
   order by share_id, version_id, n for update;
  perform 1 from share_page_failure where version_id = p_version
   order by share_id, version_id for update;
  perform 1 from document_text where version_id = p_version for update;
  perform 1 from document_text_sealed where version_id = p_version for update;
  perform 1 from offline_fill where version_id = p_version
   order by session_id, version_id for update;
  perform 1 from upload_idempotency where version_id = p_version
   order by idempotency_key for update;
  -- Then the log, as appendAudit takes it.
  perform pg_advisory_xact_lock(hashtext('audit:' || hh::text));
  -- The line that said it was added, by them: everything after it is since.
  select max(e.id) into since_line
    from audit_event e
   where e.household_id = hh
     and e.object_type = 'document' and e.object_id = doc
     and e.action = 'document.version_added'
     and e.actor_account_id = acct
     and (e.detail ->> 'version_no')::int = no;
  if since_line is null then
    return true;
  end if;
  return exists (select 1 from share_page s where s.version_id = p_version)
      or exists (select 1 from share_page_failure s where s.version_id = p_version)
      or exists (select 1 from offline_fill o
                   join session s on s.id = o.session_id
                  where o.version_id = p_version and s.account_id is distinct from acct)
      or exists (select 1 from share_link l where l.document_id = doc and l.created_at >= since)
      or exists (select 1 from share_session_use u where u.document_id = doc and u.used_at >= since)
      or exists (select 1 from audit_event e
                  where e.household_id = hh and e.id > since_line
                    and e.object_type = 'document' and e.object_id = doc
                    and (e.actor_account_id is distinct from acct or e.actor_label is not null))
      or exists (select 1 from audit_event e
                  where e.household_id = hh and e.id > since_line
                    and e.object_type = 'reminder'
                    and e.object_id in (select m.id from reminder m where m.document_id = doc)
                    and (e.actor_account_id is distinct from acct or e.actor_label is not null))
      or exists (select 1 from doc_collection_item i
                  where i.document_id = doc and i.added_at >= since
                    and i.added_by is distinct from acct)
      or exists (select 1 from reminder m
                  where m.document_id = doc and m.created_at >= since
                    and m.created_by is not null and m.created_by <> acct)
      or exists (select 1 from export x
                  where x.household_id = hh
                    and x.requested_by is distinct from acct
                    and (x.created_at >= since or x.state in ('queued', 'running')));
end $$;

-- Its uploader's Undo asks it, through the application role alone.
revoke execute on function incoming_file_version_reached(uuid) from public;
grant execute on function incoming_file_version_reached(uuid) to fdv_app;

-- 0064's: what is left of a removal, written down by an owner removing a
-- document, the vault itself, and the uploader taking back a document
-- Accept all Ready filed — that document's own objects. And (S1) the
-- uploader taking back a version they added from a batch, in time, while
-- its item still names it: that version's own file and what is drawn
-- beside it (its pages, its thumbnail), and the item's own old object and
-- its pages — never another version of the document, nor the document's.
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
                    or (f.as_version
                        and exists (select 1 from document_version v
                                     where v.id = f.version_id
                                       and v.vault_id = purge_leftover.vault_id
                                       and (starts_with(purge_leftover.object_key,
                                                        v.storage_key || '.')
                                            or purge_leftover.object_key = v.storage_key
                                            or purge_leftover.object_key = v.thumbnail_key)))
                    or (not f.as_version
                        and (exists (select 1 from document_version v
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
                                           and u.temp_vault_id = purge_leftover.vault_id)))))
           when 'system' then true
           when 'upload' then false
           else false
         end);
