-- When each tag was last put on each document (0.9.0-dev.103): the tag
-- field's "Recently used", and the Documents filter's tags in that order.
--
--   document_tag_use  one row a document and tag it carries: when the tag
--                     was put on it. A tag taken off, its row goes; put on
--                     again, it has a new time. Renamed, the new name is
--                     put on then.
--
-- Why a row a document, not one a tag: a tag is the household's, but when
-- it was last used must be told only of documents the reader can see. A
-- time kept for the tag alone would move when somebody tags their Only me
-- document, and tell everybody else so, in the order of their list. Kept
-- for each document, the API reads it only joined to the documents the
-- reader can see now (row-level security, and the list of tags' own rule
-- for Adults only and Only me), out of the Trash, and only while the
-- document still carries the tag: a tag deleted in Settings → Tags, or no
-- longer on anything they can see, is no longer listed, and its time
-- nowhere else.
--
-- Why not the activity log: a tag's words are never written there (a tag
-- deleted because it held something it should not stays deleted), and a
-- document's edit says which fields changed, not which tags.
--
-- Who writes it: the trigger below, and nothing else, whoever changes a
-- document's tags and however — its page, a list's Tags menu, Add, the
-- Inbox, a batch's defaults, Settings → Tags, a note, a connected app's
-- send, the worker. It runs with the owner's rights, past row-level
-- security, so every one of those is counted the same; it writes only the
-- row's own household and document. The application's role may read it and
-- nothing more (privileges.ts says so too, for a restored database).
--
-- A backup holds the rows as they were; a restore loads them before the
-- trigger is made, so nothing is counted twice. The documents there now
-- are given the time each was last changed, the nearest the vault knows.
-- A migration is nobody's edit: no audit event is written.

create table document_tag_use (
  household_id uuid not null references household(id) on delete cascade,
  document_id  uuid not null,
  -- As the tag is compared (`document.tag_keys`, 0073).
  tag_key      text not null check (tag_key <> ''),
  used_at      timestamptz not null default now(),
  primary key (document_id, tag_key),
  -- The paper removed for good (5.24), its rows go with it.
  foreign key (document_id, household_id) references document (id, household_id) on delete cascade
);

alter table document_tag_use enable row level security;

create policy document_tag_use_tenant on document_tag_use
  using (household_id = app_household()) with check (household_id = app_household());

-- Somebody signed in, and the vault: nobody else — a signed-out page, a
-- share or an upload link, a caller who says nothing. What it says is only
-- ever read beside a document the reader can see.
create policy document_tag_use_actor on document_tag_use as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

-- A restricted viewer (0054): only the rows of the documents they are given,
-- as with everything else that hangs off a document.
create policy document_tag_use_restricted on document_tag_use as restrictive
  using (not (select app_restricted())
         or document_id in (select app_granted_documents()));

-- Nothing of it, read or written, while a transaction acts for an app (0110).
create policy document_tag_use_no_app on document_tag_use as restrictive for all
  using ((select current_setting('app.actor', true)) is distinct from 'connected_app')
  with check ((select current_setting('app.actor', true)) is distinct from 'connected_app');

-- Each tag a document is given is stamped now; each taken off, forgotten.
-- Tags left as they were keep their time.
create function document_tag_use_stamp() returns trigger
  language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.tag_keys is not distinct from old.tag_keys then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    delete from public.document_tag_use u
     where u.document_id = new.id
       and not (u.tag_key = any(coalesce(new.tag_keys, '{}'::text[])));
  end if;
  insert into public.document_tag_use (household_id, document_id, tag_key, used_at)
  select new.household_id, new.id, k, now()
    from (select distinct k from unnest(coalesce(new.tag_keys, '{}'::text[])) as u(k)) as n
   where k <> ''
     and (tg_op = 'INSERT' or not (k = any(coalesce(old.tag_keys, '{}'::text[]))))
  on conflict (document_id, tag_key) do update set used_at = excluded.used_at;
  return null;
end $$;

revoke execute on function document_tag_use_stamp() from public;

-- Read by the application, written by the trigger alone.
revoke insert, update, delete on document_tag_use from fdv_app;

create trigger document_tag_use_stamp
  after insert or update of tags on document
  for each row execute function document_tag_use_stamp();

-- The documents there now: each tag the time its document last changed.
insert into document_tag_use (household_id, document_id, tag_key, used_at)
select distinct on (d.id, u.k) d.household_id, d.id, u.k, coalesce(d.updated_at, d.created_at)
  from document d, unnest(d.tag_keys) as u(k)
 where u.k <> ''
on conflict do nothing;
