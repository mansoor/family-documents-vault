-- The Reading check: the reader measured on a family's own papers (0.9.0, R0).
--
-- An owner asks the worker to re-read the last N documents filed through
-- review — a batch's item or an Inbox file somebody accepted, so a person
-- confirmed its details — with the reader as it is now, and to compare what
-- it offers with the documents' details now. Nothing is written to a
-- document, and no item, proposal or rule is made. Three tables:
--
--   review_filing  a version filed through review: which document, by whom,
--                  when, from where (a batch, or the Inbox), which of its
--                  details the person confirmed as they accepted it, and the
--                  activity log's last line then (what is changed by hand
--                  after is after it). Written by the database as an
--                  incoming file is accepted (incoming_file_filed), and
--                  filled once from the files accepted before; it outlives
--                  the incoming file, whose row goes with its batch or
--                  request. It goes with its version (an Undo) and its
--                  document. The vault's to write; an owner reads only the
--                  rows of documents they can see (never somebody else's
--                  Only me: asked in this one).
--   reading_check  a check: who asked, how many, how far it is, the
--                  reader's version, and its numbers — numbers only, held
--                  by reading_numbers_only(). The owner's who asked, alone,
--                  read and written: not another owner, nobody else signed
--                  in, no link, no signed-out page. One waiting or running a
--                  household. An owner makes one as themselves, cancels or
--                  removes their own; the rest is the worker's. Another
--                  owner is told only whose checks there are, and the state
--                  of each — never its numbers, nor when
--                  (reading_checks_of_others()), so that one at a time
--                  makes sense to them.
--   reading_check_sealed
--                  what the worker has done so far, then which documents
--                  needed typing and what: sealed under the key of the owner
--                  who asked (their member key), kept READING_MISSES_KEEP_DAYS
--                  (7) and theirs alone — never another owner's. Written by
--                  the vault alone.
--
-- No document's words, no proposal and no detail is kept in any of them in
-- the clear: the numbers say how many, and the sealed list says which
-- documents (by id) and which fields (kind, person, expiry).

-- ---------------------------------------------------- filed through review

create table review_filing (
  version_id   uuid primary key references document_version(id) on delete cascade,
  household_id uuid not null references household(id) on delete cascade,
  document_id  uuid not null references document(id) on delete cascade,
  -- Who accepted it; gone with their account.
  filed_by     uuid references account(id) on delete set null,
  filed_at     timestamptz not null default now(),
  -- From a batch (Many documents, the scanner folder, email in, a
  -- computer), or the Inbox (a file sent through a request).
  source       text not null constraint review_filing_source check (source in ('batch', 'inbox')),
  -- The details the person confirmed as they accepted it: a batch's card
  -- shows and files every one; an Inbox file, or a version added to a
  -- document already there, only those the accept set. What was not
  -- confirmed is never scored.
  confirmed    text[] not null default '{}'
                 constraint review_filing_confirmed
                 check (confirmed <@ array['kind', 'person', 'expiry', 'issued', 'number', 'issuer']),
  -- The activity log's last line when it was filed: a change by hand is a
  -- line after it (an accept's own lines, as a version's changes, before).
  filed_audit_id bigint not null default 0
);
create index review_filing_recent_idx on review_filing (household_id, filed_at desc);
create index review_filing_document_idx on review_filing (document_id);

alter table review_filing enable row level security;
create policy review_filing_tenant on review_filing
  using (household_id = app_household()) with check (household_id = app_household());
-- An owner, for a document they can see — everybody's and Adults only, and
-- their own Only me, never somebody else's (the visibility rule an owner is
-- given documents by); and the vault. Nobody else signed in, no link, no
-- signed-out page.
create policy review_filing_actor on review_filing as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
                               and exists (select 1 from document d
                                            where d.id = review_filing.document_id
                                              and (d.visibility <> 'private'
                                                   or d.owner_member_id = app_member()))
           when 'system' then true
           else false
         end);
-- Written by the database alone (incoming_file_filed, as its owner), and
-- removed with its version or document (their foreign keys' cascade).
create policy review_filing_actor_insert on review_filing as restrictive for insert
  with check (app_actor() = 'system');
create policy review_filing_actor_update on review_filing as restrictive for update
  using (app_actor() = 'system');
create policy review_filing_actor_delete on review_filing as restrictive for delete
  using (app_actor() = 'system');

-- An incoming file accepted: the version it made was filed through review.
-- What the person confirmed: what the accept says it set
-- (fdv.review_confirmed, set in the accept's own transaction by the API:
-- an Inbox file's, and a version's added to a document already there), or
-- else, for a batch's item filed as a document of its own, every detail its
-- card filed; else none. Said once, then let go.
create function incoming_file_filed() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  said text := nullif(current_setting('fdv.review_confirmed', true), '');
begin
  if new.state = 'accepted' and old.state is distinct from 'accepted'
     and new.version_id is not null and new.document_id is not null then
    insert into review_filing (version_id, household_id, document_id, filed_by, filed_at,
                               source, confirmed, filed_audit_id)
    values (new.version_id, new.household_id, new.document_id, new.decided_by,
            coalesce(new.decided_at, now()),
            case when new.batch_id is not null then 'batch' else 'inbox' end,
            case when said is not null then string_to_array(said, ',')
                 when new.batch_id is not null and not new.as_version
                   then array['kind', 'person', 'expiry', 'issued', 'number', 'issuer']
                 else '{}'::text[] end,
            coalesce((select max(a.id) from audit_event a
                       where a.household_id = new.household_id), 0))
    on conflict (version_id) do nothing;
    perform set_config('fdv.review_confirmed', '', true);
  end if;
  return null;
end $$;

create trigger incoming_file_filed after update of state on incoming_file
  for each row execute function incoming_file_filed();

-- The files accepted before, while their rows are still here: a batch's
-- item filed as a document of its own confirmed its card's every detail;
-- what anything else confirmed is not known, so nothing of it is scored.
insert into review_filing (version_id, household_id, document_id, filed_by, filed_at,
                           source, confirmed, filed_audit_id)
select f.version_id, f.household_id, f.document_id, f.decided_by,
       coalesce(f.decided_at, f.created_at),
       case when f.batch_id is not null then 'batch' else 'inbox' end,
       case when f.batch_id is not null and not f.as_version
            then array['kind', 'person', 'expiry', 'issued', 'number', 'issuer']
            else '{}'::text[] end,
       coalesce((select max(a.id) from audit_event a
                  where a.household_id = f.household_id
                    and a.at <= coalesce(f.decided_at, f.created_at)), 0)
  from incoming_file f
  join document_version v on v.id = f.version_id and v.document_id = f.document_id
 where f.state = 'accepted'
on conflict (version_id) do nothing;

-- What was changed by hand since: a document's lines in the activity log
-- after its filing's.
create index audit_event_document_idx on audit_event (object_id, id)
  where object_type = 'document';

-- ---------------------------------------------------------------- numbers

-- Numbers only: an object whose keys are plain words (a kind's key, a
-- count's name) and whose leaves are whole numbers, at most five deep;
-- nothing else — no string, no list, no null. @fdv/shared's numbersOnly().
create function reading_numbers_only(v jsonb, depth integer default 0) returns boolean
  language plpgsql immutable parallel safe set search_path = pg_catalog, public, pg_temp as $$
declare
  k text;
  x jsonb;
  n numeric;
begin
  if jsonb_typeof(v) = 'number' then
    n := (v #>> '{}')::numeric;
    return n >= 0 and n = trunc(n) and n <= 9007199254740991;
  end if;
  if depth > 4 or jsonb_typeof(v) is distinct from 'object' then
    return false;
  end if;
  for k, x in select e.key, e.value from jsonb_each(v) e loop
    if k !~ '^[a-z0-9_()-]{1,64}$' or not reading_numbers_only(x, depth + 1) then
      return false;
    end if;
  end loop;
  return true;
end $$;

-- ------------------------------------------------------------------ a check

create table reading_check (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references household(id) on delete cascade,
  -- Who asked: their sign-in, and the member they are (whose key seals the
  -- misses). The check stays when they go; its misses go with them.
  requested_by   uuid references account(id) on delete set null,
  member_id      uuid,
  n              integer not null constraint reading_check_n check (n between 10 and 500),
  -- Documents changed by hand since they were filed are read too, their
  -- details now the truth.
  include_edited boolean not null default true,
  state          text not null default 'waiting'
                   constraint reading_check_state
                   check (state in ('waiting', 'running', 'done', 'cancelled', 'failed')),
  -- Why it failed: the worker stopped it, or a restore did.
  failure        text constraint reading_check_failure check (failure in ('stopped', 'restored')),
  total          integer not null default 0 constraint reading_check_total check (total between 0 and 500),
  done           integer not null default 0,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  -- The reader it measured: the release, and a keyed hash of the rules.
  server_version text constraint reading_check_version check (server_version ~ '^[0-9A-Za-z.+-]{1,64}$'),
  rules_hash     text constraint reading_check_rules check (rules_hash ~ '^[0-9a-f]{12}$'),
  summary        jsonb constraint reading_check_numbers_only
                   check (summary is null or reading_numbers_only(summary)),
  -- The worker's: how many times it had trouble (it gives up at a few), and
  -- until when a run holds the check (one run at a time).
  errors         integer not null default 0 constraint reading_check_errors check (errors between 0 and 1000),
  lease_until    timestamptz,
  constraint reading_check_done_count check (done between 0 and total),
  constraint reading_check_done_has_numbers check ((state = 'done') = (summary is not null)),
  constraint reading_check_failed_says_why check ((state = 'failed') = (failure is not null)),
  constraint reading_check_ended check ((state in ('done', 'cancelled', 'failed')) = (finished_at is not null)),
  foreign key (member_id, household_id) references member (id, household_id)
    on delete set null (member_id)
);
-- One waiting or running a household.
create unique index reading_check_one_running on reading_check (household_id)
  where state in ('waiting', 'running');
create index reading_check_recent_idx on reading_check (household_id, created_at desc);

alter table reading_check enable row level security;
create policy reading_check_tenant on reading_check
  using (household_id = app_household()) with check (household_id = app_household());
-- The owner who asked, alone, and the vault's: not another owner, nobody
-- else signed in, no link, no signed-out page.
create policy reading_check_actor on reading_check as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner' and member_id = app_member()
           when 'system' then true
           else false
         end);

-- What another owner is told of the household's checks that are not theirs:
-- whose each is, and its state — nothing of what it read or counted, nor
-- when. An owner's alone.
create function reading_checks_of_others()
  returns table (state text, member_id uuid)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select c.state, c.member_id
       from reading_check c
      where c.household_id = app_household()
        and app_actor() = 'account' and app_role() = 'owner'
        and c.member_id is distinct from app_member()
      order by c.created_at desc, c.id
      limit 20 $$;
revoke execute on function reading_checks_of_others() from public;
grant execute on function reading_checks_of_others() to fdv_app;
-- Made by an owner as themselves, waiting, with nothing of the worker's.
create policy reading_check_actor_insert on reading_check as restrictive for insert
  with check (case app_actor()
                when 'account' then app_role() = 'owner'
                                    and requested_by = app_account()
                                    and member_id = app_member()
                                    and state = 'waiting' and failure is null
                                    and total = 0 and done = 0
                                    and errors = 0 and lease_until is null
                                    and started_at is null and finished_at is null
                                    and server_version is null and rules_hash is null
                                    and summary is null
                when 'system' then true
                else false
              end);

-- What an owner changes: a check waiting or running, cancelled, now. Every
-- column but those is compared, so a column added later is the worker's too.
create function reading_check_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if old.state in ('waiting', 'running') and new.state = 'cancelled'
     and new.finished_at = now()
     and (to_jsonb(new) - array['state', 'finished_at'])
         = (to_jsonb(old) - array['state', 'finished_at']) then
    return new;
  end if;
  raise exception 'an owner may only cancel a check that is waiting or running'
    using errcode = 'insufficient_privilege';
end $$;

create trigger reading_check_account_writes before update on reading_check
  for each row execute function reading_check_account_writes();

-- ------------------------------------------------------- sealed, the asker's

create table reading_check_sealed (
  check_id         uuid primary key references reading_check(id) on delete cascade,
  household_id     uuid not null references household(id) on delete cascade,
  -- Whose: the owner who asked, and the key it is sealed under (their member key).
  member_id        uuid not null,
  wrapped_by_scope uuid not null references scope_key(id) on delete cascade,
  -- While it runs: the documents chosen and what each reading made of
  -- those done. Once done: which needed typing, and what.
  work_sealed      bytea,
  misses_sealed    bytea,
  -- When it goes (the worker's daily sweep; nobody is given it after).
  expires_at       timestamptz not null,
  constraint reading_check_sealed_one check ((work_sealed is null) <> (misses_sealed is null)),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create index reading_check_sealed_expires_idx on reading_check_sealed (expires_at);

alter table reading_check_sealed enable row level security;
create policy reading_check_sealed_tenant on reading_check_sealed
  using (household_id = app_household()) with check (household_id = app_household());
-- The owner who asked, alone — never another owner — and the vault.
create policy reading_check_sealed_actor on reading_check_sealed as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner' and member_id = app_member()
           when 'system' then true
           else false
         end);
-- Written by the vault alone; removed with its check (the cascade), by the
-- vault, or by the owner who asked as they cancel it (what it read so far
-- goes at once).
create policy reading_check_sealed_actor_insert on reading_check_sealed as restrictive for insert
  with check (app_actor() = 'system');
create policy reading_check_sealed_actor_update on reading_check_sealed as restrictive for update
  using (app_actor() = 'system');
create policy reading_check_sealed_actor_delete on reading_check_sealed as restrictive for delete
  using (case app_actor()
           when 'account' then app_role() = 'owner' and member_id = app_member()
           when 'system' then true
           else false
         end);
