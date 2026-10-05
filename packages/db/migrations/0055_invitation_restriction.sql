-- Limiting what a viewer can see, from the screens (iteration 5.33, A17,
-- A27, A56–A59). 0054 is the rule; this is what the API needs beside it.
--
-- An invitation carries the limits (`invitation.restriction`). A restriction
-- is keyed on the person, and an invitee has no sign-in until they accept,
-- so the invitation holds it; accepting applies it in the same transaction
-- that makes the sign-in (household/invitations.ts), so the viewer is never
-- unrestricted for a moment. Only a viewer's invitation carries one. An
-- adult inviting a viewer must give one, without Adults only documents
-- (A27); an owner may give one, or none.
--
-- Only a collection for Everyone is given to a viewer (A17). 0054's rule
-- already gives nothing of a collection for anybody narrower, or deleted;
-- from here such a collection is never named in a grant at all. Naming one
-- is refused (a collection for Everyone, not deleted, held FOR SHARE while
-- it is named, so a change of its audience at the same moment waits, or is
-- waited for and seen), and one whose audience changes away from Everyone,
-- or that is deleted, leaves every grant in the same transaction — and is
-- not given again should it ever come back (the 5.33 review, L533-02).
--
-- And the one question an adult or a teen putting a document in a
-- collection may ask of the grants: which viewers given that collection
-- would see it (collection_viewers_given), for "Jane (viewer) will be able
-- to see this".
--
-- Every function here runs with the owner's rights, pg_temp last in its
-- path.

-- ------------------------------------------------- the invitation's limits

-- {people, types, collections, include_adults_only, include_no_person_docs,
-- expires_at, by_owner}: as the API checked it when the invitation was made.
alter table invitation add column restriction jsonb;
alter table invitation add constraint invitation_restriction_viewer
  check (restriction is null or (role = 'viewer' and jsonb_typeof(restriction) = 'object'));

-- ------------------------------------------- only a collection for Everyone

-- A collection named in a grant is one for Everyone, not deleted, held FOR
-- SHARE until the grant commits. Whoever writes it but the owning role (the
-- migrations, a restore).
create function access_restriction_collection_everyone() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is null then
    return new;
  end if;
  perform 1
     from doc_collection c
    where c.id = new.collection_id
      and c.household_id = new.household_id
      and c.audience = 'everyone'
      and c.deleted_at is null
      for share;
  if not found then
    raise exception 'only a collection for Everyone is given to a viewer'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger access_restriction_collection_everyone
  before insert or update on access_restriction_collection
  for each row execute function access_restriction_collection_everyone();

-- A collection made for anybody narrower than Everyone, or deleted, leaves
-- every grant, in the transaction that changes it, whoever changes it (its
-- maker may be an adult or a teen, who read no grant): 0054's rule would
-- give nothing of it, and now nothing names it either. Otherwise a deleted
-- one stayed named, and every save of the viewer's limits naming it was
-- refused (the 5.33 review, L533-02).
create function doc_collection_leaves_grants() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  delete from access_restriction_collection g
   where g.collection_id = new.id
     and g.household_id = new.household_id;
  return null;
end $$;

create trigger doc_collection_leaves_grants
  after update of audience, deleted_at on doc_collection
  for each row
  when ((old.audience = 'everyone' and new.audience is distinct from 'everyone')
        or (old.deleted_at is null and new.deleted_at is not null))
  execute function doc_collection_leaves_grants();

-- And what 5.32 left named: a collection deleted, or for anybody narrower,
-- gives nothing and is named no more.
delete from access_restriction_collection g
 using doc_collection c
 where c.id = g.collection_id
   and (c.deleted_at is not null or c.audience is distinct from 'everyone');

-- ------------------------------------------------------- who will see it

-- The viewers given this collection, each with a sign-in here, and how many
-- of these documents each would see by their grant now (0054's rule, with
-- the collection's items as they are in this transaction): for whoever puts
-- documents in it to be told. Asked by somebody signed in who is not
-- restricted themselves; anybody else is answered nothing.
create function collection_viewers_given(p_collection uuid, p_documents uuid[])
  returns table (member_id uuid, display_name text, documents integer)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
$$ select m.id, m.display_name, count(d.id)::int
     from access_restriction_collection g
     join member m on m.id = g.restricted_member_id and m.household_id = g.household_id
     join account_household a on a.member_id = m.id and a.household_id = m.household_id
     cross join lateral (select app_grant_of(m.id) as gr) x
     join document d on d.id = any(p_documents) and d.household_id = g.household_id
    where g.collection_id = p_collection
      and g.household_id = app_household()
      and app_actor() = 'account'
      and not app_restricted()
      and doc_in_grant(x.gr, d.id, d.visibility, d.owner_member_id, d.type_key)
    group by m.id, m.display_name
    order by m.display_name, m.id $$;
revoke execute on function collection_viewers_given(uuid, uuid[]) from public;
grant execute on function collection_viewers_given(uuid, uuid[]) to fdv_app;
