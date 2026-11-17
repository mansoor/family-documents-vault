-- Connected apps: view links and deletes (0.9.0, APP3).
--
-- An app mints a link for a document it may read now, server to server,
-- and sends its user's browser to it at once. The link is a token of 32
-- random bytes, kept here only as its SHA-256, for one document, the
-- version current when it was minted, and one mode (view: the pages the
-- vault drew; download: the file). It must be opened within two minutes,
-- and works once: the first open turns it into a session of ten minutes,
-- a cookie whose value is kept here only as its SHA-256, bound to the
-- address it was opened from. The app's read rule is asked again when it
-- is minted and at every request in the session.
--
-- An app lets go of a document it sent (its intake's unlinked_at), or
-- moves it to the Trash, as the owner chose for that app (delete_mode).

-- ------------------------------------------------------------ the app

alter table connected_app
  -- What a delete does: let go of it (it stays in the vault), or move it
  -- to the Trash (only a document that is the app's own).
  add column delete_mode text not null default 'unlink'
    constraint connected_app_delete_mode check (delete_mode in ('unlink', 'trash')),
  -- Links it may mint an hour.
  add column links_per_hour int not null default 60
    constraint connected_app_links_per_hour check (links_per_hour between 1 and 600);

-- ------------------------------------------------------------ its links

create table connected_app_link (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  app_id        uuid not null,
  document_id   uuid not null,
  -- The version current when it was minted: what it shows, whatever comes after.
  version_id    uuid not null references document_version(id) on delete cascade,
  mode          text not null constraint connected_app_link_mode check (mode in ('view', 'download')),
  token_hash    bytea not null constraint connected_app_link_token_hash
                  check (octet_length(token_hash) = 32),
  created_at    timestamptz not null default now(),
  -- Opened by then, or never.
  open_by       timestamptz not null,
  opened_at     timestamptz,
  -- The session its first open made: the cookie's hash, until when, and
  -- the address it is bound to.
  session_hash  bytea constraint connected_app_link_session_hash
                  check (octet_length(session_hash) = 32),
  session_until timestamptz,
  first_address text constraint connected_app_link_first_address
                  check (char_length(first_address) <= 64),
  constraint connected_app_link_opened_whole check (
    (opened_at is null) = (session_hash is null)
    and (opened_at is null) = (session_until is null)),
  constraint connected_app_link_token_once unique (token_hash),
  constraint connected_app_link_session_once unique (session_hash),
  foreign key (app_id, household_id) references connected_app (id, household_id) on delete cascade,
  -- A link is nothing without its document: it goes with it.
  foreign key (document_id, household_id) references document (id, household_id) on delete cascade
);
-- Links minted in the last hour, counted per app.
create index connected_app_link_app_idx on connected_app_link (app_id, created_at);
create index connected_app_link_document_idx on connected_app_link (document_id);

alter table connected_app_link enable row level security;

-- Minted, opened and ended by the vault alone, once a signature or a token
-- has been checked. Counted in Settings by whoever sees its app: the owners
-- and its person.
create policy connected_app_link_tenant on connected_app_link
  using (household_id = app_household()) with check (household_id = app_household());
create policy connected_app_link_actor on connected_app_link as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
                               or (app_role() = 'adult'
                                   and exists (select 1 from connected_app a
                                                where a.id = connected_app_link.app_id
                                                  and a.member_id = app_member()))
           when 'system' then true
           else false
         end);
create policy connected_app_link_actor_insert on connected_app_link as restrictive for insert
  with check (app_actor() = 'system');
create policy connected_app_link_actor_update on connected_app_link as restrictive for update
  using (app_actor() = 'system');
create policy connected_app_link_actor_delete on connected_app_link as restrictive for delete
  using (app_actor() = 'system');
-- And nothing of it, read or written, while a transaction acts for an app
-- (0110's rule on every other table).
create policy connected_app_link_no_app on connected_app_link as restrictive for all
  using ((select current_setting('app.actor', true)) is distinct from 'connected_app')
  with check ((select current_setting('app.actor', true)) is distinct from 'connected_app');

-- Which household and link a token names, before either is known: the one
-- question asked with the owner's rights, as share_session_find() answers
-- it for a share's cookie. Everything after asks as the vault.
create function connected_app_link_find(p_token_hash bytea)
  returns table (household_id uuid, link_id uuid)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select l.household_id, l.id from connected_app_link l where l.token_hash = p_token_hash $$;
revoke execute on function connected_app_link_find(bytea) from public;
grant execute on function connected_app_link_find(bytea) to fdv_app;

-- And which a session's cookie names, while its session lasts.
create function connected_app_link_session_find(p_session_hash bytea)
  returns table (household_id uuid, link_id uuid)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select l.household_id, l.id from connected_app_link l
      where l.session_hash = p_session_hash and l.session_until > now() $$;
revoke execute on function connected_app_link_session_find(bytea) from public;
grant execute on function connected_app_link_session_find(bytea) to fdv_app;

-- A document's links held, in one order (by id), by whoever is about to
-- take the document away (an Undo, a removal for good): opening a link
-- holds the link, then the document, so they are held first there too.
-- Whoever asks may not write them (the vault alone does), so the vault
-- holds them for the caller, in the caller's household alone.
create function connected_app_links_hold(p_document uuid) returns void
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  perform 1 from connected_app_link l
   where l.document_id = p_document and l.household_id = app_household()
   order by l.id
     for update;
end $$;
revoke execute on function connected_app_links_hold(uuid) from public;
grant execute on function connected_app_links_hold(uuid) to fdv_app;
