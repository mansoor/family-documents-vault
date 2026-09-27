-- Reminders from any date (iteration 5.16a).
--
-- Until now only Expires made reminders (regenerateDerived), and a reminder
-- row did not say which date it came from. From here a kind reminds from
-- one date it shows: Expires (Review by on the Will), or one of its own
-- `date` fields — a bill's Due date, a car's MOT (A61). Nothing repeats: a
-- bill's next due date is a new date somebody enters.
--
-- * The library gains a built-in field, 'Due date'. Only a migration writes
--   a built-in (0031). A household's own field called "Due date" keeps its
--   key and its data.
-- * Which date a kind reminds from is one column, remind_from:
--     document_type          null: no reminders; else 'expires' or a date
--                            field's key, with 1 to 8 lead times.
--     document_type_setting  null: as the built-in, like every column of a
--                            setting; so a household's "off" is 'none', which
--                            the view reads as null.
--   There is no on/off flag beside it: one would give "off" two meanings.
--   The lead times stay in reminder_leads, and belong to whichever date
--   reminds (Expires keeps its own while switched off by hiding it).
-- * reminder.source says which date a derived reminder is about. Every
--   derived reminder until now is about Expires; the UPDATE runs in place,
--   so each keeps its id, and with it its lines in reminder_delivery: none
--   is sent again.
-- * effective_document_type is replaced with 0035's columns in 0035's
--   order (its grants kept, and still read with the caller's own rights),
--   and two appended:
--     remind_from   the date the kind reminds from, while it shows that date
--                   and has lead times; otherwise null.
--     remind_leads  its lead times.
--   reminder_leads is keyed on that date: a kind reminding from a detail
--   reads [], even while that detail is hidden, so no older phone, and no
--   status window, applies a due date's lead times to Expires. A kind
--   reminding from Expires, or from nothing, reads exactly what it read
--   before, byte for byte: so every existing kind's row, and its ETag, is
--   as it was, and nobody is asked to load it again at the upgrade.
--
-- No new policy: the tenant rules and 0030's per-actor rules cover the new
-- columns as they cover the rows.
--
-- A migration is nobody's edit: no audit row, and no updated_at moves.

-- ---------------------------------------------------------- the library

insert into document_attribute (key, label, kind) values ('due_date', 'Due date', 'date')
  on conflict do nothing;

-- ------------------------------------------------------ which date reminds

alter table document_type add column remind_from text;
alter table document_type_setting add column remind_from text;

-- From what 0035's view answers today, with its own expressions: the view
-- itself needs app_household(), which a migration has not set. A kind
-- reminds from Expires where it expires and has lead times: its own
-- columns say both, for a built-in as a household has it untouched, and
-- for a household's own.
update document_type t
   set remind_from = 'expires'
 where t.expiry_driver is not null and cardinality(t.reminder_leads) > 0;

-- A household's change to a built-in says so only where it differs from
-- the built-in: 'expires' where the household made it expire, 'none' where
-- it hid Expires or emptied the lead times.
update document_type_setting s
   set remind_from = case
         when fdv_type_core(t.core, s.core, t.issued_by_label, t.expiry_driver is not null)
                ->'expires'->'shown' = 'true'::jsonb
              and cardinality(coalesce(s.reminder_leads, t.reminder_leads)) > 0
         then 'expires' else 'none' end
  from document_type t
 where t.key = s.type_key and t.household_id is null
   and (fdv_type_core(t.core, s.core, t.issued_by_label, t.expiry_driver is not null)
          ->'expires'->'shown' = 'true'::jsonb
        and cardinality(coalesce(s.reminder_leads, t.reminder_leads)) > 0)
       <> (t.remind_from is not null);

alter table document_type
  add constraint document_type_remind_from check (
    remind_from is null
    or (remind_from ~ '^(expires|[a-z][a-z0-9_]{0,63})$'
        and cardinality(reminder_leads) between 1 and 8));
alter table document_type_setting
  add constraint document_type_setting_remind_from check (
    remind_from is null or remind_from ~ '^(none|expires|[a-z][a-z0-9_]{0,63})$');

-- ---------------------------------------------- which date a reminder is about

alter table reminder add column source text;
update reminder set source = 'expires' where kind = 'derived';
alter table reminder
  add constraint reminder_source check (
    (kind = 'derived') = (source is not null)
    and (source is null or source ~ '^(expires|[a-z][a-z0-9_]{0,63})$'));

-- ------------------------------------------------------ what is in effect

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
       r.leads as remind_leads
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
