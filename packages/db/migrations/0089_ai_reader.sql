-- The AI reader set in Settings (0.9.0, AIR1; plan-ai-readers).
--
-- Until now the local AI reader (R4, 0081) was set by whoever runs the
-- server alone, in .env (FDV_LOCAL_AI_URL, FDV_LOCAL_AI_MODEL): an address an
-- owner could type points the server at its own network (the O1 review). An
-- owner may now set it in Settings → Reading → AI reader, with the guards the
-- mailbox (S4) and SMS Gate (SMS1) have. What .env sets still wins.
--
--   ai_reader        the household's reader: its kind (Ollama now; Anthropic
--                    and OpenAI-compatible kept for AIR3), its address
--                    (scheme://host[:port] and nothing more; none for
--                    Anthropic, whose address is fixed), the model, how long
--                    a paper may take, where it runs (on the household's own
--                    network, or as a cloud service), its API key — sealed
--                    under a key derived from the master key with the
--                    household, the kind and the address bound in, never
--                    returned by the API, only its last four characters — the
--                    most papers a month a cloud reader may be sent, and
--                    whether a Test passed. An owner's alone; that a Test
--                    passed, and where it found the reader runs, is the
--                    vault's word, never an owner's.
--   local_ai_state   gains the reader's kind (.env's is Ollama) and where the
--                    worker last found it runs.
--   settings_check   gains `ai_reader` (Test the reader saved: a tiny fixed
--                    prompt, no paper) and `ai_models` (its list of models,
--                    names alone).

create table ai_reader (
  household_id      uuid primary key references household(id) on delete cascade,
  kind              text not null
                      constraint ai_reader_kind
                      check (kind in ('ollama', 'anthropic', 'openai_compatible')),
  -- Where the reader is: http or https, a host and maybe a port, and
  -- nothing else — no sign-in, path, query or fragment. The vault adds the
  -- reader's own paths, and calls nothing else.
  base_url          text
                      constraint ai_reader_base_url
                      check (char_length(base_url) between 8 and 300
                             and base_url ~ '^https?://[^/?#@[:space:]]+$'),
  model             text not null
                      constraint ai_reader_model
                      check (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  timeout_seconds   integer not null default 120
                      constraint ai_reader_timeout check (timeout_seconds between 5 and 300),
  runs_at           text not null
                      constraint ai_reader_runs_at check (runs_at in ('own_network', 'cloud')),
  -- AES-256-GCM under deriveKey(master, 'ai-reader-credentials'), the
  -- household, kind and address bound in (MASTER_SEALED): it opens for that
  -- reader alone, and is moved by rotate-master-key, and by a restore of a
  -- backup made under an older key, as the other sealed secrets are.
  api_key_encrypted bytea
                      constraint ai_reader_api_key
                      check (octet_length(api_key_encrypted) between 29 and 4096),
  -- Its last four characters, to tell one key from another; never more.
  api_key_last4     text
                      constraint ai_reader_api_key_last4
                      check (char_length(api_key_last4) between 1 and 4
                             and api_key_last4 !~ '[[:cntrl:]]'),
  monthly_cap       integer not null default 500
                      constraint ai_reader_cap check (monthly_cap between 1 and 100000),
  status            text not null default 'untested'
                      constraint ai_reader_status check (status in ('untested', 'ok', 'failed')),
  last_tested_at    timestamptz,
  last_problem      text
                      constraint ai_reader_last_problem
                      check (last_problem in ('not_set_up', 'unreachable', 'timeout', 'no_model',
                                              'http_error', 'too_big', 'not_saved', 'refused',
                                              'bad_reply')),
  -- The hosted edition's rule, stamped by the API as it saves (the AIR1
  -- review, S1): https to a public address only. The worker holds a reader
  -- to the strictest of this and its own FDV_EDITION, so a worker started
  -- without it still refuses an address inside a network at connect.
  https_only        boolean not null default false,
  -- Whether a Test has ever passed at this kind and address (the AIR1
  -- review, S2): until one has, a Test says only "couldn't reach it" or
  -- "reached it, but it isn't that kind of reader" — never which of the
  -- ways it failed, so it is no scanner of the household's network. The
  -- vault's word; cleared when the kind or the address changes.
  address_proven    boolean not null default false,
  updated_by        uuid references account(id) on delete set null,
  updated_at        timestamptz not null default now(),
  -- Anthropic's address is fixed, and it is always a cloud service; every
  -- other kind has an address of its own.
  constraint ai_reader_address check ((kind = 'anthropic') = (base_url is null)),
  constraint ai_reader_anthropic_cloud check (kind <> 'anthropic' or runs_at = 'cloud')
);

alter table ai_reader enable row level security;
create policy ai_reader_tenant on ai_reader
  using (household_id = app_household()) with check (household_id = app_household());
-- An owner's alone, and the vault's: nobody else signed in, no link, no
-- signed-out page.
create policy ai_reader_actor on ai_reader as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);

-- An owner writes it as themselves. Whether a Test passed, why not, and
-- where it found the reader runs once it passed are the vault's to say: an
-- owner only ever clears it, back to untested. And a new kind, address,
-- model or key waits for a Test of its own: nothing is sent to a reader
-- nobody has tried.
create function ai_reader_account_writes() returns trigger
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
  -- That a Test passed at an address is the vault's to say, and it goes
  -- with the address.
  if new.address_proven
     and (tg_op = 'INSERT' or not old.address_proven
          or (new.kind, new.base_url) is distinct from (old.kind, old.base_url)) then
    raise exception 'whether a Test of the AI reader passed is the vault''s to say'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and new.status <> 'untested'
     and (new.kind, new.base_url, new.model, new.api_key_encrypted, new.runs_at, new.https_only)
         is distinct from (old.kind, old.base_url, old.model, old.api_key_encrypted, old.runs_at,
                           old.https_only) then
    raise exception 'a new reader, model or key waits for a Test of its own'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger ai_reader_account_writes before insert or update on ai_reader
  for each row execute function ai_reader_account_writes();

-- Which reader the household's papers go to, for whoever adds papers (the
-- R4 review's M1 notice, AIR1): its kind, its address and where it runs —
-- only once a Test passed — and nothing else of the setting, never its key.
-- The application's alone.
create function ai_reader_notice() returns table (kind text, base_url text, runs_at text)
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select r.kind, r.base_url, r.runs_at from ai_reader r
      where r.household_id = app_household()
        and app_actor() in ('account', 'system')
        and r.status = 'ok' $$;
revoke execute on function ai_reader_notice() from public;
grant execute on function ai_reader_notice() to fdv_app;

-- What each worker found of .env's reader: its kind, and where it runs.
alter table local_ai_state add column kind text not null default 'ollama'
  constraint local_ai_state_kind check (kind in ('ollama', 'anthropic', 'openai_compatible'));
alter table local_ai_state add column runs_at text
  constraint local_ai_state_runs_at check (runs_at in ('own_network', 'cloud'));

alter table settings_check drop constraint settings_check_kind;
alter table settings_check add constraint settings_check_kind
  check (kind in ('folder', 'browse', 'mailbox', 'local_ai', 'ai_reader', 'ai_models'));
alter table settings_check drop constraint settings_check_path_kind;
alter table settings_check add constraint settings_check_path_kind
  check ((path is null) = (kind in ('mailbox', 'local_ai', 'ai_reader', 'ai_models')));
