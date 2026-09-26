-- Lists of documents (iteration 5.14).
--
-- A family gathers papers for a purpose: "For the mortgage broker", "Mum's
-- care", "Before we travel". A list is a name, a few words, who it is for,
-- and the documents on it in the order they were put there. It holds
-- documents; it never widens who may see one. Each reader is given only
-- the items they could see anyway, and counted as they see them.
--
-- A list's name is information ("Divorce"), so who it is for decides
-- whether it exists at all for a reader (A17):
--
--   everyone   owners, adults and teens. Not a viewer: an accountant or an
--              attorney with a sign-in is given a list only when it is
--              granted to them (5.33).
--   teens      owners, adults and teens.
--   adults     owners and adults.
--   only_me    the member who made it, and nobody else.
--
-- The application keeps the first three. The database keeps Only me
-- itself (doc_list_only_me), so an export, a count or a digest that forgets
-- to ask still cannot give an Only me list's name, or what it holds, to
-- anybody but its maker. The vault itself (system) reads every list.
--
-- As 0030 does for the document tables, each kind of caller has a rule:
-- somebody signed in and the vault itself are given lists; a share link, an
-- upload link, a signed-out page and a caller who says nothing are given
-- none (5.19 gives a list's share what it needs). Every rule is an
-- allow-list, `case ... else false end`; app_actor() and app_member() read
-- '' as NULL (0030), so an unset member matches no Only me list, and no
-- caller matches a `when` it was not named in.
--
-- A list is never removed by the application, only marked deleted: its
-- lines in the activity log are shown to its audience, which they learn
-- from the row, and with the row gone they would be nobody's. So the
-- application role may not delete one (privileges.ts says the same). An
-- item is taken out outright.
--
-- A list and its items are the household's, and a document on a list is of
-- the same household: the keys say so, whatever the application asks.

-- ------------------------------------------------------------- the list

create table doc_list (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references household(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80),
  description     text check (char_length(description) <= 1000),
  audience        text not null check (audience in ('everyone', 'teens', 'adults', 'only_me')),
  -- The member who made it: the one who changes it (A18), and the one an
  -- Only me list is for.
  owner_member_id uuid references member(id) on delete set null,
  created_by      uuid references account(id) on delete set null,
  created_at      timestamptz not null default now(),
  -- Moves when its name, words or audience change: never with its items,
  -- which not every reader is given (its ETag is read by all of them).
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint doc_list_only_me_owner check (audience <> 'only_me' or owner_member_id is not null),
  unique (id, household_id)
);
create index doc_list_household_idx on doc_list (household_id) where deleted_at is null;

-- What an item's second key names: a document of the item's own household.
alter table document add constraint document_id_household_key unique (id, household_id);

-- A document can be on a list once. Taken to the Trash, or made somebody
-- else's Only me, it stays on the list and is simply not given to whoever
-- can no longer see it; brought back, it is there again.
create table doc_list_item (
  list_id      uuid not null,
  document_id  uuid not null,
  household_id uuid not null references household(id) on delete cascade,
  added_by     uuid references account(id) on delete set null,
  added_at     timestamptz not null default now(),
  position     int not null,
  primary key (list_id, document_id),
  foreign key (list_id, household_id) references doc_list (id, household_id) on delete cascade,
  foreign key (document_id, household_id) references document (id, household_id) on delete cascade
);
create index doc_list_item_document_idx on doc_list_item (document_id);

-- ---------------------------------------------------- the household's own

alter table doc_list enable row level security;
create policy doc_list_tenant on doc_list
  using (household_id = app_household()) with check (household_id = app_household());

alter table doc_list_item enable row level security;
create policy doc_list_item_tenant on doc_list_item
  using (household_id = app_household()) with check (household_id = app_household());

-- ------------------------------------------------- each kind of caller

-- The family and the vault; nobody else. With no WITH CHECK, each rule
-- holds the rows written as well as those read.
create policy doc_list_actor on doc_list as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

create policy doc_list_item_actor on doc_list_item as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

-- ------------------------------------------------------------- Only me

-- An Only me list is its maker's, and the vault's: to anybody else it is
-- not there, asked for by id or not asked about at all. Each audience is
-- named, so one added later is nobody's until it is taught here.
create policy doc_list_only_me on doc_list as restrictive
  using (case audience
           when 'everyone' then true
           when 'teens' then true
           when 'adults' then true
           when 'only_me' then coalesce(owner_member_id = app_member(), false)
                               or coalesce(app_actor() = 'system', false)
           else false
         end);

-- And what is on it: the items of a list the caller is not given are not
-- given either, nor can one be put on it.
create policy doc_list_item_list on doc_list_item as restrictive
  using (exists (select 1 from doc_list l where l.id = doc_list_item.list_id));

-- ------------------------------------------------- who changes a list

-- Only its maker changes a list (A18), and the application says so. Two
-- things can leave one that nobody may change: its maker moved to a role
-- outside its audience (an adult made a teen, with a list for the adults),
-- or their sign-in taken away. Its maker may still see it and delete it —
-- these rules read no role, so they give a maker their own row whatever
-- their role now — and an owner may mark it deleted, and nothing else, so
-- the household can clear a name ("Divorce") nobody can take back.
--
-- So here too: a list is changed by the member who made it (app_member()),
-- or by the vault itself; an owner (app_role()) changes one only while it
-- is stranded, and then only its deleted_at, from nothing to a moment
-- (doc_list_owner_writes). An Only me list stays its maker's alone even
-- then: doc_list_only_me keeps it from the owner, so one whose maker has no
-- sign-in is seen, and changed, by nobody.
--
-- Rows this rule does not give are not given to a SELECT ... FOR UPDATE
-- either: the application looks at a list before it holds one, to tell a
-- member of its audience who did not make it why they may not.

-- The roles in each audience (A17): inListAudience in
-- packages/shared/src/roles.ts. Change them together; lists.test.ts holds
-- them equal. An audience, or a role, this has never heard of is nobody's.
create function list_audience_has(member_role text, aud text) returns boolean
  language sql immutable parallel safe
  set search_path = pg_catalog, public, pg_temp as
  $$ select case aud
              when 'everyone' then coalesce(member_role in ('owner', 'adult', 'teen'), false)
              when 'teens' then coalesce(member_role in ('owner', 'adult', 'teen'), false)
              when 'adults' then coalesce(member_role in ('owner', 'adult'), false)
              when 'only_me' then coalesce(member_role in ('owner', 'adult', 'teen'), false)
              else false
            end $$;

-- Whether nobody may change a list any more: its maker (null once their
-- member is gone) has no sign-in in the caller's household, or one whose
-- role is outside the list's audience. It reads account_household with the
-- owner's rights, so its answer does not rest on what the caller may read
-- there, and only about the caller's own household; with no household
-- said, nothing is stranded.
create function doc_list_stranded(maker uuid, aud text) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce(aud in ('everyone', 'teens', 'adults', 'only_me'), false)
        and app_household() is not null
        and not exists (
              select 1 from account_household ah
               where ah.household_id = app_household()
                 and ah.member_id = maker
                 and list_audience_has(ah.role, aud)) $$;
grant execute on function doc_list_stranded(uuid, text) to fdv_app;

-- With no WITH CHECK, the rule holds the row as written too: nobody hands
-- a list to somebody else.
create policy doc_list_changes on doc_list as restrictive for update
  using (case app_actor()
           when 'account' then coalesce(owner_member_id = app_member(), false)
                               or (case app_role() when 'owner' then true else false end
                                   and coalesce(doc_list_stranded(owner_member_id, audience), false))
           when 'system' then true
           else false
         end);

-- What an owner may change on a list they did not make: that it is
-- deleted, once, and nothing else. A rule cannot say which columns change,
-- so a trigger does; it compares every column but deleted_at, so a column
-- added later is the maker's too.
create function doc_list_owner_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() = 'account'
     and old.owner_member_id is distinct from app_member()
     and ((to_jsonb(new) - 'deleted_at') is distinct from (to_jsonb(old) - 'deleted_at')
          or old.deleted_at is not null
          or new.deleted_at is null) then
    raise exception 'only its maker changes a list; an owner may only mark one deleted'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger doc_list_owner_writes before update on doc_list
  for each row execute function doc_list_owner_writes();

grant select, insert, update, delete on doc_list_item to fdv_app;
grant select, insert, update on doc_list to fdv_app;
revoke delete on doc_list from fdv_app;
