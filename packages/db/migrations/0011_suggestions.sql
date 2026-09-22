-- Missing-document suggestions (REM-10, REM-14).
--
-- The household profile the wizard filled is already here; this adds the
-- rules that read it and the record of the ones a family has waved away.

-- A rule is data, not code: a condition evaluated against the profile and
-- (for per-member rules) the member, plus the copy shown to a human. Rules
-- are global reference data like document_type, so no household_id and no
-- row-level security; the household's own answers do the filtering.
create table suggestion_rule (
  key           text primary key,          -- 'minor_needs_birth_certificate'
  condition     jsonb not null default '{}',
  suggests_type text not null references document_type(key),
  scope         text not null check (scope in ('household', 'per_member')),
  -- How many of this type the household should have. A number, or
  -- {"profile":"vehicle_count"} to take it from the answers.
  quantity      jsonb not null default '1',
  noun          text not null,             -- 'birth certificate', reads inside a sentence
  why           text not null,             -- the reassuring second line
  sort_order    int not null default 100,
  enabled       boolean not null default true
);
grant select on suggestion_rule to fdv_app;

-- "Not for us." Per household, per rule, and per member for the rules that
-- are about one person. Reversible: nothing here is deleted data, and the
-- Reminders screen offers the hidden ones back.
create table suggestion_dismissal (
  household_id  uuid not null references household(id) on delete cascade,
  rule_key      text not null references suggestion_rule(key) on delete cascade,
  member_id     uuid references member(id) on delete cascade,
  dismissed_at  timestamptz not null default now(),
  dismissed_by  uuid references account(id) on delete set null
);
-- A null member_id is a household-wide dismissal; two nulls are the same
-- row, which a plain unique index would not catch.
create unique index suggestion_dismissal_key
  on suggestion_dismissal (household_id, rule_key, coalesce(member_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table suggestion_dismissal enable row level security;
create policy suggestion_dismissal_tenant on suggestion_dismissal
  using (household_id = app_household()) with check (household_id = app_household());
grant select, insert, delete on suggestion_dismissal to fdv_app;

-- The seed. Every rule here is one a family could defend out loud: it
-- fires from something they told us, and the copy says why.
insert into suggestion_rule (key, condition, suggests_type, scope, quantity, noun, why, sort_order) values
  ('minor_needs_birth_certificate',
   '{"member": {"is_minor": true}}',
   'birth_certificate', 'per_member', '1',
   'birth certificate',
   'Schools, passports and benefits all ask for it.', 10),

  ('vehicle_needs_registration',
   '{"profile": {"vehicle_count": {"gte": 1}}}',
   'vehicle_registration', 'household', '{"profile": "vehicle_count"}',
   'vehicle registration',
   'You told us about the cars; this is the paper that proves they are yours.', 20),

  ('home_owner_needs_deed',
   '{"profile": {"owns_home": true}}',
   'property_deed', 'household', '1',
   'deed or title',
   'The single most expensive document to replace.', 30),

  ('renter_needs_lease',
   '{"profile": {"rents_home": true}}',
   'property_deed', 'household', '1',
   'lease',
   'Worth having to hand when a deposit or a repair is argued about.', 31),

  ('home_needs_insurance',
   '{"any": [{"profile": {"owns_home": true}}, {"profile": {"rents_home": true}}]}',
   'insurance_policy', 'household', '1',
   'insurance policy',
   'The policy number is what you need on the worst day.', 40),

  ('household_needs_will',
   '{}',
   'will', 'household', '1',
   'will or power of attorney',
   'Even a simple one saves the family a great deal later.', 50),

  ('business_needs_tax_return',
   '{"profile": {"has_business": true}}',
   'tax_return', 'household', '1',
   'tax return',
   'Running a business means someone will ask for last year''s.', 60);
