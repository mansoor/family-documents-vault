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
-- Somebody who can no longer add documents — made a viewer — keeps no
-- rules and no count: they are removed in the same transaction as the role
-- changes (intake_rules_leave_with_role), so nothing they cannot use is
-- left to stand in an owner's way (the I4 review, I4-6).
--
-- Forget all also lets go of what the rules said on items already read: an
-- item of theirs whose sealed proposal a rule spoke in goes back to be read
-- again (incoming_file_account_writes, below; the I4 review, I4-7).
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
  -- The rules it removed — contradicted more often than confirmed, or past
  -- the cap — each as it was (id, issuer key, kind or person, counts, last
  -- used), so an Undo puts them back exactly (the I4 review, I4-3).
  removed_rules       jsonb not null default '[]'
                        constraint intake_outcome_removed
                          check (jsonb_typeof(removed_rules) = 'array'
                                 and jsonb_array_length(removed_rules) <= 1000),
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

-- ------------------------------------------- leaving with a role (I4-6)

-- A role that can no longer add documents takes the person's rules and
-- count with it, in the same transaction as the change: with the owner's
-- rights, since whoever changes a role is given nobody else's.
create function intake_rules_leave_with_role() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.role::text not in ('owner', 'adult', 'teen')
     and old.role::text in ('owner', 'adult', 'teen') then
    delete from intake_rule
     where household_id = new.household_id and member_id = new.member_id;
    delete from intake_outcome
     where household_id = new.household_id and member_id = new.member_id;
  end if;
  return null;
end $$;

create trigger intake_rules_leave_with_role
  after update of role on account_household
  for each row execute function intake_rules_leave_with_role();

-- ------------------------------------------------- read again (I4-7)

-- 0064's, as it stands, word for word; and an item read, or being read,
-- goes back to be read again by its uploader — as Forget all lets go of
-- what their rules said on it.
create or replace function incoming_file_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  decision constant text[] := array['state', 'decided_by', 'decided_at', 'document_id',
                                    'version_id', 'original_name', 'sender_note', 'sha256',
                                    'proposals_sealed', 'text_sealed', 'undo_until'];
  arrival constant text[] := array['state', 'mime', 'byte_size', 'sha256', 'cipher_bytes',
                                   'cipher_sha256', 'received_at', 'submitted_at'];
  reread constant text[] := array['read_state', 'read_failure', 'read_started_at',
                                  'read_attempts', 'read_not_before', 'read_waits',
                                  'read_waited_since', 'text_sealed', 'proposals_sealed'];
  undone constant text[] := array['state', 'decided_by', 'decided_at', 'document_id',
                                  'version_id', 'undo_until', 'object_removed_at', 'storage_key',
                                  'preview_state', 'preview_requested_at', 'preview_pages',
                                  'read_state', 'read_failure', 'read_started_at',
                                  'read_attempts', 'read_not_before', 'read_waits',
                                  'read_waited_since', 'text_sealed', 'proposals_sealed'];
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  -- A sender's session ended: the foreign key's own cascade, and nothing else.
  if pg_trigger_depth() > 1
     and old.session_id is not null and new.session_id is null
     and (to_jsonb(new) - 'session_id') = (to_jsonb(old) - 'session_id') then
    return new;
  end if;
  -- An item's bytes arrived (I1): finished once, by its uploader.
  if old.batch_id is not null and old.state = 'uploading'
     and old.requester_member_id is not distinct from app_member()
     and new.state = 'received'
     and new.received_at is not null and new.submitted_at is not null
     and (to_jsonb(new) - arrival) = (to_jsonb(old) - arrival) then
    return new;
  end if;
  -- Decided already, and its object gone: said once.
  if old.state in ('accepted', 'rejected')
     and old.object_removed_at is null and new.object_removed_at is not null
     and (to_jsonb(new) - 'object_removed_at') = (to_jsonb(old) - 'object_removed_at') then
    return new;
  end if;
  -- Decided: a file sent and waiting, once, by whoever is asking; what was
  -- read of it, and proposed for it, goes with the decision.
  if old.state = 'received' and old.submitted_at is not null
     and new.decided_by is not distinct from app_account()
     and new.decided_at is not null
     and new.proposals_sealed is null
     and new.text_sealed is null
     and (to_jsonb(new) - decision) = (to_jsonb(old) - decision)
     and (
       -- Filed: as the version made of it just now, by them, in that document;
       -- a batch's item, until a moment from now, to be taken back (I3).
       (new.state = 'accepted'
        and new.original_name is not distinct from old.original_name
        and new.sender_note is not distinct from old.sender_note
        and new.sha256 is not distinct from old.sha256
        and (new.undo_until is null
             or (old.batch_id is not null
                 and new.undo_until > now()
                 and new.undo_until <= now() + interval '5 minutes 30 seconds'))
        and exists (select 1 from document_version v
                     where v.id = new.version_id
                       and v.document_id = new.document_id
                       and v.uploaded_by = app_account()
                       and v.xmin = pg_current_xact_id()::xid))
       -- Refused, or removed: nothing filed; its name, its note and its hash go.
       or (new.state = 'rejected'
           and new.document_id is null and new.version_id is null
           and new.undo_until is null
           and new.original_name is null and new.sender_note is null
           and new.sha256 is null)
     ) then
    return new;
  end if;
  -- Taken back (I3): accepted by Accept all Ready, by its uploader, in time;
  -- waiting again at a new object of its batch, to be drawn and read again.
  -- That the document it became goes in the same transaction is held at
  -- commit (incoming_file_undone_document_gone, below).
  if old.batch_id is not null and old.state = 'accepted'
     and old.undo_until is not null and old.undo_until > now()
     and old.decided_by is not distinct from app_account()
     and old.requester_member_id is not distinct from app_member()
     and new.state = 'received'
     and new.decided_by is null and new.decided_at is null
     and new.document_id is null and new.version_id is null
     and new.undo_until is null and new.object_removed_at is null
     and new.preview_state = 'none' and new.preview_requested_at is null
     and new.preview_pages is null
     and new.read_state = 'waiting' and new.read_failure is null
     and new.read_started_at is null and new.read_attempts = 0
     and new.read_not_before is null
     and new.read_waits = 0 and new.read_waited_since is null
     and new.text_sealed is null and new.proposals_sealed is null
     and new.storage_key <> old.storage_key
     and starts_with(new.storage_key, old.household_id || '/batches/' || old.batch_id || '/')
     and exists (select 1 from intake_batch b where b.id = old.batch_id and b.ends_at > now())
     and (to_jsonb(new) - undone) = (to_jsonb(old) - undone) then
    return new;
  end if;
  -- Read again (I4, Forget all): an item of its uploader's, waiting, read or
  -- being read, back to be read from nought — what was read of it, and
  -- proposed, let go — and nothing else changed.
  if old.batch_id is not null and old.state = 'received'
     and old.read_state in ('read', 'reading')
     and old.requester_member_id is not distinct from app_member()
     and new.read_state = 'waiting' and new.read_failure is null
     and new.read_started_at is null and new.read_attempts = 0
     and new.read_not_before is null
     and new.read_waits = 0 and new.read_waited_since is null
     and new.text_sealed is null and new.proposals_sealed is null
     and (to_jsonb(new) - reread) = (to_jsonb(old) - reread) then
    return new;
  end if;
  raise exception 'a reviewer may only file or refuse a file waiting for review'
    using errcode = 'insufficient_privilege';
end $$;
