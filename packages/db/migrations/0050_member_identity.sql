-- Identity records, sealed (iteration 5.26).
--
-- Each person's identity details — the Bitwarden identity set (A35): name
-- parts, birth, nationalities, contacts, addresses, work, government IDs,
-- custom fields and notes — kept in two parts:
--
--   shared    read by the person, and by whoever the household's audience
--             gives other people's shared parts to (below); written by the
--             person and by an owner.
--   only_me   the person's alone (A33): read and written by them, and by
--             nobody else signed in — not an owner, not through any path.
--
-- Nothing here is readable as words. Each part is one JSON document sealed
-- with AES-256-GCM under a fresh data key at every write, bound to its
-- household, its person and its part (`identity:<household>:<person>:<part>`),
-- so a part copied onto another person, or into the other part, does not
-- open. The data key is wrapped under the household's identity key (0049)
-- for the shared part, and under the person's own member key for Only me.
-- `filled` names which fields have a value — keys, never values — so what a
-- record lacks can be told without opening it.
--
-- The honest limit: no owner can open an Only me part through the vault,
-- but whoever runs the server holds the master key that wraps every key
-- here, and could. The screens say exactly that (5.27).
--
-- Each part has its own version, moved on by the database at every write: a
-- change to the Only me part moves nothing anybody else can see, and a write
-- made from an older version of a part is refused (the API's 409).
--
-- Who reads whose shared part is the household's choice (A34), in
-- `household.identity_audience`:
--
--   owners_and_self   (the default) the owners, and each person their own;
--   adults            and every adult;
--   family            and every teen.
--
-- Viewers read only their own record, whatever it says. Narrowing takes
-- effect at once. Widening waits 72 hours, while every adult is told and can
-- mark fields Only me first: an owner's request is a `notice_request`, and
-- the wider audience applies from the moment its notice runs out. No caller
-- that says who it is can set a wider audience before then (the guard
-- below), and the rule that reads the audience counts a notice that has run
-- out as in effect (identity_audience_now). A restore withdraws every
-- notice still waiting and sets the audience back to the narrowest.
--
-- notice_request is a primitive of its own, for anything that is done only
-- after the people it touches have been told: today the identity audience;
-- break-glass access later.

-- ------------------------------------------------------- the audience

alter table household
  add column identity_audience text not null default 'owners_and_self'
    constraint household_identity_audience_known
      check (identity_audience in ('owners_and_self', 'adults', 'family'));

-- How wide each audience is. One never heard of is narrower than any.
create function identity_audience_rank(aud text) returns integer
  language sql immutable parallel safe
  set search_path = pg_catalog, public, pg_temp as
  $$ select case aud
              when 'owners_and_self' then 0
              when 'adults' then 1
              when 'family' then 2
              else -1
            end $$;

-- Whether somebody of this role reads other people's shared parts under this
-- audience: canSeeIdentity (packages/shared/src/roles.ts) but for the person
-- themselves, whom the rules below ask about on their own. Each role named,
-- so a role or an audience added later is nobody's until it is taught here;
-- visibility-rule.test.ts holds the two equal.
create function identity_audience_sees(aud text, reader_role text) returns boolean
  language sql immutable parallel safe
  set search_path = pg_catalog, public, pg_temp as
  $$ select (case reader_role
               when 'owner' then aud in ('owners_and_self', 'adults', 'family')
               when 'adult' then aud in ('adults', 'family')
               when 'teen' then aud = 'family'
               else false
             end) is true $$;

-- ------------------------------------------------------------ notices

create table notice_request (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references household(id) on delete cascade,
  kind          text not null
                  constraint notice_request_kind_known check (kind in ('identity_audience')),
  -- What it is about, by kind. 'identity_audience': the audience it widens to.
  subject       text not null,
  requested_by  uuid references account(id) on delete set null,
  requested_at  timestamptz not null default now(),
  -- Nothing it asks for happens before this.
  notice_until  timestamptz not null,
  completed_at  timestamptz,
  withdrawn_at  timestamptz,
  constraint notice_request_ends_once check (completed_at is null or withdrawn_at is null),
  constraint notice_request_identity_subject
    check (kind <> 'identity_audience' or subject in ('adults', 'family')),
  -- A wider audience for identity details waits 72 hours (A34).
  constraint notice_request_identity_notice
    check (kind <> 'identity_audience' or notice_until >= requested_at + interval '72 hours')
);
-- One widening of the identity audience waiting at a time, a household.
create unique index notice_request_one_identity_audience on notice_request (household_id)
  where kind = 'identity_audience' and completed_at is null and withdrawn_at is null;

alter table notice_request enable row level security;
create policy notice_request_tenant on notice_request
  using (household_id = app_household()) with check (household_id = app_household());

-- Read by everybody signed in — a notice is for telling people — and by the
-- vault itself. A share link, an upload link (A74), a signed-out page and a
-- caller who says nothing read none of it.
create policy notice_request_actor on notice_request as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then false
           when 'upload' then false
           when 'anonymous' then false
           else false
         end);

-- Asked for by an owner, in their own name; ended by an owner, or the vault.
create policy notice_request_actor_insert on notice_request as restrictive for insert
  with check (case app_actor()
                when 'account' then case app_role() when 'owner' then true else false end
                                    and requested_by is not distinct from app_account()
                when 'system' then true
                else false
              end);
create policy notice_request_actor_update on notice_request as restrictive for update
  using (case app_actor()
           when 'account' then case app_role() when 'owner' then true else false end
           when 'system' then true
           else false
         end);

-- Never removed but with its household: what was asked, and when, is kept.
revoke delete on notice_request from fdv_app;

-- What a notice says is fixed once asked: asked now, and ending once —
-- completed, only once its notice has run out, or withdrawn — with nothing
-- else changing. Whoever asks that says who they are; the operator's own
-- connection (a restore, a migration) says nobody.
create function notice_request_fixed() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.requested_at is distinct from now()
       or new.completed_at is not null or new.withdrawn_at is not null then
      raise exception 'a notice is asked for now, and ends later'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['completed_at', 'withdrawn_at'])
       is distinct from (to_jsonb(old) - array['completed_at', 'withdrawn_at'])
     or (old.completed_at is not null and new.completed_at is distinct from old.completed_at)
     or (old.withdrawn_at is not null and new.withdrawn_at is distinct from old.withdrawn_at)
     or (old.completed_at is null and new.completed_at is not null
         and (new.notice_until > now() or new.completed_at < new.notice_until)) then
    raise exception 'a notice ends once, and is completed only once it has run out'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger notice_request_fixed before insert or update on notice_request
  for each row execute function notice_request_fixed();

-- The household's audience now: what it is set to, or the wider one whose
-- notice has run out and which nobody has written in yet. With the owner's
-- rights, so that every caller's rule reads the same answer, notices and
-- all; for the asking household alone.
create function identity_audience_now() returns text
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce(
              (select n.subject
                 from notice_request n
                where n.household_id = h.id
                  and n.kind = 'identity_audience'
                  and n.completed_at is null
                  and n.withdrawn_at is null
                  and n.notice_until <= now()),
              h.identity_audience)
       from household h
      where h.id = app_household() $$;
grant execute on function identity_audience_now() to fdv_app;

-- Nobody widens the audience before its notice has run out: set wider than
-- what is in effect now, it is refused, whoever asks — the vault itself
-- included. Narrowing is an owner's, or the vault's. A new household starts
-- at the narrowest. The operator's own connection says nobody, and is not
-- asked (a restore narrows it).
create function household_identity_audience_guard() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  due text;
begin
  if app_actor() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.identity_audience is distinct from 'owners_and_self' then
      raise exception 'a household starts with identity details for the owners and each person'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.identity_audience is not distinct from old.identity_audience then
    return new;
  end if;
  if app_actor() is distinct from 'system'
     and (app_actor() is distinct from 'account' or app_role() is distinct from 'owner') then
    raise exception 'only an owner changes who sees identity details'
      using errcode = 'insufficient_privilege';
  end if;
  select n.subject into due
    from notice_request n
   where n.household_id = old.id
     and n.kind = 'identity_audience'
     and n.completed_at is null
     and n.withdrawn_at is null
     and n.notice_until <= now();
  if identity_audience_rank(new.identity_audience)
     > identity_audience_rank(coalesce(due, old.identity_audience)) then
    raise exception 'a wider audience for identity details waits for its notice to run out'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger household_identity_audience_guard
  before insert or update of identity_audience on household
  for each row execute function household_identity_audience_guard();

-- ---------------------------------------------------------- the records

create table member_identity (
  household_id     uuid not null references household(id) on delete cascade,
  member_id        uuid not null,
  part             text not null
                     constraint member_identity_part_known check (part in ('shared', 'only_me')),
  -- iv (12) || ciphertext || tag (16), under the data key.
  sealed           bytea not null
                     constraint member_identity_sealed_size
                       check (octet_length(sealed) between 28 and 131072 + 28),
  -- The data key, wrapped under the scope key below.
  dek_wrapped      bytea not null,
  -- The identity key (shared) or the person's member key (only_me).
  wrapped_by_scope uuid not null references scope_key(id),
  -- Which fields have a value: keys, never values.
  filled           text[] not null default '{}',
  -- Moved on by the database at every write (member_identity_versioned).
  version          integer not null default 1
                     constraint member_identity_version_positive check (version >= 1),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references account(id) on delete set null,
  primary key (member_id, part),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create index member_identity_household_idx on member_identity (household_id);

alter table member_identity enable row level security;
create policy member_identity_tenant on member_identity
  using (household_id = app_household()) with check (household_id = app_household());

-- Only me is the person's own, whoever else asks (A33): an owner's query with
-- no WHERE clause at all finds no other person's Only me row, to read, change
-- or write. The vault itself is not a person.
create policy member_identity_only_me on member_identity as restrictive
  using (part <> 'only_me' or member_id = app_member() or app_actor() = 'system');

-- Each kind of caller. Somebody signed in: their own record, and the shared
-- parts the household's audience gives their role (identity_audience_sees,
-- as in effect now). The vault itself: every row. A share link, an upload
-- link, a signed-out page and a caller who says nothing: nothing.
create policy member_identity_actor on member_identity as restrictive
  using (case app_actor()
           when 'account' then coalesce(member_id = app_member(), false)
                               or (part = 'shared'
                                   and identity_audience_sees((select identity_audience_now()),
                                                              app_role()))
           when 'system' then true
           when 'link' then false
           when 'upload' then false
           when 'anonymous' then false
           else false
         end);

-- Who writes which part: the person, both parts of their own record — an
-- owner, an adult or a teen; a viewer changes nothing — and an owner, the
-- shared part of anybody's. The vault itself. Nobody else.
create policy member_identity_writer_insert on member_identity as restrictive for insert
  with check (case app_actor()
                when 'account' then case app_role()
                                      when 'owner' then coalesce(member_id = app_member(), false)
                                                        or part = 'shared'
                                      when 'adult' then coalesce(member_id = app_member(), false)
                                      when 'teen' then coalesce(member_id = app_member(), false)
                                      else false
                                    end
                when 'system' then true
                else false
              end);
create policy member_identity_writer_update on member_identity as restrictive for update
  using (case app_actor()
           when 'account' then case app_role()
                                 when 'owner' then coalesce(member_id = app_member(), false)
                                                   or part = 'shared'
                                 when 'adult' then coalesce(member_id = app_member(), false)
                                 when 'teen' then coalesce(member_id = app_member(), false)
                                 else false
                               end
           when 'system' then true
           else false
         end);

-- A part is never removed but with its person: nothing clears an Only me
-- part by deleting it.
revoke delete on member_identity from fdv_app;

-- The version, when and by whom are the database's to keep, whatever a
-- statement says; and a part stays its person's, that part, under the key
-- its part is for — the household's identity key for the shared part, the
-- person's own member key for Only me — so no write can put an Only me
-- value where somebody else's key opens it.
create function member_identity_versioned() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    if (new.household_id, new.member_id, new.part)
       is distinct from (old.household_id, old.member_id, old.part) then
      raise exception 'a part of somebody''s identity details stays theirs, and that part'
        using errcode = 'check_violation';
    end if;
    if (new.sealed, new.dek_wrapped, new.wrapped_by_scope, new.filled)
       is not distinct from (old.sealed, old.dek_wrapped, old.wrapped_by_scope, old.filled) then
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
                    and case new.part
                          when 'shared' then k.kind = 'identity'
                          when 'only_me' then k.kind = 'member' and k.member_id = new.member_id
                          else false
                        end) then
    raise exception 'a part of somebody''s identity details is wrapped under the key of its part'
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  new.updated_by := app_account();
  return new;
end $$;

create trigger member_identity_versioned before insert or update on member_identity
  for each row execute function member_identity_versioned();
