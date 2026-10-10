-- The vault learns from your corrections (Phase 6, I4).
--
-- Each time somebody accepts an item of a batch, what they filed is compared
-- with what its card started from. A correction teaches a small rule, never
-- the text: this issuer → this kind, this issuer → this person. The worker
-- uses a person's rules when it reads their next items (@fdv/shared,
-- learning.ts), and the person is shown how well it is doing: "Of your last
-- 50 accepted, 31 needed no change".
--
-- Rules are each person's own, as a batch is (0062, Q3): learned only from
-- their own accepts, used only for their own items, and read only by them —
-- never another adult, never an owner. "Letters from this clinic are
-- Sara's", learned from Sara's Only me documents, must not be proposed on
-- anybody else's uploads, nor shown to anybody else. So a rule keeps nothing
-- but:
--
--   issuer_key    the issuer's key (@fdv/shared issuerKey: lower case,
--                 accents, punctuation and the legal form gone);
--   type_key      the kind it says, or
--   person_id     the person it says (one of the two);
--   confirmed     how many times it was made or confirmed;
--   contradicted  how many times something else was filed for that issuer;
--   last_used     the day it was last made or confirmed.
--
-- Never a number, a date, a name as typed, a file's name or a word of the
-- pages. A rule contradicted more often than confirmed is removed, and a
-- person keeps at most 500 (the API: LEARNED_RULES_MAX).
--
-- The count is kept beside them (intake_outcome): for each item read and
-- accepted, whether it needed no change, and which rules the accept
-- confirmed or contradicted — so an Undo of Accept all Ready (0064) takes
-- back what that accept taught. Its newest LEARNING_OUTCOMES_KEPT (200) are
-- kept. Forgetting removes both.
--
-- Both are in the backup, as every table is; a restore brings them back,
-- and its checks know their rules. A person's export holds no settings of
-- theirs, so it holds no rules either.

-- ------------------------------------------------------------- the rules

create table intake_rule (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  -- Whose rule it is: learned from their accepts, used for their items.
  member_id    uuid not null,
  issuer_key   text not null constraint intake_rule_issuer
                 check (char_length(issuer_key) between 1 and 120),
  type_key     text constraint intake_rule_type check (char_length(type_key) between 1 and 64),
  person_id    uuid,
  confirmed    integer not null default 1
                 constraint intake_rule_confirmed check (confirmed between 0 and 1000000),
  contradicted integer not null default 0
                 constraint intake_rule_contradicted check (contradicted between 0 and 1000000),
  last_used    date not null default current_date,
  -- A kind, or a person: one of them.
  constraint intake_rule_says_one check ((type_key is null) <> (person_id is null)),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade,
  -- A person no longer of the household is said by no rule.
  foreign key (person_id, household_id) references member (id, household_id) on delete cascade
);
create unique index intake_rule_kind on intake_rule (household_id, member_id, issuer_key, type_key)
  where type_key is not null;
create unique index intake_rule_person on intake_rule (household_id, member_id, issuer_key, person_id)
  where person_id is not null;
create index intake_rule_person_idx on intake_rule (person_id) where person_id is not null;

alter table intake_rule enable row level security;

create policy intake_rule_tenant on intake_rule
  using (household_id = app_household()) with check (household_id = app_household());

-- Its person's alone: somebody signed in who may add documents, and is the
-- member whose rule it is — never another adult, never an owner, never a
-- viewer; and the vault itself (its worker reads them only as the person,
-- through readAs). No link of either kind, no signed-out page. With no WITH
-- CHECK, the same holds what is written.
create policy intake_rule_actor on intake_rule as restrictive
  using (case app_actor()
           when 'account' then app_role() in ('owner', 'adult', 'teen')
                               and member_id = app_member()
           when 'system' then true
           else false
         end);

-- ------------------------------------------------------------- the count

create table intake_outcome (
  household_id        uuid not null references household(id) on delete cascade,
  member_id           uuid not null,
  -- The item accepted (an incoming file of a batch). Not a reference: the
  -- count outlives its batch, which goes 30 days after it was made.
  item_id             uuid not null,
  -- Every field accepted as the card proposed it.
  unchanged           boolean not null,
  accepted_at         timestamptz not null default now(),
  -- What the accept taught, for an Undo to take back.
  confirmed_rules     uuid[] not null default '{}'
                        constraint intake_outcome_confirmed check (cardinality(confirmed_rules) <= 4),
  contradicted_rules  uuid[] not null default '{}'
                        constraint intake_outcome_contradicted check (cardinality(contradicted_rules) <= 1000),
  primary key (household_id, member_id, item_id),
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);
create index intake_outcome_newest on intake_outcome (household_id, member_id, accepted_at desc);

alter table intake_outcome enable row level security;

create policy intake_outcome_tenant on intake_outcome
  using (household_id = app_household()) with check (household_id = app_household());

-- Its person's alone, as the rules are.
create policy intake_outcome_actor on intake_outcome as restrictive
  using (case app_actor()
           when 'account' then app_role() in ('owner', 'adult', 'teen')
                               and member_id = app_member()
           when 'system' then true
           else false
         end);

-- ------------------------------------------------- keeping something private

-- 0052's question, with rules: a person's rules are theirs alone, and may
-- say what only their Only me documents taught, so somebody who has one
-- keeps something private — an owner's hand-over link is not for them. The
-- rest is 0062's, word for word.
create or replace function member_holds_private(p_account uuid) returns boolean
  language plpgsql stable security definer
  set search_path = pg_catalog, public, pg_temp as $$
declare
  hh uuid := app_household();
  m uuid;
begin
  -- Unset is no answer: a caller who says nothing is refused (coalesce).
  if not coalesce((app_actor() = 'account' and app_role() = 'owner')
                  or (app_actor() = 'anonymous' and app_account() = p_account), false) then
    raise exception 'only an owner, or the reset itself, asks what somebody keeps private'
      using errcode = 'insufficient_privilege';
  end if;
  select a.member_id into m
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
      or exists (select 1 from intake_rule r
                  where r.household_id = hh and r.member_id = m)
      or exists (select 1 from export e
                  where e.requested_by = p_account and e.state <> 'failed'
                    and (e.expires_at is null or e.expires_at > now()))
      or exists (select 1 from doc_collection c
                  where c.household_id = hh and c.owner_member_id = m
                    and c.audience = 'only_me');
end $$;

-- 0052's guard, with a rule made: it waits for a hand-over link being spent,
-- and a session that reset ended learns nothing. The rest is 0062's.
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

create trigger intake_rule_private_gained
  before insert or update of member_id on intake_rule
  for each row execute function member_private_gained();
