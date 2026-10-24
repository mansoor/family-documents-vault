-- The vault's reading model, on or off (0.9.0, R2).
--
-- The worker reads a batch's pages with the rules and, beside them, a small
-- local text classifier (the reading model) whose say is one more cue: it
-- may suggest a kind where the rules found none (never Ready by itself),
-- make the rules' own kind sure where it agrees, and keep it from Ready
-- where it disagrees. A household rule, an owner's: on unless an owner turns
-- it off (and on for a vault restored from a backup made before this), so
-- the owner can compare the Reading check with it and without it.
--
-- Who changes it: an owner signed in (the API), the vault itself, or the
-- owning role (a restore) — household_reading_model_rule.

alter table household add column reading_model boolean not null default true;

create function household_reading_model_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.reading_model is distinct from old.reading_model
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner turns the vault''s reading model on or off'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger household_reading_model_rule before update on household
  for each row execute function household_reading_model_rule();

-- Whether each worker has the reading model (the R2 review and its
-- re-check): its weights loaded, held to their hash — or missing, or not the
-- file this release was built with. A row a worker process, written as its
-- proposal thread starts and again every few minutes while it runs; read by
-- the API, which counts only rows said lately (READING_MODEL_STALE_MS) and
-- offers the model (features.reading_model) only while every one of them has
-- it loaded, and by Settings, which says when it is not. Not tenant data:
-- the installation's, as watch_dir is.
create table reading_model_state (
  worker     text primary key
               constraint reading_model_state_worker check (char_length(worker) between 1 and 200),
  state      text not null
               constraint reading_model_state_state check (state in ('loaded', 'missing', 'corrupt')),
  checked_at timestamptz not null default now()
);
grant select on reading_model_state to fdv_app;
revoke insert, update, delete on reading_model_state from fdv_app;
