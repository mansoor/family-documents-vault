-- Email documents to the vault: a household mailbox checked over IMAP
-- (0.8.0, S4, CAP-09).
--
-- The operator makes a mailbox of its own for the household (a Gmail or
-- Outlook address with an app password, say) and gives the worker its
-- server, sign-in and folder (FDV_MAIL_IN_*). An owner turns it on in
-- Settings. Every FDV_MAIL_IN_POLL_SECONDS one worker — the one holding an
-- advisory lock — signs in and looks at the folder. Mail From the confirmed
-- sign-in address of somebody of the family who may add documents goes into
-- that person's Inbox: each attachment the vault keeps is an item (0062) of
-- their batch of the day, "Email, 12 Oct", encrypted under their own member
-- key and read as anything they add (I2, I4). Once every attachment is
-- received the mail is moved to a "Filed" folder, or deleted. Anything else
-- is left unread and untouched in the mailbox, and counted for the owners.
-- The password is never here: only that one is set.
--
-- Four tables, and columns:
--
--   mail_in_server  the mailbox as the worker last had it: the
--                   installation's, not a household's (one row, as
--                   watch_dir is). Its address and folder, what is done with
--                   mail afterwards, whether senders are checked, how often
--                   it looks — and when the worker last said so. The API
--                   reads it for /capabilities and Settings; only the
--                   vault's owning role writes it.
--   mail_in         a household's setting: on or off; and what the worker
--                   says — when it last looked, the last error (a word, no
--                   message), when it last added a file, and how many mails
--                   it left alone. An owner's alone. One household at most
--                   has it on: the mailbox is the server's.
--   mail_in_address somebody's sign-in address, confirmed for email in: a
--                   one-time code they send from it, in a subject, to the
--                   mailbox. Theirs alone, and the vault's.
--   watch_notice    (0068) now says whether a note is of the scanner folder
--                   or of an email (source), and an email's note may name no
--                   file: "An email had nothing we could add".
--   intake_batch.mail_day
--                   the day an email batch is for: one a person a day, made
--                   by the vault alone.
--   incoming_file.mail_key, .sender_unverified
--                   an item from an email: a keyed hash of the mail's
--                   Message-ID and the attachment's SHA-256 (the fallback to
--                   its Idempotency-Key, which is of the mail's UIDVALIDITY
--                   and UID); and whether the mailbox's own check of the
--                   sender could be asked (FDV_MAIL_IN_AUTHSERV_ID unset: not
--                   verified, said on its card). Set by the vault alone.
--
-- Nothing of a mail's content is kept here: not its body, not its subject
-- (no sealed field of an item fits it, so it is dropped), not its sender's
-- address (theirs is their sign-in's). An attachment's bytes are an item's,
-- under an item's rules.

-- ------------------------------------------------------------ the mailbox

create table mail_in_server (
  singleton     boolean primary key default true check (singleton),
  -- FDV_MAIL_IN_HOST, _USER and a password set: the worker can sign in.
  configured    boolean not null,
  -- Where the family sends mail (FDV_MAIL_IN_ADDRESS, or the sign-in when it is an address).
  address       text constraint mail_in_server_address check (char_length(address) between 3 and 320),
  folder        text constraint mail_in_server_folder check (char_length(folder) between 1 and 200),
  after         text not null default 'move' constraint mail_in_server_after check (after in ('move', 'delete')),
  -- FDV_MAIL_IN_AUTHSERV_ID is set: a sender is accepted only on the mailbox's own word.
  sender_check  boolean not null default false,
  poll_seconds  integer not null constraint mail_in_server_poll check (poll_seconds between 30 and 86400),
  checked_at    timestamptz not null default now()
);
-- Not tenant data: the application role reads it, as it reads watch_dir.
grant select on mail_in_server to fdv_app;
revoke insert, update, delete on mail_in_server from fdv_app;

-- ------------------------------------------------------------ the setting

create table mail_in (
  household_id     uuid primary key references household(id) on delete cascade,
  enabled          boolean not null default false,
  updated_by       uuid references account(id) on delete set null,
  updated_at       timestamptz not null default now(),
  -- What the worker says: when it last looked; the last thing that went
  -- wrong, as a word (never the server's message, which can carry the
  -- sign-in), and since when; when it last added a file.
  last_checked_at  timestamptz,
  last_error       text
                     constraint mail_in_error
                     check (last_error in ('login_failed', 'unreachable', 'certificate', 'no_folder',
                                           'not_filed', 'sealed', 'no_storage', 'unreadable')),
  last_error_at    timestamptz,
  last_added_at    timestamptz,
  -- Mail left alone in the mailbox, as of the last look: from nobody of the
  -- family; from a family address the mailbox's check did not pass; and from
  -- somebody who cannot have files added now (locked, after a restore, a
  -- full day), waiting.
  unknown_senders  integer not null default 0 constraint mail_in_unknown check (unknown_senders between 0 and 1000000),
  unverified       integer not null default 0 constraint mail_in_unverified check (unverified between 0 and 1000000),
  waiting          integer not null default 0 constraint mail_in_waiting check (waiting between 0 and 1000000)
);
-- The mailbox is the server's: one household at most fills Inboxes from it.
create unique index mail_in_one_on on mail_in ((true)) where enabled;

alter table mail_in enable row level security;
create policy mail_in_tenant on mail_in
  using (household_id = app_household()) with check (household_id = app_household());
-- An owner's alone, and the vault's: nobody else signed in, no link, no
-- signed-out page.
create policy mail_in_actor on mail_in as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);

-- Whether the caller's household has email in on: the one word of the
-- owners' row that everybody who may add documents is told, with where to
-- send (GET /mail-in/me). Nothing else of it.
create function mail_in_on() returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce((select m.enabled from mail_in m
                       where m.household_id = app_household()), false) $$;
grant execute on function mail_in_on() to fdv_app;

-- What an owner writes: on or off, as themselves; what the worker says is
-- the worker's. Every column but those is compared, so a column added later
-- is the worker's too.
create function mail_in_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  owners_own constant text[] := array['enabled', 'updated_by', 'updated_at'];
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if new.updated_by is distinct from app_account() then
    raise exception 'an owner changes email in as themselves'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.last_checked_at is not null or new.last_error is not null
       or new.last_error_at is not null or new.last_added_at is not null
       or new.unknown_senders <> 0 or new.unverified <> 0 or new.waiting <> 0 then
      raise exception 'what the worker says of email in is the worker''s'
        using errcode = 'insufficient_privilege';
    end if;
  elsif (to_jsonb(new) - owners_own) is distinct from (to_jsonb(old) - owners_own) then
    raise exception 'an owner changes only whether email in is on'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger mail_in_account_writes before insert or update on mail_in
  for each row execute function mail_in_account_writes();

-- ------------------------------------------------------- a confirmed address

create table mail_in_address (
  household_id    uuid not null references household(id) on delete cascade,
  member_id       uuid not null,
  -- The sign-in address the mailbox heard from, with the code, and when:
  -- confirmed only while it is still their sign-in's.
  email           citext constraint mail_in_address_email check (char_length(email) between 3 and 320),
  confirmed_at    timestamptz,
  -- The code they are to send: its SHA-256 (it is 60 random bits), until when.
  code_hash       bytea constraint mail_in_address_code check (octet_length(code_hash) = 32),
  code_expires_at timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (household_id, member_id),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade,
  constraint mail_in_address_confirmed check ((email is null) = (confirmed_at is null)),
  constraint mail_in_address_code_until check ((code_hash is null) = (code_expires_at is null))
);
create index mail_in_address_code_idx on mail_in_address (household_id, code_hash)
  where code_hash is not null;

alter table mail_in_address enable row level security;
create policy mail_in_address_tenant on mail_in_address
  using (household_id = app_household()) with check (household_id = app_household());
-- Its person's alone, while they may add documents: never another adult,
-- never an owner who is not them. And the vault's.
create policy mail_in_address_actor on mail_in_address as restrictive
  using (case app_actor()
           when 'account' then app_role() in ('owner', 'adult', 'teen')
                               and member_id = app_member()
           when 'system' then true
           else false
         end);
-- Never removed by anybody signed in: a confirmation goes with its person.
create policy mail_in_address_actor_delete on mail_in_address as restrictive for delete
  using (app_actor() = 'system');

-- What its person writes: a new code, and until when. That the address is
-- confirmed is the vault's to say, once it has the code from it.
create function mail_in_address_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  theirs constant text[] := array['code_hash', 'code_expires_at', 'updated_at'];
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.email is not null or new.confirmed_at is not null then
      raise exception 'that an address is confirmed is the vault''s to say'
        using errcode = 'insufficient_privilege';
    end if;
  elsif (to_jsonb(new) - theirs) is distinct from (to_jsonb(old) - theirs) then
    raise exception 'somebody changes only their own code'
      using errcode = 'insufficient_privilege';
  end if;
  if new.code_expires_at is not null and new.code_expires_at > now() + interval '1 day 1 minute' then
    raise exception 'a code lasts a day at most'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger mail_in_address_account_writes before insert or update on mail_in_address
  for each row execute function mail_in_address_account_writes();

-- ------------------------------------------------------------ the notes

-- "An email couldn't be added", in Needs attention beside the scanner's:
-- the attachment's name where there is one (the sender's own, so theirs to
-- see), and why. Its person's alone, made by the vault (0068's rules).
alter table watch_notice
  add column source text not null default 'scanner'
    constraint watch_notice_source check (source in ('scanner', 'email')),
  alter column file_name drop not null,
  drop constraint watch_notice_reason,
  add constraint watch_notice_reason check (
    (source = 'scanner' and file_name is not null
     and reason in ('unsupported', 'too_large', 'unreadable', 'empty', 'linked'))
    or (source = 'email'
        and reason in ('too_large', 'message_too_large', 'unreadable', 'nothing_to_add')));

-- ------------------------------------------------------------ the day's batch

alter table intake_batch
  add column mail_day date,
  add constraint intake_batch_one_day check (watch_day is null or mail_day is null);
-- One a person a day.
create unique index intake_batch_mail_day_idx on intake_batch (household_id, member_id, mail_day)
  where mail_day is not null;
-- Made by the vault alone, as a scanner's is (0068).
create policy intake_batch_mail_insert on intake_batch as restrictive for insert
  with check (mail_day is null or app_actor() = 'system');

-- ------------------------------------------------------------ an email's item

alter table incoming_file
  add column mail_key uuid,
  add column sender_unverified boolean not null default false,
  add constraint incoming_file_mail_batch check (mail_key is null or batch_id is not null),
  add constraint incoming_file_unverified_batch check (not sender_unverified or batch_id is not null);
-- Put in by the vault alone: somebody adding a file of their own says
-- neither. (Changing them is refused by 0064's trigger, which fixes every
-- column it does not name.)
create policy incoming_file_mail_insert on incoming_file as restrictive for insert
  with check ((mail_key is null and not sender_unverified) or app_actor() = 'system');
-- An attachment taken before, found by its mail's Message-ID (one runner,
-- so a lookup and an insert never race).
create index incoming_file_household_mail_key_idx on incoming_file (household_id, mail_key)
  where mail_key is not null;
