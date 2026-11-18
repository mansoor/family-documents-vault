-- Connected apps authenticate with API keys the vault generates (0.9.0-dev.63,
-- APP6), in place of request signing.
--
-- An owner generates a key for an app in Settings → Connected apps: a name
-- (optional), its own permissions (some of the app's scopes), and how long
-- it lasts (a number of days, or never). The vault shows its client ID and
-- secret once and keeps only the SHA-256 of the secret: 32 random bytes
-- need no slow hash, and nothing in this table lets anybody act as an app.
-- The app sends both on every request, as HTTP Basic authentication.
--
-- Only an owner generates or revokes a key; an app never adds or retires
-- one of its own. Two live keys an app at most (not revoked, not expired),
-- so an app can be moved to a new key without a gap. The owners are told
-- 14 days before a key expires, and again once it has (the worker's
-- hourly sweep, once each). A key revoked ends what it opened: a view
-- link it minted, and a session opened from one, end at their next
-- request. A restore revokes every key (a key revoked since the backup
-- would otherwise work again): the owners generate new ones.
--
-- Signing is gone, not kept beside: the public keys, the nonces, the
-- function that found a signature's key, and an app-added key's confirm.
-- The cutover is hard. Apps connected with a public key before this
-- migration stop authenticating until an owner generates an API key for
-- them; every public key is dropped with its table. Nothing else of an app
-- changes. A restore's moment, which signatures were held to, stays as the
-- epoch of an app's changes feed, under the name it means now.

-- ------------------------------------------------------- signing, gone

drop function if exists connected_app_find(uuid, uuid);
drop table connected_app_nonce;
drop table connected_app_key;
drop function if exists connected_app_key_writes();

alter table connected_app rename column signed_after to restored_at;

-- ------------------------------------------------------------ its keys

create table connected_app_key (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references household(id) on delete cascade,
  app_id          uuid not null,
  -- Names the key on every request: `fdvc_` and 16 random bytes,
  -- base64url. Not a secret.
  client_id       text not null constraint connected_app_key_client_id
                    check (client_id ~ '^fdvc_[A-Za-z0-9_-]{22}$'),
  -- SHA-256 of the secret (`fdvs_` and 32 random bytes, base64url): the
  -- secret itself was shown once and is kept nowhere.
  secret_hash     bytea not null constraint connected_app_key_hash_length
                    check (octet_length(secret_hash) = 32),
  name            text constraint connected_app_key_name
                    check (char_length(name) between 1 and 60),
  -- What it may do: some of the app's scopes. A request is held to these
  -- and the app's own, both, as they are when it arrives.
  permissions     text[] not null constraint connected_app_key_permissions
                    check (cardinality(permissions) >= 1
                           and permissions <@ array['documents.send', 'documents.read',
                                                    'documents.download', 'documents.links',
                                                    'documents.delete']::text[]),
  created_by      uuid references account(id) on delete set null,
  created_at      timestamptz not null default now(),
  -- When it stops working; null: never.
  expires_at      timestamptz constraint connected_app_key_expires_after
                    check (expires_at > created_at),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid references account(id) on delete set null,
  -- Why: an owner revoked it, its app was removed, or a restore.
  revoked_reason  text constraint connected_app_key_revoked_reason
                    check (revoked_reason in ('owner', 'app_removed', 'restore')),
  constraint connected_app_key_revoked_says_why
    check ((revoked_at is null) = (revoked_reason is null)),
  -- The owners told it expires soon, and that it has: once each.
  warned_at       timestamptz,
  expired_told_at timestamptz,
  constraint connected_app_key_client_id_key unique (client_id),
  foreign key (app_id, household_id) references connected_app (id, household_id) on delete cascade
);
create index connected_app_key_app_idx on connected_app_key (app_id, created_at);
-- The worker's sweep: keys that will expire, or have, and that nobody has
-- been told of yet.
create index connected_app_key_expiring_idx on connected_app_key (expires_at)
  where revoked_at is null and expires_at is not null and expired_told_at is null;

alter table connected_app_key enable row level security;

create policy connected_app_key_tenant on connected_app_key
  using (household_id = app_household()) with check (household_id = app_household());

-- Listed for whoever sees its app: the owners and its person; and the vault.
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
-- Generated by an owner, as themselves; never by its person or the app.
create policy connected_app_key_actor_insert on connected_app_key as restrictive for insert
  with check (case app_actor()
                when 'account' then app_role() = 'owner' and created_by = app_account()
                when 'system' then true
                else false
              end);
-- Revoked by an owner; its use and the owners' notices noted by the vault.
create policy connected_app_key_actor_update on connected_app_key as restrictive for update
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);
create policy connected_app_key_actor_delete on connected_app_key as restrictive for delete
  using (app_actor() = 'system');
-- And nothing of it, read or written, while a transaction acts for an app
-- (0110's rule on every other table).
create policy connected_app_key_no_app on connected_app_key as restrictive for all
  using ((select current_setting('app.actor', true)) is distinct from 'connected_app')
  with check ((select current_setting('app.actor', true)) is distinct from 'connected_app');

-- Two live keys an app at most, counted under the app's row; never one for
-- a removed app. Nothing of a key changes but its use, its revoking and the
-- owners' notices; a revoked key stays revoked, and who revoked it and why
-- never change after (but for an account going); an owner changes nothing
-- but the revoking.
create function connected_app_key_writes() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  live int;
  gone timestamptz;
begin
  if tg_op = 'INSERT' then
    select revoked_at into gone from connected_app where id = new.app_id for update;
    if gone is not null then
      raise exception 'a removed app is given no key' using errcode = 'insufficient_privilege';
    end if;
    select count(*) into live from connected_app_key
     where app_id = new.app_id and revoked_at is null
       and (expires_at is null or expires_at > now());
    if live >= 2 then
      raise exception 'an app has two live keys at most' using errcode = 'check_violation',
        constraint = 'connected_app_key_two';
    end if;
    return new;
  end if;
  -- Who generated or revoked it, gone with their account.
  if pg_trigger_depth() > 1
     and ((old.created_by is not null and new.created_by is null)
          or (old.revoked_by is not null and new.revoked_by is null))
     and (to_jsonb(new) - array['created_by', 'revoked_by'])
         = (to_jsonb(old) - array['created_by', 'revoked_by']) then
    return new;
  end if;
  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at
          or new.revoked_by is distinct from old.revoked_by
          or new.revoked_reason is distinct from old.revoked_reason) then
    raise exception 'a revoked key stays revoked' using errcode = 'insufficient_privilege';
  end if;
  if (to_jsonb(new) - array['last_used_at', 'revoked_at', 'revoked_by', 'revoked_reason',
                            'warned_at', 'expired_told_at'])
     is distinct from (to_jsonb(old) - array['last_used_at', 'revoked_at', 'revoked_by',
                                             'revoked_reason', 'warned_at',
                                             'expired_told_at']) then
    raise exception 'only a key''s use, its revoking and the notices about it change'
      using errcode = 'insufficient_privilege';
  end if;
  if app_actor() = 'account'
     and (new.last_used_at is distinct from old.last_used_at
          or new.warned_at is distinct from old.warned_at
          or new.expired_told_at is distinct from old.expired_told_at) then
    raise exception 'an owner revokes a key, and nothing else of it'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger connected_app_key_writes before insert or update on connected_app_key
  for each row execute function connected_app_key_writes();

-- An app removed: its keys revoked with it, in the same transaction.
create or replace function connected_app_revoked() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update connected_app_key set revoked_at = now(), revoked_reason = 'app_removed'
     where app_id = new.id and revoked_at is null;
  end if;
  return null;
end $$;

-- Which household and app a client ID names, and what its secret is
-- checked against: the one question asked before the household is known.
-- Nothing for a client ID the vault does not know.
create function connected_app_find(p_client_id text)
  returns table (household_id uuid, app_id uuid, key_id uuid, secret_hash bytea,
                 permissions text[], expires_at timestamptz, key_revoked boolean,
                 revoked boolean, paused_reason text, approval text, ip_allow text[])
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select a.household_id, a.id, k.id, k.secret_hash, k.permissions, k.expires_at,
            k.revoked_at is not null,
            a.revoked_at is not null, a.paused_reason, a.approval, a.ip_allow::text[]
       from connected_app_key k
       join connected_app a on a.id = k.app_id
      where k.client_id = p_client_id $$;
revoke execute on function connected_app_find(text) from public;
grant execute on function connected_app_find(text) to fdv_app;

-- ------------------------------------------------- a link, and its key

-- The key a view or download link was minted with: revoked or expired, the
-- link and any session opened from it end at their next request. Links
-- minted before (with a signature) end now: they are minutes long anyway.
delete from connected_app_link;
alter table connected_app_link
  add column key_id uuid not null references connected_app_key(id) on delete cascade;
create index connected_app_link_key_idx on connected_app_link (key_id);

-- ------------------------------------------- what its own send made, kept

-- The owner's decision (18 Nov 2026): the app that made a document — a send
-- of its filed as a document of its own, not into a family paper — keeps
-- reading it while it is in the vault, out of the Trash and not Only me,
-- whatever newer versions the family or another app added since. 0110 also
-- asked that its current version be one the app sent; no longer. (Deleting
-- it still asks that: the API's, so an app never trashes the family's newer
-- file.) Everything else of the rule is 0110's, word for word.
create or replace function connected_app_documents(p_app uuid) returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as $$
  with app as (
    select a.id, a.household_id
      from connected_app a
      join account_household ah
        on ah.account_id = a.account_id and ah.household_id = a.household_id
       and ah.member_id = a.member_id
     where a.id = p_app and a.household_id = app_household()
       and a.revoked_at is null and a.paused_reason is null and a.approval = 'approved'
       and ah.role::text in ('owner', 'adult')
  ), z as (
    select coalesce(nullif(current_setting('app.zone', true), ''), 'UTC') as zone
  ), docs as (
    select d.id, d.type_key, d.sensitive, t.category as kind_category,
           coalesce(s.sensitive_default, t.sensitive_default) as kind_sensitive,
           coalesce(s.usually_essential, t.usually_essential) as kind_essential,
           connected_app_paper_date(d.issued_on, d.extra, d.created_at, z.zone) as paper_date,
           (now() at time zone z.zone)::date as today
      from app
      join document d on d.household_id = app.household_id
      cross join z
      join document_type t on t.key = d.type_key
       and (t.household_id is null or t.household_id = d.household_id)
      left join document_type_setting s
        on t.household_id is null and s.household_id = d.household_id and s.type_key = t.key
     where d.deleted_at is null
       and d.visibility::text in ('household', 'adults')
       and not d.is_essential
       and d.sensitive is distinct from true
       and d.type_key <> 'note'
       and d.category in ('financial', 'tax', 'bills', 'insurance', 'work', 'property', 'other')
       and t.category in ('financial', 'tax', 'bills', 'insurance', 'work', 'property', 'other')
  )
  select docs.id
    from docs
   where exists (select 1 from connected_app_intake i
                  where i.app_id = p_app and i.document_id = docs.id
                    and i.state = 'filed' and i.unlinked_at is null and i.made_document)
      or (docs.kind_essential is false
          and exists (select 1 from connected_app_grant g
                       where g.app_id = p_app
                         and (g.kind_key = docs.type_key or g.category = docs.kind_category)
                         and docs.paper_date
                             >= (docs.today - make_interval(months => g.lookback_months))::date
                         and (docs.sensitive is false or docs.kind_sensitive is false
                              or docs.type_key = any (g.sensitive_kinds))))
$$;
