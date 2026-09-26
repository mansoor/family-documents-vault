-- A kind of document deleted while documents its deleter cannot see still
-- use it (the 5.11 review).
--
-- DELETE /document-types/{key} refused a kind any document used, whoever's.
-- An adult who could see none of them learned from the refusal alone that
-- another member has an Only me document of a kind such as "Immigration
-- case": the gap the privacy wall forbids. From here the answer depends
-- only on what the caller can see. A kind that a document they can see
-- uses (in the Trash too) is still refused; one that only documents they
-- cannot see use is deleted for them, exactly as an unused one is — 204,
-- and the same line in the log — but its row is kept, marked deleted_at,
-- so the documents filed under it keep their kind.
--
-- A deleted kind:
--   * is left out of GET /document-types, ?all=true included, for anybody
--     who can see none of its documents;
--   * is not changed, archived, restored, counted or deleted again by
--     anybody (404, as a kind that is gone): each of those would be a line
--     in the activity log, which the family reads;
--   * is never offered for a new document: typed in, it is refused as a
--     kind not on the list; captured, the document is filed with no kind;
--   * still names the documents filed under it, for whoever can see them;
--   * is gone for good once no document uses it: when the last of them is
--     filed under another kind (the Trash keeps a document; nothing purges
--     one yet).
--
-- effective_document_type carries it, last, and counts a deleted kind as
-- hidden. The view is replaced with the same columns in the same order: its
-- grants are kept, and it still reads with the caller's own rights.
--
-- A migration is nobody's edit: no row is written, and no audit event.

alter table document_type add column deleted_at timestamptz;

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
       coalesce(s.reminder_leads, t.reminder_leads) as reminder_leads,
       coalesce(s.usually_essential, t.usually_essential) as usually_essential,
       coalesce(s.default_visibility, t.default_visibility) as default_visibility,
       t.sort_order,
       t.pack_version,
       c.core,
       c.core->'issued_by'->>'label' as issued_by_label,
       t.short_label,
       t.issuer_noun,
       coalesce(s.hidden, false) or t.archived_at is not null or t.deleted_at is not null
         as hidden,
       t.archived_at,
       greatest(t.updated_at, s.updated_at) as updated_at,
       t.deleted_at
  from document_type t
  left join document_type_setting s
    on t.household_id is null and s.type_key = t.key and s.household_id = app_household()
  -- offset 0 keeps the planner from copying the merge into each column that
  -- reads it, which ran it three times a row.
  cross join lateral (
    select fdv_type_core(t.core, s.core, t.issued_by_label, t.expiry_driver is not null) as core
    offset 0
  ) c;
