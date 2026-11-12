-- The household, and what each kind usually belongs to (0.9.0, the owner's
-- decisions of 11 Nov 2026).
--
-- Until now a document with no person said two things at once: "nobody in
-- particular, the household's" and "not decided yet", and both read Needs
-- a person — so every gas bill nagged. From here:
--
--   document.household_owned   The household's: a bill, the deeds, the
--                              pet's records. Never with a person (the
--                              check), and a person chosen clears it, by
--                              whatever writes (the trigger) — so an older
--                              client choosing somebody never leaves a row
--                              both. No person and not the household's is
--                              Not sure yet, which alone reads Needs a
--                              person. A flag rather than an enum beside
--                              owner_member_id: every query, policy and
--                              older client that reads the person reads it
--                              as before, and nothing can disagree with it.
--   document_type.belongs_to   Whom a kind's documents usually belong to:
--                              'person' (every kind until now) or
--                              'household'. A new document of a household's
--                              kind is the household's unless somebody is
--                              chosen (the API). A household changes a
--                              built-in's in document_type_setting (null:
--                              as the built-in), as it changes the rest.
--
-- The built-ins that are the home's, not anybody's: Utility / bill, Property
-- deed / lease and Pet records (a pet is nobody in the family). Not a
-- loan or a mortgage, nor an insurance policy: a car loan, a student loan,
-- a life policy are a person's. Their documents already filed with nobody
-- chosen are made the household's: that is what nobody meant for them.
--
-- And the Utility / bill becomes a bill: a Due date (the library's
-- `due_date`, 0038) in place of Expires, reminding 7 days and 1 day before
-- as Expires did, and Amount called Bill amount. Each bill's expiry moves
-- to its due date, in the date form a date detail is kept in ({date,
-- precision}), and its reminders with it, in place: each keeps its id, its
-- day, its lead time, whether it was done or snoozed and its lines in
-- reminder_delivery, so none is lost and none is sent again — only what it
-- says it is about (`source`) changes. A household that changed the kind
-- keeps its changes: one that switched Expires on for it keeps Expires, its
-- bills' dates and its reminders as they are; one that gave the kind its
-- own fields keeps them, with a Due date added for its bills' dates (and
-- Amount called Bill amount where it still had the built-in's word). An
-- Only me bill's due date is written plain, as an older release left its
-- details, and sealed by the worker's private.seal as it starts (0033): SQL
-- holds no keys. A bill that already has a due date keeps both dates as
-- they are.
--
-- A migration is nobody's edit: no audit event is written and no
-- document's updated_at moves (the API's ETag epoch moves instead, so a
-- write made from an older view of a bill cannot put its Expires back).

-- --------------------------------------------------------- the household's

alter table document add column household_owned boolean not null default false;

alter table document add constraint document_household_or_person
  check (not (household_owned and owner_member_id is not null));

-- A person chosen is the person's, whoever writes it: never both.
create function document_person_not_household() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.owner_member_id is not null then
    new.household_owned := false;
  end if;
  return new;
end $$;

create trigger document_person_not_household
  before insert or update of owner_member_id, household_owned on document
  for each row execute function document_person_not_household();

-- ------------------------------------------------- whom a kind belongs to

alter table document_type add column belongs_to text not null default 'person'
  constraint document_type_belongs_to check (belongs_to in ('person', 'household'));

alter table document_type_setting add column belongs_to text
  constraint document_type_setting_belongs_to
    check (belongs_to is null or belongs_to in ('person', 'household'));

update document_type
   set belongs_to = 'household'
 where household_id is null and key in ('utility_bill', 'property_deed', 'pet_record');

-- ------------------------------------------------------- a bill's due date

-- Households that switched Expires on for the bill themselves keep it, and
-- go on reminding from it; one that pointed its reminders at Expires
-- without keeping it shown follows the bill's Due date.
update document_type_setting s
   set remind_from = case
         when s.core->'expires'->'shown' = 'true'::jsonb then coalesce(s.remind_from, 'expires')
         else null end
 where s.type_key = 'utility_bill'
   and (s.core->'expires'->'shown' = 'true'::jsonb or s.remind_from = 'expires');

-- A household's own fields for the bill: a Due date for its bills' dates,
-- required as a reminding date always is (0.5.15), and Amount called Bill
-- amount where it still had the built-in's word.
update document_type_setting s
   set fields = coalesce(
         (select jsonb_agg(case
                             when e->>'key' = 'due_date' then e || '{"required": true}'
                             when e->>'key' = 'amount' and e->>'label' = 'Amount'
                               then e || '{"label": "Bill amount"}'
                             else e end
                           order by i)
            from jsonb_array_elements(s.fields) with ordinality x(e, i)),
         '[]'::jsonb)
       || case when s.fields @> '[{"key": "due_date"}]'::jsonb then '[]'::jsonb
               else '[{"key": "due_date", "label": "Due date", "kind": "date", "required": true}]'::jsonb
          end
 where s.type_key = 'utility_bill'
   and s.fields is not null
   and jsonb_typeof(s.fields) = 'array'
   and s.core->'expires'->'shown' is distinct from 'true'::jsonb;

-- The bills that move: every bill with an expiry and no due date yet,
-- where the household keeps the bill's Expires hidden — as the built-in
-- now has it — kept in the Trash or not.
create temporary table bill_moved on commit drop as
select d.id
  from document d
  left join document_type_setting s
    on s.household_id = d.household_id and s.type_key = 'utility_bill'
 where d.type_key = 'utility_bill'
   and d.expires_on is not null
   and s.core->'expires'->'shown' is distinct from 'true'::jsonb
   and coalesce(d.extra->'due_date', 'null'::jsonb) = 'null'::jsonb
   and not ('due_date' = any(d.sealed_details));

update document d
   set extra = coalesce(d.extra, '{}'::jsonb)
               || jsonb_build_object('due_date', jsonb_build_object(
                    'date', to_char(d.expires_on, 'YYYY-MM-DD'),
                    'precision', coalesce(d.expires_precision, 'day'))),
       expires_on = null,
       expires_precision = null
  from bill_moved m
 where m.id = d.id;

-- Its reminders, in place: about the due date now, on the same days.
update reminder r
   set source = 'due_date'
  from bill_moved m
 where r.document_id = m.id and r.kind = 'derived' and r.source = 'expires';

-- The bill itself: no Expires, a Due date reminding 7 days and 1 day
-- before (the lead times Expires had), and its amount a bill's.
update document_type
   set fields = '[{"key": "account", "label": "Account", "kind": "text", "required": false},
                  {"key": "amount", "label": "Bill amount", "kind": "text", "required": false},
                  {"key": "due_date", "label": "Due date", "kind": "date", "required": true}]',
       expiry_driver = null,
       remind_from = 'due_date',
       core = fdv_type_core(core, '{}', issued_by_label, false),
       pack_version = pack_version + 1,
       updated_at = now()
 where household_id is null and key = 'utility_bill';

-- ------------------------------------------- what nobody meant for them

-- Documents of a kind that is the household's, filed with nobody chosen:
-- the household's. Every household's kinds are the built-ins' here, as
-- none has changed whom one belongs to yet.
update document d
   set household_owned = true
  from document_type t
 where t.key = d.type_key and t.household_id is null and t.belongs_to = 'household'
   and d.owner_member_id is null and not d.household_owned;

-- ------------------------------------------------------ what is in effect

-- As 0078 made it, with whom it belongs to appended.
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
       case when cardinality(r.leads) > 0
             and ((r.chosen = 'expires' and c.core->'expires'->'shown' = 'true'::jsonb)
                  or (r.chosen <> 'expires'
                      and coalesce(s.fields, t.fields)
                            @> jsonb_build_array(jsonb_build_object('key', r.chosen, 'kind', 'date'))))
            then r.chosen end as remind_from,
       r.leads as remind_leads,
       coalesce(s.belongs_to, t.belongs_to) as belongs_to
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
  ) r;
