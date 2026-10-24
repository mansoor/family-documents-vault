-- The local AI reader, off by default, on the household's own server
-- (0.9.0, R4).
--
-- An operator may run a small language model beside the vault — an
-- Ollama-compatible endpoint on the same server or the LAN, set in .env
-- alone (FDV_LOCAL_AI_URL, FDV_LOCAL_AI_MODEL; never from the web). The
-- worker then asks it about a batch's pages, beside the rules, and what it
-- says is one more cue the existing guards weigh: it never makes a card
-- Ready. Each household decides whether its papers are read so:
--
--   household.local_ai  on or off, an owner's; off unless an owner turns it
--                       on (and off for a vault restored from a backup made
--                       before this). Who changes it: an owner signed in
--                       (the API), the vault itself, or the owning role (a
--                       restore) — household_local_ai_rule.
--   local_ai_state      what each worker found of the endpoint: the model
--                       and host the operator set (never the URL's path or
--                       anything else), and whether it answered when last
--                       asked — a row a worker process, written as it starts
--                       and again every few minutes. Read by the API, which
--                       counts only rows said lately, for Settings and for
--                       `features.local_ai`. Not tenant data: the
--                       installation's, as watch_dir is.
--   settings_check      gains `local_ai`: Test, asked by an owner, answered
--                       by the worker — a tiny fixed prompt, no paper's
--                       words; its result the model, the host and how long.

alter table household add column local_ai boolean not null default false;

create function household_local_ai_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.local_ai is distinct from old.local_ai
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner turns the local AI on or off'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger household_local_ai_rule before update on household
  for each row execute function household_local_ai_rule();

create table local_ai_state (
  worker     text primary key
               constraint local_ai_state_worker check (char_length(worker) between 1 and 200),
  model      text not null
               constraint local_ai_state_model check (char_length(model) between 1 and 200),
  host       text not null
               constraint local_ai_state_host check (char_length(host) between 1 and 300),
  state      text not null
               constraint local_ai_state_state check (state in ('reachable', 'unreachable', 'no_model')),
  checked_at timestamptz not null default now()
);
grant select on local_ai_state to fdv_app;
revoke insert, update, delete on local_ai_state from fdv_app;

alter table settings_check drop constraint settings_check_kind;
alter table settings_check add constraint settings_check_kind
  check (kind in ('folder', 'browse', 'mailbox', 'local_ai'));
alter table settings_check drop constraint settings_check_path_kind;
alter table settings_check add constraint settings_check_path_kind
  check ((path is null) = (kind in ('mailbox', 'local_ai')));
