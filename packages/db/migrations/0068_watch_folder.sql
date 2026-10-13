-- A watched folder for network scanners (0.8.0, S3, CAP-10).
--
-- The operator mounts a folder into the worker (FDV_WATCH_DIR, for example
-- ./scanner:/watch) and points the household's scanner at it over SMB or
-- FTP. An owner turns it on in Settings and chooses whose Inbox it fills:
-- by default themselves, or anybody else of the family who may add
-- documents — never a viewer. The worker looks every 15 seconds, takes a
-- file once its size and time have stood still for 10, and puts it through
-- the same path as Add → Many documents: an item (0062) in a batch of the
-- day, "Scanner, 12 Oct", encrypted under that person's own member key,
-- drawn, read and proposed for as theirs (I2, I4). Once the item is safely
-- stored the file is deleted. What the vault cannot take is moved to
-- rejected/ with a note saying why, and that person is told.
--
-- Three tables, and a column:
--
--   watch_dir      the folder as the worker last found it: the
--                  installation's, not a household's (one row, as
--                  instance is). The API reads it for /capabilities and
--                  Settings; only the vault's owning role writes it.
--   watch_folder   a household's setting: on or off, and whose Inbox it
--                  fills; and what the worker says of it — paused, and why;
--                  when it last added a file. An owner's alone: nobody
--                  else signed in is given it, read or written. One
--                  household at most has it on: the folder is the server's.
--   watch_notice   "A scanned file couldn't be added", in Needs attention:
--                  the file's name (their own scanner's, so theirs to see)
--                  and why. Its person's alone — never an owner who is not
--                  them — made by the vault, and dismissed by them.
--   intake_batch.watch_day
--                  the day a scanner's batch is for, on the household's
--                  calendar: one a person a day. Set by the vault alone.
--
-- Nothing of a file's content is kept here: its bytes are an item's, under
-- an item's rules. A file's place in the folder is kept only as the item's
-- Idempotency-Key (0062), a keyed hash of its path, size, time and SHA-256
-- that says nothing of them, which finds an item a worker left on its way.
-- A worker that stops between storing a file and deleting it finds the item
-- the next time by the file's SHA-256 among that person's scanner items
-- waiting or accepted, and deletes the file without making it twice; one
-- removed from the Inbox since is added again.

-- ------------------------------------------------------------ the folder

create table watch_dir (
  singleton  boolean primary key default true check (singleton),
  -- FDV_WATCH_DIR as the worker has it: null when it is not set.
  dir        text constraint watch_dir_dir check (char_length(dir) between 1 and 1024),
  state      text not null
               constraint watch_dir_state
               check (state in ('off', 'ready', 'missing', 'not_a_folder', 'not_writable')),
  checked_at timestamptz not null default now()
);
-- Not tenant data: the application role reads it, as it reads instance.
grant select on watch_dir to fdv_app;
revoke insert, update, delete on watch_dir from fdv_app;

-- ------------------------------------------------------------ the setting

create table watch_folder (
  household_id   uuid primary key references household(id) on delete cascade,
  enabled        boolean not null default false,
  -- Whose Inbox it fills. Gone with the person: the folder waits, paused.
  member_id      uuid,
  updated_by     uuid references account(id) on delete set null,
  updated_at     timestamptz not null default now(),
  -- What the worker says: why it is paused, since when; when it last added a file.
  paused_reason  text
                   constraint watch_folder_paused
                   check (paused_reason in ('removed', 'no_sign_in', 'cannot_add', 'locked',
                                            'restored', 'sealed', 'no_storage', 'day_full')),
  paused_at      timestamptz,
  last_added_at  timestamptz,
  -- Files stored in the vault that the worker could not then delete from
  -- the folder: still there, not encrypted. Owners are told the count.
  stuck_files    integer not null default 0
                   constraint watch_folder_stuck check (stuck_files between 0 and 100000),
  foreign key (member_id, household_id) references member (id, household_id)
    on delete set null (member_id)
);
-- The folder is the server's: one household at most fills Inboxes from it.
create unique index watch_folder_one_on on watch_folder ((true)) where enabled;

alter table watch_folder enable row level security;
create policy watch_folder_tenant on watch_folder
  using (household_id = app_household()) with check (household_id = app_household());
-- An owner's alone, and the vault's: nobody else signed in, no link, no
-- signed-out page.
create policy watch_folder_actor on watch_folder as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);

-- What an owner writes: on or off, and whose Inbox, as themselves; what
-- the worker says is the worker's. And whose Inbox is somebody of the
-- family with a sign-in that may add documents — never a viewer, never a
-- guest. A rule cannot say which columns change, so a trigger does; it
-- compares every column but those, so a column added later is the
-- worker's too.
create function watch_folder_account_writes() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  owners_own constant text[] := array['enabled', 'member_id', 'updated_by', 'updated_at'];
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
       or new.last_added_at is not null or new.stuck_files <> 0 then
      raise exception 'what the worker says of the scanner folder is the worker''s'
        using errcode = 'insufficient_privilege';
    end if;
  elsif (to_jsonb(new) - owners_own) is distinct from (to_jsonb(old) - owners_own) then
    raise exception 'an owner changes only whether the scanner folder is on, and whose Inbox it fills'
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

create trigger watch_folder_account_writes before insert or update on watch_folder
  for each row execute function watch_folder_account_writes();

-- ---------------------------------------------- "a scanned file couldn't be added"

create table watch_notice (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  member_id    uuid not null,
  -- The file's name as the scanner wrote it (its last part), and why.
  file_name    text not null constraint watch_notice_name check (char_length(file_name) between 1 and 255),
  reason       text not null
                 constraint watch_notice_reason
                 check (reason in ('unsupported', 'too_large', 'unreadable', 'empty',
                                   'incomplete', 'linked')),
  -- Which file it was, as a keyed hash of its place, size and time (no
  -- name): the note is made before the file is moved, once however often
  -- the move is tried.
  file_key     uuid not null,
  created_at   timestamptz not null default now(),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create index watch_notice_member_idx on watch_notice (household_id, member_id, created_at desc);
create unique index watch_notice_file_idx on watch_notice (household_id, member_id, file_key);
create index watch_notice_created_idx on watch_notice (created_at);

alter table watch_notice enable row level security;
create policy watch_notice_tenant on watch_notice
  using (household_id = app_household()) with check (household_id = app_household());
-- Its person's alone, while they may add documents: never another adult,
-- never an owner who is not them. And the vault's.
create policy watch_notice_actor on watch_notice as restrictive
  using (case app_actor()
           when 'account' then app_role() in ('owner', 'adult', 'teen')
                               and member_id = app_member()
           when 'system' then true
           else false
         end);
-- Made and changed by the vault alone; its person dismisses it (a delete).
create policy watch_notice_actor_insert on watch_notice as restrictive for insert
  with check (app_actor() = 'system');
create policy watch_notice_actor_update on watch_notice as restrictive for update
  using (app_actor() = 'system');

-- ------------------------------------------------------------ the day's batch

alter table intake_batch
  add column watch_day date;
-- One a person a day.
create unique index intake_batch_watch_day_idx on intake_batch (household_id, member_id, watch_day)
  where watch_day is not null;
-- Made by the vault alone: somebody signed in makes a batch of their own,
-- never one the scanner's files would go in. (Changing it is refused by
-- 0062's trigger, which fixes every column but the name and defaults.)
create policy intake_batch_watch_insert on intake_batch as restrictive for insert
  with check (watch_day is null or app_actor() = 'system');

-- A file the worker took before, found by its key wherever it went (one
-- runner, so a lookup and an insert never race).
create index incoming_file_household_key_idx on incoming_file (household_id, idempotency_key)
  where idempotency_key is not null;
