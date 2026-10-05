-- Someone outside the family: a guest (iteration 5.34, D4, A27, A28, A34,
-- A37, A54, A55–A59).
--
-- An attorney or an accountant who needs more than a link: a sign-in of
-- their own, always limited to what an owner (or an adult, within what the
-- adult sees, A27) gives them, ending on a day within a year (A28), and
-- never shown among the family. On the wire a guest is a viewer (role
-- `viewer`, kind `guest`), so an older phone treats them as one.
--
--   member.kind                     `family` (everybody until now) or
--                                   `guest`; fixed once the person is made.
--   account_household.access_expires_at
--                                   a guest's sign-in ends then: the API
--                                   refuses the sign-in from then on, and
--                                   their grant is empty (below). Only a
--                                   guest's sign-in has one, and always.
--   invitation.kind, .access_expires_at
--                                   a guest's invitation: always a viewer's,
--                                   always limited, always with an end.
--
-- What the database holds to, whoever writes (the API asks first, and says
-- why in a sentence; these are the second wall):
--
--   - a guest owns no document, by any path — made, changed, handed over,
--     a file sent in and filed — `FDV04`, which the API answers 422;
--   - a guest is a viewer and nothing else, `FDV03` (every route that sets
--     a role asks first, and answers 409 `guest`); and their sign-in ends
--     within a year;
--   - a guest's sign-in never stands without a restriction, nor their
--     restriction go while the sign-in stands (both checked as the
--     transaction commits, so an invitation accepted writes the sign-in and
--     then the limits, as 5.33's did);
--   - a guest has no member key (nothing of theirs is private: they own no
--     document) and no identity details (A34: never in an identity
--     audience, and nobody's record to keep);
--   - and app_restricted() is true for every guest, so one whose
--     restriction row is somehow missing sees nothing at all — fails
--     closed.
--
-- And, from the 5.32 review (R532-04's remainder): somebody signed in reads
-- their own account and the accounts of the household's sign-ins (and of
-- its people whose sign-in was taken away, to give it back) — no longer
-- every account of the instance. A restricted caller keeps 0054's narrower
-- rule beside it.
--
-- Every function here that runs with the owner's rights puts pg_temp last
-- in its path.

-- ------------------------------------------------------------ the columns

alter table member
  add column kind text not null default 'family'
    constraint member_kind_known check (kind in ('family', 'guest'));

alter table account_household add column access_expires_at timestamptz;

alter table invitation
  add column kind text not null default 'family'
    constraint invitation_kind_known check (kind in ('family', 'guest')),
  add column access_expires_at timestamptz,
  -- A guest's invitation is a viewer's, limited, with an end (A27, A28)...
  add constraint invitation_guest_limited
    check (kind = 'family'
           or (role = 'viewer' and restriction is not null and access_expires_at is not null)),
  -- ...and nobody else's has an end.
  add constraint invitation_family_no_end check (kind = 'guest' or access_expires_at is null);

-- --------------------------------------------------------------- the guards

-- Whether somebody is of the family or a guest is fixed once they are made:
-- a guest is never made one of the family (with all the family sees), nor
-- one of the family a guest (whose documents would then be a guest's).
-- Whoever asks but the owning role (a migration, a restore).
create function member_kind_fixed() returns trigger
  language plpgsql
  set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is not null and new.kind is distinct from old.kind then
    raise exception 'whether somebody is of the family or a guest never changes'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger member_kind_fixed before update of kind on member
  for each row execute function member_kind_fixed();

-- A guest owns no document: made for them, changed or handed over to them,
-- a file sent in filed as theirs. Whoever writes it, the owning role too.
-- Its own SQLSTATE, FDV04, which the API answers 422. With the owner's
-- rights: whoever writes may not read the person it names.
create function document_owner_not_guest() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.owner_member_id is not null
     and exists (select 1 from member m
                  where m.id = new.owner_member_id
                    and m.kind = 'guest') then
    raise exception 'a guest owns no document'
      using errcode = 'FDV04';
  end if;
  return new;
end $$;

create trigger document_owner_not_guest before insert or update of owner_member_id on document
  for each row execute function document_owner_not_guest();

-- A guest's sign-in: a viewer's (FDV03; the routes ask first, 409 `guest`),
-- ending on a day within a year (A28); nobody else's ends on a day. Whoever
-- asks but the owning role (a restore, a migration). With the owner's
-- rights: an invitation accepted, or a sign-in given back, may not read the
-- person.
create function account_household_guest() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
declare
  guest boolean;
begin
  if app_actor() is null then
    return new;
  end if;
  select m.kind = 'guest' into guest
    from member m
   where m.id = new.member_id
     and m.household_id = new.household_id;
  if coalesce(guest, false) then
    if new.role is distinct from 'viewer' then
      raise exception 'a guest is always a viewer'
        using errcode = 'FDV03';
    end if;
    if new.access_expires_at is null then
      raise exception 'a guest''s sign-in ends on a day'
        using errcode = 'check_violation';
    end if;
    if (tg_op = 'INSERT' or new.access_expires_at is distinct from old.access_expires_at)
       and new.access_expires_at > now() + interval '366 days' then
      raise exception 'a guest''s sign-in ends within a year'
        using errcode = 'check_violation';
    end if;
  elsif new.access_expires_at is not null then
    raise exception 'only a guest''s sign-in ends on a day'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger account_household_guest before insert or update on account_household
  for each row execute function account_household_guest();

-- A guest's sign-in never stands without a restriction: asked as the
-- transaction commits, so accepting an invitation may make the sign-in and
-- then write its limits (5.33's order). Whoever asks but the owning role.
create function account_household_guest_limited() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is null then
    return null;
  end if;
  if exists (select 1 from member m
              where m.id = new.member_id
                and m.household_id = new.household_id
                and m.kind = 'guest')
     and exists (select 1 from account_household a
                  where a.member_id = new.member_id
                    and a.household_id = new.household_id)
     and not exists (select 1 from access_restriction r
                      where r.member_id = new.member_id
                        and r.household_id = new.household_id) then
    raise exception 'a guest''s sign-in is always limited to what they are given'
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger account_household_guest_limited
  after insert or update of member_id on account_household
  deferrable initially deferred
  for each row execute function account_household_guest_limited();

-- Nor does a guest's restriction go while their sign-in stands (the API
-- refuses DELETE /members/{id}/access for a guest first): asked as the
-- transaction commits, so a sign-in taken away with it, or the person gone
-- with both, is no refusal. Whoever asks but the owning role.
create function access_restriction_guest_kept() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is null then
    return null;
  end if;
  if exists (select 1 from member m
              where m.id = old.member_id
                and m.household_id = old.household_id
                and m.kind = 'guest')
     and exists (select 1 from account_household a
                  where a.member_id = old.member_id
                    and a.household_id = old.household_id)
     and not exists (select 1 from access_restriction r
                      where r.member_id = old.member_id
                        and r.household_id = old.household_id) then
    raise exception 'a guest''s limits stay while they can sign in'
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger access_restriction_guest_kept
  after delete on access_restriction
  deferrable initially deferred
  for each row execute function access_restriction_guest_kept();

-- A guest keeps no identity details here (A34): never in an identity
-- audience, and nobody's record to keep. Whoever writes them.
create function member_identity_not_guest() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  if exists (select 1 from member m
              where m.id = new.member_id
                and m.kind = 'guest') then
    raise exception 'a guest keeps no identity details'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger member_identity_not_guest before insert or update of member_id on member_identity
  for each row execute function member_identity_not_guest();

-- Nor a member key (invitations.ts makes none for them): nothing of a
-- guest's is private, since they own no document. Whoever writes it.
create function scope_key_not_guest() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.kind = 'member'
     and new.member_id is not null
     and exists (select 1 from member m
                  where m.id = new.member_id
                    and m.kind = 'guest') then
    raise exception 'a guest has no member key'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger scope_key_not_guest before insert or update of member_id, kind on scope_key
  for each row execute function scope_key_not_guest();

-- ------------------------------------------------------------ the helpers

-- 0054's: whether the caller is restricted. Every guest is, restriction row
-- or none: one whose row is somehow missing is restricted with no grant, and
-- so sees nothing (5.34's "fails closed").
create or replace function app_restricted() returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select exists (select 1 from access_restriction r
                     where r.member_id = app_member()
                       and r.household_id = app_household())
         or exists (select 1 from member m
                     where m.id = app_member()
                       and m.household_id = app_household()
                       and m.kind = 'guest') $$;

-- 0054's: somebody's restriction, read once. A guest's has run out once
-- their sign-in has ended too (A28), so past their end the database gives
-- them nothing even where nothing asks the API first (a worker's digest
-- built as them).
create or replace function app_grant_of(p_member uuid) returns access_grant
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
$$ select row((r.expires_at is null or r.expires_at > now())
              and not exists (select 1 from account_household a
                               where a.member_id = r.member_id
                                 and a.household_id = r.household_id
                                 and a.access_expires_at is not null
                                 and a.access_expires_at <= now()),
              r.member_id,
              r.include_adults_only,
              r.include_no_person_docs,
              r.limits_people,
              r.limits_types,
              array(select m.member_id from access_restriction_member m
                     where m.restricted_member_id = r.member_id),
              array(select t.type_key from access_restriction_type t
                     where t.restricted_member_id = r.member_id),
              array(select i.document_id
                      from access_restriction_collection g
                      join doc_collection c on c.id = g.collection_id
                      join doc_collection_item i on i.collection_id = g.collection_id
                     where g.restricted_member_id = r.member_id
                       and c.deleted_at is null
                       and c.audience = 'everyone'))::access_grant
     from access_restriction r
    where r.member_id = p_member
      and r.household_id = app_household() $$;
revoke execute on function app_grant_of(uuid) from public;

-- ------------------------------------------------------ whose accounts

-- Somebody signed in reads their own account, those of the household's
-- sign-ins, and those its people had before their sign-in was taken away
-- (to give one back, co-owners.ts) — no other household's (R532-04's
-- remainder). A restricted caller is narrower still (0054). Every other
-- caller is as it was: a sign-in page, a reset and the vault itself read an
-- account by its address or id, and a link or an upload link reads none
-- (0042, 0044).
create policy account_reach on account as restrictive
  using (case app_actor()
           when 'account' then coalesce(id = app_account(), false)
                               or id in (select a.account_id from account_household a
                                          where a.household_id = app_household())
                               or id in (select m.former_account_id from member m
                                          where m.household_id = app_household()
                                            and m.former_account_id is not null)
           else true
         end);
