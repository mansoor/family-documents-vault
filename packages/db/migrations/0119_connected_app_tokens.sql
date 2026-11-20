-- Connected apps hardened before going live (0.9.0-dev.72).
--
-- 1. Short-lived access tokens (OAuth 2.0 client credentials, RFC 6749
--    §4.4). An app trades its API key for an access token at
--    POST /api/v1/apps/token and sends `Authorization: Bearer` with it on
--    every other app route; the secret then crosses the wire once every
--    fifteen minutes, not on every request. A token is `fdvt_` and 32
--    random bytes, base64url, opaque: the vault keeps its SHA-256 alone, as
--    it keeps a secret's, and finds it by that hash before the household is
--    known (connected_app_token_find). It is bound to the key it was minted
--    with: what a request with it may do is asked of the key and the app as
--    they are when it arrives — the key revoked or expired, the app paused
--    or removed, and the token ends at once, by the same refusals as the
--    key's. Minted, read and removed by the vault alone; the worker's
--    hourly sweep removes those that have ended. A restore removes
--    them all.
--
-- 2. Alerts on unusual use. The networks each key was used from (an IPv4
--    /24, an IPv6 /64): the first time one is used from a network it was
--    never used from, but for its very first, the owners are emailed,
--    once a key a day (`told_at`). 500 a key at most are kept (past them a
--    new one is neither kept nor told of); the sweep forgets one not seen
--    in 90 days. And each app's requests a day, with
--    what is usual for it (the median of the seven days before, days with
--    none counted as none): a day past five times its usual and past 200
--    requests, the owners are emailed, once an app a day. Both the vault's
--    alone to write and read; neither names a person.

-- ------------------------------------------------------------ 1. tokens

create table connected_app_token (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  app_id        uuid not null,
  -- The key it was minted with: revoked or expired, the token ends with it.
  key_id        uuid not null references connected_app_key(id) on delete cascade,
  -- SHA-256 of the token; the token itself is answered once and kept nowhere.
  token_hash    bytea not null constraint connected_app_token_hash_length
                  check (octet_length(token_hash) = 32),
  created_at    timestamptz not null default now(),
  -- Minutes long: an hour at the very most, whatever the vault is set to.
  expires_at    timestamptz not null constraint connected_app_token_expires_soon
                  check (expires_at > created_at and expires_at <= created_at + interval '1 hour'),
  constraint connected_app_token_once unique (token_hash),
  foreign key (app_id, household_id) references connected_app (id, household_id) on delete cascade
);
create index connected_app_token_key_idx on connected_app_token (key_id);
-- The worker's sweep: those past their end.
create index connected_app_token_expires_idx on connected_app_token (expires_at);

alter table connected_app_token enable row level security;

create policy connected_app_token_tenant on connected_app_token
  using (household_id = app_household()) with check (household_id = app_household());
-- The vault's alone, read and written: nobody signed in is given a token,
-- nor anything made from one.
create policy connected_app_token_actor on connected_app_token as restrictive
  using (case app_actor() when 'system' then true else false end)
  with check (case app_actor() when 'system' then true else false end);
-- And nothing of it while a transaction acts for an app (0110's rule on
-- every other table).
create policy connected_app_token_no_app on connected_app_token as restrictive for all
  using ((select current_setting('app.actor', true)) is distinct from 'connected_app')
  with check ((select current_setting('app.actor', true)) is distinct from 'connected_app');

-- Which household, app and key a token names, and what it is checked
-- against: the one question asked before the household is known, as
-- connected_app_find() answers it for a client ID. Nothing for a token
-- the vault does not know.
create function connected_app_token_find(p_token_hash bytea)
  returns table (household_id uuid, app_id uuid, key_id uuid, token_expires_at timestamptz,
                 permissions text[], expires_at timestamptz, key_revoked boolean,
                 revoked boolean, paused_reason text, approval text, ip_allow text[],
                 ip_allow_names text[])
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select t.household_id, a.id, k.id, t.expires_at, k.permissions, k.expires_at,
            k.revoked_at is not null,
            a.revoked_at is not null, a.paused_reason, a.approval, a.ip_allow::text[],
            a.ip_allow_names
       from connected_app_token t
       join connected_app_key k on k.id = t.key_id
       join connected_app a on a.id = t.app_id
      where t.token_hash = p_token_hash $$;
revoke execute on function connected_app_token_find(bytea) from public;
grant execute on function connected_app_token_find(bytea) to fdv_app;

-- ----------------------------------------------- 2. the networks of a key

create table connected_app_key_network (
  key_id        uuid not null references connected_app_key(id) on delete cascade,
  household_id  uuid not null references household(id) on delete cascade,
  -- An IPv4 /24 or an IPv6 /64, as the vault writes it: "203.0.113.0/24".
  network       text not null constraint connected_app_key_network_shape
                  check (char_length(network) between 3 and 64),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- The owners were emailed of this one: once a key a day at most.
  told_at       timestamptz,
  primary key (key_id, network)
);

alter table connected_app_key_network enable row level security;

create policy connected_app_key_network_tenant on connected_app_key_network
  using (household_id = app_household()) with check (household_id = app_household());
create policy connected_app_key_network_actor on connected_app_key_network as restrictive
  using (case app_actor() when 'system' then true else false end)
  with check (case app_actor() when 'system' then true else false end);
create policy connected_app_key_network_no_app on connected_app_key_network as restrictive for all
  using ((select current_setting('app.actor', true)) is distinct from 'connected_app')
  with check ((select current_setting('app.actor', true)) is distinct from 'connected_app');

-- -------------------------------------------------- 3. an app's days

create table connected_app_day (
  app_id        uuid not null,
  household_id  uuid not null references household(id) on delete cascade,
  -- The household's day.
  day           date not null,
  requests      int not null default 0 constraint connected_app_day_requests
                  check (requests >= 0),
  -- The median of the seven days before, as the day began; null when the
  -- app had no day before it to go by.
  usual         int constraint connected_app_day_usual check (usual >= 0),
  -- The owners were emailed that the day is far past its usual: once.
  told_at       timestamptz,
  primary key (app_id, day),
  foreign key (app_id, household_id) references connected_app (id, household_id) on delete cascade
);

alter table connected_app_day enable row level security;

create policy connected_app_day_tenant on connected_app_day
  using (household_id = app_household()) with check (household_id = app_household());
create policy connected_app_day_actor on connected_app_day as restrictive
  using (case app_actor() when 'system' then true else false end)
  with check (case app_actor() when 'system' then true else false end);
create policy connected_app_day_no_app on connected_app_day as restrictive for all
  using ((select current_setting('app.actor', true)) is distinct from 'connected_app')
  with check ((select current_setting('app.actor', true)) is distinct from 'connected_app');
