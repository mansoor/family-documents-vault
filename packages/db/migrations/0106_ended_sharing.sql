-- Ended links and requests removed after a while (0.9.0, RQ; the owner's ask
-- of 16 Nov 2026: "remove non-working expired ones after some period. That
-- information will anyways stay in the activity log").
--
--   household.ended_sharing_days   How long a link outside the family (to a
--                       document or a collection) and a request to send
--                       documents are kept once they have ended for good:
--                       30, 90 or 365 days, or null for never. 90 for every
--                       household, new and old. An owner's to change
--                       (household_ended_sharing_rule, as 0093's), the
--                       vault itself, or the owning role (a restore).
--   household.ended_sharing_from   When the keeping began: when this
--                       migration ran (an upgrade, or a restore of a backup
--                       from before it), or the household was made. Its
--                       time counts from the later of this and the moment a
--                       link or request ended, so nothing that ended before
--                       the upgrade goes sooner than the household's time
--                       after it (the review of 0106). Never changed but by
--                       the vault or the owning role.
--
-- Ended for good is what nothing brings back: a link taken back or past its
-- end, a request taken back, closed, or past its end — counted from the
-- earliest of those moments. Paused, used up (a page opened on it lasts to
-- its end) and stopped by wrong codes while still before its end are not:
-- such a link or request waits until its end has passed too. Emergency
-- links (H4) are the person's own and are never removed here.
--
-- The worker removes them each night (jobs/ended-sharing.ts), in batches.
-- What goes, and what stays:
--
--   a link        its sessions, codes, what a session had, its pages' rows
--                 (only once the nightly prune has deleted their files), its
--                 snapshot of what a collection's link was made with, and so
--                 who opened it (H5) as a list of its own. The activity log
--                 keeps every line about it: the lines name it by id, and
--                 nothing in the log has a key to it.
--   a request     its items, sessions and codes, and a refused file's row
--                 (its bytes are gone first). Never while a file it brought
--                 is waiting or on its way, nor while a decided file's bytes
--                 are still to be removed. A file filed from it keeps its row,
--                 let go of the request (below), so a document's history
--                 still says its version was sent through a request link.
--
-- What the activity log needs once the row is gone, kept as a tombstone (as
-- 0045's for a document): whom a request's lines are for, and who made a
-- collection's link and what it was made with. Never its title, message,
-- recipient, address or secret.
--
-- A migration is nobody's edit: no audit event is written.

alter table household add column ended_sharing_days smallint default 90
  constraint household_ended_sharing_days check (ended_sharing_days in (30, 90, 365));
-- now(), for every household there is as it runs, and each made after.
alter table household add column ended_sharing_from timestamptz not null default now();

create function household_ended_sharing_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.ended_sharing_days is distinct from old.ended_sharing_days
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner chooses how long ended links and requests are kept'
      using errcode = 'insufficient_privilege';
  end if;
  if new.ended_sharing_from is distinct from old.ended_sharing_from
     and app_actor() is not null and app_actor() <> 'system' then
    raise exception 'when the keeping of ended links and requests began is the vault''s'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger household_ended_sharing_rule before update on household
  for each row execute function household_ended_sharing_rule();

-- ------------------------------------------------ a request, once removed

-- Whom its lines in the activity log are for, as the request's own rule
-- said (0044, 0047): its requester, or any owner or adult; once moved to
-- the owners, theirs alone. It goes with its requester, as the request did.
create table upload_request_tombstone (
  -- The request's own id. No key to it: it outlives the row.
  id                  uuid primary key,
  household_id        uuid not null references household(id) on delete cascade,
  requester_member_id uuid not null,
  review_by           text not null
                        constraint upload_request_tombstone_review_by
                        check (review_by in ('me', 'adults')),
  moved_to_owners_at  timestamptz,
  removed_at          timestamptz not null default now(),
  foreign key (requester_member_id, household_id) references member (id, household_id)
    on delete cascade
);

alter table upload_request_tombstone enable row level security;
create policy upload_request_tombstone_tenant on upload_request_tombstone
  using (household_id = app_household()) with check (household_id = app_household());

-- Read as the request was (0044's rule, and 0047's for one moved to the
-- owners): its reviewers', and the vault's. Nobody else, and no link of
-- either kind.
create policy upload_request_tombstone_actor on upload_request_tombstone as restrictive
  using (case app_actor()
           when 'account' then app_role() in ('owner', 'adult')
                               and (requester_member_id = app_member() or review_by = 'adults')
                               and (moved_to_owners_at is null or app_role() = 'owner')
           when 'system' then true
           else false
         end);
-- Written by the vault alone, as it removes the request.
create policy upload_request_tombstone_actor_insert on upload_request_tombstone
  as restrictive for insert
  with check (case app_actor() when 'system' then true else false end);

-- Never changed, never removed: the household's own going takes them, and
-- the requester's.
revoke update, delete on upload_request_tombstone from fdv_app;

-- ------------------------------------- a collection's link, once removed

-- Who made it, its collection, and the documents it was made with or has
-- followed — what the activity log asks of a collection's link (5.19) to
-- know whom its lines are for. A document's own link needs none: its lines
-- are the document's.
create table share_link_tombstone (
  -- The link's own id. No key to it: it outlives the row.
  id            uuid primary key,
  household_id  uuid not null references household(id) on delete cascade,
  created_by    uuid not null,
  collection_id uuid not null,
  document_ids  uuid[] not null default '{}',
  removed_at    timestamptz not null default now()
);

alter table share_link_tombstone enable row level security;
create policy share_link_tombstone_tenant on share_link_tombstone
  using (household_id = app_household()) with check (household_id = app_household());

-- Read as the link was (0030's share_link_actor, and 0054's restriction):
-- by the family — the log's own rules decide, line by line, whom a line is
-- for, and need the tombstone to keep a line through a collection's link
-- from whoever was not told of the link (a teen; the review of 0106) — and
-- the vault. No link of either kind. It holds no recipient.
create policy share_link_tombstone_actor on share_link_tombstone as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);
create policy share_link_tombstone_restricted on share_link_tombstone as restrictive
  using (not (select app_restricted())
         or collection_id in (select app_granted_collections()));
create policy share_link_tombstone_actor_insert on share_link_tombstone
  as restrictive for insert
  with check (case app_actor() when 'system' then true else false end);

revoke update, delete on share_link_tombstone from fdv_app;

-- ------------------------------------- a filed file, its request removed

-- A file filed from a request keeps its row once the request is removed:
-- a document's history asks it which request its version came through
-- (5.23). It lets go of the request, its item and its session, and keeps
-- whom the request was for, in the family's words, and when it went. Only
-- a filed file, and only the vault does this (incoming_file_account_writes
-- leaves the vault's writes alone; nobody else can reach these columns).
alter table incoming_file
  add column request_removed_at timestamptz,
  add column request_label text
    constraint incoming_file_request_label check (char_length(request_label) <= 80),
  drop constraint incoming_file_one_way,
  add constraint incoming_file_one_way
    check ((request_id is null) <> (batch_id is null)
           or (request_id is null and batch_id is null and request_removed_at is not null)),
  add constraint incoming_file_request_removed
    check (request_removed_at is null
           or (request_id is null and batch_id is null and state = 'accepted'
               and item_id is null and session_id is null)),
  add constraint incoming_file_request_label_removed
    check (request_label is null or request_removed_at is not null);

-- The worker looks for what ended long ago, household by household.
create index share_link_ended_idx on share_link (household_id, (least(revoked_at, expires_at)))
  where emergency_member_id is null;
create index upload_request_ended_idx
  on upload_request (household_id, (least(revoked_at, closed_at, expires_at)));
