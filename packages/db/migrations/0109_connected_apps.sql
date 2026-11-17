-- Connected apps: an app an owner connects, its keys, and what it sends
-- (0.9.0, APP1).
--
-- An owner connects an app (one Acme Money workspace, say) in Settings →
-- Connected apps, after a passkey or a code. The app made its own Ed25519
-- key pair; the vault keeps only the public key. The app acts as one adult
-- of the family, who has a sign-in and is an owner or an adult, and can
-- never do more than that person could. When that person is not the owner
-- who connected it, it waits until they turn it on themselves.
--
-- It signs every request (RFC 9421): the keyid names an app and a key this
-- vault made, so a signature made for one vault is never good at another;
-- a nonce is kept for the five minutes a signature lasts, so a request is
-- never taken twice. Nothing in these tables lets anybody act as an app:
-- public keys, spent nonces, and what was sent, its hints sealed under the
-- item's own key.
--
-- What it sends goes through the batch path a paired computer's does: into
-- its person's Inbox, one batch an app a household day ("From Acme Money, 16
-- Nov 2026"), a second past 200 files. Nobody else sees the items until
-- they are filed, not even an owner. Each send is followed in
-- connected_app_intake by its external id, so the app can ask what became
-- of it after the Inbox row has gone.
--
-- An app is revoked, never removed: by an owner or its person; by the
-- database in the same transaction as its person's sign-in is taken away
-- or their role becomes one that cannot act (connected_apps_leave_with_role);
-- and by the emergency controls (connected_apps_revoke_for). A restore
-- pauses every app until an owner turns it back on: a backup is the past,
-- and a key revoked since would work again.

-- ------------------------------------------------------------- the app

create table connected_app (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references household(id) on delete cascade,
  -- What the owner called it: "Acme Money".
  name               text not null constraint connected_app_name
                       check (char_length(name) between 1 and 60),
  -- Whom it acts as: their sign-in and the member they are.
  account_id         uuid not null references account(id) on delete cascade,
  member_id          uuid not null,
  created_by         uuid references account(id) on delete set null,
  -- Turned on by its person: at once when they connected it, or later in
  -- their own Settings.
  approval           text not null default 'waiting' constraint connected_app_approval
                       check (approval in ('waiting', 'approved')),
  approved_at        timestamptz,
  constraint connected_app_approved_when check ((approval = 'approved') = (approved_at is not null)),
  -- What it may do. APP1 grants documents.send alone.
  scopes             text[] not null default '{documents.send}' constraint connected_app_scopes
                       check (scopes <@ array['documents.send', 'documents.read', 'documents.download',
                                              'documents.links', 'documents.delete']::text[]),
  -- The kinds it may send, by key.
  allowed_kinds      text[] not null default '{}' constraint connected_app_kinds
                       check (cardinality(allowed_kinds) <= 200),
  -- Who sees what it sends, as a batch's default: null as each kind says;
  -- narrowing only.
  default_visibility text constraint connected_app_visibility
                       check (default_visibility in ('household', 'adults', 'private')),
  -- Filing without review when everything is sure: off, and kept off
  -- until the iteration that files.
  auto_file          boolean not null default false,
  -- The day's caps, within the operator's ceilings.
  daily_files        int not null default 100 constraint connected_app_daily_files
                       check (daily_files between 1 and 100000),
  daily_bytes        bigint not null default 524288000 constraint connected_app_daily_bytes
                       check (daily_bytes between 1048576 and 1099511627776),
  -- A backfill allowance: higher caps until a date, at most 30 days ahead.
  backfill_until     timestamptz,
  backfill_files     int constraint connected_app_backfill_files
                       check (backfill_files between 1 and 100000),
  backfill_bytes     bigint constraint connected_app_backfill_bytes
                       check (backfill_bytes between 1048576 and 1099511627776),
  backfill_auto_file boolean not null default false,
  constraint connected_app_backfill_whole check (
    (backfill_until is null) = (backfill_files is null)
    and (backfill_until is null) = (backfill_bytes is null)),
  -- Where its requests may come from: up to ten addresses or networks.
  ip_allow           cidr[] not null default '{}' constraint connected_app_ip_allow
                       check (cardinality(ip_allow) <= 10),
  -- Paused by an owner, or by a restore, until an owner turns it back on.
  paused_reason      text constraint connected_app_paused
                       check (paused_reason in ('owner', 'restored')),
  -- Revoked: by an owner ('owner'), its person ('member'), the vault as
  -- their sign-in went ('sign_in_removed') or a role that cannot act came
  -- ('cannot_act'), or the emergency controls ('signed_out',
  -- 'owner_stopped'). Once, and for good.
  revoked_at         timestamptz,
  revoked_by         uuid references account(id) on delete set null,
  revoked_reason     text constraint connected_app_revoked_reason
                       check (revoked_reason in ('owner', 'member', 'sign_in_removed', 'cannot_act',
                                                 'signed_out', 'owner_stopped')),
  constraint connected_app_revoked_says_why check ((revoked_at is null) = (revoked_reason is null)),
  last_used_at       timestamptz,
  -- What it sent today, on the household's calendar: for its caps, and for
  -- the owners' list, who see none of the items.
  use_day            date,
  files_today        int not null default 0,
  bytes_today        bigint not null default 0,
  -- Refusals today, and the last one's code: not a line each.
  refused_on         date,
  refused_today      int not null default 0,
  last_refusal       text constraint connected_app_last_refusal check (char_length(last_refusal) <= 64),
  -- The last "checked on files it sent" line, so polling never floods the log.
  checked_line_at    timestamptz,
  -- A restore's moment: a signature made before it is refused, so the
  -- nonces a restore forgets open nothing to a replay. Set by the restore.
  signed_after       timestamptz,
  created_at         timestamptz not null default now(),
  constraint connected_app_household_key unique (id, household_id),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create index connected_app_household_idx on connected_app (household_id, created_at desc);
create index connected_app_account_idx on connected_app (account_id) where revoked_at is null;

alter table connected_app enable row level security;

create policy connected_app_tenant on connected_app
  using (household_id = app_household()) with check (household_id = app_household());

-- The owners', and its person's own; the vault's. Nobody else signed in —
-- not another adult, not a teen, not a viewer — no link and no signed-out
-- page.
create policy connected_app_actor on connected_app as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
                               or (app_role() = 'adult' and member_id = app_member())
           when 'system' then true
           else false
         end);
-- Connected by an owner, as themselves: turned on already only when it
-- acts as them; another adult turns on their own.
create policy connected_app_actor_insert on connected_app as restrictive for insert
  with check (case app_actor()
                when 'account' then app_role() = 'owner' and created_by = app_account()
                                    and (approval = 'waiting' or member_id = app_member())
                when 'system' then true
                else false
              end);
-- And never removed: revoked, and kept for the activity log.
create policy connected_app_actor_delete on connected_app as restrictive for delete
  using (app_actor() = 'system');

-- Whom it acts as, who connected it and when never change, and a revoked
-- app never changes again (who revoked it aside, gone with their account).
create function connected_app_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  fixed constant text[] := array['id', 'household_id', 'account_id', 'member_id', 'created_by',
                                 'created_at'];
  movable constant text[] := array['approval', 'approved_at', 'revoked_at', 'revoked_by',
                                   'revoked_reason', 'last_used_at', 'use_day', 'files_today',
                                   'bytes_today', 'refused_on', 'refused_today', 'last_refusal',
                                   'checked_line_at'];
begin
  if pg_trigger_depth() > 1
     and old.revoked_by is not null and new.revoked_by is null
     and (to_jsonb(new) - 'revoked_by') = (to_jsonb(old) - 'revoked_by') then
    return new;
  end if;
  if pg_trigger_depth() > 1
     and old.created_by is not null and new.created_by is null
     and (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by') then
    return new;
  end if;
  if old.revoked_at is not null then
    raise exception 'a revoked app never changes' using errcode = 'insufficient_privilege';
  end if;
  if (select jsonb_object_agg(k, to_jsonb(new) -> k) from unnest(fixed) k)
     is distinct from (select jsonb_object_agg(k, to_jsonb(old) -> k) from unnest(fixed) k) then
    raise exception 'whom an app acts as never changes' using errcode = 'insufficient_privilege';
  end if;
  -- Only its person turns it on.
  if app_actor() = 'account' and old.approval = 'waiting' and new.approval = 'approved'
     and old.member_id is distinct from app_member() then
    raise exception 'only its person turns an app on' using errcode = 'insufficient_privilege';
  end if;
  -- Its person, an adult, turns it on, removes it, and has its use noted:
  -- what it may do is an owner's to change.
  if app_actor() = 'account' and app_role() is distinct from 'owner'
     and (to_jsonb(new) - movable) is distinct from (to_jsonb(old) - movable) then
    raise exception 'only an owner changes what an app may do'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger connected_app_writes before update on connected_app
  for each row execute function connected_app_writes();

-- ------------------------------------------------------------- its keys

create table connected_app_key (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  app_id        uuid not null,
  -- The 32 raw bytes of an Ed25519 public key: nothing to sign with.
  public_key    bytea not null constraint connected_app_key_length check (octet_length(public_key) = 32),
  added_by      text not null constraint connected_app_key_added_by check (added_by in ('owner', 'app')),
  created_at    timestamptz not null default now(),
  -- Confirmed in Settings by an owner or the person the app acts as: an
  -- owner's key is as it is added; a key the app adds itself signs nothing
  -- until then, so a stolen key cannot add one that outlives it.
  confirmed_at  timestamptz,
  constraint connected_app_key_owner_confirmed check (added_by = 'app' or confirmed_at is not null),
  -- First used to sign a request: the older key retires seven days after.
  first_used_at timestamptz,
  retired_at    timestamptz,
  foreign key (app_id, household_id) references connected_app (id, household_id) on delete cascade
);
create index connected_app_key_app_idx on connected_app_key (app_id, created_at);
-- A live key belongs to one app of the household.
create unique index connected_app_key_live_idx on connected_app_key (household_id, public_key)
  where retired_at is null;

alter table connected_app_key enable row level security;

create policy connected_app_key_tenant on connected_app_key
  using (household_id = app_household()) with check (household_id = app_household());

-- Whoever sees its app: the owners and its person; and the vault.
create policy connected_app_key_actor on connected_app_key as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
                               or (app_role() = 'adult'
                                   and exists (select 1 from connected_app a
                                                where a.id = connected_app_key.app_id
                                                  and a.member_id = app_member()))
           when 'system' then true
           else false
         end);
create policy connected_app_key_actor_insert on connected_app_key as restrictive for insert
  with check (case app_actor()
                when 'account' then app_role() = 'owner' and added_by = 'owner'
                when 'system' then true
                else false
              end);
create policy connected_app_key_actor_delete on connected_app_key as restrictive for delete
  using (app_actor() = 'system');

-- At most two live keys an app, for rotation; a retired key never comes
-- back; and nothing of a key changes but its first use and its retiring.
create function connected_app_key_writes() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  live int;
begin
  if tg_op = 'INSERT' then
    perform 1 from connected_app where id = new.app_id for update;
    select count(*) into live from connected_app_key
     where app_id = new.app_id and retired_at is null;
    if live >= 2 then
      raise exception 'an app has two live keys at most' using errcode = 'check_violation',
        constraint = 'connected_app_key_two';
    end if;
    return new;
  end if;
  if old.retired_at is not null and new.retired_at is distinct from old.retired_at then
    raise exception 'a retired key stays retired' using errcode = 'insufficient_privilege';
  end if;
  if old.confirmed_at is not null and new.confirmed_at is distinct from old.confirmed_at then
    raise exception 'a confirmed key stays confirmed' using errcode = 'insufficient_privilege';
  end if;
  if (to_jsonb(new) - array['first_used_at', 'retired_at', 'confirmed_at'])
     is distinct from (to_jsonb(old) - array['first_used_at', 'retired_at', 'confirmed_at']) then
    raise exception 'only when a key was confirmed and first used, and its retiring, change'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger connected_app_key_writes before insert or update on connected_app_key
  for each row execute function connected_app_key_writes();

-- An app revoked: its keys retire with it, so the same key may be given to
-- an app connected again.
create function connected_app_revoked() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update connected_app_key set retired_at = now()
     where app_id = new.id and retired_at is null;
  end if;
  return null;
end $$;

create trigger connected_app_revoked after update of revoked_at on connected_app
  for each row execute function connected_app_revoked();

-- --------------------------------------------------------- its nonces

-- A nonce kept while a signature with it could be taken (its created time
-- and five minutes): a second use by the same app is refused. Written by
-- the vault alone, once a signature has verified.
create table connected_app_nonce (
  household_id uuid not null references household(id) on delete cascade,
  app_id       uuid not null,
  nonce        text not null constraint connected_app_nonce_text
                 check (nonce ~ '^[A-Za-z0-9_-]{22,64}$'),
  expires_at   timestamptz not null,
  primary key (app_id, nonce),
  foreign key (app_id, household_id) references connected_app (id, household_id) on delete cascade
);
create index connected_app_nonce_expires_idx on connected_app_nonce (expires_at);

alter table connected_app_nonce enable row level security;

create policy connected_app_nonce_tenant on connected_app_nonce
  using (household_id = app_household()) with check (household_id = app_household());
create policy connected_app_nonce_actor on connected_app_nonce as restrictive
  using (app_actor() = 'system');

-- Which household a keyid names, and what the signature is checked
-- against: the one question asked before the household is known. Nothing
-- for a keyid the vault does not know. A key retires by itself seven days
-- after a newer, confirmed key of its app was first used; one the app added
-- and nobody has confirmed yet is pending, and signs nothing.
create function connected_app_find(p_app uuid, p_key uuid)
  returns table (household_id uuid, public_key bytea, key_live boolean, key_pending boolean,
                 revoked boolean, paused_reason text, approval text, ip_allow text[],
                 account_id uuid, member_id uuid, signed_after timestamptz)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select a.household_id, k.public_key,
            k.retired_at is null
              and not exists (select 1 from connected_app_key n
                               where n.app_id = k.app_id and n.id <> k.id
                                 and n.created_at > k.created_at
                                 and n.retired_at is null
                                 and n.confirmed_at is not null
                                 and n.first_used_at < now() - interval '7 days'),
            k.confirmed_at is null,
            a.revoked_at is not null, a.paused_reason, a.approval,
            a.ip_allow::text[], a.account_id, a.member_id, a.signed_after
       from connected_app_key k
       join connected_app a on a.id = k.app_id
      where k.app_id = p_app and k.id = p_key $$;
revoke execute on function connected_app_find(uuid, uuid) from public;
grant execute on function connected_app_find(uuid, uuid) to fdv_app;

-- ------------------------------------------------ what it sent: intake

-- One row an external id an app sent: the state it can ask about once the
-- Inbox row is gone. Its person's alone (they are whom the app acts as),
-- and the vault's: not an owner's, as the items are not.
create table connected_app_intake (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references household(id) on delete cascade,
  app_id           uuid not null,
  member_id        uuid not null,
  external_id      text not null constraint connected_app_intake_external_id
                     check (external_id ~ '^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,127}$'),
  -- 'arriving' while its bytes come: answered to nobody.
  state            text not null constraint connected_app_intake_state
                     check (state in ('arriving', 'waiting', 'filed', 'refused', 'removed')),
  removed_reason   text constraint connected_app_intake_removed_reason
                     check (removed_reason in ('withdrawn', 'declined', 'expired')),
  constraint connected_app_intake_removed_says_why
    check ((state = 'removed') = (removed_reason is not null)),
  refusal          text constraint connected_app_intake_refusal
                     check (refusal in ('kind_not_allowed', 'unsupported_type', 'too_large')),
  constraint connected_app_intake_refused_says_why check ((state = 'refused') = (refusal is not null)),
  sha256           bytea constraint connected_app_intake_sha256 check (octet_length(sha256) = 32),
  byte_size        bigint,
  -- The Inbox item, while there is one (no foreign key: the row outlives it).
  incoming_file_id uuid,
  document_id      uuid,
  version_id       uuid,
  -- Its hints, sealed under the item's own key, beside its proposals.
  hints_sealed     bytea,
  created_at       timestamptz not null default now(),
  started_at       timestamptz not null default now(),
  -- The send that holds it while it arrives: each of its writes names it,
  -- so a send taken over by a later one changes nothing.
  attempt          uuid,
  received_at      timestamptz,
  decided_at       timestamptz,
  -- Let go of by the app (APP3).
  unlinked_at      timestamptz,
  constraint connected_app_intake_one unique (app_id, external_id),
  foreign key (app_id, household_id) references connected_app (id, household_id) on delete cascade,
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade,
  -- The row outlives its document (it is what keeps a send from being filed
  -- twice), so the document's id goes with the document, and nothing else.
  foreign key (document_id, household_id) references document (id, household_id)
    on delete set null (document_id)
);
create index connected_app_intake_file_idx on connected_app_intake (incoming_file_id)
  where incoming_file_id is not null;
create index connected_app_intake_decided_idx on connected_app_intake (decided_at)
  where state in ('refused', 'removed');

alter table connected_app_intake enable row level security;

create policy connected_app_intake_tenant on connected_app_intake
  using (household_id = app_household()) with check (household_id = app_household());
create policy connected_app_intake_actor on connected_app_intake as restrictive
  using (case app_actor()
           when 'account' then app_role() in ('owner', 'adult') and member_id = app_member()
           when 'system' then true
           else false
         end);

-- What became of an Inbox item, followed in the same transaction, whoever
-- decides it: filed, removed by its person, back after an Undo, or gone
-- with its batch undecided (the worker's sweep). Withdrawn by the app is
-- written by the API before the item goes, so it is not a 'waiting' row
-- here any more.
create function connected_app_intake_follows() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.state = 'received' then
      update connected_app_intake
         set state = 'removed', removed_reason = 'expired', decided_at = now(), hints_sealed = null
       where incoming_file_id = old.id and state = 'waiting';
    end if;
    return old;
  end if;
  if new.state = 'accepted' and old.state = 'received' then
    update connected_app_intake
       set state = 'filed', document_id = new.document_id, version_id = new.version_id,
           decided_at = now(), hints_sealed = null
     where incoming_file_id = new.id and state = 'waiting';
  elsif new.state = 'rejected' and old.state = 'received' then
    update connected_app_intake
       set state = 'removed', removed_reason = 'declined', decided_at = now(), hints_sealed = null
     where incoming_file_id = new.id and state = 'waiting';
  elsif new.state = 'received' and old.state = 'accepted' then
    -- Taken back by an Undo: waiting again.
    update connected_app_intake
       set state = 'waiting', document_id = null, version_id = null, decided_at = null
     where incoming_file_id = new.id and state = 'filed';
  end if;
  return new;
end $$;

-- Before the row goes, so the item is still found by its id.
create trigger connected_app_intake_follows before delete on incoming_file
  for each row execute function connected_app_intake_follows();
create trigger connected_app_intake_follows_state after update of state on incoming_file
  for each row execute function connected_app_intake_follows();

-- ------------------------------------------------- a batch an app a day

-- What an app sends goes into its person's own uploads: a batch an app a
-- household day, and a second past 200 files ("From Acme Money, 16 Nov 2026
-- (2)"). Which app, day and part are fixed once made
-- (intake_batch_account_writes compares every column but those an
-- uploader may change); only a live, approved, unpaused app of the
-- batch's own member is named.
alter table intake_batch
  add column app_id uuid,
  add column app_day date,
  add column app_part int,
  add constraint intake_batch_app_day check (
    (app_id is null) = (app_day is null) and (app_id is null) = (app_part is null)),
  add constraint intake_batch_app_part check (app_part between 1 and 1000),
  add constraint intake_batch_app_fkey
    foreign key (app_id, household_id) references connected_app (id, household_id)
    on delete cascade,
  add constraint intake_batch_app_day_key unique (app_id, app_day, app_part);

create policy intake_batch_app_insert on intake_batch as restrictive for insert
  with check (app_id is null
              or exists (select 1 from connected_app a
                          where a.id = app_id and a.member_id = intake_batch.member_id
                            and a.revoked_at is null and a.paused_reason is null
                            and a.approval = 'approved'));

-- ------------------------------------------------- leaving with a role

-- A sign-in taken away, or a role that can no longer act for an app (a
-- teen, a viewer, a guest): its apps revoked in the same transaction, with
-- the owner's rights. The API writes the activity log's line for each.
create function connected_apps_leave_with_role() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    update connected_app set revoked_at = now(), revoked_reason = 'sign_in_removed'
     where household_id = old.household_id and account_id = old.account_id
       and revoked_at is null;
  elsif new.role::text not in ('owner', 'adult')
        and old.role::text in ('owner', 'adult') then
    update connected_app set revoked_at = now(), revoked_reason = 'cannot_act'
     where household_id = new.household_id and account_id = new.account_id
       and revoked_at is null;
  end if;
  return null;
end $$;

create trigger connected_apps_leave_with_role
  after delete or update of role on account_household
  for each row execute function connected_apps_leave_with_role();

-- --------------------------------------------- the emergency controls

-- Its person signed out everywhere ('signed_out'), or their password
-- stopped by an owner ('owner_stopped'): every app acting as them stops at
-- once. Not on an ordinary password change: an app's credential is not the
-- password. Asked by its person or an owner, with the owner's rights.
-- Answers what it revoked, for the activity log's lines.
create function connected_apps_revoke_for(p_account uuid, p_reason text)
  returns table (id uuid, member_id uuid, name text)
  language plpgsql volatile security definer
  set search_path = pg_catalog, public, pg_temp as $$
#variable_conflict use_column
begin
  if p_reason is null or p_reason not in ('signed_out', 'owner_stopped') then
    raise exception 'not a reason an app is stopped for' using errcode = 'insufficient_privilege';
  end if;
  if not coalesce(app_actor() = 'account'
                  and (app_account() = p_account or app_role() = 'owner'), false) then
    raise exception 'only its person or an owner stops somebody''s apps'
      using errcode = 'insufficient_privilege';
  end if;
  return query
    update connected_app a
       set revoked_at = now(), revoked_by = app_account(), revoked_reason = p_reason
     where a.household_id = app_household() and a.account_id = p_account
       and a.revoked_at is null
    returning a.id, a.member_id, a.name;
end $$;
revoke execute on function connected_apps_revoke_for(uuid, text) from public;
grant execute on function connected_apps_revoke_for(uuid, text) to fdv_app;
