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
  -- Only a decided file's object goes while its row stays: a waiting one's
  -- goes with its row.
  add constraint incoming_file_removed_decided
    check (object_removed_at is null or state in ('accepted', 'rejected'));

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

-- What somebody signed in may change on a file they are given: deciding a
-- waiting one, once — filed (the document and version it became) or
-- refused — as themselves; saying, once it is decided, that its object is
-- gone; and the database letting go of what it points at as that goes
-- (`on delete set null`): a sender's session ended (a request taken back,
-- or its requester demoted, ends them), a filed document or version
-- removed for good (5.24). Nothing else: whose key, who reviews it, what
-- it is, where it is kept, its previews and its scan are the vault's. A
-- rule cannot say which columns change, so a trigger does, comparing every
-- column but those, so a column added later is the vault's.
create function incoming_file_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  decision constant text[] := array['state', 'decided_by', 'decided_at', 'document_id', 'version_id'];
  pointers constant text[] := array['session_id', 'document_id', 'version_id'];
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  -- What it points at gone: let go of, and nothing else.
  if (to_jsonb(new) - pointers) = (to_jsonb(old) - pointers)
     and (new.session_id is null or new.session_id = old.session_id)
     and (new.document_id is null or new.document_id = old.document_id)
     and (new.version_id is null or new.version_id = old.version_id) then
    return new;
  end if;
  -- Decided already, and its object gone: said once.
  if old.state in ('accepted', 'rejected')
     and old.object_removed_at is null and new.object_removed_at is not null
     and (to_jsonb(new) - 'object_removed_at') = (to_jsonb(old) - 'object_removed_at') then
    return new;
  end if;
  -- Decided: a file sent and waiting, once, by whoever is asking; filed
  -- names what it became, refused names nothing.
  if old.state = 'received' and old.submitted_at is not null
     and new.state in ('accepted', 'rejected')
     and new.decided_by is not distinct from app_account()
     and new.decided_at is not null
     and ((new.state = 'accepted' and new.document_id is not null and new.version_id is not null)
          or (new.state = 'rejected' and new.document_id is null and new.version_id is null))
     and (to_jsonb(new) - decision) = (to_jsonb(old) - decision) then
    return new;
  end if;
  raise exception 'a reviewer may only file or refuse a file waiting for review'
    using errcode = 'insufficient_privilege';
end $$;

create trigger incoming_file_account_writes before update on incoming_file
  for each row execute function incoming_file_account_writes();
