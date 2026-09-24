-- An upload key is claimed before the bytes arrive, and committed after.
--
-- Until 0.4.8 the key was only written down once an upload had finished.
-- Two tries of the same capture at once both found nothing and both made
-- a document; a capture whose upload failed left an empty Needs-info
-- document behind, because the document was made first. Now:
--
--  1. Claim: a pending row for the key, holding who asked, for what (a
--     capture or a new version of one document) and a nonce for this try.
--  2. The bytes go to a temporary object named after the key and nonce.
--  3. Commit: one transaction checks the claim is still this try's, makes
--     the document and the version, and marks the key done.
--
-- A failed try deletes its claim and its temporary object, so the same key
-- works again. A try that died without cleaning up leaves a pending claim;
-- after 15 minutes the same account may take it over, and the worker
-- deletes it (and its temporary object) after a day.

alter table upload_idempotency
  add column account_id    uuid references account(id) on delete cascade,
  add column state         text not null default 'done' check (state in ('pending', 'done')),
  add column request_kind  text not null default 'version' check (request_kind in ('capture', 'version')),
  add column claim_nonce   uuid,
  add column claimed_at    timestamptz not null default now(),
  -- Where this try's bytes are while it runs, for whoever cleans up after it.
  add column temp_key      text,
  add column temp_vault_id uuid references vault(id) on delete set null;

-- A capture's document does not exist until the commit.
alter table upload_idempotency alter column document_id drop not null;

-- Keys made before this: whoever uploaded the version made the key. A
-- capture made its document and first version together, a moment apart; a
-- first file added later to a document made without one was a new version.
update upload_idempotency u
   set account_id   = v.uploaded_by,
       request_kind = case
                        when v.version_no = 1 and v.uploaded_at - d.created_at < interval '1 minute'
                          then 'capture'
                        else 'version'
                      end,
       claimed_at   = u.created_at
  from document_version v
  join document d on d.id = v.document_id
 where v.id = u.version_id;

alter table upload_idempotency
  add constraint upload_idempotency_done_has_result
    check (state = 'pending' or (document_id is not null and version_id is not null)),
  add constraint upload_idempotency_pending_has_nonce
    check (state = 'done' or claim_nonce is not null);

-- The worker's two sweeps: stale claims, and done keys past their time.
create index upload_idempotency_state_idx on upload_idempotency (state, claimed_at);
