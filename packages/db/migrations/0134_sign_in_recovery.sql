-- Getting back in when the second step is lost (0.9.0-dev.104).
--
--   recovery_code     ten one-time codes a person, made when they set up
--                     two-step sign-in and again whenever they ask, each of
--                     which stands in for a lost second step once: with the
--                     password, or after a reset link. A new set replaces
--                     the old. The code itself is never kept: code_hash is
--                     an HMAC-SHA256 under a key derived from the master key
--                     (recovery-code-hmac), over the account and the code —
--                     each code has about 50 random bits, so a slow hash
--                     buys nothing but memory at every try. One used is
--                     marked so, and never works again. Rotating the master
--                     key removes every one (it could no longer be checked).
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
-- in a copy of everything (exports), and a restore deletes both (a used
-- code would work again, a set replaced since would come back, and answers
-- changed or removed since would): the person makes and sets them again.
--
--   account.recovered_at   when a recovery code or the security questions
--                     last stood in for this person's second step. Every
--                     second step was taken away then; until they set one
--                     up again and make new recovery codes beside it, their
--                     sessions may only do that, or sign out. The vault's
--                     alone to set and clear (or the owning role's, a
--                     restore).
--
--   account.recovered_session   the session a sign-in's recovery opened:
--                     the one that may finish setting up, while every other
--                     sign-in by password alone is refused. Null after a
--                     recovery at a reset, which opens no session, and once
--                     a reset has been spent since.
--
--   password_reset.skip_text   an owner said, as they made the link, that the
--                     person has lost their phone: the link asks for no code
--                     by text. Only an owner's or the operator's link.
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
  code_hash    bytea not null
                 constraint recovery_code_hash_length check (octet_length(code_hash) = 32),
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

alter table account
  add column recovered_at      timestamptz,
  add column recovered_session uuid;

-- The vault's alone (or the owning role's, a restore): nobody signed in
-- lifts it from themselves or puts it on anybody else, and no sign-in page,
-- link or app writes it.
create function account_recovered_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if (new.recovered_at, new.recovered_session)
       is distinct from (old.recovered_at, old.recovered_session)
     and app_actor() is not null and app_actor() <> 'system' then
    raise exception 'only the vault marks a sign-in as recovered'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger account_recovered_writes before update on account
  for each row execute function account_recovered_writes();

alter table password_reset add column skip_text boolean not null default false,
  add constraint password_reset_skip_text_not_self check (not skip_text or issued_by <> 'self');

-- Said as the link is made, by an owner's or the operator's link, and never
-- after: no account signed in changes it on a link of its own (or anybody's).
-- The vault and the owning role (a restore) may.
create function password_reset_skip_text_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.skip_text and new.issued_by not in ('owner', 'operator') then
      raise exception 'only an owner''s or the operator''s link skips the code by text'
        using errcode = 'insufficient_privilege';
    end if;
  elsif new.skip_text is distinct from old.skip_text
        and app_actor() is not null and app_actor() <> 'system' then
    raise exception 'whether a link asks for the code by text is said as it is made'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger password_reset_skip_text_writes before insert or update on password_reset
  for each row execute function password_reset_skip_text_writes();

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
