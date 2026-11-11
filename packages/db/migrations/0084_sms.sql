-- Text messages (0.9.0, SMS1): the household's own SMS Gate, and each
-- person's mobile number, confirmed by a code sent to it.
--
-- SMS Gate for Android (sms-gate.app) is an app on a phone the family owns
-- that sends texts for whoever asks it over HTTP: on the home network
-- (`local`, recommended), through SMS Gate's cloud relay (`cloud`), or
-- through a server of their own (`private`). An owner sets it up in
-- Settings, and only once a test text has gone does the vault send any
-- other. Notifications by text come later (SMS2); for now the only texts
-- are a test and the code that confirms a number.
--
--   sms_settings   how the vault reaches the household's SMS Gate: the
--                  mode, its address, the sign-in and its password — sealed
--                  under a key derived from the master key with the
--                  household, mode, address and sign-in bound in, never
--                  returned by the API — the country a number typed without
--                  + is in, the most texts in a calendar month, and whether
--                  a test passed. An owner's alone; that a test passed is
--                  the vault's word, never an owner's.
--   member_phone   somebody's mobile number, as E.164, and when it was
--                  confirmed. Theirs, and the owners'.
--   phone_code     each code sent to confirm a number: an HMAC of it under a
--                  key derived from the master key (never the code), 10
--                  minutes, 5 tries, used once, as share_code (0043) is.
--                  The vault's alone: a code is between it and the phone.
--   sms_message    each text the vault asked SMS Gate to send: whom (a
--                  person, the last three digits of the number), what kind,
--                  and what became of it. Never its words. The owners' to
--                  read, the vault's to write; what the month's texts are
--                  counted by.

-- ------------------------------------------------------------ the setting

create table sms_settings (
  household_id       uuid primary key references household(id) on delete cascade,
  mode               text not null
                       constraint sms_settings_mode check (mode in ('local', 'cloud', 'private')),
  -- Where SMS Gate's API is: http or https on the home network; the relay's
  -- own address for the cloud; https for a server of the family's. Never a
  -- sign-in inside it, a query or a fragment.
  base_url           text not null
                       constraint sms_settings_base_url
                       check (char_length(base_url) between 10 and 2048
                              and base_url ~ '^https?://[^/?#@[:space:]]+(/[^?#[:space:]]*)?$'),
  username           text not null
                       constraint sms_settings_username
                       check (char_length(username) between 1 and 200 and username !~ '[[:cntrl:]]'),
  -- AES-256-GCM under deriveKey(master, 'sms-credentials'), the household,
  -- mode, address and sign-in bound in (MASTER_SEALED): it opens for that
  -- server alone, and is moved by rotate-master-key, and by a restore of a
  -- backup made under an older key, as the other sealed secrets are.
  password_encrypted bytea
                       constraint sms_settings_password check (octet_length(password_encrypted) between 29 and 4096),
  -- Where a number typed without + is (ISO 3166-1 alpha-2).
  country            char(2) not null default 'GB'
                       constraint sms_settings_country check (country ~ '^[A-Z]{2}$'),
  monthly_cap        integer not null default 200
                       constraint sms_settings_cap check (monthly_cap between 1 and 100000),
  status             text not null default 'untested'
                       constraint sms_settings_status check (status in ('untested', 'ok', 'failed')),
  last_verified_at   timestamptz,
  last_error         text
                       constraint sms_settings_last_error check (char_length(last_error) between 1 and 1000),
  updated_by         uuid references account(id) on delete set null,
  updated_at         timestamptz not null default now(),
  constraint sms_settings_cloud check ((mode = 'cloud') = (base_url = 'https://api.sms-gate.app/3rdparty/v1')),
  constraint sms_settings_https check (mode = 'local' or base_url like 'https://%')
);

alter table sms_settings enable row level security;
create policy sms_settings_tenant on sms_settings
  using (household_id = app_household()) with check (household_id = app_household());
-- An owner's alone, and the vault's: nobody else signed in, no link, no
-- signed-out page.
create policy sms_settings_actor on sms_settings as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);

-- An owner writes it as themselves. Whether a test text went, and why not,
-- is the vault's to say: an owner only ever clears it, back to untested.
-- And a new mode, address, sign-in or password waits for a test of its
-- own: nothing is sent through a server nobody has tried.
create function sms_settings_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if new.updated_by is distinct from app_account() then
    raise exception 'an owner sets up text messages as themselves'
      using errcode = 'insufficient_privilege';
  end if;
  if (tg_op = 'INSERT'
      or (new.status, new.last_verified_at, new.last_error)
         is distinct from (old.status, old.last_verified_at, old.last_error))
     and (new.status <> 'untested' or new.last_verified_at is not null
          or new.last_error is not null) then
    raise exception 'whether a test text went is the vault''s to say'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and new.status <> 'untested'
     and (new.mode, new.base_url, new.username, new.password_encrypted)
         is distinct from (old.mode, old.base_url, old.username, old.password_encrypted) then
    raise exception 'a new address, sign-in or password waits for a test of its own'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger sms_settings_account_writes before insert or update on sms_settings
  for each row execute function sms_settings_account_writes();

-- Whether the household can send texts now (GET /sms/status, for anybody
-- signed in): set up, with a password, and a test passed. Nothing else of
-- the setting; the application's alone.
create function sms_ready() returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select app_actor() in ('account', 'system')
            and exists (select 1 from sms_settings s
                         where s.household_id = app_household()
                           and s.status = 'ok'
                           and s.password_encrypted is not null) $$;
revoke execute on function sms_ready() from public;
grant execute on function sms_ready() to fdv_app;

-- Where a number typed without + is, for the household (for anybody signed
-- in who adds a number): its owners' choice, else the UK. Nothing else of
-- the setting.
create function sms_country() returns text
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce((select s.country::text from sms_settings s
                        where s.household_id = app_household()
                          and app_actor() in ('account', 'system')), 'GB') $$;
revoke execute on function sms_country() from public;
grant execute on function sms_country() to fdv_app;

-- ------------------------------------------------------------ the numbers

create table member_phone (
  member_id    uuid primary key,
  household_id uuid not null references household(id) on delete cascade,
  number       text not null
                 constraint member_phone_number check (number ~ '^\+[1-9][0-9]{6,14}$'),
  -- Null until a code sent to this number is typed back; a new number is
  -- unconfirmed until its own is.
  confirmed_at timestamptz,
  updated_by   uuid references account(id) on delete set null,
  updated_at   timestamptz not null default now(),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create index member_phone_household_idx on member_phone (household_id);

alter table member_phone enable row level security;
create policy member_phone_tenant on member_phone
  using (household_id = app_household()) with check (household_id = app_household());
-- The person's own, and the owners' (an owner adds one for somebody with no
-- sign-in); the vault's. Nobody else signed in, no link, no signed-out page.
create policy member_phone_actor on member_phone as restrictive
  using (case app_actor()
           when 'account' then coalesce(member_id = app_member(), false)
                               or coalesce(app_role() = 'owner', false)
           when 'system' then true
           else false
         end);

-- Somebody writes a number as themselves, and never confirms one: a number
-- is confirmed by the vault alone, once its code is typed back. A number
-- changed is unconfirmed until its own code is.
create function member_phone_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if new.updated_by is distinct from app_account() then
    raise exception 'somebody changes a mobile number as themselves'
      using errcode = 'insufficient_privilege';
  end if;
  if new.confirmed_at is not null
     and (tg_op = 'INSERT' or new.number is distinct from old.number
          or new.confirmed_at is distinct from old.confirmed_at) then
    raise exception 'a mobile number is confirmed by its code alone'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger member_phone_account_writes before insert or update on member_phone
  for each row execute function member_phone_account_writes();

-- ------------------------------------------------------------- the codes
--
-- One row a code sent: to which number, for whom, when, until when (10
-- minutes), how many tries it has had (5 at most), and when it confirmed
-- the number — once. The code itself is never kept: code_hash is an
-- HMAC-SHA256 under a key derived from the master key (phone-code-hmac),
-- over the person, the number, this row and the code. A newer code ends the
-- ones before it. The rows are also what the sends are counted by: 3 in 15
-- minutes and 10 in a day, a number. A day after it was sent the API clears
-- it, and a restore deletes every one.

create table phone_code (
  id           uuid primary key,
  household_id uuid not null references household(id) on delete cascade,
  member_id    uuid not null,
  number       text not null
                 constraint phone_code_number check (number ~ '^\+[1-9][0-9]{6,14}$'),
  code_hash    bytea not null constraint phone_code_hash_length check (octet_length(code_hash) = 32),
  sent_at      timestamptz not null default now(),
  expires_at   timestamptz not null,
  attempts     int not null default 0 constraint phone_code_attempts check (attempts between 0 and 5),
  used_at      timestamptz,
  constraint phone_code_ten_minutes check (expires_at <= sent_at + interval '10 minutes'),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create index phone_code_member_idx on phone_code (member_id, sent_at);
create index phone_code_number_idx on phone_code (household_id, number, sent_at);

alter table phone_code enable row level security;
create policy phone_code_tenant on phone_code
  using (household_id = app_household()) with check (household_id = app_household());
-- The vault's alone, to read as to write: nobody signed in, an owner
-- included, is given a row of them.
create policy phone_code_actor on phone_code as restrictive
  using (app_actor() = 'system');
create policy phone_code_actor_insert on phone_code as restrictive for insert
  with check (app_actor() = 'system');
create policy phone_code_actor_update on phone_code as restrictive for update
  using (app_actor() = 'system');
create policy phone_code_actor_delete on phone_code as restrictive for delete
  using (app_actor() = 'system');

-- A code, once sent, keeps what it is: its hash, its person, its number and
-- when it was sent. Its tries only go up, it is used once, and its end only
-- comes sooner. Whoever asks.
create function phone_code_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.code_hash is distinct from old.code_hash
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

create trigger phone_code_writes before update on phone_code
  for each row execute function phone_code_writes();

-- Until when the newest code out for somebody's number can still be typed:
-- for the person themselves and the owners, who are shown it. Never the
-- code, its tries or anything else of the row.
create function phone_code_expires(p_member uuid) returns timestamptz
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select c.expires_at
       from phone_code c
       join member_phone p on p.member_id = c.member_id and p.number = c.number
      where c.member_id = p_member
        and c.household_id = app_household()
        and app_actor() = 'account'
        and (p_member = app_member() or app_role() = 'owner')
        and p.confirmed_at is null
        and c.used_at is null
        and c.attempts < 5
        and c.expires_at > now()
      order by c.sent_at desc
      limit 1 $$;
revoke execute on function phone_code_expires(uuid) from public;
grant execute on function phone_code_expires(uuid) to fdv_app;

-- ------------------------------------------------------------- the texts

create table sms_message (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  member_id    uuid references member(id) on delete set null,
  -- The number's last three digits, and nothing more of it.
  number_tail  text not null constraint sms_message_tail check (number_tail ~ '^[0-9]{3}$'),
  kind         text not null
                 constraint sms_message_kind check (kind in ('test', 'phone_code', 'phone_changed')),
  -- SMS Gate's id for it, and its state as SMS Gate last said; `not_sent`:
  -- SMS Gate never took it (unreachable, refused, the wrong password).
  provider_id  text constraint sms_message_provider_id check (char_length(provider_id) between 1 and 200),
  state        text not null default 'pending'
                 constraint sms_message_state
                 check (state in ('pending', 'processed', 'sent', 'delivered', 'failed', 'not_sent')),
  error        text constraint sms_message_error check (char_length(error) between 1 and 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index sms_message_household_idx on sms_message (household_id, created_at);

alter table sms_message enable row level security;
create policy sms_message_tenant on sms_message
  using (household_id = app_household()) with check (household_id = app_household());
-- The owners' to read, and the vault's.
create policy sms_message_actor on sms_message as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);
-- Written by the vault alone, as it sends.
create policy sms_message_actor_insert on sms_message as restrictive for insert
  with check (app_actor() = 'system');
create policy sms_message_actor_update on sms_message as restrictive for update
  using (app_actor() = 'system');
create policy sms_message_actor_delete on sms_message as restrictive for delete
  using (app_actor() = 'system');
