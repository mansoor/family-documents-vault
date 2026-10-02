-- Change a person's details; the owner's view of a sign-in (iteration 5.25).
--
-- A person's name, date of birth and relationship can be changed, and an
-- owner can record that somebody has passed away. Each change is made to
-- the person as the one changing them saw them: `version` moves on with
-- every change to those four, and an edit made from an older version is
-- refused (the API's If-Match, 409). `updated_at` and `updated_by` say when
-- they last changed, and who changed them: an account, or null for the
-- vault itself (and once that account is gone). A photo is member_photo's
-- (0040), and never moves the version.
--
-- The version is the database's to keep: member_versioned moves it on by
-- one, and stamps when and by whom, whenever one of the four changes, and
-- keeps all three as they were on any other change (a sign-in taken away
-- writes former_account_id, 0019), whatever the statement said.
--
-- Who may change whom (A66; roles.ts canChangePerson), held here as well as
-- in the API, for every kind of caller (member_change_actor): the vault
-- itself; an owner, anybody; an adult, themselves and anybody with no
-- sign-in; a teen, themselves; nobody else — a viewer, a role never heard
-- of, a share link, an upload link, a signed-out page, a caller who says
-- nothing. A change the rule refuses changes no row, so the API counts
-- what it changed. Restrictive, for updates alone: what anybody reads, and
-- who adds a person (member.add), are as they were; the tenant rule (0003)
-- and the link's (0042) still hold every write as before. And that
-- somebody has passed away is an owner's to say, or the vault's
-- (member_versioned refuses anybody else signed in).
--
-- Nobody signs in as somebody who has passed away. Their sign-in is taken
-- away first: member_versioned refuses to record the passing of somebody
-- who still has one; and account_household_not_deceased refuses them one
-- afterwards — an invitation accepted, a sign-in given back — whoever asks.
-- It holds the person's row while it looks, so a passing recorded at the
-- same moment is waited for, and seen.

alter table member
  add column version    integer not null default 1
    constraint member_version_positive check (version >= 1),
  add column updated_at timestamptz,
  add column updated_by uuid references account(id) on delete set null;

create function member_versioned() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if (new.display_name, new.date_of_birth, new.relationship, new.is_deceased)
     is not distinct from (old.display_name, old.date_of_birth, old.relationship, old.is_deceased) then
    new.version := old.version;
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
    return new;
  end if;
  if new.is_deceased is distinct from old.is_deceased
     and app_actor() is not null and app_actor() <> 'system'
     and app_role() is distinct from 'owner' then
    raise exception 'only an owner records that somebody has passed away'
      using errcode = 'insufficient_privilege';
  end if;
  if new.is_deceased and not old.is_deceased
     and exists (select 1 from account_household ah where ah.member_id = new.id) then
    raise exception 'somebody who can still sign in is not recorded as passed away'
      using errcode = 'check_violation';
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  new.updated_by := app_account();
  return new;
end $$;

create trigger member_versioned before update on member
  for each row execute function member_versioned();

-- With the owner's rights, so that it sees and holds the person's row
-- whoever is asking: a signed-out page accepting an invitation, the vault
-- itself, an owner giving a sign-in back.
create function account_household_not_deceased() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
declare
  dead boolean;
begin
  select m.is_deceased into dead from member m where m.id = new.member_id for share;
  if dead then
    raise exception 'somebody recorded as passed away is not given a sign-in'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger account_household_not_deceased before insert or update of member_id
  on account_household
  for each row execute function account_household_not_deceased();

-- The roles of A66, each named, so a role added later changes nobody until
-- it is taught here. Change them with canChangePerson (roles.ts);
-- visibility-rule.test.ts holds the two equal.
create policy member_change_actor on member as restrictive for update
  using (case app_actor()
           when 'system' then true
           when 'account' then case app_role()
                                 when 'owner' then true
                                 when 'adult' then coalesce(id = app_member(), false)
                                                   or not exists (select 1 from account_household ah
                                                                   where ah.member_id = member.id)
                                 when 'teen' then coalesce(id = app_member(), false)
                                 else false
                               end
           else false
         end);

-- ------------------------------------------- the owner's powers (A54)
--
-- The owner's powers over other people's sign-ins — today the account card
-- (GET /members/{id}/account), and the locks, resets and signing out of
-- 5.28-5.30 — ask for a passkey or a code from an authenticator app, never
-- the password: one phished password must not reach everybody's sign-in.
-- A session says when it last saw one: at a sign-in with a passkey or with
-- a code, or at a step-up with either. verified_at (0013) still says when it
-- last saw any credential, which every other step-up asks, as before. A
-- session from before this release has seen none, and is asked.
-- session_tenant (0003) and session_link (0042) hold it, as they hold the
-- rest of the row.

alter table session add column factor_verified_at timestamptz;
