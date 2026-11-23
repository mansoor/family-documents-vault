-- Who issued it, as one household names it (0.9.0-dev.91): what a cabinet
-- may be arranged by, and what the Documents table's Who issued it filter
-- finds.
--
--   document.issuer_key  The paper's issuer key: `issued_by` with case,
--                        accents, punctuation, the legal form and a leading
--                        "The" gone (`issuerKey` in @fdv/shared), so
--                        "BARCLAYS BANK UK PLC" and "Barclays Bank UK" are
--                        one. Written by the vault with `issued_by`, on
--                        every create and change, from the one function the
--                        phone and the web use too: Postgres has no way to
--                        fold accents or tell a letter from punctuation that
--                        is the same as JavaScript's on every installation
--                        (its answers hang on the server's locale and C
--                        library), and two keys for one issuer would split it.
--                        Where folding leaves nothing ("Ltd", "—"), the text
--                        itself, lower case, its spaces tidied and commas
--                        gone. Null with no issuer.
--   issuer_alias         The household's "Same as" list: a key said to be
--                        the same issuer as another ("Barclays Bank UK" is
--                        "Barclays"). One level only: `to_key` is never a
--                        key said to be the same as another, which the vault
--                        keeps so as it saves, and a rule below holds it to.
--                        `path` keeps what a join moved: the keys each row
--                        followed before, the nearest first, so separating
--                        one puts back the group it brought with it.
--                        No paper is changed. Read by the whole household,
--                        as the filter and the cabinet follow it for anybody;
--                        written by owners and adults, and the vault.
--   issuer_apart         Two keys said to be separate: never suggested as
--                        the same again, and the time a join was undone,
--                        which a drawn cabinet grows by. As the list: read
--                        by the household (only owners and adults are ever
--                        told of it), written by owners and adults.
--
-- A migration is nobody's edit: no audit event is written. Papers kept
-- before have no key until they are next saved.

alter table document add column issuer_key text
  constraint document_issuer_key
  check (char_length(issuer_key) between 1 and 400 and issuer_key !~ '(^ | $|  )');
create index document_issuer_key_idx on document (household_id, issuer_key)
  where issuer_key is not null and deleted_at is null;
-- And the papers with no issuer given, a folder of their own.
create index document_no_issuer_idx on document (household_id)
  where issuer_key is null and deleted_at is null;

create table issuer_alias (
  household_id uuid not null references household(id) on delete cascade,
  from_key     text not null
                 constraint issuer_alias_from_key
                 check (char_length(from_key) between 1 and 400),
  to_key       text not null
                 constraint issuer_alias_to_key
                 check (char_length(to_key) between 1 and 400),
  -- The keys this one followed before a join moved it, the nearest first.
  path         text[] not null default '{}',
  created_by   uuid references account(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (household_id, from_key),
  constraint issuer_alias_not_itself check (from_key <> to_key)
);
create index issuer_alias_to_idx on issuer_alias (household_id, to_key);

-- One level only: a key that others are the same as is no alias itself,
-- and an alias is never what another is the same as. One change of a
-- household's list at a time, whoever writes it (the vault takes the same
-- lock first): two at once can never make a chain between them.
create function issuer_alias_one_level() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('issuer-alias:' || new.household_id::text, 0));
  if exists (select 1 from issuer_alias a
              where a.household_id = new.household_id
                and (a.from_key = new.to_key or a.to_key = new.from_key)) then
    raise exception 'an issuer is said to be the same as one that is the same as no other'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger issuer_alias_one_level before insert or update on issuer_alias
  for each row execute function issuer_alias_one_level();

create table issuer_apart (
  household_id uuid not null references household(id) on delete cascade,
  a_key        text not null
                 constraint issuer_apart_a_key
                 check (char_length(a_key) between 1 and 400),
  b_key        text not null
                 constraint issuer_apart_b_key
                 check (char_length(b_key) between 1 and 400),
  created_by   uuid references account(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (household_id, a_key, b_key),
  -- Each pair once, in order.
  constraint issuer_apart_order check (a_key < b_key)
);

alter table issuer_alias enable row level security;
create policy issuer_alias_tenant on issuer_alias
  using (household_id = app_household()) with check (household_id = app_household());
-- Read by whoever is signed in to the household (the filter and the
-- cabinet follow it for everybody), and the vault; nobody else — no link,
-- upload link or signed-out page.
create policy issuer_alias_actor on issuer_alias as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);
-- Written by owners and adults, and the vault.
create policy issuer_alias_actor_insert on issuer_alias as restrictive for insert
  with check (app_actor() = 'system'
              or (app_actor() = 'account' and app_role() in ('owner', 'adult')));
create policy issuer_alias_actor_update on issuer_alias as restrictive for update
  using (app_actor() = 'system'
         or (app_actor() = 'account' and app_role() in ('owner', 'adult')));
create policy issuer_alias_actor_delete on issuer_alias as restrictive for delete
  using (app_actor() = 'system'
         or (app_actor() = 'account' and app_role() in ('owner', 'adult')));
-- Nothing of it, read or written, while a transaction acts for an app (0110).
create policy issuer_alias_no_app on issuer_alias as restrictive for all
  using ((select current_setting('app.actor', true)) is distinct from 'connected_app')
  with check ((select current_setting('app.actor', true)) is distinct from 'connected_app');

alter table issuer_apart enable row level security;
create policy issuer_apart_tenant on issuer_apart
  using (household_id = app_household()) with check (household_id = app_household());
create policy issuer_apart_actor on issuer_apart as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);
create policy issuer_apart_actor_insert on issuer_apart as restrictive for insert
  with check (app_actor() = 'system'
              or (app_actor() = 'account' and app_role() in ('owner', 'adult')));
create policy issuer_apart_actor_update on issuer_apart as restrictive for update
  using (app_actor() = 'system'
         or (app_actor() = 'account' and app_role() in ('owner', 'adult')));
create policy issuer_apart_actor_delete on issuer_apart as restrictive for delete
  using (app_actor() = 'system'
         or (app_actor() = 'account' and app_role() in ('owner', 'adult')));
create policy issuer_apart_no_app on issuer_apart as restrictive for all
  using ((select current_setting('app.actor', true)) is distinct from 'connected_app')
  with check ((select current_setting('app.actor', true)) is distinct from 'connected_app');
