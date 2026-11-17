-- Connected apps read (0.9.0, APP2): what an app may read, its changes
-- feed, and its downloads.
--
-- An app reads its own documents — those filed from what it sent — and
-- what its read grants cover: a kind or a category, each with a lookback
-- counted on the paper's date ("bank statements and payslips for the last
-- 12 months"). Never anything its person cannot see, nothing Only me (its
-- own included), nothing Essential, nothing in the Trash, no identity,
-- legal, medical or other paper outside the categories an app may ever be
-- given, and never a paper somebody marked Sensitive. A kind Sensitive by
-- default is read through a grant only when an owner said yes to that
-- when they made it.
--
-- The rule is written once, here (connected_app_documents), and the
-- database keeps it: a transaction acting for an app (app.actor
-- 'connected_app') is given those documents and their current files, and
-- nothing at all of any other table. The API reads every document it
-- answers an app with in such a transaction, and asks its own copy of the
-- rule as well.
--
-- What changed for an app is worked out when it asks: what it may read now,
-- with a fingerprint of what it is told of each, against what it was told
-- before (connected_app_seen); each difference is a line of its feed
-- (connected_app_change), so a document it may no longer read is said to
-- be unavailable — never why.

-- ------------------------------------------------------------ the app

alter table connected_app
  -- Bytes a day it may download, within the operator's ceiling.
  add column daily_read_bytes bigint not null default 1073741824
    constraint connected_app_daily_read_bytes
    check (daily_read_bytes between 1048576 and 1099511627776),
  -- What it downloaded today, on the household's calendar.
  add column read_day date,
  add column read_bytes_today bigint not null default 0,
  -- The last "looked up documents" line, so reading never floods the log.
  add column looked_line_at timestamptz,
  -- Its feed's lines up to here are gone (kept 90 days): a cursor before
  -- it is too old, and the app reads everything again.
  add column changes_pruned_to bigint not null default 0;

-- ------------------------------------------------------- its read grants

-- A kind, or a category, it may read, and how far back on the paper's
-- date. Only the categories an app may ever be given; a kind of any other
-- category is never read, whatever is written here.
create table connected_app_grant (
  id                     uuid primary key default gen_random_uuid(),
  household_id           uuid not null references household(id) on delete cascade,
  app_id                 uuid not null,
  kind_key               text constraint connected_app_grant_kind
                           check (kind_key ~ '^[a-z0-9_]{1,64}$'),
  category               text constraint connected_app_grant_category
                           check (category in ('financial', 'tax', 'bills', 'insurance', 'work',
                                               'property', 'other')),
  constraint connected_app_grant_one check ((kind_key is null) <> (category is null)),
  lookback_months        int not null constraint connected_app_grant_lookback
                           check (lookback_months between 1 and 36),
  -- The kinds Sensitive by default an owner said yes to its reading, by
  -- key: a kind that becomes Sensitive later, or is moved into a granted
  -- category, is read only once an owner says yes to it too. When, and who,
  -- last said yes.
  sensitive_kinds        text[] not null default '{}' constraint connected_app_grant_sensitive_kinds
                           check (cardinality(sensitive_kinds) <= 500),
  sensitive_confirmed_at timestamptz,
  sensitive_confirmed_by uuid references account(id) on delete set null,
  created_at             timestamptz not null default now(),
  constraint connected_app_grant_kind_once unique (app_id, kind_key),
  constraint connected_app_grant_category_once unique (app_id, category),
  foreign key (app_id, household_id) references connected_app (id, household_id) on delete cascade
);

alter table connected_app_grant enable row level security;

create policy connected_app_grant_tenant on connected_app_grant
  using (household_id = app_household()) with check (household_id = app_household());
-- Read by whoever sees its app: the owners and its person; the vault.
create policy connected_app_grant_actor on connected_app_grant as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
                               or (app_role() = 'adult'
                                   and exists (select 1 from connected_app a
                                                where a.id = connected_app_grant.app_id
                                                  and a.member_id = app_member()))
           when 'system' then true
           else false
         end);
-- Given, changed and taken away by an owner alone.
create policy connected_app_grant_actor_insert on connected_app_grant as restrictive for insert
  with check (case app_actor()
                when 'account' then app_role() = 'owner'
                when 'system' then true
                else false
              end);
create policy connected_app_grant_actor_update on connected_app_grant as restrictive for update
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);
create policy connected_app_grant_actor_delete on connected_app_grant as restrictive for delete
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);

-- ------------------------------------------------------- its changes feed

-- What it was last told of each document it could read: the fingerprint
-- of the fields it was given, and whether it may still read it.
--
-- Here and in its feed a document is named by its id alone, with no key to
-- it: these rows are what tell the app a document is no longer available,
-- one removed for good included, so they outlive it — its id and nothing
-- else — until the worker lets them go after 90 days.
create table connected_app_seen (
  household_id uuid not null references household(id) on delete cascade,
  app_id       uuid not null,
  document_id  uuid not null,
  fingerprint  bytea not null constraint connected_app_seen_fingerprint
                 check (octet_length(fingerprint) = 32),
  available    boolean not null,
  changed_at   timestamptz not null default now(),
  primary key (app_id, document_id),
  foreign key (app_id, household_id) references connected_app (id, household_id) on delete cascade
);
create index connected_app_seen_gone_idx on connected_app_seen (changed_at) where not available;

-- Its feed: a line each time a document it may read is new or changed,
-- and each time one it could read is no longer available to it.
create table connected_app_change (
  seq          bigint generated always as identity primary key,
  household_id uuid not null references household(id) on delete cascade,
  app_id       uuid not null,
  document_id  uuid not null,
  change       text not null constraint connected_app_change_change
                 check (change in ('changed', 'unavailable')),
  at           timestamptz not null default now(),
  foreign key (app_id, household_id) references connected_app (id, household_id) on delete cascade
);
create index connected_app_change_app_idx on connected_app_change (app_id, seq);
create index connected_app_change_at_idx on connected_app_change (at);

alter table connected_app_seen enable row level security;
alter table connected_app_change enable row level security;

create policy connected_app_seen_tenant on connected_app_seen
  using (household_id = app_household()) with check (household_id = app_household());
create policy connected_app_seen_actor on connected_app_seen as restrictive
  using (app_actor() = 'system');
create policy connected_app_change_tenant on connected_app_change
  using (household_id = app_household()) with check (household_id = app_household());
create policy connected_app_change_actor on connected_app_change as restrictive
  using (app_actor() = 'system');

-- ------------------------------------------------- what it made itself

-- Whether a send that was filed made its document, or went into one that
-- was there (a reviewer filing it as a new version of the family's paper):
-- only a document the app made can be the app's own. Followed from the
-- Inbox in the same transaction, as the rest of the send's state is; an
-- Undo puts it back to waiting, to false, and to not let go of.
alter table connected_app_intake
  add column made_document boolean not null default false;

-- Sends filed before now: from their Inbox item where it is still there;
-- otherwise false, the safe side (the document is then read only as a
-- grant allows).
update connected_app_intake i
   set made_document = not f.as_version
  from incoming_file f
 where f.id = i.incoming_file_id and i.state = 'filed' and f.state = 'accepted';

create or replace function connected_app_intake_follows() returns trigger
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
           made_document = not new.as_version,
           decided_at = now(), hints_sealed = null
     where incoming_file_id = new.id and state = 'waiting';
  elsif new.state = 'rejected' and old.state = 'received' then
    update connected_app_intake
       set state = 'removed', removed_reason = 'declined', decided_at = now(), hints_sealed = null
     where incoming_file_id = new.id and state = 'waiting';
  elsif new.state = 'received' and old.state = 'accepted' then
    -- Taken back by an Undo: waiting again, as if never filed — nor let go
    -- of, so filing it again gives the app its document.
    update connected_app_intake
       set state = 'waiting', document_id = null, version_id = null, decided_at = null,
           made_document = false, unlinked_at = null
     where incoming_file_id = new.id and state = 'filed';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------- the rule

-- The app a transaction acts for, when it acts for one.
create function app_connected_app() returns uuid
  language sql stable parallel safe as
  $$ select nullif(current_setting('app.connected_app_id', true), '')::uuid $$;

-- The date a document's lookback is counted on: its issue date, else its
-- due date (a real day), else the day it was filed, on the household's
-- calendar. Never an error, whatever a detail holds: it is asked of every
-- document a rule looks at.
create function connected_app_paper_date(p_issued date, p_extra jsonb, p_created timestamptz,
                                         p_zone text)
  returns date
  language plpgsql stable parallel safe set search_path = pg_catalog, public, pg_temp as $$
declare
  due text := case jsonb_typeof(p_extra -> 'due_date')
                when 'object' then p_extra -> 'due_date' ->> 'date'
                when 'string' then p_extra ->> 'due_date'
              end;
  y int;
  m int;
  d int;
begin
  if p_issued is not null then
    return p_issued;
  end if;
  if due ~ '^\d{4}-\d{2}-\d{2}$' then
    y := substr(due, 1, 4)::int;
    m := substr(due, 6, 2)::int;
    d := substr(due, 9, 2)::int;
    if y >= 1 and m between 1 and 12 and d >= 1
       and d <= extract(day from (make_date(y, m, 1) + interval '1 month - 1 day')) then
      return make_date(y, m, d);
    end if;
  end if;
  return (p_created at time zone p_zone)::date;
end $$;

-- The documents an app may read now. Its person is an owner or an adult
-- who may act, and the app is live, on and turned on. A document is read
-- when all of these hold:
--   its person sees it (Everyone, or Adults only), and it is not Only me,
--   whoever's it is; not Essential; out of the Trash; not a note;
--   its own category and its kind's are both ones an app may ever be
--   given (an allow-list: a category added later is closed until named);
--   nobody marked it Sensitive;
--   it is the app's own — a document it made (a send of its filed, not let
--   go of, that made the document rather than went into one that was there)
--   whose current version is still one the app sent (its own later file
--   filed into it keeps it its own; a newer one from the family, and a
--   family paper the app's file was filed into, are the family's) — or a
--   grant covers its kind, or its kind's category, its kind not one
--   kept as an Essential, its paper's date within the grant's lookback;
--   and, when its kind makes it Sensitive, that kind was confirmed on the
--   grant (its own need no confirming).
-- The household's calendar is the transaction's app.zone (the API's
-- answer for the household), else UTC.
create function connected_app_documents(p_app uuid) returns setof uuid
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
   where (exists (select 1 from connected_app_intake i
                   where i.app_id = p_app and i.document_id = docs.id
                     and i.state = 'filed' and i.unlinked_at is null and i.made_document)
          and exists (select 1 from connected_app_intake i
                       where i.app_id = p_app and i.document_id = docs.id
                         and i.state = 'filed' and i.unlinked_at is null
                         and i.version_id = (select v.id from document_version v
                                              where v.document_id = docs.id
                                              order by v.version_no desc limit 1)))
      or (docs.kind_essential is false
          and exists (select 1 from connected_app_grant g
                       where g.app_id = p_app
                         and (g.kind_key = docs.type_key or g.category = docs.kind_category)
                         and docs.paper_date
                             >= (docs.today - make_interval(months => g.lookback_months))::date
                         and (docs.sensitive is false or docs.kind_sensitive is false
                              or docs.type_key = any (g.sensitive_kinds))))
$$;
revoke execute on function connected_app_documents(uuid) from public;
grant execute on function connected_app_documents(uuid) to fdv_app;

-- For the rules: what the asking app reads, once a statement.
create function app_connected_app_documents() returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select connected_app_documents(app_connected_app()) $$;
revoke execute on function app_connected_app_documents() from public;
grant execute on function app_connected_app_documents() to fdv_app;

-- And the current version of each: never another.
create function app_connected_app_versions() returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select distinct on (v.document_id) v.id
       from document_version v
      where v.document_id in (select app_connected_app_documents())
      order by v.document_id, v.version_no desc $$;
revoke execute on function app_connected_app_versions() from public;
grant execute on function app_connected_app_versions() to fdv_app;

-- --------------------------------------------------------- the rules kept

-- The document, and its current file: what the app reads, and nothing
-- else. It writes neither.
drop policy document_actor on document;
create policy document_actor on document as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then id in (select app_link_documents())
           when 'connected_app' then id in (select app_connected_app_documents())
           else false
         end);

drop policy document_version_actor on document_version;
create policy document_version_actor on document_version as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then id in (select app_link_versions())
           when 'connected_app' then id in (select app_connected_app_versions())
           else false
         end);

-- Every other table: nothing at all, read or written, while a transaction
-- acts for an app. One rule each, so no table's other rules — some of
-- which leave a caller they do not name alone — open anything to it. On
-- the setting itself, not app_actor(): the restore tells a table's rule
-- for each kind of caller by its asking app_actor(), and this is not one.
do $$
declare
  t text;
begin
  for t in
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
       and c.relname not in ('document', 'document_version')
     order by c.relname
  loop
    execute format(
      'create policy %I on public.%I as restrictive for all
         using ((select current_setting(''app.actor'', true)) is distinct from %L)
         with check ((select current_setting(''app.actor'', true)) is distinct from %L)',
      t || '_no_app', t, 'connected_app', 'connected_app');
  end loop;
end $$;
