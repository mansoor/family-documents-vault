-- Codes by text (0.9.0, SMS3): a share link's code, an invitation's code,
-- and a code to somebody's own confirmed number as a second proof of who
-- they are — when a password is reset, when they sign in, and when they
-- confirm it's them.
--
-- A text is the weakest of the vault's second factors (a SIM swap moves a
-- number to somebody else's phone), so it is only ever in addition: never
-- the only one an owner has, never what an owner's powers ask (A54), and a
-- reset or a sign-in whose code cannot be texted goes on as it would have
-- without it, rather than lock anybody out.
--
--   share_link      `code_phone`: where a link's code goes by text, as E.164
--                   — the number its sharer typed, beside `code_email` and
--                   never with it. Cleared with the address when the link
--                   ends, by the same rule (0043): never shown back in full,
--                   only masked (•••• •••123). The codes are share_code's,
--                   as an emailed one's are: the same 10 minutes, 5 tries
--                   and limits.
--   account         `sign_in_text`, `reset_text`: whether somebody asked for
--                   a code by text at sign-in (and when they confirm it's
--                   them), and when their password is reset. Off until they
--                   turn it on; theirs alone to change.
--   sms_code        each code texted to somebody's own confirmed number, for
--                   a reset, a sign-in or a step-up: an HMAC of it under a
--                   key derived from the master key (sms-code-hmac), never
--                   the code; 10 minutes, 5 tries, used once, as phone_code
--                   (0084) is. The vault's alone.
--   sms_message     a text's kind may also be `share_code`, `invite_code`,
--                   `reset_code`, `sign_in_code` or `step_up_code`: counted
--                   against the same monthly cap, never its words.
--   the activity    a link may also write `share.code_not_sent` (its code
--                   could not be texted, and why, in a word), and say how
--                   its code went (`by`) on `share.code_sent`.
--
-- An invitation's code is texted as it is made, and nothing is kept of the
-- number but what every text keeps (sms_message's last three digits).

-- ------------------------------------------------------------- the link

alter table share_link
  add column code_phone text
    constraint share_link_code_phone check (code_phone ~ '^\+[1-9][0-9]{6,14}$');

alter table share_link
  add constraint share_link_code_phone_v2 check (flow = 'v2' or code_phone is null),
  -- One way for its code: by email or by text, never both.
  add constraint share_link_one_code_way check (code_email is null or code_phone is null);

-- 0043's rule, with the number beside the address: what protects a link is
-- fixed when it is made; the address and the number a code goes to only
-- ever go, and only once the link has ended, in the statement that ends it.
create or replace function share_link_factors_fixed() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.revoked_at is not null
     or new.attempts >= 10
     or (new.max_opens is not null and new.open_count >= new.max_opens) then
    new.code_email := null;
    new.code_phone := null;
  end if;
  if new.pin_hash is distinct from old.pin_hash
     or new.secret_kind is distinct from old.secret_kind
     or new.this_device_only is distinct from old.this_device_only then
    raise exception 'a link keeps the protection it was made with'
      using errcode = 'check_violation';
  end if;
  if new.device_hash is distinct from old.device_hash and old.device_hash is not null then
    raise exception 'a link stays with the device it was first opened on'
      using errcode = 'check_violation';
  end if;
  if (new.code_email is distinct from old.code_email
      or new.code_phone is distinct from old.code_phone) and (
       new.code_email is not null and new.code_email is distinct from old.code_email
       or new.code_phone is not null and new.code_phone is distinct from old.code_phone
       or not (new.revoked_at is not null
               or new.expires_at <= now()
               or new.attempts >= 10
               or (new.max_opens is not null and new.open_count >= new.max_opens))) then
    raise exception 'the address a link''s code goes to is cleared only when the link has ended'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- What a link may change on its own share (0030, 0041, 0043): its counts,
-- each only upwards; binding its device; and clearing where its code goes —
-- the address, and now the number — once it has ended.
create or replace function share_link_link_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() = 'link' and (
       (to_jsonb(new) - array['open_count', 'last_opened_at', 'attempts', 'downloads_used',
                              'device_hash', 'code_email', 'code_phone'])
         is distinct from
       (to_jsonb(old) - array['open_count', 'last_opened_at', 'attempts', 'downloads_used',
                              'device_hash', 'code_email', 'code_phone'])
       or new.open_count < old.open_count
       or new.attempts < old.attempts
       or new.downloads_used < old.downloads_used
       or (new.device_hash is distinct from old.device_hash and new.device_hash is null)
       or (new.code_email is distinct from old.code_email and new.code_email is not null)
       or (new.code_phone is distinct from old.code_phone and new.code_phone is not null)) then
    raise exception 'a share link may only count its opens, downloads and wrong tries, bind its device and clear its code''s address'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- ------------------------------------------------- the activity log (0043)
--
-- A link writes one more line: its code could not be texted (`reason`: the
-- household's texts not set up, this month's all sent, or the phone did not
-- take it), where it would have gone, masked. And a code sent says how it
-- went (`by`: email or sms). Nothing else of 0042's rule changes.
create or replace function app_link_audit_actions() returns text[]
  language sql stable parallel safe
  set search_path = pg_catalog, public, pg_temp as
  $$ select array['share.opened', 'share.viewed', 'share.downloaded', 'share.locked',
                  'share.code_sent', 'share.code_not_sent']::text[] $$;
grant execute on function app_link_audit_actions() to fdv_app;

create or replace function app_link_line_keys(p_action text) returns text[]
  language sql stable parallel safe
  set search_path = pg_catalog, public, pg_temp as
  $$ select case p_action
              when 'share.code_sent' then array['share_id', 'user_agent', 'to', 'by']::text[]
              when 'share.code_not_sent' then array['share_id', 'user_agent', 'to', 'reason']::text[]
              else array['share_id', 'user_agent']::text[]
            end $$;
grant execute on function app_link_line_keys(text) to fdv_app;

-- ------------------------------------------------------------ the person

alter table account
  add column sign_in_text boolean not null default false,
  add column reset_text   boolean not null default false;

-- Whether somebody is asked for a code by text is theirs alone to say:
-- signed in, nobody changes another's — an owner included. The vault, a
-- reset and a sign-in page write as they always have.
create function account_text_codes_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if (new.sign_in_text, new.reset_text) is distinct from (old.sign_in_text, old.reset_text)
     and new.id is distinct from app_account() then
    raise exception 'somebody asks for codes by text for themselves alone'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger account_text_codes_writes before update on account
  for each row execute function account_text_codes_writes();

-- ------------------------------------------------------------- the codes
--
-- One row a code texted to somebody's own confirmed number: for which
-- purpose, to which number, for whom, when, until when (10 minutes), how
-- many tries it has had (5 at most), and when it was used — once. The code
-- itself is never kept: code_hash is an HMAC-SHA256 under a key derived
-- from the master key (sms-code-hmac), over the purpose, the account, the
-- number, this row and the code. A newer code for the same purpose ends
-- the ones before it. The rows are also what the sends are counted by: 3
-- in 15 minutes and 10 in a day, a number and an account. A day after it
-- was sent the API clears it, and a restore deletes every one.

create table sms_code (
  id           uuid primary key,
  household_id uuid not null references household(id) on delete cascade,
  account_id   uuid not null references account(id) on delete cascade,
  member_id    uuid not null,
  purpose      text not null
                 constraint sms_code_purpose check (purpose in ('reset', 'sign_in', 'step_up')),
  number       text not null
                 constraint sms_code_number check (number ~ '^\+[1-9][0-9]{6,14}$'),
  code_hash    bytea not null constraint sms_code_hash_length check (octet_length(code_hash) = 32),
  sent_at      timestamptz not null default now(),
  expires_at   timestamptz not null,
  attempts     int not null default 0 constraint sms_code_attempts check (attempts between 0 and 5),
  used_at      timestamptz,
  constraint sms_code_ten_minutes check (expires_at <= sent_at + interval '10 minutes'),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create index sms_code_account_idx on sms_code (account_id, purpose, sent_at);
create index sms_code_number_idx on sms_code (household_id, number, sent_at);

alter table sms_code enable row level security;
create policy sms_code_tenant on sms_code
  using (household_id = app_household()) with check (household_id = app_household());
-- The vault's alone, to read as to write: nobody signed in, an owner
-- included, no link and no sign-in page, is given a row of them.
create policy sms_code_actor on sms_code as restrictive
  using (app_actor() = 'system');
create policy sms_code_actor_insert on sms_code as restrictive for insert
  with check (app_actor() = 'system');
create policy sms_code_actor_update on sms_code as restrictive for update
  using (app_actor() = 'system');
create policy sms_code_actor_delete on sms_code as restrictive for delete
  using (app_actor() = 'system');

-- A code, once sent, keeps what it is: its hash, its purpose, its person,
-- its number and when it was sent. Its tries only go up, it is used once,
-- and its end only comes sooner. Whoever asks.
create function sms_code_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.code_hash is distinct from old.code_hash
     or new.purpose is distinct from old.purpose
     or new.account_id is distinct from old.account_id
     or new.member_id is distinct from old.member_id
     or new.number is distinct from old.number
     or new.household_id is distinct from old.household_id
     or new.sent_at is distinct from old.sent_at
     or new.attempts < old.attempts
     or (old.used_at is not null and new.used_at is distinct from old.used_at)
     or new.expires_at > old.expires_at then
    raise exception 'a code keeps what it was sent as: its tries only go up, and it is used once'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger sms_code_writes before update on sms_code
  for each row execute function sms_code_writes();

-- ------------------------------------------------------------- the texts

alter table sms_message drop constraint sms_message_kind;
alter table sms_message add constraint sms_message_kind
  check (kind in ('test', 'phone_code', 'phone_changed', 'reminders', 'alert', 'share_opened',
                  'share_code', 'invite_code', 'reset_code', 'sign_in_code', 'step_up_code'));
