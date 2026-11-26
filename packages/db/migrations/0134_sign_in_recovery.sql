-- Getting back in when the second step is lost (0.9.0-dev.104).
--
--   recovery_code     ten one-time codes a person, made when they set up
--                     two-step sign-in and again whenever they ask, each of
--                     which stands in for a lost second step once: with the
--                     password, or after a reset link. A new set replaces
--                     the old. The code itself is never kept: code_hash is
--                     an Argon2id hash, as a password's is. One used is
--                     marked so, and never works again.
--
--   security_answer   three questions a person chose, and their answers,
--                     which stand in for a lost second step as a code does
--                     (never on their own). The answers are kept as Argon2id
--                     hashes of their normalised words — case, spaces and
--                     punctuation taken out — and never shown again. Wrong
--                     answers are counted here: five, and the questions are
--                     refused for a day.
--
-- Both are the vault's alone, to read as to write, as the codes texted to
-- somebody's own number are (0088): nobody signed in, an owner included, no
-- link, no sign-in page and no app is given a row of either. The API reads
-- and writes them as the vault, for the person they belong to. Neither is
-- in a copy of everything (exports), and a restore deletes every recovery
-- code (a used one would work again, and a set replaced since would come
-- back): the person makes new ones.
--
--   account.recovered_at   when a recovery code or the security questions
--                     last stood in for this person's second step. Every
--                     second step was taken away then; until they set one
--                     up again and make new recovery codes beside it, their
--                     sessions may only do that, or sign out. Nobody signed
--                     in sets or clears it: the vault does, and a sign-in
--                     page or a reset link as it is used.
--
--   household.security_questions   whether the household lets security
--                     questions stand in for a lost second step. On unless
--                     an owner turns it off; off, the questions people set
--                     are kept and never asked. An owner's to change (the
--                     rule below), the vault itself, or the owning role (a
--                     restore).
--
-- A migration is nobody's edit: no audit event is written.

create table recovery_code (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  account_id   uuid not null references account(id) on delete cascade,
  member_id    uuid not null,
  code_hash    text not null
                 constraint recovery_code_hash_argon2 check (code_hash like '$argon2id$%'),
  made_at      timestamptz not null default now(),
  used_at      timestamptz,
  -- Their person gone from the household, their codes go with them.
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
-- A person's codes still to use, as a sign-in looks for them.
create index recovery_code_account_idx on recovery_code (account_id) where used_at is null;

alter table recovery_code enable row level security;
create policy recovery_code_tenant on recovery_code
  using (household_id = app_household()) with check (household_id = app_household());
-- The vault's alone, to read as to write.
create policy recovery_code_actor on recovery_code as restrictive
  using (case app_actor() when 'system' then true else false end)
  with check (case app_actor() when 'system' then true else false end);
-- Nothing of it, read or written, while a transaction acts for an app (0110).
create policy recovery_code_no_app on recovery_code as restrictive for all
  using ((select current_setting('app.actor', true)) is distinct from 'connected_app')
  with check ((select current_setting('app.actor', true)) is distinct from 'connected_app');

-- A code, once made, keeps what it is: its hash, its person and when it was
-- made. It is used once, and never unused again. Whoever asks.
create function recovery_code_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.code_hash is distinct from old.code_hash
     or new.account_id is distinct from old.account_id
     or new.member_id is distinct from old.member_id
     or new.household_id is distinct from old.household_id
     or new.made_at is distinct from old.made_at
     or (old.used_at is not null and new.used_at is distinct from old.used_at) then
    raise exception 'a recovery code keeps what it was made as, and is used once'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger recovery_code_writes before update on recovery_code
  for each row execute function recovery_code_writes();

create table security_answer (
  account_id    uuid primary key references account(id) on delete cascade,
  household_id  uuid not null references household(id) on delete cascade,
  member_id     uuid not null,
  -- The three questions, in order: [{ "key": ..., "text": ... }].
  questions     jsonb not null
                  constraint security_answer_three check (jsonb_typeof(questions) = 'array'
                                                          and jsonb_array_length(questions) = 3),
  -- Their answers, in the same order, each an Argon2id hash.
  answer_hashes text[] not null
                  constraint security_answer_three_hashes check (cardinality(answer_hashes) = 3),
  set_at        timestamptz not null default now(),
  -- Wrong answers since tries_since (reserved before they are checked);
  -- refused until refused_until after five.
  tries         integer not null default 0 constraint security_answer_tries check (tries >= 0),
  tries_since   timestamptz,
  refused_until timestamptz,
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);

alter table security_answer enable row level security;
create policy security_answer_tenant on security_answer
  using (household_id = app_household()) with check (household_id = app_household());
-- The vault's alone, to read as to write.
create policy security_answer_actor on security_answer as restrictive
  using (case app_actor() when 'system' then true else false end)
  with check (case app_actor() when 'system' then true else false end);
create policy security_answer_no_app on security_answer as restrictive for all
  using ((select current_setting('app.actor', true)) is distinct from 'connected_app')
  with check ((select current_setting('app.actor', true)) is distinct from 'connected_app');

alter table account add column recovered_at timestamptz;

-- Nobody signed in lifts it from themselves, or puts it on anybody else.
-- The vault, a sign-in page and a reset write it as they always have.
create function account_recovered_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.recovered_at is distinct from old.recovered_at
     and app_actor() is not distinct from 'account' then
    raise exception 'only the vault marks a sign-in as recovered'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger account_recovered_writes before update on account
  for each row execute function account_recovered_writes();

alter table household add column security_questions boolean not null default true;

create function household_security_questions_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.security_questions is distinct from old.security_questions
     and app_actor() is not null and app_actor() <> 'system'
     and (app_actor() <> 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner chooses whether security questions are offered'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger household_security_questions_rule before update on household
  for each row execute function household_security_questions_rule();
