-- Anthropic and OpenAI-compatible readers, and who may be sent (0.9.0, AIR3
-- of plan-ai-readers; the owner's ask of 12 Nov 2026).
--
-- A household may now send a paper's words to Anthropic or to an
-- OpenAI-compatible server, beside the local (Ollama) reader of R4. A
-- reader that runs as a cloud service is sent nothing of a sensitive paper
-- (0090) unless the household says so, never anything of an Only me paper,
-- and at most so many papers a month.
--
--   household.ai_send_sensitive  "Also send sensitive papers" (decision 6):
--                       off unless an owner turns it on, with step-up; the
--                       owners are emailed and the activity log says so each
--                       time it changes. Only Me papers are never sent,
--                       whatever it says. Who changes it: an owner signed in
--                       (the API), the vault itself, or the owning role (a
--                       restore) — household_ai_send_sensitive_rule. A new
--                       kind of reader or a new address turns it off again
--                       (the API): the warning named the provider.
--   ai_reader.own_network  The owner's word that an OpenAI-compatible reader
--                       is on the household's own network (decision 2). It
--                       counts as one only when its address is a private one
--                       too; otherwise it is a cloud service. Ignored for
--                       the other kinds: Anthropic is always a cloud service,
--                       and Ollama is where its address resolves.
--   ai_reader_send      One row for each paper a reader was asked about
--                       (decision 11): which reader (its kind and where it
--                       runs), which paper (a batch's item, or a document a
--                       Reading check read), when, how long, and whether it
--                       answered — never a word sent or received. What the
--                       monthly cap counts (decision 10): the papers sent to
--                       a cloud reader in the household's calendar month,
--                       but those it was never sent (resting, refused). The
--                       owners' to read, the vault's to write; rows older
--                       than 400 days are let go as new ones are written.
--   ai_reader_cap_warning  The month an 80% email went to the owners: one
--                       a household a month, the vault's to write.

-- ------------------------------------------------------------ the switch

alter table household add column ai_send_sensitive boolean not null default false;
-- Which reader the switch was turned on for (the AIR3 review, S3): a saved
-- one by its kind and address, .env's by its kind and host
-- (`aiReaderIdentity`). The warning named that provider; for any other
-- reader — another saved, or .env's taking over or moving — the switch
-- counts as off.
alter table household add column ai_send_sensitive_for text
  constraint household_ai_send_sensitive_for
  check (char_length(ai_send_sensitive_for) between 1 and 400);

create function household_ai_send_sensitive_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if (new.ai_send_sensitive, new.ai_send_sensitive_for)
       is distinct from (old.ai_send_sensitive, old.ai_send_sensitive_for)
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner says whether sensitive papers go to a cloud AI reader'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger household_ai_send_sensitive_rule before update on household
  for each row execute function household_ai_send_sensitive_rule();

-- ------------------------------------------------- an own-network reader

alter table ai_reader add column own_network boolean not null default false;

-- As 0089 made it, with the owner's word on where it runs among what waits
-- for a Test of its own.
create or replace function ai_reader_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if new.updated_by is distinct from app_account() then
    raise exception 'an owner sets up the AI reader as themselves'
      using errcode = 'insufficient_privilege';
  end if;
  if (tg_op = 'INSERT'
      or (new.status, new.last_tested_at, new.last_problem)
         is distinct from (old.status, old.last_tested_at, old.last_problem))
     and (new.status <> 'untested' or new.last_tested_at is not null
          or new.last_problem is not null) then
    raise exception 'whether a Test of the AI reader passed is the vault''s to say'
      using errcode = 'insufficient_privilege';
  end if;
  if new.address_proven
     and (tg_op = 'INSERT' or not old.address_proven
          or (new.kind, new.base_url) is distinct from (old.kind, old.base_url)) then
    raise exception 'whether a Test of the AI reader passed is the vault''s to say'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and new.status <> 'untested'
     and (new.kind, new.base_url, new.model, new.api_key_encrypted, new.runs_at, new.https_only,
          new.own_network)
         is distinct from (old.kind, old.base_url, old.model, old.api_key_encrypted, old.runs_at,
                           old.https_only, old.own_network) then
    raise exception 'a new reader, model or key waits for a Test of its own'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- ------------------------------------------------------ what was sent

create table ai_reader_send (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references household(id) on delete cascade,
  kind             text not null
                     constraint ai_reader_send_kind
                     check (kind in ('ollama', 'anthropic', 'openai_compatible')),
  runs_at          text not null
                     constraint ai_reader_send_runs_at check (runs_at in ('own_network', 'cloud')),
  -- Which paper: a batch's item (its row, and its count, stay when the item
  -- goes), or a document a Reading check read (gone with the document, as
  -- everything that names a document is, but its tombstone).
  incoming_file_id uuid references incoming_file(id) on delete set null,
  document_id      uuid references document(id) on delete cascade,
  purpose          text not null
                     constraint ai_reader_send_purpose check (purpose in ('item', 'check')),
  sent_at          timestamptz not null default now(),
  -- How long it took, once it answered or did not.
  ms               integer constraint ai_reader_send_ms check (ms between 0 and 3600000),
  -- `read`: it answered; `without`: it was sent, and gave nothing to use in
  -- time; `not_sent`: nothing left the vault (resting, the address refused).
  outcome          text
                     constraint ai_reader_send_outcome
                     check (outcome in ('read', 'without', 'not_sent'))
);
create index ai_reader_send_household_idx on ai_reader_send (household_id, sent_at);

alter table ai_reader_send enable row level security;
create policy ai_reader_send_tenant on ai_reader_send
  using (household_id = app_household()) with check (household_id = app_household());
-- The owners' to read, and the vault's.
create policy ai_reader_send_actor on ai_reader_send as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);
-- Written by the vault alone, as it sends.
create policy ai_reader_send_actor_insert on ai_reader_send as restrictive for insert
  with check (app_actor() = 'system');
create policy ai_reader_send_actor_update on ai_reader_send as restrictive for update
  using (app_actor() = 'system');
create policy ai_reader_send_actor_delete on ai_reader_send as restrictive for delete
  using (app_actor() = 'system');

-- ------------------------------------------------------- the 80% email

-- A row a household a month: inserted with `on conflict do nothing`, never
-- updated, so PG 16.16's check of a conflicting row against UPDATE's USING
-- policies never comes into it.
create table ai_reader_cap_warning (
  household_id uuid not null references household(id) on delete cascade,
  -- The first day of the month, on the household's calendar.
  month        date not null
                 constraint ai_reader_cap_warning_month check (extract(day from month) = 1),
  warned_at    timestamptz not null default now(),
  primary key (household_id, month)
);

alter table ai_reader_cap_warning enable row level security;
create policy ai_reader_cap_warning_tenant on ai_reader_cap_warning
  using (household_id = app_household()) with check (household_id = app_household());
create policy ai_reader_cap_warning_actor on ai_reader_cap_warning as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);
create policy ai_reader_cap_warning_actor_insert on ai_reader_cap_warning as restrictive for insert
  with check (app_actor() = 'system');
create policy ai_reader_cap_warning_actor_update on ai_reader_cap_warning as restrictive for update
  using (app_actor() = 'system');
create policy ai_reader_cap_warning_actor_delete on ai_reader_cap_warning as restrictive for delete
  using (app_actor() = 'system');
