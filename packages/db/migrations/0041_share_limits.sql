-- Until a date and time, view or download, so many opens (iteration 5.18).
--
-- A link made since 5.16 (`flow = 'v2'`) can now say more than "until this
-- day":
--
--   permission     view: the recipient sees the pages, drawn with whom the
--                  link is for and the day it was made (share_page below),
--                  and never the file itself, by any route. download: the
--                  file, as every link gave until now. Every link made
--                  before this migration is download.
--   max_opens      how many times Open may work. One use is one Open that
--                  worked: reloads, pages and the file again inside the
--                  session it gave are free. open_count, which every link
--                  already keeps, is what it is counted against.
--   max_downloads  how many downloads, each document counted once in a
--                  session (share_session_use below), against
--                  downloads_used.
--
-- The end of a link is still expires_at, which the vault now takes as a
-- time as well as a day.
--
-- Each is a v2 link's alone, as 0037 said the later options would be: a
-- legacy link opens on routes that ignore them, so it has none of them
-- (`flow = 'v2' or …`), and 0037 keeps a link's flow for good.

-- ------------------------------------------------------------- the link

alter table share_link
  add column permission text not null default 'download'
    constraint share_link_permission check (permission in ('view', 'download')),
  add column max_opens int
    constraint share_link_max_opens check (max_opens between 1 and 1000),
  add column max_downloads int
    constraint share_link_max_downloads check (max_downloads between 1 and 1000),
  add column downloads_used int not null default 0
    constraint share_link_downloads_used check (downloads_used >= 0);

alter table share_link
  add constraint share_link_permission_v2 check (flow = 'v2' or permission = 'download'),
  add constraint share_link_max_opens_v2 check (flow = 'v2' or max_opens is null),
  add constraint share_link_max_downloads_v2 check (flow = 'v2' or max_downloads is null),
  -- A link to view has nothing to download.
  add constraint share_link_view_downloads check (permission = 'download' or max_downloads is null),
  -- And a limit holds, however many ask at once: the counts are each moved
  -- by one guarded statement (shares.ts), and this is the floor under it.
  add constraint share_link_opens_within check (max_opens is null or open_count <= max_opens),
  add constraint share_link_downloads_within
    check (max_downloads is null or downloads_used <= max_downloads);

-- What a link's pages name: the link, its household, and that it is for
-- viewing.
alter table share_link add constraint share_link_id_household_permission_key
  unique (id, household_id, permission);

-- What a link may change on its own share (0030): its counts of opens (and
-- when), of downloads and of wrong PINs, each only upwards. Its permission
-- and its limits are the sharer's, like everything else on it.
create or replace function share_link_link_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() = 'link' and (
       (to_jsonb(new) - array['open_count', 'last_opened_at', 'attempts', 'downloads_used'])
         is distinct from
       (to_jsonb(old) - array['open_count', 'last_opened_at', 'attempts', 'downloads_used'])
       or new.open_count < old.open_count
       or new.attempts < old.attempts
       or new.downloads_used < old.downloads_used) then
    raise exception 'a share link may only count its opens, downloads and wrong PINs'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- ------------------------------------------------- what a session has had
--
-- A download is counted once per document per session, and written down
-- once (share.downloaded); so is looking at a view-only link's pages
-- (share.viewed). Until 5.18 every fetch of the file wrote a line, so a
-- link could write to the permanent log as often as it was asked. Ends
-- with its session.

alter table share_session add constraint share_session_id_share_key unique (id, share_id);

create table share_session_use (
  household_id uuid not null references household(id) on delete cascade,
  session_id   uuid not null,
  share_id     uuid not null,
  document_id  uuid not null references document(id) on delete cascade,
  kind         text not null constraint share_session_use_kind check (kind in ('viewed', 'downloaded')),
  used_at      timestamptz not null default now(),
  primary key (session_id, document_id, kind),
  foreign key (session_id, share_id) references share_session (id, share_id) on delete cascade
);
create index share_session_use_share_idx on share_session_use (share_id);

alter table share_session_use enable row level security;
create policy share_session_use_tenant on share_session_use
  using (household_id = app_household()) with check (household_id = app_household());

-- A link reaches what its own sessions have had, and writes it down; the
-- family's and the vault's own: every row; nobody else: none.
create policy share_session_use_actor on share_session_use as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then share_id = app_share()
           else false
         end);

-- ----------------------------------------------------- a link's own pages
--
-- A view-only link never gives the file. What it gives are the pages the
-- vault drew of it (0027), drawn again by the worker with whom the link is
-- for and the day it was made across each, encrypted under the version's
-- own file key and kept beside it (`<storage_key>.share-<share>.p<n>.enc`).
-- The first 30 pages, as the previews are: the sharer is told, and so is
-- the recipient. Drawn for the newest version, as the link gives the
-- newest; a newer version is drawn again. When the link ends its pages go
-- (the worker's share.pages.prune), and a restore's paused link has them
-- drawn again when an owner turns it back on.
--
-- Only a link to view has any (the key names its permission).

create table share_page (
  household_id uuid not null references household(id) on delete cascade,
  share_id     uuid not null,
  permission   text not null default 'view' constraint share_page_view_only check (permission = 'view'),
  document_id  uuid not null references document(id) on delete cascade,
  version_id   uuid not null references document_version(id) on delete cascade,
  n            smallint not null constraint share_page_n check (n >= 1),
  storage_key  text not null,
  created_at   timestamptz not null default now(),
  primary key (share_id, version_id, n),
  foreign key (share_id, household_id, permission)
    references share_link (id, household_id, permission) on delete cascade
);
create index share_page_document_idx on share_page (document_id);

alter table share_page enable row level security;
create policy share_page_tenant on share_page
  using (household_id = app_household()) with check (household_id = app_household());

-- A link reads its own pages, while it reaches its document at all
-- (app_shared_document(), 0037): as it reads its share. Drawing and
-- removing them is the vault's, and an owner's turning a link back on.
create policy share_page_actor on share_page as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then share_id = app_share() and document_id = (select app_shared_document())
           else false
         end);
create policy share_page_actor_insert on share_page as restrictive for insert
  with check (case app_actor() when 'account' then true when 'system' then true else false end);
create policy share_page_actor_update on share_page as restrictive for update
  using (case app_actor() when 'account' then true when 'system' then true else false end);
create policy share_page_actor_delete on share_page as restrictive for delete
  using (case app_actor() when 'account' then true when 'system' then true else false end);
