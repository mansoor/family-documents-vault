-- The vault learns each sender's papers from your corrections (0.9.0, R1).
--
-- I4 (0065) learns, for each issuer, a kind and a person. Most of a family's
-- papers come from the same senders month after month, each laid out the
-- same way each time; so the vault also learns a sender's paper *shape*, and
-- on it which label carries the date or the number that was filed
-- (@fdv/shared shapes.ts). The next paper of that shape is read right, its
-- dates included.
--
-- A shape is a fingerprint of a page's layout and wording, never of what it
-- says about anybody. It keeps exactly:
--
--   the issuer's key, as I4 keeps it (the issuer filed);
--   its words: the page's words that are in a fixed list of everyday words
--     papers are laid out with (@fdv/shared shape-words.ts), less any word
--     of the household's people's names or its name — so never a name of
--     theirs, an address, a number, an amount, a month, a company or a place;
--   its lessons: for the kind, a kind's key; for whose it is, a member's id;
--     for the issue date, the expiry and the number, the label before the
--     value on the page, in the same list's words, and a coarse place (a
--     band of lines, left or right) — "payment date", never the date —
--     each with how many times it was confirmed (by a reviewed accept),
--     vouched for (a correction, or an item at Check) and contradicted; and
--     for whose it is, keyed hashes of the numbers filed with it, under a
--     key derived from the member key (never a number).
--   Before any of it is kept, the words of the name of anybody of the
--   household, family or guest, are taken out, now and as people are added.
--
-- All of it is sealed (shape_sealed: AES-256-GCM under its person's own
-- member key, bound to the row's household, member and id), so not even the
-- issuer's key of a shape is in a plain column; only the day it was last
-- taught is, for the least used to go first past the cap (200 a person).
--
-- Shapes are each person's own, as their rules are (0065): learned only from
-- their own accepts, used only on their own uploads, read only by them —
-- never another adult, never an owner — and gone with their rules on Forget
-- all, and in the same transaction as they can no longer add documents.
-- What an accept taught a shape is kept, sealed the same way, beside the
-- count (intake_outcome.shape_taught), so an Undo takes it back exactly.
--
-- In the backup, as every table is; a restore's checks know them. A person's
-- export holds no shapes, as it holds no rules.

-- ------------------------------------------------------------- the shapes

create table intake_shape (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  -- Whose shape it is: learned from their accepts, used for their items.
  member_id    uuid not null,
  -- { v: 1, issuer, words, lessons }, sealed under the member's key.
  shape_sealed bytea not null
                 constraint intake_shape_sealed check (octet_length(shape_sealed) between 29 and 65536),
  last_used    date not null default current_date,
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create index intake_shape_member on intake_shape (household_id, member_id, last_used);

alter table intake_shape enable row level security;

create policy intake_shape_tenant on intake_shape
  using (household_id = app_household()) with check (household_id = app_household());

-- Its person's alone, as a rule is (0065): somebody signed in who may add
-- documents, and is the member whose shape it is; and the vault itself (its
-- worker reads them only as the person, through readAs). With no WITH
-- CHECK, the same holds what is written.
create policy intake_shape_actor on intake_shape as restrictive
  using (case app_actor()
           when 'account' then app_role() in ('owner', 'adult', 'teen')
                               and member_id = app_member()
           when 'system' then true
           else false
         end);

-- What an accept taught a shape, sealed the same way, for an Undo.
alter table intake_outcome add column shape_taught bytea
  constraint intake_outcome_shape_taught
    check (shape_taught is null or octet_length(shape_taught) between 29 and 4194304);

-- ------------------------------------------------- keeping something private

-- 0065's question, with shapes: they may say what only somebody's Only me
-- documents taught, so somebody who has one keeps something private. The
-- rest is 0065's, word for word.
create or replace function member_holds_private(p_account uuid) returns boolean
  language plpgsql stable security definer
  set search_path = pg_catalog, public, pg_temp as $$
declare
  hh uuid := app_household();
  m uuid;
  their_role text;
begin
  -- Unset is no answer: a caller who says nothing is refused (coalesce).
  if not coalesce((app_actor() = 'account' and app_role() = 'owner')
                  or (app_actor() = 'anonymous' and app_account() = p_account), false) then
    raise exception 'only an owner, or the reset itself, asks what somebody keeps private'
      using errcode = 'insufficient_privilege';
  end if;
  select a.member_id, a.role::text into m, their_role
    from account_household a
   where a.account_id = p_account and a.household_id = hh;
  if m is null then
    raise exception 'nobody of this household'
      using errcode = 'insufficient_privilege';
  end if;
  return exists (select 1 from document d
                  where d.household_id = hh and d.owner_member_id = m
                    and d.visibility = 'private')
      or exists (select 1 from document_tombstone t
                  where t.household_id = hh and t.owner_member_id = m
                    and t.visibility = 'private')
      or exists (select 1 from member_identity i
                  where i.household_id = hh and i.member_id = m
                    and i.part = 'only_me')
      or exists (select 1 from upload_request r
                  where r.household_id = hh and r.requester_member_id = m
                    and r.review_by = 'me')
      or exists (select 1 from incoming_file f
                  where f.household_id = hh and f.requester_member_id = m
                    and f.scope = 'member' and f.review_by = 'me')
      or exists (select 1 from intake_batch b
                  where b.household_id = hh and b.member_id = m)
      -- Rules count only for somebody who may still add documents (I4-6):
      -- a viewer's are removed as they become one, and never stand in the way.
      or (their_role in ('owner', 'adult', 'teen')
          and exists (select 1 from intake_rule r
                       where r.household_id = hh and r.member_id = m))
      -- And so do the shapes learned from their papers (0075, R1).
      or (their_role in ('owner', 'adult', 'teen')
          and exists (select 1 from intake_shape s
                       where s.household_id = hh and s.member_id = m))
      or exists (select 1 from export e
                  where e.requested_by = p_account and e.state <> 'failed'
                    and (e.expires_at is null or e.expires_at > now()))
      or exists (select 1 from doc_collection c
                  where c.household_id = hh and c.owner_member_id = m
                    and c.audience = 'only_me');
end $$;

-- 0065's guard, with a shape made: it waits for a hand-over link being
-- spent, and a session that reset ended learns nothing. The rest is 0065's.
create or replace function member_private_gained() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog, public, pg_temp as $$
declare
  who uuid;
  acct uuid;
  ended text;
begin
  if tg_table_name = 'document' then
    if new.visibility = 'private' and new.owner_member_id is not null
       and (tg_op = 'INSERT' or old.visibility is distinct from 'private'
            or old.owner_member_id is distinct from new.owner_member_id) then
      who := new.owner_member_id;
    end if;
  elsif tg_table_name = 'doc_collection' then
    if new.audience = 'only_me' and new.owner_member_id is not null and new.deleted_at is null
       and (tg_op = 'INSERT' or old.audience is distinct from 'only_me'
            or old.owner_member_id is distinct from new.owner_member_id) then
      who := new.owner_member_id;
    end if;
  elsif tg_table_name = 'member_identity' then
    if new.part = 'only_me'
       and (tg_op = 'INSERT' or old.part is distinct from 'only_me'
            or old.member_id is distinct from new.member_id) then
      who := new.member_id;
    end if;
  elsif tg_table_name = 'upload_request' then
    if new.review_by = 'me'
       and (tg_op = 'INSERT' or old.review_by is distinct from 'me'
            or old.requester_member_id is distinct from new.requester_member_id) then
      who := new.requester_member_id;
    end if;
  elsif tg_table_name = 'incoming_file' then
    if new.scope = 'member'
       and (tg_op = 'INSERT' or old.scope is distinct from 'member'
            or old.requester_member_id is distinct from new.requester_member_id) then
      who := new.requester_member_id;
    end if;
  elsif tg_table_name = 'intake_batch' then
    if tg_op = 'INSERT' or old.member_id is distinct from new.member_id then
      who := new.member_id;
    end if;
  elsif tg_table_name = 'intake_rule' then
    if tg_op = 'INSERT' or old.member_id is distinct from new.member_id then
      who := new.member_id;
    end if;
  elsif tg_table_name = 'intake_shape' then
    if tg_op = 'INSERT' or old.member_id is distinct from new.member_id then
      who := new.member_id;
    end if;
  elsif tg_table_name = 'export' then
    if tg_op = 'INSERT' then
      acct := new.requested_by;
    end if;
  end if;
  if who is null and acct is null then
    return new;
  end if;
  if who is not null then
    perform 1 from account_household a
     where a.member_id = who and a.household_id = new.household_id
       for share;
  else
    perform 1 from account_household a
     where a.account_id = acct and a.household_id = new.household_id
       for share;
  end if;
  -- The session asking, ended since it was let in (a reset ends them all;
  -- a lock, sign-out everywhere): it gains nothing private now.
  if app_actor() = 'account' then
    select coalesce(s.revoked_reason, '') into ended
      from session s
     where s.id = app_session() and s.revoked_at is not null;
    if found then
      raise exception 'this sign-in has ended'
        using errcode = 'FDV01', detail = ended;
    end if;
  end if;
  return new;
end $$;

create trigger intake_shape_private_gained
  before insert or update of member_id on intake_shape
  for each row execute function member_private_gained();

-- ------------------------------------------- leaving with a role (0065)

-- A role that can no longer add documents takes the person's rules, count
-- and shapes with it, in the same transaction as the change.
create or replace function intake_rules_leave_with_role() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.role::text not in ('owner', 'adult', 'teen')
     and old.role::text in ('owner', 'adult', 'teen') then
    delete from intake_rule
     where household_id = new.household_id and member_id = new.member_id;
    delete from intake_outcome
     where household_id = new.household_id and member_id = new.member_id;
    delete from intake_shape
     where household_id = new.household_id and member_id = new.member_id;
  end if;
  return null;
end $$;
