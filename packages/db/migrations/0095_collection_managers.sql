-- Collection managers (0.9.0, the owner's decision of 13 Nov 2026).
--
-- Until now only a collection's maker changed it (A18, 0036). Its maker may
-- now choose particular people of the family to manage it with them, and
-- what each of them may do:
--
--   every manager, always   put documents in it and take them out; fill it
--                           from a checklist, change the checklist or clear
--                           it, and add what it finds; rename it and change
--                           its words.
--   may_change_audience     besides, change who it is for — never to Only
--                           me, which is its maker's alone.
--   may_delete              besides, delete it.
--   may_choose_managers     besides, choose its managers: add them, take
--                           them away and set what they may do — giving
--                           only what they may do themselves.
--
-- Each switch is off unless the maker (or a manager who has it) turns it
-- on. The maker is never one of its managers: they may do everything
-- already, and cannot be taken away.
--
-- A manager is somebody of the family with a sign-in whose role is in the
-- collection's audience now: never a viewer or a guest, never anybody the
-- collection is not for. So a manager never sees more than they did — a
-- collection never widens who sees a document (5.14), and they put in only
-- what they could open themselves (the API asks). An Only me collection
-- has none. A manager who could no longer see the collection is no longer
-- one: made for fewer people, its managers outside it go in the same
-- transaction (doc_collection_drops_managers); a manager whose role moves
-- outside it, or whose sign-in is taken away, goes too
-- (account_household_drops_managers).
--
-- What the database keeps, as 0036 keeps a maker's:
--
--   * a collection's row (doc_collection_changes, doc_collection_owner_writes)
--     is changed by its maker; by a manager — its name, words and when it
--     changed; who it is for with that switch, to an audience they and its
--     maker are both in (a manager never pushes the maker out of their own
--     collection); marked deleted with that switch — or marked deleted by
--     an owner while nobody may delete it any more: its maker may not change
--     it (no sign-in, or outside its audience) and no live manager may
--     delete it (doc_collection_nobody_deletes), so the household can
--     always clear a name ("Divorce") nobody can take back (0036);
--   * its checklist (0077) is written by its maker or any manager;
--   * its managers are written by its maker, in its audience, or by a
--     manager who may choose managers (doc_collection_manager_writer_*),
--     and each row as written is somebody who may be one, given only
--     switches the writer has (doc_collection_manager_rule). While its
--     maker may not change it, an owner who can see it may take its
--     managers away — never add one, nor give anything
--     (doc_collection_clears_managers).
--
-- A manager whose sign-in is locked or paused (0051) is a manager in name
-- only: no power, chosen by nobody, and no bar to an owner's delete.
--
-- What is in a collection (doc_collection_item) keeps 0036's and 0042's
-- rules: the API says who puts documents in.
--
-- A migration is nobody's edit: no audit event is written.

create table doc_collection_manager (
  collection_id       uuid not null,
  household_id        uuid not null references household(id) on delete cascade,
  member_id           uuid not null,
  may_change_audience boolean not null default false,
  may_delete          boolean not null default false,
  may_choose_managers boolean not null default false,
  added_by            uuid references account(id) on delete set null,
  added_at            timestamptz not null default now(),
  primary key (collection_id, member_id),
  foreign key (collection_id, household_id)
    references doc_collection (id, household_id) on delete cascade,
  foreign key (member_id, household_id)
    references member (id, household_id) on delete cascade
);
create index doc_collection_manager_member_idx on doc_collection_manager (member_id);

-- ------------------------------------------------------ who manages, now

-- What member `p_member` may do as a manager of collection `p_collection`
-- were it for `p_audience`: one row, or none when they are not one — not
-- named, not of the family, with no sign-in here, or with a role outside
-- that audience. Only me has no managers. Asked with the audience a row is
-- being written with, so a manager's change of who it is for keeps them in
-- it. With the owner's rights, about the caller's own household alone: its
-- answer does not rest on what the caller may read, and a policy on
-- doc_collection may ask it without asking itself.
create function doc_collection_manager_powers(p_collection uuid, p_audience text, p_member uuid)
  returns table (may_change_audience boolean, may_delete boolean, may_choose_managers boolean)
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select m.may_change_audience, m.may_delete, m.may_choose_managers
       from doc_collection_manager m
       join doc_collection c on c.id = m.collection_id and c.household_id = m.household_id
       join member p on p.id = m.member_id and p.household_id = m.household_id
       join account_household ah on ah.member_id = m.member_id
                                and ah.household_id = m.household_id
      where m.collection_id = p_collection
        and m.member_id = p_member
        and m.household_id = app_household()
        and c.owner_member_id is distinct from m.member_id
        and p.kind = 'family'
        and coalesce(p_audience <> 'only_me', false)
        and collection_audience_has(ah.role, p_audience)
        -- A sign-in locked or paused (0051) manages nothing meanwhile.
        and not suspension_in_effect(ah.suspended_at, ah.suspended_until) $$;
revoke execute on function doc_collection_manager_powers(uuid, text, uuid) from public;
grant execute on function doc_collection_manager_powers(uuid, text, uuid) to fdv_app;

-- Whether nobody may delete a collection any more (0036's stranded, and now
-- its managers too): its maker may not change it — no sign-in, or outside
-- its audience — and no live manager may delete it. Then an owner who can
-- see it may mark it deleted: the household can always clear a name.
create function doc_collection_nobody_deletes(p_collection uuid, maker uuid, aud text)
  returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce(doc_collection_stranded(maker, aud), false)
        and not exists (
              select 1 from doc_collection_manager m
               where m.collection_id = p_collection
                 and m.household_id = app_household()
                 and exists (select 1
                               from doc_collection_manager_powers(p_collection, aud, m.member_id) w
                              where w.may_delete)) $$;
revoke execute on function doc_collection_nobody_deletes(uuid, uuid, text) from public;
grant execute on function doc_collection_nobody_deletes(uuid, uuid, text) to fdv_app;

-- Whether the caller may choose collection `p_collection`'s managers: the
-- vault itself; its maker, while they are in its audience; or a manager
-- who may choose managers.
create function doc_collection_chooses_managers(p_collection uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select case app_actor()
              when 'system' then true
              when 'account' then coalesce((
                select (c.owner_member_id = app_member()
                        and exists (select 1 from account_household ah
                                     where ah.household_id = c.household_id
                                       and ah.member_id = app_member()
                                       and collection_audience_has(ah.role, c.audience)))
                       or exists (select 1
                                    from doc_collection_manager_powers(c.id, c.audience, app_member()) w
                                   where w.may_choose_managers)
                  from doc_collection c
                 where c.id = p_collection
                   and c.household_id = app_household()
                   and c.deleted_at is null), false)
              else false
            end $$;
revoke execute on function doc_collection_chooses_managers(uuid) from public;
grant execute on function doc_collection_chooses_managers(uuid) to fdv_app;

-- Whether the caller may take collection `p_collection`'s managers away:
-- whoever may choose them, or an owner while its maker may not change it
-- (no sign-in, or outside its audience) — so a collection is never left
-- with managers nobody can take away.
create function doc_collection_clears_managers(p_collection uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select doc_collection_chooses_managers(p_collection)
        or (coalesce(app_actor() = 'account' and app_role() = 'owner', false)
            and coalesce((select doc_collection_stranded(c.owner_member_id, c.audience)
                            from doc_collection c
                           where c.id = p_collection
                             and c.household_id = app_household()
                             and c.deleted_at is null), false)) $$;
revoke execute on function doc_collection_clears_managers(uuid) from public;
grant execute on function doc_collection_clears_managers(uuid) to fdv_app;

-- --------------------------------------------------------- the managers

alter table doc_collection_manager enable row level security;

create policy doc_collection_manager_tenant on doc_collection_manager
  using (household_id = app_household()) with check (household_id = app_household());

-- The family signed in, and the vault; nobody else — not a viewer, a guest,
-- a share link, an upload link, a signed-out page or a caller who says
-- nothing. Each role is named, so a role added later sees none until it is
-- taught here.
create policy doc_collection_manager_actor on doc_collection_manager as restrictive
  using (case app_actor()
           when 'account' then case app_role()
                                 when 'owner' then true
                                 when 'adult' then true
                                 when 'teen' then true
                                 else false
                               end
           when 'system' then true
           else false
         end);

-- A collection the caller is not given has no managers for them either:
-- doc_collection's own rules (Only me among them) decide.
create policy doc_collection_manager_collection on doc_collection_manager as restrictive
  using (exists (select 1 from doc_collection l where l.id = doc_collection_manager.collection_id));

-- Written by its maker, in its audience, or by a manager who may choose
-- managers; or by the vault.
create policy doc_collection_manager_writer_insert on doc_collection_manager as restrictive
  for insert
  with check (doc_collection_chooses_managers(collection_id));
create policy doc_collection_manager_writer_update on doc_collection_manager as restrictive
  for update
  using (doc_collection_chooses_managers(collection_id));
-- Taken away, also by an owner while its maker may not change it.
create policy doc_collection_manager_writer_delete on doc_collection_manager as restrictive
  for delete
  using (doc_collection_clears_managers(collection_id));

-- What a row says, as it is written by somebody signed in: somebody who may
-- be a manager of a collection that may have one, never its maker, given
-- only what the writer may do themselves. Its collection, person and
-- household, and who added them and when, stay as they were. The owning
-- role (the migrations, a restore) and the vault write as they must.
create function doc_collection_manager_rule() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
declare
  c record;
  w record;
  maker boolean;
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and (new.collection_id, new.member_id, new.household_id, new.added_by, new.added_at)
         is distinct from (old.collection_id, old.member_id, old.household_id, old.added_by, old.added_at) then
    raise exception 'a manager stays the manager of the collection they were made one of'
      using errcode = 'insufficient_privilege';
  end if;
  select l.id, l.household_id, l.audience, l.owner_member_id, l.deleted_at into c
    from doc_collection l
   where l.id = new.collection_id and l.household_id = new.household_id
     for share;
  if not found or c.deleted_at is not null then
    raise exception 'a deleted collection has no managers'
      using errcode = 'insufficient_privilege';
  end if;
  if c.audience = 'only_me' then
    raise exception 'an Only me collection is its maker''s alone: it has no managers'
      using errcode = 'insufficient_privilege';
  end if;
  if new.member_id is not distinct from c.owner_member_id then
    raise exception 'a collection''s maker is not one of its managers: they may do everything already'
      using errcode = 'insufficient_privilege';
  end if;
  -- Somebody of the family, with a sign-in whose role is in its audience;
  -- held, so a role taken away meanwhile waits.
  perform 1
     from member p
     join account_household ah on ah.member_id = p.id and ah.household_id = p.household_id
    where p.id = new.member_id
      and p.household_id = new.household_id
      and p.kind = 'family'
      and collection_audience_has(ah.role, c.audience)
      -- Nobody is newly chosen while their sign-in is locked or paused.
      and (tg_op = 'UPDATE' or not suspension_in_effect(ah.suspended_at, ah.suspended_until))
      for share of ah;
  if not found then
    raise exception 'a manager is somebody of the family with a sign-in who can see the collection'
      using errcode = 'insufficient_privilege';
  end if;
  maker := coalesce(c.owner_member_id = app_member(), false);
  if maker then
    return new;
  end if;
  -- A manager who may choose managers (the policies asked): giving only
  -- what they may do themselves. Taking a switch away is anybody's who
  -- may choose managers.
  select * into w from doc_collection_manager_powers(c.id, c.audience, app_member());
  if not found or not w.may_choose_managers then
    raise exception 'only its maker, or a manager who may choose managers, chooses a collection''s managers'
      using errcode = 'insufficient_privilege';
  end if;
  if (new.may_change_audience and not w.may_change_audience
      and (tg_op = 'INSERT' or not old.may_change_audience))
     or (new.may_delete and not w.may_delete
         and (tg_op = 'INSERT' or not old.may_delete)) then
    raise exception 'a manager gives another only what they may do themselves'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger doc_collection_manager_rule
  before insert or update on doc_collection_manager
  for each row execute function doc_collection_manager_rule();

-- ------------------------------------------------------ the collection

-- Who changes a collection's row: its maker, a manager (the trigger says
-- what of it), an owner while its maker may not (the trigger: only to mark
-- it deleted, and only while nobody may delete it), or the vault.
alter policy doc_collection_changes on doc_collection
  using (case app_actor()
           when 'account' then coalesce(owner_member_id = app_member(), false)
                               or exists (select 1
                                            from doc_collection_manager_powers(id, audience, app_member()))
                               or (case app_role() when 'owner' then true else false end
                                   and coalesce(doc_collection_stranded(owner_member_id, audience), false))
           when 'system' then true
           else false
         end);

-- What somebody signed in who did not make a collection may change of it
-- (0036's rule, with its managers): a manager its name, its words and when
-- it changed, and who it is for with that switch, to an audience they and
-- its maker are in; marked deleted, once and nothing else, by a manager with
-- that switch or by an owner while nobody may delete it. Every other column is the
-- maker's alone, so a column added later is the maker's too. Nobody signed
-- in hands a collection to another member or household, its maker included.
create or replace function doc_collection_owner_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  w record;
  managed constant text[] := array['name', 'description', 'updated_at', 'audience'];
begin
  if app_actor() = 'account'
     and (new.owner_member_id is distinct from old.owner_member_id
          or new.household_id is distinct from old.household_id) then
    raise exception 'a collection keeps its maker and its household'
      using errcode = 'insufficient_privilege';
  end if;
  if app_actor() is distinct from 'account'
     or coalesce(old.owner_member_id = app_member(), false) then
    return new;
  end if;
  -- Marked deleted, and nothing else.
  if (to_jsonb(new) - 'deleted_at') is not distinct from (to_jsonb(old) - 'deleted_at')
     and old.deleted_at is null and new.deleted_at is not null then
    if exists (select 1 from doc_collection_manager_powers(old.id, old.audience, app_member()) p
                where p.may_delete)
       or (app_role() = 'owner'
           and coalesce(doc_collection_nobody_deletes(old.id, old.owner_member_id, old.audience), false)) then
      return new;
    end if;
    raise exception 'only its maker, or a manager its maker lets, deletes a collection; an owner only one nobody may delete any more'
      using errcode = 'insufficient_privilege';
  end if;
  -- A manager's change.
  select * into w from doc_collection_manager_powers(old.id, old.audience, app_member());
  if found
     and old.deleted_at is null and new.deleted_at is null
     and (to_jsonb(new) - managed) is not distinct from (to_jsonb(old) - managed)
     and (new.audience is not distinct from old.audience
          or (w.may_change_audience
              and exists (select 1
                            from doc_collection_manager_powers(old.id, new.audience, app_member()))
              -- Never pushing its maker out of their own collection.
              and not coalesce(doc_collection_stranded(old.owner_member_id, new.audience), false))) then
    return new;
  end if;
  raise exception 'only its maker changes a collection, or a manager as its maker lets them; an owner may only mark one deleted'
    using errcode = 'insufficient_privilege';
end $$;

-- Made for fewer people, its managers who could no longer see it are no
-- longer its managers, whoever changed it; made Only me, it has none. In
-- the transaction that changes it: the API reads who went, for the log.
create function doc_collection_drops_managers() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  delete from doc_collection_manager m
   where m.collection_id = new.id
     and m.household_id = new.household_id
     and not exists (select 1
                       from member p
                       join account_household ah on ah.member_id = p.id
                                                and ah.household_id = p.household_id
                      where p.id = m.member_id
                        and p.household_id = m.household_id
                        and p.kind = 'family'
                        and new.audience <> 'only_me'
                        and collection_audience_has(ah.role, new.audience));
  return null;
end $$;

create trigger doc_collection_drops_managers
  after update of audience on doc_collection
  for each row
  when (old.audience is distinct from new.audience)
  execute function doc_collection_drops_managers();

-- And somebody whose role moves outside a collection's audience, or whose
-- sign-in is taken away, is no longer its manager.
create function account_household_drops_managers() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  delete from doc_collection_manager m
   using doc_collection c
   where c.id = m.collection_id
     and m.member_id = old.member_id
     and m.household_id = old.household_id
     and (tg_op = 'DELETE'
          or new.member_id is distinct from old.member_id
          or not collection_audience_has(new.role, c.audience));
  return null;
end $$;

create trigger account_household_drops_managers
  after update of role, member_id or delete on account_household
  for each row execute function account_household_drops_managers();

-- --------------------------------------------------- the checklist (0077)

-- Written by its collection's maker or any of its managers, or by the vault.
alter policy collection_checklist_maker_insert on collection_checklist
  with check (coalesce(app_actor() = 'system', false)
              or exists (select 1 from doc_collection l
                          where l.id = collection_checklist.collection_id
                            and (l.owner_member_id = app_member()
                                 or exists (select 1
                                              from doc_collection_manager_powers(l.id, l.audience, app_member())))));
alter policy collection_checklist_maker_update on collection_checklist
  using (coalesce(app_actor() = 'system', false)
         or exists (select 1 from doc_collection l
                     where l.id = collection_checklist.collection_id
                       and (l.owner_member_id = app_member()
                            or exists (select 1
                                         from doc_collection_manager_powers(l.id, l.audience, app_member())))));
alter policy collection_checklist_maker_delete on collection_checklist
  using (coalesce(app_actor() = 'system', false)
         or exists (select 1 from doc_collection l
                     where l.id = collection_checklist.collection_id
                       and (l.owner_member_id = app_member()
                            or exists (select 1
                                         from doc_collection_manager_powers(l.id, l.audience, app_member())))));

grant select, insert, update, delete on doc_collection_manager to fdv_app;
