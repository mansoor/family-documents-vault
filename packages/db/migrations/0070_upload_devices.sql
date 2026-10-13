-- A computer that sends scans: pairing, and an upload-only key (0.8.0, D1).
--
-- Somebody who may add documents (an owner, an adult, a teen) pairs a
-- computer of theirs: Settings asks for their password again (the step-up)
-- and gives a one-time code for 10 minutes, which the uploader app on that
-- computer trades for a key of its own. The key does one thing: it puts a
-- file into its person's own uploads, as a batch a day, through one route
-- (POST /device-uploads), and says what it is (GET /devices/me). It reads,
-- lists and downloads nothing, and every other route refuses it.
--
-- Neither the code nor the key is kept. A code is an HMAC under a key of
-- the server's, so a dump cannot be searched for one, nor a guess tried
-- against it without the server; a key, 256 random bits, its SHA-256,
-- which needs no secret beside it. A code is in two halves, each hashed: the
-- first finds it, the whole proves it, and five wrong tries at the second
-- half end it — so a guess is a guess at one code, counted on it. One live
-- code a person at most: a new one replaces the old.
--
-- A key is revoked, never removed: by its person, or by an owner (who sees
-- the household's computers by name and person, never anything sent); and
-- by the database itself, in the same transaction, once its person's
-- sign-in is taken away or they can no longer add documents
-- (upload_devices_leave_with_role). A restore revokes every key (a backup
-- is the past: one revoked since would work again) and forgets every code.

-- ----------------------------------------------------------- the computer

create table upload_device (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references household(id) on delete cascade,
  -- Whose: their sign-in, and the member they are. Its files are theirs alone.
  account_id     uuid not null references account(id) on delete cascade,
  member_id      uuid not null,
  -- What its person called it, and what it runs on, as its app said.
  name           text not null constraint upload_device_name
                   check (char_length(name) between 1 and 60),
  platform       text not null constraint upload_device_platform
                   check (platform in ('windows', 'macos', 'linux', 'other')),
  -- The key's SHA-256, bound to this computer's id: never the key.
  key_hash       bytea not null constraint upload_device_key_hash check (octet_length(key_hash) = 32),
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  -- Revoked: by its person ('member'), an owner ('owner'), the vault as a
  -- sign-in went ('sign_in_removed') or a role that cannot add came
  -- ('cannot_add'), as its person was signed out everywhere ('signed_out'),
  -- as an owner stopped their password ('owner_stopped'), as their password
  -- was changed or reset ('password_changed'), or a restore ('restored'). Once,
  -- and for good.
  revoked_at     timestamptz,
  revoked_by     uuid references account(id) on delete set null,
  revoked_reason text constraint upload_device_revoked_reason
                   check (revoked_reason in ('member', 'owner', 'sign_in_removed', 'cannot_add',
                                             'signed_out', 'owner_stopped', 'password_changed',
                                             'restored')),
  constraint upload_device_revoked_says_why check ((revoked_at is null) = (revoked_reason is null)),
  constraint upload_device_household_key unique (id, household_id),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create index upload_device_member_idx on upload_device (household_id, member_id, created_at desc);
create index upload_device_account_idx on upload_device (account_id) where revoked_at is null;

alter table upload_device enable row level security;

create policy upload_device_tenant on upload_device
  using (household_id = app_household()) with check (household_id = app_household());

-- Its person's, while they may add documents; and the owners', who see
-- the household's computers by name and person. Nobody else signed in —
-- not another adult, not a teen, not a viewer — no link of either kind and
-- no signed-out page. The vault itself.
create policy upload_device_actor on upload_device as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
                               or (app_role() in ('adult', 'teen') and member_id = app_member())
           when 'system' then true
           else false
         end);
-- Made only by the vault, as a code is traded (the app is nobody signed in).
create policy upload_device_actor_insert on upload_device as restrictive for insert
  with check (app_actor() = 'system');
-- And never removed but with its person (the foreign keys' own cascade).
create policy upload_device_actor_delete on upload_device as restrictive for delete
  using (app_actor() = 'system');

-- Whoever asks, the vault and the owning role included: a key revoked is
-- never changed again, and nothing of a key ever changes but when it last
-- sent something and its revocation — never its hash, whose it is, its
-- name or its platform. Somebody signed in changes less still: their own
-- computer's last sending, now; or a key revoked, once, now, as themselves
-- — 'member' for their own, 'owner' for anybody else's, 'signed_out',
-- 'owner_stopped' or 'password_changed' as upload_devices_revoke_for()
-- writes them — and,
-- inside account_household's own trigger (a sign-in taken away, a role that
-- cannot add), the vault's revocation with no one named. A rule cannot say
-- which columns change, so a trigger does.
create function upload_device_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  movable constant text[] := array['last_used_at', 'revoked_at', 'revoked_by', 'revoked_reason'];
begin
  -- Who revoked it, gone with their account (the foreign key's own SET NULL).
  if pg_trigger_depth() > 1
     and old.revoked_by is not null and new.revoked_by is null
     and (to_jsonb(new) - 'revoked_by') = (to_jsonb(old) - 'revoked_by') then
    return new;
  end if;
  if old.revoked_at is not null then
    raise exception 'a revoked computer''s key never changes'
      using errcode = 'insufficient_privilege';
  end if;
  if (to_jsonb(new) - movable) is distinct from (to_jsonb(old) - movable) then
    raise exception 'only when a computer last sent something, and its revocation, change'
      using errcode = 'insufficient_privilege';
  end if;
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if new.revoked_at is null then
    if new.last_used_at = now() and old.member_id = app_member() then
      return new;
    end if;
  elsif new.last_used_at is not distinct from old.last_used_at
        and (
          (new.revoked_at = now()
           and new.revoked_by is not distinct from app_account()
           and (new.revoked_reason = case when old.account_id = app_account() then 'member'
                                          else 'owner' end
                or new.revoked_reason in ('signed_out', 'owner_stopped', 'password_changed')))
          or (pg_trigger_depth() > 1
              and new.revoked_by is null
              and new.revoked_reason in ('sign_in_removed', 'cannot_add'))
        ) then
    return new;
  end if;
  raise exception 'a computer''s key may only be revoked, once'
    using errcode = 'insufficient_privilege';
end $$;

create trigger upload_device_writes before update on upload_device
  for each row execute function upload_device_writes();

-- ------------------------------------------------------------- the code

create table device_pairing (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  account_id   uuid not null references account(id) on delete cascade,
  member_id    uuid not null,
  -- HMACs under the server's key: of the code's first half, which finds
  -- it, and of the whole, which proves it.
  handle_hash  bytea not null constraint device_pairing_handle check (octet_length(handle_hash) = 32),
  code_hash    bytea not null constraint device_pairing_code check (octet_length(code_hash) = 32),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  attempts     int not null default 0 constraint device_pairing_attempts check (attempts between 0 and 5),
  constraint device_pairing_ten_minutes check (expires_at <= created_at + interval '10 minutes'),
  -- One code a person at most: a new one replaces the old.
  constraint device_pairing_one_each unique (household_id, member_id),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create unique index device_pairing_handle_idx on device_pairing (handle_hash);

alter table device_pairing enable row level security;

create policy device_pairing_tenant on device_pairing
  using (household_id = app_household()) with check (household_id = app_household());

-- Its person's own, while they may add documents; and the vault's. Nobody
-- else's, not even an owner's: a code is a way in for whoever holds it.
create policy device_pairing_actor on device_pairing as restrictive
  using (case app_actor()
           when 'account' then app_role() in ('owner', 'adult', 'teen')
                               and member_id = app_member() and account_id = app_account()
           when 'system' then true
           else false
         end);
-- Made by its person, untried, for 10 minutes at most.
create policy device_pairing_actor_insert on device_pairing as restrictive for insert
  with check (case app_actor()
                when 'account' then attempts = 0 and expires_at <= now() + interval '10 minutes'
                when 'system' then true
                else false
              end);
-- Its tries are counted by the vault alone.
create policy device_pairing_actor_update on device_pairing as restrictive for update
  using (app_actor() = 'system');

-- Which household and code a first half names, while the code can be
-- used: the one question asked before the household is known.
create function device_pairing_find(p_handle_hash bytea)
  returns table (household_id uuid, pairing_id uuid)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select p.household_id, p.id
       from device_pairing p
      where p.handle_hash = p_handle_hash
        and p.expires_at > now()
        and p.attempts < 5 $$;
revoke execute on function device_pairing_find(bytea) from public;
grant execute on function device_pairing_find(bytea) to fdv_app;

-- Which household a key belongs to, given its id and its HMAC, and whether
-- it is revoked: nothing for a key the vault does not know.
create function upload_device_find(p_id uuid, p_key_hash bytea)
  returns table (household_id uuid, revoked boolean)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select d.household_id, d.revoked_at is not null
       from upload_device d
      where d.id = p_id and d.key_hash = p_key_hash $$;
revoke execute on function upload_device_find(uuid, bytea) from public;
grant execute on function upload_device_find(uuid, bytea) to fdv_app;

-- ------------------------------------------------- leaving with a role

-- A sign-in taken away, or a role that can no longer add documents: its
-- computers' keys revoked, and its code forgotten, in the same transaction
-- as the change — with the owner's rights, since whoever changes a role is
-- given nobody's code. The API writes the activity log's line for each.
create function upload_devices_leave_with_role() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    update upload_device set revoked_at = now(), revoked_reason = 'sign_in_removed'
     where household_id = old.household_id and account_id = old.account_id
       and revoked_at is null;
    delete from device_pairing
     where household_id = old.household_id and account_id = old.account_id;
  elsif new.role::text not in ('owner', 'adult', 'teen')
        and old.role::text in ('owner', 'adult', 'teen') then
    update upload_device set revoked_at = now(), revoked_reason = 'cannot_add'
     where household_id = new.household_id and account_id = new.account_id
       and revoked_at is null;
    delete from device_pairing
     where household_id = new.household_id and account_id = new.account_id;
  end if;
  return null;
end $$;

create trigger upload_devices_leave_with_role
  after delete or update of role on account_household
  for each row execute function upload_devices_leave_with_role();

-- --------------------------------------------- the emergency controls

-- Its person signed out everywhere ('signed_out'); their password stopped
-- by an owner ('owner_stopped'); their password changed or reset
-- ('password_changed'):
-- every computer of theirs here stops at once, and any code waiting is
-- forgotten. Asked by its person, an owner, or — signed out, with only the
-- account named — the reset being spent; with the owner's rights, since a
-- reset's page is nobody signed in. Answers what it revoked, for the
-- activity log's lines.
create function upload_devices_revoke_for(p_account uuid, p_reason text)
  returns table (member_id uuid, name text, platform text)
  language plpgsql volatile security definer
  set search_path = pg_catalog, public, pg_temp as $$
#variable_conflict use_column
begin
  if p_reason is null or p_reason not in ('signed_out', 'owner_stopped', 'password_changed') then
    raise exception 'not a reason a computer is stopped for'
      using errcode = 'insufficient_privilege';
  end if;
  if not coalesce((app_actor() = 'account'
                   and (app_account() = p_account or app_role() = 'owner'))
                  or (app_actor() = 'anonymous' and app_account() = p_account), false) then
    raise exception 'only its person, an owner, or their reset stops somebody''s computers'
      using errcode = 'insufficient_privilege';
  end if;
  delete from device_pairing p
   where p.household_id = app_household() and p.account_id = p_account;
  return query
    update upload_device d
       set revoked_at = now(),
           revoked_by = case when app_actor() = 'account' then app_account() end,
           revoked_reason = p_reason
     where d.household_id = app_household() and d.account_id = p_account
       and d.revoked_at is null
    returning d.member_id, d.name, d.platform;
end $$;
revoke execute on function upload_devices_revoke_for(uuid, text) from public;
grant execute on function upload_devices_revoke_for(uuid, text) to fdv_app;

-- ------------------------------------------------- a batch a day

-- What a computer sends goes into its person's own uploads: a batch a
-- day, "From <computer>, <date>", made on its first file that day, on the
-- household's calendar. Which computer and day are fixed once made
-- (intake_batch_account_writes compares every column but the ones an
-- uploader may change), and only a live computer of the batch's own
-- member is named.
alter table intake_batch
  add column device_id uuid,
  add column device_day date,
  add constraint intake_batch_device_day check ((device_id is null) = (device_day is null)),
  add constraint intake_batch_device_fkey
    foreign key (device_id, household_id) references upload_device (id, household_id)
    on delete cascade,
  add constraint intake_batch_device_day_key unique (device_id, device_day);

create policy intake_batch_device_insert on intake_batch as restrictive for insert
  with check (device_id is null
              or exists (select 1 from upload_device d
                          where d.id = device_id and d.member_id = intake_batch.member_id
                            and d.revoked_at is null));
