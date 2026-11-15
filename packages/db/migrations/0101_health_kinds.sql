-- Health kinds, their details and reminders (0.9.0, H3 of the health plan).
--
-- ------------------------------------------------------------- the kinds
--
-- Nine built-ins in Medical, each kept for adults and Sensitive by default
-- (the column's default since 0090: a built-in a release adds starts On).
-- None interprets anything: each files a paper and says what is on it.
--
--   insurance_card           Health insurance card. Insurer, Member ID (the
--                            number every document has, sealed for Only me
--                            as every number is), a Group number, and an
--                            Expires the family adds if the card has one; it
--                            reminds 30 and 7 days before.
--   explanation_of_benefits  An insurer's account of a claim: Insurer, Claim
--                            number, Date of service and Amount you may owe.
--                            Named for its insurer, as a statement is.
--   lab_result               A lab's results, a visit's summary and an
--   visit_summary            imaging report: who issued it (Provider) and the
--   imaging_report           Date of service, as a medical record has.
--   vaccination_record       Vaccines, Date given and Next dose due, which it
--                            reminds from, 30 and 7 days before, when the
--                            family adds one. Kept for adults like the rest;
--                            a teen's own is never Only me by H1a's rule (the
--                            API: their parents keep it, since schools ask).
--   advance_directive        An advance directive or living will, a
--   healthcare_proxy         healthcare proxy or a power of attorney for
--                            health care: when it was Signed and who the
--                            Agent is. Neither expires; each may be reviewed
--                            every year (below).
--   hipaa_authorization      Signed, who it is Shared with, and an Expires the
--                            family adds if it has one (30 days before).
--
-- Their fields are the library's, as every built-in's are (0031): the new
-- ones are added to it here.
--
-- Two built-ins change:
--
--   medical_record   is called "Medical record": immunisations have a kind of
--                    their own now. Its key, fields and documents are as they
--                    were; its ETag moves with its name.
--   prescription     gains a Next refill date, and reminds from it, 7 days
--                    and a day before — and, for a prescription with no Next
--                    refill, from its Expires as before (its fallback, below),
--                    on the same days. Expires is shown and asked for as it
--                    was. A household that gave the kind fields of its own
--                    gains Next refill among them, so its reminders go on
--                    from a date it asks for; one that chose a date to remind
--                    from keeps its choice, with no fallback. A prescription's
--                    reminders already made 7 days before its Expires are
--                    kept, by the next edit too, while it has no Next refill.
--
-- A household that already keeps a kind of its own by one of these names
-- ("Vaccinations", "Living will", "EOB", "HIPAA release"…) goes on using it:
-- the new built-in is hidden for that household, as 0077 did for the
-- payslip, and it can show it again in Kinds of document. Its own kind and
-- every document of it are untouched. A name that says the paper itself
-- ("Living will", "EOB") counts in any category; one that could be anything
-- ("Vaccinations", "Imaging", "Insurance card") only on a kind of the
-- household's in Medical (or, for the card, Insurance): a gym's "Member
-- card" or a school's "Test results" hides nothing.
--
-- ----------------------------------------------- a date to fall back on
--
--   document_type.remind_fallback   The date a kind reminds from when a
--                     document has none of the one it reminds from: the
--                     prescription's Expires, when it has no Next refill.
--                     The same lead times; null for every other kind. In
--                     effect only while the household keeps the kind's own
--                     date to remind from (a household that chose its own
--                     has none), and while the kind shows that date
--                     (effective_document_type.remind_fallback).
--
-- A vaccination record's Next dose due and a prescription's Next refill are
-- asked for but never required, though each is the date its kind reminds
-- from (REMINDING_DATE_OPTIONAL in @fdv/shared): most records have no next
-- dose, and a document without one is not left Needs info for good.
--
-- ------------------------------------------------- a review every year
--
--   reminder.recur_from  The day a repeating reminder was first set for,
--                     which every later one is counted from: one on 29
--                     February comes back on the 28th in other years and on
--                     the 29th in a leap year, never drifting to the 28th
--                     for good. Null: its own day (fire_at) is that day.
--   reminder.review   A reminder set to come back every year to look the
--                     paper over again (an advance directive, a proxy, a
--                     HIPAA authorization): one somebody sets on a document,
--                     a reminder of their own (kind 'manual') repeating
--                     every year. Done brings the next one a year on; Snooze
--                     waits as any reminder's does. At most one open a
--                     document. Off by default: nobody is reminded until
--                     somebody turns it on.
--
-- A migration is nobody's edit: no audit event is written, and no
-- document's updated_at moves.

-- --------------------------------------------------------- the library

insert into document_attribute (key, label, kind) values
  ('group_number', 'Group number', 'text'),
  ('amount_you_owe', 'Amount you may owe', 'text'),
  ('vaccines', 'Vaccines', 'text'),
  ('date_given', 'Date given', 'date'),
  ('next_dose_due', 'Next dose due', 'date'),
  ('agent', 'Agent', 'text'),
  ('authorized_person', 'Shared with', 'text'),
  ('refill_date', 'Next refill', 'date')
on conflict do nothing;

-- ------------------------------------------------------------ the kinds

insert into document_type
  (key, label, category, fields, expiry_driver, reminder_leads, usually_essential,
   default_visibility, sort_order, issued_by_label, short_label, issuer_noun, remind_from, core)
values
  ('insurance_card', 'Health insurance card', 'medical',
   '[{"key":"group_number","label":"Group number","kind":"text","required":false}]',
   'expires_on', '{30,7}', true, 'adults', 72, 'Insurer', 'Insurance card', null,
   'expires',
   fdv_type_core('{"identifier":{"label":"Member ID"}}', '{}', 'Insurer', true)),
  ('explanation_of_benefits', 'Explanation of benefits', 'medical',
   '[{"key":"date_of_service","label":"Date of service","kind":"date","required":false},
     {"key":"amount_you_owe","label":"Amount you may owe","kind":"text","required":false}]',
   null, '{}', false, 'adults', 73, 'Insurer', 'Explanation of benefits',
   'explanation of benefits',
   null,
   fdv_type_core('{"identifier":{"label":"Claim number"}}', '{}', 'Insurer', false)),
  ('lab_result', 'Lab result', 'medical',
   '[{"key":"date_of_service","label":"Date of service","kind":"date","required":false}]',
   null, '{}', false, 'adults', 74, 'Provider', 'Lab result', null,
   null,
   fdv_type_core('{}', '{}', 'Provider', false)),
  ('visit_summary', 'Visit summary', 'medical',
   '[{"key":"date_of_service","label":"Date of service","kind":"date","required":false}]',
   null, '{}', false, 'adults', 75, 'Provider', 'Visit summary', null,
   null,
   fdv_type_core('{}', '{}', 'Provider', false)),
  ('imaging_report', 'Imaging report', 'medical',
   '[{"key":"date_of_service","label":"Date of service","kind":"date","required":false}]',
   null, '{}', false, 'adults', 76, 'Provider', 'Imaging report', null,
   null,
   fdv_type_core('{}', '{}', 'Provider', false)),
  ('vaccination_record', 'Vaccination record', 'medical',
   '[{"key":"vaccines","label":"Vaccines","kind":"text","required":false},
     {"key":"date_given","label":"Date given","kind":"date","required":false},
     {"key":"next_dose_due","label":"Next dose due","kind":"date","required":false}]',
   null, '{30,7}', false, 'adults', 77, 'Provider', 'Vaccination record', null,
   'next_dose_due',
   fdv_type_core('{}', '{}', 'Provider', false)),
  ('advance_directive', 'Advance directive / living will', 'medical',
   '[{"key":"agent","label":"Health care agent","kind":"text","required":false}]',
   null, '{}', true, 'adults', 78, null, 'Advance directive', null,
   null,
   fdv_type_core('{"issued":{"label":"Signed"},"issued_by":{"shown":false}}', '{}', null, false)),
  ('healthcare_proxy', 'Healthcare proxy / power of attorney', 'medical',
   '[{"key":"agent","label":"Agent","kind":"text","required":false}]',
   null, '{}', true, 'adults', 79, null, 'Healthcare proxy', null,
   null,
   fdv_type_core('{"issued":{"label":"Signed"},"issued_by":{"shown":false}}', '{}', null, false)),
  ('hipaa_authorization', 'HIPAA authorization', 'medical',
   '[{"key":"authorized_person","label":"Shared with","kind":"text","required":false}]',
   'expires_on', '{30}', false, 'adults', 80, 'Provider', 'HIPAA authorization', null,
   'expires',
   fdv_type_core('{"issued":{"label":"Signed"}}', '{}', 'Provider', true));

-- -------------------------------------------- the two built-ins that change

update document_type
   set label = 'Medical record', updated_at = now()
 where key = 'medical_record' and household_id is null;

-- A date to fall back on, when a document has none of the one its kind
-- reminds from: 'expires' or a date field's key, as remind_from.
alter table document_type add column remind_fallback text
  constraint document_type_remind_fallback check (
    remind_fallback is null
    or (remind_fallback ~ '^(expires|[a-z][a-z0-9_]{0,63})$'
        and remind_from is not null and remind_fallback <> remind_from));

update document_type
   set fields = '[{"key": "medication", "label": "Medication", "kind": "text", "required": false},
                  {"key": "prescriber", "label": "Prescriber", "kind": "text", "required": false},
                  {"key": "refills", "label": "Refills", "kind": "text", "required": false},
                  {"key": "refill_date", "label": "Next refill", "kind": "date", "required": false}]',
       remind_from = 'refill_date',
       remind_fallback = 'expires',
       reminder_leads = '{7,1}',
       pack_version = pack_version + 1,
       updated_at = now()
 where key = 'prescription' and household_id is null;

-- A household's own fields for the prescription: Next refill among them, so
-- it reminds from a date the kind asks for — unless the household chose a
-- date to remind from itself, which it keeps.
update document_type_setting s
   set fields = s.fields
                || '[{"key": "refill_date", "label": "Next refill", "kind": "date", "required": false}]'::jsonb
 where s.type_key = 'prescription'
   and s.fields is not null
   and jsonb_typeof(s.fields) = 'array'
   and s.remind_from is null
   and not (s.fields @> '[{"key": "refill_date"}]'::jsonb);

-- --------------------------------------- a household's own kind, kept

-- A household that already keeps a kind of its own by one of these names
-- goes on using it: the new built-in is hidden for it, as if it had hidden
-- it in Kinds of document, where it can show it again (as 0077).
--   names       say the paper itself: a kind of any category by one of them.
--   generic     could be anything: only a kind in one of `categories`.
insert into document_type_setting (household_id, type_key, hidden)
select distinct t.household_id, k.key, true
  from document_type t
  join (values
          ('insurance_card',
           array['health insurance card', 'health insurance cards', 'medical insurance card',
                 'medical insurance cards', 'ehic', 'ghic'],
           array['insurance card', 'insurance cards', 'health insurance', 'medical insurance',
                 'insurance id card', 'health card'],
           array['medical', 'insurance']),
          ('explanation_of_benefits',
           array['explanation of benefits', 'explanations of benefits', 'eob', 'eobs'],
           array[]::text[],
           array['medical']),
          ('lab_result',
           array['lab result', 'lab results', 'lab report', 'lab reports',
                 'blood test results', 'laboratory results', 'laboratory report',
                 'pathology report', 'pathology results'],
           array['labs', 'blood test', 'blood tests', 'blood results'],
           array['medical']),
          ('visit_summary',
           array['visit summary', 'visit summaries', 'after visit summary',
                 'after-visit summary', 'after visit summaries', 'after-visit summaries',
                 'discharge summary', 'discharge summaries'],
           array['doctor visit', 'doctor visits', 'clinic visit', 'clinic visits'],
           array['medical']),
          ('imaging_report',
           array['imaging report', 'imaging reports', 'radiology report', 'radiology reports',
                 'mri report', 'ultrasound report'],
           array['imaging', 'radiology', 'x-ray', 'x-rays', 'xray', 'xrays', 'scan report',
                 'scan reports', 'scan results', 'mri', 'ultrasound'],
           array['medical']),
          ('vaccination_record',
           array['vaccination record', 'vaccination records', 'vaccination card',
                 'vaccination cards', 'vaccine record', 'vaccine records', 'vaccine card',
                 'immunisation record', 'immunisation records', 'immunization record',
                 'immunization records', 'shot record', 'shot records'],
           array['vaccination', 'vaccinations', 'vaccines', 'immunisation', 'immunisations',
                 'immunization', 'immunizations', 'shots'],
           array['medical']),
          ('advance_directive',
           array['advance directive', 'advance directives', 'living will', 'living wills',
                 'advance decision', 'advance decisions', 'advance care plan',
                 'advance healthcare directive', 'advance health care directive'],
           array['dnr', 'polst', 'molst'],
           array['medical']),
          ('healthcare_proxy',
           array['healthcare proxy', 'health care proxy', 'medical power of attorney',
                 'healthcare power of attorney', 'health care power of attorney',
                 'lpa health and welfare', 'health and welfare lpa',
                 'health and welfare power of attorney'],
           array['health proxy', 'medical proxy', 'medical poa', 'healthcare poa',
                 'health care agent', 'healthcare agent'],
           array['medical']),
          ('hipaa_authorization',
           array['hipaa', 'hipaa authorization', 'hipaa authorisation', 'hipaa authorizations',
                 'hipaa release', 'hipaa releases', 'hipaa form', 'hipaa forms'],
           array['medical release', 'medical records release', 'release of information'],
           array['medical'])
       ) as k(key, names, generic, categories)
    on lower(btrim(t.label)) = any(k.names)
       or lower(btrim(coalesce(t.short_label, ''))) = any(k.names)
       or (t.category = any(k.categories)
           and (lower(btrim(t.label)) = any(k.generic)
                or lower(btrim(coalesce(t.short_label, ''))) = any(k.generic)))
 where t.household_id is not null
   and t.archived_at is null
   and t.deleted_at is null
on conflict (household_id, type_key) do update set hidden = true;

-- ---------------------------------------------------- a review every year

alter table reminder add column review boolean not null default false;

-- The day a repeating reminder is counted from (see above).
alter table reminder add column recur_from date;

-- A yearly review is somebody's own reminder about a document, repeating
-- every year: never one made from a date, nor about a person.
alter table reminder add constraint reminder_review
  check (not review or (kind = 'manual' and recurrence = 'annual' and document_id is not null));

-- One open a document: turning it on twice is turning it on.
create unique index reminder_one_review on reminder (document_id)
  where review and status in ('scheduled', 'due', 'snoozed');

-- ------------------------------------------------------ what is in effect

-- As 0090 made it, with the date to fall back on appended: the kind's own,
-- while the household keeps the kind's date to remind from, that date is in
-- effect, and the kind shows the one to fall back on.
create or replace view effective_document_type with (security_invoker = true) as
select t.key,
       t.household_id,
       t.household_id is null as builtin,
       t.label,
       t.category,
       t.locale,
       coalesce(s.fields, t.fields) as fields,
       case when c.core->'expires'->'shown' = 'true'::jsonb
            then coalesce(t.expiry_driver, 'expires_on') end as expiry_driver,
       -- Keyed on the date that reminds: a detail's lead times are never
       -- Expires's, for an older phone or a status window.
       case when r.chosen <> 'expires' then '{}'::int[] else r.leads end as reminder_leads,
       coalesce(s.usually_essential, t.usually_essential) as usually_essential,
       coalesce(s.default_visibility, t.default_visibility) as default_visibility,
       t.sort_order,
       t.pack_version,
       c.core,
       c.core->'issued_by'->>'label' as issued_by_label,
       t.short_label,
       t.issuer_noun,
       coalesce(s.hidden, false) or t.archived_at is not null or t.deleted_at is not null
         or (t.household_id is null and t.key = 'note')
         as hidden,
       t.archived_at,
       greatest(t.updated_at, s.updated_at) as updated_at,
       t.deleted_at,
       -- Only while the kind shows that date and has lead times for it.
       f.remind_from,
       r.leads as remind_leads,
       coalesce(s.belongs_to, t.belongs_to) as belongs_to,
       coalesce(s.sensitive_default, t.sensitive_default) as sensitive_default,
       case when f.remind_from is not null
             and s.remind_from is null
             and t.remind_fallback is not null
             and ((t.remind_fallback = 'expires' and c.core->'expires'->'shown' = 'true'::jsonb)
                  or (t.remind_fallback <> 'expires'
                      and coalesce(s.fields, t.fields)
                            @> jsonb_build_array(jsonb_build_object('key', t.remind_fallback,
                                                                    'kind', 'date'))))
            then t.remind_fallback end as remind_fallback
  from document_type t
  left join document_type_setting s
    on t.household_id is null and s.type_key = t.key and s.household_id = app_household()
  -- offset 0 keeps the planner from copying the merge into each column that
  -- reads it, which ran it three times a row.
  cross join lateral (
    select fdv_type_core(t.core, s.core, t.issued_by_label, t.expiry_driver is not null) as core
    offset 0
  ) c
  cross join lateral (
    select nullif(coalesce(s.remind_from, t.remind_from), 'none') as chosen,
           coalesce(s.reminder_leads, t.reminder_leads) as leads
    offset 0
  ) r
  cross join lateral (
    select case when cardinality(r.leads) > 0
                 and ((r.chosen = 'expires' and c.core->'expires'->'shown' = 'true'::jsonb)
                      or (r.chosen <> 'expires'
                          and coalesce(s.fields, t.fields)
                                @> jsonb_build_array(jsonb_build_object('key', r.chosen, 'kind', 'date'))))
                then r.chosen end as remind_from
    offset 0
  ) f;
