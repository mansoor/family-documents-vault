-- The scanner folder and the email-in mailbox set from Settings, and kept
-- scans (0.9.0, O1).
--
-- The scanner folder's path is chosen in Settings, inside the folders the
-- operator mounted for it (FDV_WATCH_ROOTS, by default /watch; and
-- FDV_WATCH_DIR, which stays the default choice). The API refuses a path
-- outside them, or one of the vault's own folders or a folder above one,
-- and the worker refuses it again every round, by its real path. "Verify"
-- and "Test the mailbox" run in the worker, which alone has the folders and
-- the mailbox's password; and a scan, once stored, is kept in processed/ for
-- an owner's number of days before it is deleted.
--
--   watch_dir.roots, .own_dirs
--                  FDV_WATCH_ROOTS (and FDV_WATCH_DIR) as the worker has
--                  them, and the vault's own folders it will never take:
--                  what the API checks a path against before the worker
--                  does. The installation's, written by the owning role.
--   watch_folder.dir, .keep_days
--                  the owner's choice of folder (null: FDV_WATCH_DIR) and
--                  how many days a stored scan is kept in processed/ (0:
--                  deleted at once; 7 for a new setting, 0 for one made
--                  before 0.9.0). The owner's, as enabled is.
--   watch_folder.dir_state, .dir_seen, .dir_checked_at
--                  what the worker last found of the folder chosen, which,
--                  and when. The worker's.
--   mail_in_mailbox
--                  the household mailbox as an owner set it up: its server,
--                  sign-in, folder, what is done with mail, the provider's
--                  authserv-id, how often it is checked; and its app
--                  password, sealed under a key derived from the master key
--                  with the household bound in, never returned by the API.
--                  It overrides FDV_MAIL_IN_*. An owner's alone.
--   mail_in_server.mailboxes
--                  how many households' own mailboxes have a password, as the
--                  worker counted: email in is offered with one. The worker's.
--   mail_in.filing how the household's mail is filed, as its server allows
--                  (0069's F10, as mail_in_server.filing is for FDV_MAIL_IN_*).
--                  The worker's.
--   watch_kept     each scan the vault kept in processed/: the only files it
--                  ever deletes there (the O1 review, M2). The owners' to
--                  read, the vault's to write.
--   settings_check a "Verify", a folder browsed, or a "Test the mailbox":
--                  asked for by an owner, answered by the worker. An
--                  owner's alone.

-- ------------------------------------------------------------ the folders

alter table watch_dir
  add column roots text[] not null default '{}'
    constraint watch_dir_roots check (cardinality(roots) <= 20),
  add column own_dirs text[] not null default '{}'
    constraint watch_dir_own_dirs check (cardinality(own_dirs) <= 50),
  -- FDV_WATCH_ROOTS the worker refuses (the O1 review, M4): `/`, or a folder
  -- holding one of the vault's own, by name or by identity.
  add column refused_roots text[] not null default '{}'
    constraint watch_dir_refused_roots check (cardinality(refused_roots) <= 20),
  drop constraint watch_dir_state,
  -- `refused`: FDV_WATCH_DIR names one of the vault's own folders, or one above one.
  add constraint watch_dir_state
    check (state in ('off', 'ready', 'missing', 'not_a_folder', 'not_writable', 'refused'));

-- ------------------------------------------------------------ the setting

alter table watch_folder
  add column dir text
    constraint watch_folder_dir check (dir is null or (char_length(dir) between 1 and 1024 and left(dir, 1) = '/')),
  -- 0 for every household that has the scanner folder set up already: its
  -- scans go on being deleted at once, as before 0.9.0 (the owner's
  -- decision of 18 Oct). 7 for a setting made from now on (below).
  add column keep_days integer not null default 0
    constraint watch_folder_keep_days check (keep_days between 0 and 365),
  add column dir_state text
    constraint watch_folder_dir_state
    check (dir_state in ('ready', 'missing', 'not_a_folder', 'not_writable', 'refused')),
  add column dir_seen text
    constraint watch_folder_dir_seen check (dir_seen is null or char_length(dir_seen) between 1 and 1024),
  add column dir_checked_at timestamptz,
  -- The worker's word (the O1 review, M2, L1): a processed/ folder there it
  -- did not make (which it never keeps scans in); and how many scans it kept
  -- are in a folder it may no longer use, and so are left there.
  add column processed_foreign boolean not null default false,
  add column kept_left integer not null default 0
    constraint watch_folder_kept_left check (kept_left between 0 and 1000000),
  -- Kept scans changed since they were kept, on a file system that gives no
  -- birth time to know them by: left in place, never deleted (the O1
  -- re-check, 1). Files in a processed/ of the vault's that it has no record
  -- of, after a restore: never deleted (2); and whether to count them.
  add column kept_changed integer not null default 0
    constraint watch_folder_kept_changed check (kept_changed between 0 and 1000000),
  add column kept_untracked integer not null default 0
    constraint watch_folder_kept_untracked check (kept_untracked between 0 and 1000000),
  add column kept_reconcile boolean not null default false;
alter table watch_folder alter column keep_days set default 7;

-- What an owner writes: on or off, whose Inbox, which folder and how long
-- scans are kept, as themselves; the rest is the worker's (0068's rule, with
-- the two new columns an owner's).
create or replace function watch_folder_account_writes() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  owners_own constant text[] := array['enabled', 'member_id', 'updated_by', 'updated_at',
                                      'dir', 'keep_days'];
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if new.updated_by is distinct from app_account() then
    raise exception 'an owner changes the scanner folder as themselves'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.paused_reason is not null or new.paused_at is not null
       or new.last_added_at is not null or new.stuck_files <> 0
       or new.processed_foreign or new.kept_left <> 0 or new.kept_changed <> 0
       or new.kept_untracked <> 0 or new.kept_reconcile
       or new.dir_state is not null or new.dir_seen is not null
       or new.dir_checked_at is not null then
      raise exception 'what the worker says of the scanner folder is the worker''s'
        using errcode = 'insufficient_privilege';
    end if;
  elsif (to_jsonb(new) - owners_own) is distinct from (to_jsonb(old) - owners_own) then
    raise exception 'an owner changes only whether the scanner folder is on, whose Inbox it fills, which folder it is and how long scans are kept'
      using errcode = 'insufficient_privilege';
  end if;
  if new.member_id is not null
     and (tg_op = 'INSERT' or new.member_id is distinct from old.member_id
          or (new.enabled and not old.enabled))
     and not exists (select 1
                       from account_household a
                       join member m on m.id = a.member_id and m.household_id = a.household_id
                      where a.member_id = new.member_id
                        and a.household_id = new.household_id
                        and a.role in ('owner', 'adult', 'teen')
                        and m.kind = 'family') then
    raise exception 'the scanner folder fills the Inbox of somebody who may add documents'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------ the mailbox

create table mail_in_mailbox (
  household_id       uuid primary key references household(id) on delete cascade,
  host               text not null
                       constraint mail_in_mailbox_host
                       check (char_length(host) between 1 and 253 and host ~ '^[A-Za-z0-9.-]+$'),
  port               integer not null default 993
                       constraint mail_in_mailbox_port check (port between 1 and 65535),
  username           text not null
                       constraint mail_in_mailbox_username
                       check (char_length(username) between 1 and 320 and username !~ '[[:cntrl:]]'),
  -- AES-256-GCM under deriveKey(master, 'mail-in-credentials'), the
  -- household and the host, port and sign-in it was typed for bound in
  -- (MASTER_SEALED): it opens for that server alone, and is moved by
  -- rotate-master-key, and by a restore of a backup made under an older
  -- key, as the other sealed secrets are.
  password_encrypted bytea
                       constraint mail_in_mailbox_password check (octet_length(password_encrypted) between 29 and 4096),
  folder             text not null default 'INBOX'
                       constraint mail_in_mailbox_folder
                       check (char_length(folder) between 1 and 200 and folder !~ '[[:cntrl:]]'),
  after              text not null default 'move'
                       constraint mail_in_mailbox_after check (after in ('move', 'delete')),
  authserv_id        text
                       constraint mail_in_mailbox_authserv
                       check (authserv_id is null
                              or (char_length(authserv_id) between 1 and 253
                                  and authserv_id ~ '^[A-Za-z0-9.-]+$')),
  poll_seconds       integer not null default 300
                       constraint mail_in_mailbox_poll check (poll_seconds between 30 and 86400),
  updated_by         uuid references account(id) on delete set null,
  updated_at         timestamptz not null default now()
);

alter table mail_in_mailbox enable row level security;
create policy mail_in_mailbox_tenant on mail_in_mailbox
  using (household_id = app_household()) with check (household_id = app_household());
-- An owner's alone, and the vault's: nobody else signed in, no link, no
-- signed-out page.
create policy mail_in_mailbox_actor on mail_in_mailbox as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);

-- An owner writes it as themselves.
create function mail_in_mailbox_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if new.updated_by is distinct from app_account() then
    raise exception 'an owner sets up the household mailbox as themselves'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger mail_in_mailbox_account_writes before insert or update on mail_in_mailbox
  for each row execute function mail_in_mailbox_account_writes();

-- How many households' own mailboxes have a password set, as the worker
-- that checks them counted (the installation's word, no household's
-- name): email in is offered (/capabilities) with one, as with FDV_MAIL_IN_*.
alter table mail_in_server
  add column mailboxes integer not null default 0
    constraint mail_in_server_mailboxes check (mailboxes between 0 and 1000000),
  -- What a mailbox set up in Settings may be (the O1 review, M3): the ports
  -- the worker connects to (FDV_MAIL_IN_ALLOWED_PORTS, 993 by default), and
  -- whether an address inside its own network is allowed
  -- (FDV_MAIL_IN_ALLOW_PRIVATE). The API refuses what it can tell is
  -- outside them; the worker refuses again, by the address it resolves.
  add column allowed_ports integer[] not null default '{993}'
    constraint mail_in_server_allowed_ports check (cardinality(allowed_ports) between 1 and 20),
  add column allow_private boolean not null default false;

-- What everybody who may add documents is told of the household's own
-- mailbox (GET /mail-in/me, and the notes of an email): set up, where to
-- send, what is done with mail, whether senders are checked. Never its
-- server, sign-in or password; the application's alone.
create function mail_in_box() returns table (configured boolean, address text, after text,
                                             sender_check boolean)
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select m.password_encrypted is not null,
            case when m.username ~ '^[^[:space:]@]+@[^[:space:]@]+$' then m.username end,
            m.after,
            m.authserv_id is not null
       from mail_in_mailbox m
      where m.household_id = app_household()
        and app_actor() in ('account', 'system') $$;
revoke execute on function mail_in_box() from public;
grant execute on function mail_in_box() to fdv_app;

-- How the household's mail is filed, as its server allows: the worker's
-- (0069's rule compares every column but the owner's).
alter table mail_in
  add column filing text constraint mail_in_filing check (filing in ('move', 'delete', 'leave')),
  -- `password_sealed`: the app password set in Settings does not open with this
-- master key; `address_refused`: its server is a port or an address the
-- worker does not connect to (the O1 review, M3).
  drop constraint mail_in_error,
  add constraint mail_in_error
    check (last_error in ('login_failed', 'unreachable', 'certificate', 'no_folder',
                          'not_filed', 'sealed', 'no_storage', 'unreadable', 'password_sealed',
                          'address_refused'));

-- ------------------------------------------------------------ kept scans

-- Each scan the vault kept in a scanner folder's processed/ (the O1 review,
-- M2): where (the folder's real path then, and the file's path from it),
-- which file (device, inode, change time and size once moved there, and its
-- birth time where the file system gives one: the O1 re-check, 1), and
-- since when. The worker deletes only these, only while each is still that
-- very file, and only once kept long enough: never anything else saved in
-- processed/. Wherever it was kept, while that folder may still be used
-- (L1). The vault's alone, to read as to write: the files' names are the
-- family's, each person's scan its own (the re-check, 3).
create table watch_kept (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  dir          text not null constraint watch_kept_dir check (char_length(dir) between 1 and 1024),
  rel          text not null constraint watch_kept_rel check (char_length(rel) between 1 and 4096),
  file_id      text not null constraint watch_kept_file check (char_length(file_id) between 1 and 200),
  born         text constraint watch_kept_born check (born ~ '^[0-9]{1,30}$'),
  kept_at      timestamptz not null default now()
);
create index watch_kept_household_idx on watch_kept (household_id, kept_at);

alter table watch_kept enable row level security;
create policy watch_kept_tenant on watch_kept
  using (household_id = app_household()) with check (household_id = app_household());
create policy watch_kept_actor on watch_kept as restrictive
  using (app_actor() = 'system');
create policy watch_kept_actor_insert on watch_kept as restrictive for insert
  with check (app_actor() = 'system');
create policy watch_kept_actor_update on watch_kept as restrictive for update
  using (app_actor() = 'system');
create policy watch_kept_actor_delete on watch_kept as restrictive for delete
  using (app_actor() = 'system');

-- Whether another household uses a folder (the O1 review, L2): one it chose,
-- or FDV_WATCH_DIR while it has the scanner folder on with none chosen. A
-- folder is in use when it is that folder, inside it, or (unless only
-- browsing through it) above it. Nothing else of the other household is
-- told; asked by an owner choosing, verifying or browsing a folder.
create function watch_dir_used_elsewhere(p_dir text, p_browsing boolean) returns boolean
  language sql stable security definer set search_path = pg_catalog, public, pg_temp as
  $$ with used as (
       select coalesce(w.dir, (select d.dir from watch_dir d)) as dir
         from watch_folder w
        where w.household_id <> app_household()
          and (w.dir is not null or w.enabled))
     select app_actor() = 'account' and exists (
       select 1 from used u
        where u.dir is not null
          and (u.dir = p_dir
               or starts_with(p_dir, u.dir || '/')
               or (not p_browsing and starts_with(u.dir, p_dir || '/')))) $$;
revoke execute on function watch_dir_used_elsewhere(text, boolean) from public;
grant execute on function watch_dir_used_elsewhere(text, boolean) to fdv_app;

-- ------------------------------------------------------------ the checks

create table settings_check (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  -- `folder`: Verify a path; `browse`: the folders inside one; `mailbox`: Test the mailbox.
  kind         text not null constraint settings_check_kind check (kind in ('folder', 'browse', 'mailbox')),
  path         text constraint settings_check_path check (char_length(path) between 1 and 1024),
  requested_by uuid references account(id) on delete set null,
  requested_at timestamptz not null default now(),
  -- What the worker found, once it has looked: never a password, never a
  -- mail's content (a count, capabilities, an authserv-id).
  done_at      timestamptz,
  result       jsonb constraint settings_check_result check (jsonb_typeof(result) = 'object'),
  constraint settings_check_done check ((done_at is null) = (result is null)),
  constraint settings_check_path_kind check ((path is null) = (kind = 'mailbox'))
);
create index settings_check_household_idx on settings_check (household_id, requested_at desc);
create index settings_check_requested_idx on settings_check (requested_at);

alter table settings_check enable row level security;
create policy settings_check_tenant on settings_check
  using (household_id = app_household()) with check (household_id = app_household());
-- An owner's alone, and the vault's.
create policy settings_check_actor on settings_check as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);
-- Asked for by an owner as themselves, unanswered; answered, and cleared
-- away, by the vault alone.
create policy settings_check_actor_insert on settings_check as restrictive for insert
  with check (app_actor() = 'system'
              or (requested_by = app_account() and done_at is null and result is null));
create policy settings_check_actor_update on settings_check as restrictive for update
  using (app_actor() = 'system');
create policy settings_check_actor_delete on settings_check as restrictive for delete
  using (app_actor() = 'system');
