-- Many documents at once: batches, their defaults, and your uploads (Phase 6, I1).
--
-- Somebody who may add documents (an owner, an adult, a teen) puts many
-- files in at once: a batch, with defaults for what is filed from it, and
-- its files sent one request at a time. Each file is an item that waits in
-- its uploader's Inbox until they accept it (filed as a document, through
-- the commit every upload goes through) or remove it. Until then it is not a
-- document: nothing searches, lists, reminds or counts it, and nobody but
-- its uploader sees it — not another adult, not an owner (the owner's
-- decision Q3). A batch's defaults fill only what is blank (Q4); reading
-- the pages and proposing is I2's, and the place it fills is here
-- (`read_state`, `proposals_sealed`).
--
-- An item is an incoming file (0044, 0047): one table of files that are not
-- documents yet, encrypted from their first byte under the key of whoever
-- decides them, their pages drawn by the worker, filed by fileIncoming, and
-- removed after 30 days if nobody decides. A file sent through a request
-- names its request; an item names its batch instead (`batch_id`), never
-- both. An item is always its uploader's alone: `review_by` 'me',
-- `requester_member_id` the uploader, under their own member key (`scope`
-- 'member') — so whatever already keeps a person's private things theirs
-- (a reset's hand-over link, member_holds_private) keeps these too.
--
-- What changes for files sent through a request: nothing. Every rule below
-- that is 0044's or 0047's keeps its words for them, and gains a branch for
-- a batch's items only. The household's room for files waiting for review
-- (incoming_room) counts files sent through a request alone: it bounds what
-- strangers can make the vault keep, and an item counted there would let a
-- stranger's refusal say how much somebody of the family had uploaded.

-- ----------------------------------------------------------- the batch

create table intake_batch (
  id                        uuid primary key default gen_random_uuid(),
  household_id              uuid not null references household(id) on delete cascade,
  -- Who made it: their sign-in, and the member they are. Its items are
  -- under that member's key, and theirs alone.
  created_by                uuid not null references account(id),
  member_id                 uuid not null,
  name                      text constraint intake_batch_name
                              check (char_length(name) between 1 and 120),
  -- The defaults: each fills only what is blank on the card (Q4). Whose,
  -- the kind, who can see them (null: as each kind says), where the paper
  -- copies are, a collection, tags, Essential.
  default_owner_member_id   uuid,
  default_type_key          text constraint intake_batch_type
                              check (char_length(default_type_key) between 1 and 64),
  default_visibility        visibility,
  default_physical_location text constraint intake_batch_location
                              check (char_length(default_physical_location) between 1 and 500),
  default_collection_id     uuid references doc_collection(id) on delete set null,
  default_tags              text[] not null default '{}'
                              constraint intake_batch_tags check (cardinality(default_tags) <= 50),
  default_essential         boolean not null default false,
  created_at                timestamptz not null default now(),
  -- Its end: 30 days after it was made (INCOMING_KEEP_DAYS). What is still
  -- undecided then is removed with it, by the worker's daily sweep.
  ends_at                   timestamptz not null,
  constraint intake_batch_thirty_days check (ends_at <= created_at + interval '30 days 5 minutes'),
  constraint intake_batch_uploader_key unique (id, household_id, member_id),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade,
  foreign key (default_owner_member_id, household_id) references member (id, household_id)
    on delete set null (default_owner_member_id)
);
create index intake_batch_member_idx on intake_batch (household_id, member_id, created_at desc);
create index intake_batch_ends_idx on intake_batch (ends_at);

alter table intake_batch enable row level security;

create policy intake_batch_tenant on intake_batch
  using (household_id = app_household()) with check (household_id = app_household());

-- Its uploader's alone (Q3): somebody signed in who may add documents, and
-- is the member who made it — never another adult, never an owner, never
-- a teen or a viewer who did not make it; and the vault itself. No link of
-- either kind, no signed-out page. A batch is made, changed and removed by
-- its uploader too (the same rule, with no WITH CHECK, holds what is
-- written).
create policy intake_batch_actor on intake_batch as restrictive
  using (case app_actor()
           when 'account' then app_role() in ('owner', 'adult', 'teen')
                               and member_id = app_member()
           when 'system' then true
           else false
         end);
-- Made by somebody signed in as themselves.
create policy intake_batch_actor_insert on intake_batch as restrictive for insert
  with check (case app_actor()
                when 'account' then created_by = app_account()
                when 'system' then true
                else false
              end);

-- What its uploader may change: its name and its defaults; and its end,
-- brought to now as they remove it, so nothing more can be sent to it
-- while what is in it is removed (the I1 review) — never later. Who made
-- it, and when, are fixed. A rule cannot say which columns change, so a
-- trigger does; it compares every column but those, so a column added
-- later is fixed too.
create function intake_batch_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() = 'account'
     and ((to_jsonb(new) - array['name', 'default_owner_member_id', 'default_type_key',
                                 'default_visibility', 'default_physical_location',
                                 'default_collection_id', 'default_tags', 'default_essential',
                                 'ends_at'])
          is distinct from
          (to_jsonb(old) - array['name', 'default_owner_member_id', 'default_type_key',
                                 'default_visibility', 'default_physical_location',
                                 'default_collection_id', 'default_tags', 'default_essential',
                                 'ends_at'])
          or (new.ends_at is distinct from old.ends_at
              and new.ends_at is distinct from least(old.ends_at, now())))
  then
    raise exception 'an uploader may change only a batch''s name and defaults, or end it now'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger intake_batch_account_writes before update on intake_batch
  for each row execute function intake_batch_account_writes();

-- ------------------------------------------------- its items: incoming files

alter table incoming_file alter column request_id drop not null;
alter table incoming_file
  add column batch_id uuid,
  -- Read for its details (I2): waiting until then. A batch's items only.
  add column read_state text
    constraint incoming_file_read_state check (read_state in ('waiting', 'reading', 'read', 'failed')),
  -- What I2 proposes from its pages, sealed under the item's own key: a
  -- passport number is a proposal. Gone once it is decided.
  add column proposals_sealed bytea,
  -- The uploader's Idempotency-Key for the file (the I1 review): a file sent
  -- again after its answer was lost is answered with the item it made, not
  -- made twice. A random key the browser chose: it says nothing of the file.
  add column idempotency_key uuid,
  -- Through a request, or in a batch: one, never both.
  add constraint incoming_file_one_way check ((request_id is null) <> (batch_id is null)),
  -- An item is its uploader's alone, under their own key, and carries
  -- nothing a sender's file does.
  add constraint incoming_file_batch_item
    check (batch_id is null
           or (scope = 'member' and review_by = 'me' and not owners_only
               and item_id is null and session_id is null and sender_note is null)),
  add constraint incoming_file_read_batch check ((batch_id is null) = (read_state is null)),
  add constraint incoming_file_proposals_batch check (proposals_sealed is null or batch_id is not null),
  add constraint incoming_file_key_batch check (idempotency_key is null or batch_id is not null),
  add constraint incoming_file_batch_fkey
    foreign key (batch_id, household_id, requester_member_id)
    references intake_batch (id, household_id, member_id) on delete cascade;
create index incoming_file_batch_idx on incoming_file (batch_id) where batch_id is not null;
-- One item a key, in a batch.
create unique index incoming_file_batch_key_idx on incoming_file (batch_id, idempotency_key)
  where idempotency_key is not null;
-- Duplicates by SHA-256 (I1): among an uploader's items, and the documents' versions.
create index incoming_file_batch_sha_idx on incoming_file (requester_member_id, sha256)
  where batch_id is not null;
create index document_version_sha256_idx on document_version (household_id, sha256);

-- 0044's rule for each kind of caller, with a batch's items: its uploader's
-- alone, while they may add documents (a teen included, as for a single
-- add). A file sent through a request keeps exactly what it had.
drop policy incoming_file_actor on incoming_file;
create policy incoming_file_actor on incoming_file as restrictive
  using (case app_actor()
           when 'account' then
             case when batch_id is not null
                  then app_role() in ('owner', 'adult', 'teen')
                       and requester_member_id = app_member()
                  else app_role() in ('owner', 'adult')
                       and case review_by
                             when 'me' then requester_member_id = app_member()
                             when 'adults' then true
                             else false
                           end
             end
           when 'system' then true
           when 'upload' then request_id = app_upload_request() and session_id = app_upload_session()
           else false
         end);

-- Who puts a file in: a sender (and the vault), as 0044 says; and, since
-- I1, somebody signed in, into a batch of their own before its end, on its
-- way, under their own member key, waiting to be read, drawn by nobody yet
-- and scanned by nothing (A42).
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
                                    and told_at is null
                                    and wrapped_by_scope = (select k.id from scope_key k
                                                             where k.kind = 'member'
                                                               and k.member_id = app_member())
                                    and exists (select 1 from intake_batch b
                                                 where b.id = batch_id and b.ends_at > now())
                else false
              end);

-- 0047's: a reviewer never removes a file. An uploader removes an item of
-- their own still on its way, whose sending failed; anything decided stays
-- for the vault to remove.
drop policy incoming_file_account_delete on incoming_file;
create policy incoming_file_account_delete on incoming_file as restrictive for delete
  using (case app_actor()
           when 'account' then batch_id is not null and state = 'uploading'
           else true
         end);

-- 0047's: what somebody signed in may change on a file they are given. The
-- same, and two things more: a batch's item finished by its uploader once
-- its bytes have arrived (its kind, size and hashes, when, and sent at
-- once: an item has no Finish); and what I2 proposed, let go of as it is
-- decided.
create or replace function incoming_file_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  decision constant text[] := array['state', 'decided_by', 'decided_at', 'document_id',
                                    'version_id', 'original_name', 'sender_note', 'sha256',
                                    'proposals_sealed'];
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
  -- proposed for it goes with the decision.
  if old.state = 'received' and old.submitted_at is not null
     and new.decided_by is not distinct from app_account()
     and new.decided_at is not null
     and new.proposals_sealed is null
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

-- 0047's: a decided file's row going while its bytes are not known to be
-- gone leaves them, and every page drawn of it, to purge_leftover. And a
-- batch's item gone undecided — on its way or waiting — the same (the I1
-- review): an uploader's removal, or its batch's, never leaves bytes with
-- nothing to remove them, whatever happens to the removal after it commits.
-- Not the vault's own sweeps: they remove an item's bytes before its row.
create or replace function incoming_file_leaves_bytes() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if old.object_removed_at is null
     and (old.state in ('accepted', 'rejected')
          or (old.batch_id is not null and old.state in ('uploading', 'received')
              and app_actor() is distinct from 'system')) then
    insert into purge_leftover (household_id, vault_id, object_key, removed_document)
    select old.household_id, old.vault_id, k.key, coalesce(old.document_id, old.id)
      from (select old.storage_key as key
            union all
            select old.storage_key || '.p' || n || '.enc' from generate_series(1, 30) n) k
    on conflict (vault_id, object_key) do nothing;
  end if;
  return old;
end $$;

-- 0044's room, counting files sent through a request alone: a batch's
-- items are the family's own, and neither take a stranger's room nor are
-- told of by a stranger's refusal.
create or replace function incoming_room(p_request uuid)
  returns table (household_bytes bigint, request_files int, request_bytes bigint)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce(sum(case when f.state = 'received' then f.byte_size
                              when f.session_id is not null
                               and f.created_at > now() - interval '15 minutes'
                                then f.reserved_bytes
                              else 0 end), 0)::bigint,
            (count(*) filter (where f.request_id = p_request and f.state = 'uploading'
                                and f.session_id is not null
                                and f.created_at > now() - interval '15 minutes'))::int,
            coalesce(sum(f.reserved_bytes) filter (where f.request_id = p_request
                                                     and f.state = 'uploading'
                                                     and f.session_id is not null
                                                     and f.created_at > now() - interval '15 minutes'),
                     0)::bigint
       from incoming_file f
      where f.household_id = app_household()
        and f.batch_id is null
        and f.state in ('uploading', 'received') $$;

-- ------------------------------------------------- keeping something private

-- 0052's question, with a batch: a batch is its uploader's alone, its name
-- and defaults too, so somebody who has one keeps something private (its
-- items, under their member key, are counted as a file sent for them alone
-- to review already). The rest is 0052's, word for word.
create or replace function member_holds_private(p_account uuid) returns boolean
  language plpgsql stable security definer
  set search_path = pg_catalog, public, pg_temp as $$
declare
  hh uuid := app_household();
  m uuid;
begin
  -- Unset is no answer: a caller who says nothing is refused (coalesce).
  if not coalesce((app_actor() = 'account' and app_role() = 'owner')
                  or (app_actor() = 'anonymous' and app_account() = p_account), false) then
    raise exception 'only an owner, or the reset itself, asks what somebody keeps private'
      using errcode = 'insufficient_privilege';
  end if;
  select a.member_id into m
    from account_household a
   where a.account_id = p_account and a.household_id = hh;
  if m is null then
    raise exception 'nobody of this household'
      using errcode = 'insufficient_privilege';
  end if;
  return exists (select 1 from document d
                  where d.household_id = hh and d.owner_member_id = m
                    and d.visibility = 'private')
      or exists (select 1 from document_tombstone t
                  where t.household_id = hh and t.owner_member_id = m
                    and t.visibility = 'private')
      or exists (select 1 from member_identity i
                  where i.household_id = hh and i.member_id = m
                    and i.part = 'only_me')
      or exists (select 1 from upload_request r
                  where r.household_id = hh and r.requester_member_id = m
                    and r.review_by = 'me')
      or exists (select 1 from incoming_file f
                  where f.household_id = hh and f.requester_member_id = m
                    and f.scope = 'member' and f.review_by = 'me')
      or exists (select 1 from intake_batch b
                  where b.household_id = hh and b.member_id = m)
      or exists (select 1 from export e
                  where e.requested_by = p_account and e.state <> 'failed'
                    and (e.expires_at is null or e.expires_at > now()))
      or exists (select 1 from doc_collection c
                  where c.household_id = hh and c.owner_member_id = m
                    and c.audience = 'only_me');
end $$;

-- 0052's guard, with a batch made: it waits for a hand-over link being
-- spent, and a session that reset ended makes none. The rest is 0052's.
create or replace function member_private_gained() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
declare
  who uuid;
  acct uuid;
  ended text;
begin
  if tg_table_name = 'document' then
    if new.visibility = 'private' and new.owner_member_id is not null
       and (tg_op = 'INSERT' or old.visibility is distinct from 'private'
            or old.owner_member_id is distinct from new.owner_member_id) then
      who := new.owner_member_id;
    end if;
  elsif tg_table_name = 'doc_collection' then
    if new.audience = 'only_me' and new.owner_member_id is not null and new.deleted_at is null
       and (tg_op = 'INSERT' or old.audience is distinct from 'only_me'
            or old.owner_member_id is distinct from new.owner_member_id) then
      who := new.owner_member_id;
    end if;
  elsif tg_table_name = 'member_identity' then
    if new.part = 'only_me'
       and (tg_op = 'INSERT' or old.part is distinct from 'only_me'
            or old.member_id is distinct from new.member_id) then
      who := new.member_id;
    end if;
  elsif tg_table_name = 'upload_request' then
    if new.review_by = 'me'
       and (tg_op = 'INSERT' or old.review_by is distinct from 'me'
            or old.requester_member_id is distinct from new.requester_member_id) then
      who := new.requester_member_id;
    end if;
  elsif tg_table_name = 'incoming_file' then
    if new.scope = 'member'
       and (tg_op = 'INSERT' or old.scope is distinct from 'member'
            or old.requester_member_id is distinct from new.requester_member_id) then
      who := new.requester_member_id;
    end if;
  elsif tg_table_name = 'intake_batch' then
    if tg_op = 'INSERT' or old.member_id is distinct from new.member_id then
      who := new.member_id;
    end if;
  elsif tg_table_name = 'export' then
    if tg_op = 'INSERT' then
      acct := new.requested_by;
    end if;
  end if;
  if who is null and acct is null then
    return new;
  end if;
  if who is not null then
    perform 1 from account_household a
     where a.member_id = who and a.household_id = new.household_id
       for share;
  else
    perform 1 from account_household a
     where a.account_id = acct and a.household_id = new.household_id
       for share;
  end if;
  -- The session asking, ended since it was let in (a reset ends them all;
  -- a lock, sign-out everywhere): it gains nothing private now.
  if app_actor() = 'account' then
    select coalesce(s.revoked_reason, '') into ended
      from session s
     where s.id = app_session() and s.revoked_at is not null;
    if found then
      raise exception 'this sign-in has ended'
        using errcode = 'FDV01', detail = ended;
    end if;
  end if;
  return new;
end $$;

create trigger intake_batch_private_gained
  before insert or update of member_id on intake_batch
  for each row execute function member_private_gained();
