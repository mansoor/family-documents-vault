-- Emergency information for each person (0.9.0, H4 of the health plan).
--
-- One page a person: their allergies, medications, conditions, blood type,
-- insurance, doctors and emergency contacts, as they (or an owner) typed
-- them. The vault files and shows what was entered; it interprets nothing.
-- The person's advance directive, healthcare proxy and insurance card are
-- their H3 documents, found by kind, never copied here.
--
-- ---------------------------------------------------------- member_emergency
--
-- One row a person, sealed as identity details are (0050): one JSON
-- document under a fresh data key at every write, bound to its household
-- and person ("emergency:<household>:<person>"), the key wrapped under the
-- household's identity key. Who reads it is the row's own `audience` and
-- `chosen`, never the household's identity audience:
--
--   audience  owners_and_self   the person and the owners;
--             adults            and every adult (the default);
--             family            and every teen too;
--   chosen    people of the family named besides, each signed in as an
--             adult or a teen (an owner reads it anyway).
--
-- The words are the identity audience's, and the named people a list as a
-- caregiver grant is: the two patterns the family already knows. A viewer
-- and a guest are never in it, chosen or not.
--
-- A caregiver with a live grant their person kept (0098, H1b) reads it too,
-- under the same conditions as caregiver_reads — signed in as an owner or
-- an adult, the household in standard protection — and nothing else of the
-- person's for it.
--
-- Who writes it: the person (signed in as an owner, an adult or a teen),
-- and every owner. Who chooses its audience, and makes a clinician's link
-- to it: the person, signed in as a grown-up; for anybody else — a child,
-- a teen, somebody with no sign-in — an owner (emergency_chooses).
--
-- A row is never removed but with its person (no delete for the
-- application role, here and in privileges.ts); emptied, it is written
-- empty.

create table member_emergency (
  household_id     uuid not null references household(id) on delete cascade,
  member_id        uuid not null,
  sealed           bytea not null
                     constraint member_emergency_sealed_size
                       check (octet_length(sealed) between 28 and 65536 + 28),
  dek_wrapped      bytea not null,
  wrapped_by_scope uuid not null references scope_key(id),
  audience         text not null default 'adults'
                     constraint member_emergency_audience_known
                       check (audience in ('owners_and_self', 'adults', 'family')),
  chosen           uuid[] not null default '{}'
                     constraint member_emergency_chosen_few
                       check (cardinality(chosen) <= 50),
  version          integer not null default 1
                     constraint member_emergency_version_positive check (version >= 1),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references account(id) on delete set null,
  primary key (member_id),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create index member_emergency_household_idx on member_emergency (household_id);

alter table share_link
  add column emergency_member_id uuid,
  add column emergency_fields text[];

-- A live link's person (its column is added here, the rest of the link
-- below), for the rule on member_emergency.
create function app_link_emergency_member() returns uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.emergency_member_id
       from share_link s
      where s.id = app_live_share()
        and s.household_id = app_household() $$;
revoke execute on function app_link_emergency_member() from public;
grant execute on function app_link_emergency_member() to fdv_app;

-- Whether the caller is the person's caregiver, as caregiver_reads asks it
-- (0098) without a paper: signed in as an owner or an adult, standard
-- protection, a live grant the person kept.
create function emergency_caregiver(p_member uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce(
       app_actor() = 'account'
       and app_role() in ('owner', 'adult')
       and p_member is not null
       and p_member <> app_member()
       and exists (select 1 from household h
                    where h.id = app_household() and h.protection_mode = 'standard')
       and exists (select 1 from caregiver_grant g
                    where g.household_id = app_household()
                      and g.person_member_id = p_member
                      and g.caregiver_member_id = app_member()
                      and g.revoked_at is null
                      and g.person_confirmed_at is not null),
       false) $$;
revoke execute on function emergency_caregiver(uuid) from public;
grant execute on function emergency_caregiver(uuid) to fdv_app;

-- Whether somebody signed in reads another person's page: an owner; an
-- adult or a teen the audience takes in, or chosen by name; their
-- caregiver. Never a viewer or a guest, and nobody restricted.
create function emergency_reads(p_member uuid, p_audience text, p_chosen uuid[]) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce(
       app_actor() = 'account'
       and not app_restricted()
       and (app_role() = 'owner'
            or (app_role() = 'adult' and p_audience in ('adults', 'family'))
            or (app_role() = 'teen' and p_audience = 'family')
            or (app_role() in ('adult', 'teen') and app_member() = any(p_chosen))
            or emergency_caregiver(p_member)),
       false) $$;
revoke execute on function emergency_reads(uuid, text, uuid[]) from public;
grant execute on function emergency_reads(uuid, text, uuid[]) to fdv_app;

-- Who chooses who sees a person's page, and makes a link of it: the person
-- signed in as a grown-up; for anybody else, an owner.
create function emergency_chooses(p_member uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce(
       app_actor() = 'account'
       and ((p_member = app_member() and app_role() in ('owner', 'adult'))
            or (app_role() = 'owner'
                and p_member <> app_member()
                and not member_signs_in_grown_up(p_member))),
       false) $$;
revoke execute on function emergency_chooses(uuid) from public;
grant execute on function emergency_chooses(uuid) to fdv_app;

alter table member_emergency enable row level security;
create policy member_emergency_tenant on member_emergency
  using (household_id = app_household()) with check (household_id = app_household());

-- Read: the person, and whoever emergency_reads says; a link, the one
-- person its live link is to (below); the vault. Nobody else.
create policy member_emergency_actor on member_emergency as restrictive
  using (case app_actor()
           when 'account' then coalesce(member_id = app_member(), false)
                               or emergency_reads(member_id, audience, chosen)
           when 'system' then true
           when 'link' then member_id = (select app_link_emergency_member())
           when 'upload' then false
           when 'anonymous' then false
           else false
         end);

-- Written by the person (an owner, an adult or a teen) and by any owner.
create policy member_emergency_writer_insert on member_emergency as restrictive for insert
  with check (case app_actor()
                when 'account' then case app_role()
                                      when 'owner' then true
                                      when 'adult' then coalesce(member_id = app_member(), false)
                                      when 'teen' then coalesce(member_id = app_member(), false)
                                      else false
                                    end
                when 'system' then true
                else false
              end);
create policy member_emergency_writer_update on member_emergency as restrictive for update
  using (case app_actor()
           when 'account' then case app_role()
                                 when 'owner' then true
                                 when 'adult' then coalesce(member_id = app_member(), false)
                                 when 'teen' then coalesce(member_id = app_member(), false)
                                 else false
                               end
           when 'system' then true
           else false
         end);

grant select, insert, update on member_emergency to fdv_app;
revoke delete on member_emergency from fdv_app;

-- The row's own rules, whoever writes it: stays its person's; a guest keeps
-- none; wrapped under the household's identity key; chosen people are of
-- this family and not the person; its audience changed only by whoever
-- chooses it (a first write by anybody else takes the default); versioned
-- by the database, as identity details are.
create function member_emergency_rule() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'UPDATE'
     and (new.household_id, new.member_id) is distinct from (old.household_id, old.member_id) then
    raise exception 'somebody''s emergency information stays theirs'
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from member m where m.id = new.member_id and m.kind = 'guest') then
    raise exception 'a guest keeps no emergency information'
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(new.chosen) c
              where c = new.member_id
                 or not exists (select 1 from member m
                                 where m.id = c
                                   and m.household_id = new.household_id
                                   and m.kind = 'family')) then
    raise exception 'whoever is chosen to see somebody''s emergency information is of their family'
      using errcode = 'check_violation';
  end if;
  if app_actor() = 'account' then
    if tg_op = 'INSERT' then
      if (new.audience <> 'adults' or cardinality(new.chosen) > 0)
         and not emergency_chooses(new.member_id) then
        raise exception 'only the person, or an owner for a child, chooses who sees their emergency information'
          using errcode = 'insufficient_privilege';
      end if;
    elsif (new.audience, new.chosen) is distinct from (old.audience, old.chosen)
          and not emergency_chooses(new.member_id) then
      raise exception 'only the person, or an owner for a child, chooses who sees their emergency information'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if (new.sealed, new.dek_wrapped, new.wrapped_by_scope, new.audience, new.chosen)
       is not distinct from
       (old.sealed, old.dek_wrapped, old.wrapped_by_scope, old.audience, old.chosen) then
      new.version := old.version;
      new.updated_at := old.updated_at;
      new.updated_by := old.updated_by;
      return new;
    end if;
    new.version := old.version + 1;
  else
    new.version := 1;
  end if;
  if not exists (select 1 from scope_key k
                  where k.id = new.wrapped_by_scope
                    and k.household_id = new.household_id
                    and k.kind = 'identity') then
    raise exception 'somebody''s emergency information is wrapped under the household''s identity key'
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  new.updated_by := app_account();
  return new;
end $$;

create trigger member_emergency_rule before insert or update on member_emergency
  for each row execute function member_emergency_rule();

-- ------------------------------------------------- a clinician's link to it
--
-- The family's own share links (0016 onwards), a third kind beside a
-- document's and a collection's: `emergency_member_id`, the person whose
-- page it gives, and `emergency_fields`, the parts of it the sharer ticked.
-- Always a new link (v2), to view, for 24 hours at most; its factors,
-- sessions, opens, codes, emailing and log lines are every link's. It gives
-- no document, and none of the page but what was ticked.

alter table share_link drop constraint share_link_one_target;
alter table share_link
  add constraint share_link_emergency_fkey
    foreign key (emergency_member_id, household_id)
    references member (id, household_id) on delete cascade,
  -- A link is to one document, one collection or one person's page.
  add constraint share_link_one_target
    check (num_nonnulls(document_id, collection_id, emergency_member_id) = 1),
  add constraint share_link_emergency_fields
    check ((emergency_fields is null) = (emergency_member_id is null)
           and (emergency_fields is null
                or (cardinality(emergency_fields) between 1 and 20
                    and emergency_fields <@ array['date_of_birth', 'blood_type', 'allergies',
                                                  'medications', 'conditions', 'insurance',
                                                  'doctors', 'emergency_contacts', 'notes']::text[]))),
  -- Hours, not days: to view, on the new routes, and a day at most.
  add constraint share_link_emergency_shape
    check (emergency_member_id is null
           or (flow = 'v2'
               and permission = 'view'
               and max_downloads is null
               and expires_at <= created_at + interval '24 hours'));
create index share_link_emergency_idx on share_link (emergency_member_id)
  where emergency_member_id is not null;

-- A link keeps what it was made for: its person and its fields too.
create or replace function share_link_target_fixed() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.document_id is distinct from old.document_id
     or new.collection_id is distinct from old.collection_id
     or new.emergency_member_id is distinct from old.emergency_member_id
     or new.emergency_fields is distinct from old.emergency_fields
     or new.follow_collection is distinct from old.follow_collection
     or new.follow_audience is distinct from old.follow_audience then
    raise exception 'a link keeps what it was made for'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- Who manages a person's links: the person, and the owners. Nobody else
-- signed in is given a row of them, so not even that one exists.
create policy share_link_emergency_actor on share_link as restrictive
  using (case app_actor()
           when 'account' then emergency_member_id is null
                               or coalesce(emergency_member_id = app_member(), false)
                               or coalesce(app_role() = 'owner', false)
           else true
         end);

-- And who makes one: whoever chooses who sees the page, as themselves.
create policy share_link_emergency_insert on share_link as restrictive for insert
  with check (emergency_member_id is null
              or case app_actor()
                   when 'account' then emergency_chooses(emergency_member_id)
                                       and created_by = app_account()
                   when 'system' then true
                   else false
                 end);

-- Whose page a live link gives, by name and date of birth: what the page a
-- clinician opens says at its top. A link is given no other member's row
-- (the member table's rule names its sharer alone), so this reads the one
-- person, and only while the link is live.
create function app_link_emergency_person()
  returns table (display_name text, date_of_birth date)
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select m.display_name, m.date_of_birth
       from member m
      where m.id = (select app_link_emergency_member())
        and m.household_id = app_household() $$;
revoke execute on function app_link_emergency_person() from public;
grant execute on function app_link_emergency_person() to fdv_app;

-- Whether somebody has a page at all, for the API to tell a page the
-- caller is not given (404) from one nobody has written yet (the
-- default's): a yes or a no, never what is on it, and for somebody signed
-- in alone.
create function emergency_page_kept(p_member uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select app_actor() = 'account'
            and exists (select 1 from member_emergency e
                         where e.member_id = p_member
                           and e.household_id = app_household()) $$;
revoke execute on function emergency_page_kept(uuid) from public;
grant execute on function emergency_page_kept(uuid) to fdv_app;

-- 0054's, with the third kind: a person's page lent while the link is
-- live, its maker an owner or an adult whose sign-in works and who is not
-- restricted, still the one who chooses who sees the page — the person
-- signed in as a grown-up, or an owner for anybody else (so an owner's link
-- for a teen ends once the teen signs in as a grown-up: theirs to share
-- then) — and the page still there.
create or replace function app_live_share() returns uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.id
       from share_link s
      where s.id = app_share()
        and s.household_id = app_household()
        and case
              when s.document_id is not null then app_shared_document() is not null
              when s.collection_id is not null then exists (
                select 1
                  from doc_collection c
                  join account_household maker
                    on maker.account_id = s.created_by and maker.household_id = s.household_id
                 where c.id = s.collection_id
                   and c.household_id = s.household_id
                   and s.revoked_at is null
                   and s.paused_at is null
                   and s.expires_at > now()
                   and s.attempts < 10
                   and c.deleted_at is null
                   and c.audience in ('everyone', 'teens', 'adults')
                   and maker.role in ('owner', 'adult')
                   and not suspension_in_effect(maker.suspended_at, maker.suspended_until)
                   and (collection_audience_has(maker.role, c.audience)
                        or coalesce(c.owner_member_id = maker.member_id, false))
                   and not exists (select 1 from access_restriction r
                                    where r.member_id = maker.member_id
                                      and r.household_id = s.household_id))
              when s.emergency_member_id is not null then exists (
                select 1
                  from account_household maker
                  join member m
                    on m.id = s.emergency_member_id and m.household_id = s.household_id
                  join member_emergency e
                    on e.member_id = s.emergency_member_id and e.household_id = s.household_id
                 where maker.account_id = s.created_by
                   and maker.household_id = s.household_id
                   and s.revoked_at is null
                   and s.paused_at is null
                   and s.expires_at > now()
                   and s.attempts < 10
                   and m.kind = 'family'
                   and maker.role in ('owner', 'adult')
                   and not suspension_in_effect(maker.suspended_at, maker.suspended_until)
                   and case
                         when maker.member_id = s.emergency_member_id then true
                         else maker.role = 'owner'
                              and not exists (select 1 from account_household grown
                                               where grown.member_id = s.emergency_member_id
                                                 and grown.household_id = s.household_id
                                                 and grown.role in ('owner', 'adult'))
                       end
                   and not exists (select 1 from access_restriction r
                                    where r.member_id = maker.member_id
                                      and r.household_id = s.household_id))
              else false
            end $$;
grant execute on function app_live_share() to fdv_app;

-- A link's own lines in the activity log may be about its person's page.
create or replace function app_link_may_name(p_type text, p_id uuid) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce((
       select case p_type
                when 'document' then p_id = s.document_id
                                     or p_id in (select app_link_documents())
                when 'collection' then p_id = s.collection_id
                when 'emergency' then p_id = s.emergency_member_id
                else false
              end
         from share_link s
        where s.id = app_share() and s.household_id = app_household()), false) $$;
grant execute on function app_link_may_name(text, uuid) to fdv_app;

alter policy audit_event_link_insert on audit_event
  with check (case app_actor()
                when 'link' then actor_account_id is null
                                 and action = any(app_link_audit_actions())
                                 and case when action = 'share.locked' then app_link_locked()
                                          else true end
                                 and detail->>'share_id' = app_share()::text
                                 and actor_label is not distinct from app_link_label()
                                 and object_type in ('document', 'collection', 'emergency')
                                 and app_link_may_name(object_type, object_id)
                                 and prev_hash is not distinct from audit_chain_head(household_id)
                                 and at between clock_timestamp() - interval '15 minutes'
                                            and clock_timestamp() + interval '1 minute'
                else true
              end);
