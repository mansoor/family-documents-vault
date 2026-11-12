-- Sensitive (0.9.0, AIR2 of the AI readers plan; the owner's ask of 12
-- Nov 2026, AIR-04). A sensitive paper's words are never sent to an AI
-- reader outside the house (AIR3 holds them back; this only says which
-- papers are). Two things say it:
--
--   a kind's Sensitive by default   Whether its documents are, unless a
--                              document says otherwise. Per household,
--                              never one global answer: a built-in kind is
--                              every household's on a server, so its
--                              release default is on document_type and a
--                              household's own choice beside it in
--                              document_type_setting (null: as the
--                              built-in), as everything else a household
--                              changes about a built-in is (0031). A kind a
--                              household makes keeps it on its own row, and
--                              starts On: safer until somebody says
--                              otherwise. Kinds made before today are On
--                              too, for the same reason.
--   document.sensitive      The document's own choice: null as its kind
--                              says (every document today), true yes, false
--                              no. What a document left on null is follows
--                              its kind's default as it is now — worked out
--                              (sensitiveOf, @fdv/shared), never written
--                              down — so a kind's default changed changes
--                              every such document at once, and a document
--                              set yes or no keeps it.
--   intake_batch.default_sensitive  A batch's default (bulk intake): as
--                              the other defaults, it fills only what an
--                              accept leaves unsaid. Null, as each kind says.
--
-- The release's defaults (decision 5): On for papers that prove who
-- somebody is — passport, driving licence, national ID, visa / residence
-- permit, birth certificate — and for certificates (marriage / divorce, a
-- diploma), a will, every financial kind (bank, investment and credit card
-- statements, payslips, loans), tax returns and tax forms, and medical
-- records and prescriptions. There is no Health area yet (plan-health): its
-- kinds will start On when they land, as the column's default makes any new
-- built-in. Off for the rest: a bill, insurance, a warranty or receipt,
-- vehicle papers, a deed or lease, an employment contract, a school report,
-- pet records, Something else, and a note (which is never read).
--
-- A migration is nobody's edit: no audit event is written, and no kind's or
-- document's updated_at moves. A kind's ETag does not change (type-etag.ts):
-- the default was not there to have changed, and every change a household
-- makes to it moves the kind's updated_at, which the ETag holds.

-- ------------------------------------------------------------------ a kind's

alter table document_type add column sensitive_default boolean not null default true;

alter table document_type_setting add column sensitive_default boolean;

update document_type
   set sensitive_default = false
 where household_id is null
   and key not in ('passport', 'drivers_licence', 'national_id', 'visa', 'birth_certificate',
                   'marriage_certificate', 'diploma', 'will',
                   'bank_statement', 'investment_statement', 'credit_card_statement',
                   'pay_statement', 'loan', 'tax_return', 'tax_form',
                   'medical_record', 'prescription');

-- -------------------------------------------------------------- a document's

alter table document add column sensitive boolean;

-- -------------------------------------------------------------- a batch's

alter table intake_batch add column default_sensitive boolean;

-- What its uploader may change: its name and its defaults, now with
-- Sensitive; and its end, brought to now as they remove it (0062).
create or replace function intake_batch_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() = 'account'
     and ((to_jsonb(new) - array['name', 'default_owner_member_id', 'default_type_key',
                                 'default_visibility', 'default_physical_location',
                                 'default_collection_id', 'default_tags', 'default_essential',
                                 'default_sensitive', 'ends_at'])
          is distinct from
          (to_jsonb(old) - array['name', 'default_owner_member_id', 'default_type_key',
                                 'default_visibility', 'default_physical_location',
                                 'default_collection_id', 'default_tags', 'default_essential',
                                 'default_sensitive', 'ends_at'])
          or (new.ends_at is distinct from old.ends_at
              and new.ends_at is distinct from least(old.ends_at, now())))
  then
    raise exception 'an uploader may change only a batch''s name and defaults, or end it now'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- ------------------------------------------------------ what is in effect

-- As 0087 made it, with Sensitive by default appended.
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
       coalesce(s.belongs_to, t.belongs_to) as belongs_to,
       coalesce(s.sensitive_default, t.sensitive_default) as sensitive_default
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
