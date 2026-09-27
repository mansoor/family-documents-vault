-- Links whose secrets stay out of URLs (iteration 5.16).
--
-- A link used to be /shared/<token>: the secret in a path, which every
-- server and proxy on the way sees, and a GET that opened it, which a link
-- scanner in an email client does before anybody has read the message. A
-- new link is /s#<token>. A fragment never reaches a server; the page reads
-- it, takes it out of the address bar and its tab's history (the browser's
-- own history of visited pages may keep it), and nothing is opened until
-- somebody presses Open. Opening sets a session cookie, and the document is
-- fetched inside that session.
--
-- The two kinds of link are told apart, for good:
--
--   legacy  every link made before this migration. It keeps working on the
--           old routes, and only there, until it lapses (A25): no new one
--           is ever made, so the last is gone within FDV_SHARE_MAX_DAYS.
--   v2      every link made from now on. It works on the new routes only;
--           the old ones answer 404 for it, whatever its options.
--
-- A link keeps its flow (share_link_flow_fixed): a new link turned legacy
-- would open on a route that ignores its options, and a legacy one turned
-- new would carry a secret that has already travelled in paths.
--
-- A session is a v2 link's alone. Its key names the flow, and its check
-- says which, so a legacy link cannot be given one. The later options —
-- 5.18's permission and limits, 5.19's list, 5.20's secret kinds, codes and
-- "this device only" — belong to v2 in the same way: each of those
-- migrations adds its columns to share_link with a check that a legacy row
-- leaves them unset (`flow = 'v2' or <column> is null`).

-- ------------------------------------------------------------- the link

alter table share_link add column flow text not null default 'legacy'
  constraint share_link_flow check (flow in ('legacy', 'v2'));
alter table share_link alter column flow set default 'v2';

-- Paused, for an owner to turn back on (A55): after a restore, which brings
-- back links revoked since the backup was made. 5.21 and 5.28 add their own
-- reasons for what they pause; a link has this one.
alter table share_link
  add column paused_at     timestamptz,
  add column paused_reason text,
  add constraint share_link_paused check ((paused_at is null) = (paused_reason is null)),
  add constraint share_link_paused_reason check (paused_reason in ('restored'));

-- What a session's key names: this link, its household and its flow.
alter table share_link add constraint share_link_id_household_flow_key
  unique (id, household_id, flow);

create function share_link_flow_fixed() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.flow is distinct from old.flow then
    raise exception 'a link keeps the flow it was made with'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger share_link_flow_fixed before update on share_link
  for each row execute function share_link_flow_fixed();

-- ---------------------------------------------------------- the session
--
-- What pressing Open gives the browser: a cookie of 32 random bytes, kept
-- here only as their SHA-256, so neither a dump nor a backup can make one.
-- It lasts 30 minutes from its last use and never more than 4 hours, nor
-- past its link's end (A26): expires_at is the earlier of the two ends,
-- and the vault checks the idle half on every request. Every request inside
-- it checks the link again as well: revoked, paused, expired, locked, the
-- sharer no longer able to see the document, the document in the Trash.
--
-- Who opened it is kept as little as will do: the address cut to its /24
-- (IPv4) or /48 (IPv6) (A24), and the browser's own description of itself.

create table share_session (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  share_id     uuid not null,
  flow         text not null default 'v2' constraint share_session_v2_only check (flow = 'v2'),
  cookie_hash  bytea not null unique,
  -- 5.20's "this device only": the device cookie's hash, when it is on.
  device_hash  bytea,
  -- What was proved to open it: the link alone (null), or its PIN. 5.20
  -- adds a password and an emailed code.
  verified_by  text check (verified_by in ('pin')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  ip           inet,
  user_agent   text check (char_length(user_agent) <= 512),
  constraint share_session_at_most_four_hours
    check (expires_at <= created_at + interval '4 hours'),
  foreign key (share_id, household_id, flow)
    references share_link (id, household_id, flow) on delete cascade
);
create index share_session_share_idx on share_session (share_id);

alter table share_session enable row level security;
create policy share_session_tenant on share_session
  using (household_id = app_household()) with check (household_id = app_household());

-- A rule for each kind of caller (0030's, for this table). A link reaches
-- the sessions of its own share: it makes them, uses them, and ends them —
-- also once the link itself has stopped, so it can clear them away. The
-- family's and the vault's own: every row. Nobody else: none.
create policy share_session_actor on share_session as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then share_id = app_share()
           else false
         end);

-- Which household and link a cookie belongs to, before either is known:
-- the one question asked with the owner's rights, as share_link_household()
-- answers it for a token. Everything after asks as the link.
create function share_session_find(p_cookie_hash bytea)
  returns table (household_id uuid, share_id uuid)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.household_id, s.share_id
       from share_session s
      where s.cookie_hash = p_cookie_hash
        and s.expires_at > now() $$;
grant execute on function share_session_find(bytea) to fdv_app;

-- ----------------------------------------------------- a link's own rule
--
-- 0030's document for a link, with one more check: a paused link reaches
-- nothing, as a revoked one does. The rest is as it was; change it with
-- ShareService.live() (shares.ts).
create or replace function app_shared_document() returns uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.document_id
       from share_link s
       join document d on d.id = s.document_id
       join account_household maker
         on maker.account_id = s.created_by and maker.household_id = s.household_id
      where s.id = app_share()
        and s.household_id = app_household()
        and s.revoked_at is null
        and s.paused_at is null
        and s.expires_at > now()
        and s.attempts < 10
        and d.deleted_at is null
        and case d.visibility
              when 'household' then true
              when 'adults' then maker.role in ('owner', 'adult')
              when 'private' then d.owner_member_id = maker.member_id
              else false
            end $$;
