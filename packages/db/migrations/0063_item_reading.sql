-- The vault reads each item and suggests (Phase 6, I2).
--
-- A batch's item (0062) is read by the worker once its pages are drawn, one
-- at a time a household: its words taken as a filed document's are (5.37),
-- and what they propose — the kind, whose it is, the dates, the number, who
-- issued it, each with a confidence — kept until its uploader decides. Both
-- are sealed under the item's own file key (wrapped under the uploader's
-- member key, as the file is): a passport number is a proposal, so neither
-- is ever in a plain column, nor in the search index, before the item is a
-- document. Once it is decided — accepted, removed, or swept with its batch
-- — they are gone; accepted, its pages are read again as any upload's are.
--
-- `read_state` (0062) says where it is: waiting, reading, read, or failed —
-- and then `read_failure` says why. A read is taken by stamping
-- `read_started_at`; one taken long ago, by a worker that stopped, is taken
-- again, and only the worker that took it last writes what it read. Each
-- taking is counted (`read_attempts`): one that could not be finished — its
-- bytes not to be had, the proposal thread gone — waits behind the others
-- until `read_not_before`, and after a few tries is not read at all (the I2
-- review: one bad item never holds up its household).

alter table incoming_file
  -- Its words, sealed (`item-text:<id>`): kept while it waits.
  add column text_sealed bytea,
  -- Why its pages were not read: blank, a password, not readable as what
  -- it is, too slow to propose from, or a kind the vault does not read.
  add column read_failure text
    constraint incoming_file_read_failure
      check (read_failure in ('blank', 'password', 'unreadable', 'too_slow', 'not_read')),
  -- When the worker took it to read.
  add column read_started_at timestamptz,
  -- How many times it has been taken to read, and, after one that could not
  -- be finished, when it may be taken again.
  add column read_attempts smallint not null default 0
    constraint incoming_file_read_attempts check (read_attempts between 0 and 100),
  add column read_not_before timestamptz,
  add constraint incoming_file_text_batch check (text_sealed is null or batch_id is not null),
  -- A reason only for a read that failed, and a read that failed has one.
  add constraint incoming_file_read_failed
    check (batch_id is null or ((read_failure is not null) = (read_state = 'failed'))),
  -- What was read is kept only while it waits: a decided item holds neither.
  add constraint incoming_file_read_waiting
    check (state = 'received' or (text_sealed is null and proposals_sealed is null));

-- 0062's: who puts an item in. As 0062 says, and with nothing read.
drop policy incoming_file_actor_insert on incoming_file;
create policy incoming_file_actor_insert on incoming_file as restrictive for insert
  with check (case app_actor()
                when 'system' then true
                when 'upload' then request_id = (select app_live_upload_request())
                                   and state = 'uploading'
                when 'account' then batch_id is not null
                                    and state = 'uploading'
                                    and requester_member_id = app_member()
                                    and scan_state = 'unscanned'
                                    and preview_state = 'none'
                                    and read_state = 'waiting'
                                    and proposals_sealed is null
                                    and text_sealed is null
                                    and read_failure is null
                                    and read_started_at is null
                                    and read_attempts = 0
                                    and read_not_before is null
                                    and told_at is null
                                    and wrapped_by_scope = (select k.id from scope_key k
                                                             where k.kind = 'member'
                                                               and k.member_id = app_member())
                                    and exists (select 1 from intake_batch b
                                                 where b.id = batch_id and b.ends_at > now())
                else false
              end);

-- 0062's: what somebody signed in may change on a file they are given. The
-- same, and what was read — its words as well as its proposals — let go of
-- as it is decided. Nobody signed in reads an item, or says it was read.
create or replace function incoming_file_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  decision constant text[] := array['state', 'decided_by', 'decided_at', 'document_id',
                                    'version_id', 'original_name', 'sender_note', 'sha256',
                                    'proposals_sealed', 'text_sealed'];
  arrival constant text[] := array['state', 'mime', 'byte_size', 'sha256', 'cipher_bytes',
                                   'cipher_sha256', 'received_at', 'submitted_at'];
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
       -- Refused, or removed: nothing filed; its name, its note and its hash go.
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

-- The worker's next item to read, a household at a time: waiting, or taken
-- by a worker long gone.
create index incoming_file_batch_read_idx
  on incoming_file (household_id, read_attempts, received_at, id)
  where batch_id is not null and state = 'received' and read_state in ('waiting', 'reading');
