-- Notes kept on their own (0.9.0, N1, the owner's request of 18 Oct 2026).
--
-- A note is a document without a file, of a built-in kind of its own,
-- "Note": its words are the document's note (`notes`, 5.35), kept and
-- sealed as every document's note is — plain for Everyone and Adults only,
-- sealed under its owner's key for Only me (0033), the plain column empty.
-- So it is everything a document is, with nothing new to keep: who sees it,
-- its links, its collections, its tags, search (the private pass among
-- them), the activity log, the Trash, export, backup and restore. What is
-- new is only what keeps it a note:
--
--   the kind      `note`, a built-in like any other, with no details, no
--                 dates, no number and no place the original is kept. It
--                 is never a kind to file a paper as: hidden from the list
--                 of kinds (but for whoever can see a note, as any hidden
--                 kind is — an older phone looks a kind up there), never
--                 proposed for one, and not the household's to change
--                 (document_type_setting refuses it).
--   no file       a note never has a version (document_version refuses
--                 one), and a document with a file never becomes a note.
--                 Whatever files a paper — an upload, a capture, the
--                 Inbox, a version, a request's files — is refused by the
--                 API first; these are what hold whatever writes.
--
-- Nothing is moved: no document becomes a note. A migration is nobody's
-- edit: no audit event is written.
--
-- The functions put pg_temp last in their path. The two that ask about a
-- document's versions, or a version's document, ask past row-level
-- security (security definer): a row the writer cannot see is still the
-- row it would write about.

insert into document_type
  (key, label, category, fields, expiry_driver, reminder_leads, usually_essential,
   default_visibility, sort_order, issued_by_label, short_label, issuer_noun, remind_from, core)
values
  ('note', 'Note', 'other', '[]', null, '{}', false, 'household', 990, null, 'Note', null, null,
   fdv_type_core(
     '{"identifier": {"shown": false}, "issued_by": {"shown": false},
       "issued": {"shown": false}, "expires": {"shown": false},
       "physical_location": {"shown": false}, "notes": {"label": "Note"}}',
     '{}', null, false));

-- ------------------------------------------------------ what is in effect

-- As 0038 made it, with the note's kind hidden: never offered to file a
-- paper as, and listed only where its own rule lists a hidden kind.
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

-- ------------------------------------------------------------ no file

-- A version of a note: never, whoever writes it.
create function document_version_not_on_note() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if exists (select 1 from document d where d.id = new.document_id and d.type_key = 'note') then
    raise exception 'a note keeps no file'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger document_version_not_on_note before insert or update of document_id
  on document_version for each row execute function document_version_not_on_note();

-- A document with a file never becomes a note. (A note made another kind
-- is a document without a file, which any kind may be; the API keeps a
-- note a note.)
create function document_note_has_no_file() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.type_key = 'note' and new.type_key is distinct from old.type_key
     and exists (select 1 from document_version v where v.document_id = new.id) then
    raise exception 'a document with a file is not a note'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger document_note_has_no_file before update of type_key on document
  for each row execute function document_note_has_no_file();

-- The note's kind is the vault's: no household hides it, shows it, or
-- gives it fields, dates or reminders.
create function document_type_setting_not_note() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.type_key = 'note' then
    raise exception 'the kind of a note is not changed'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger document_type_setting_not_note before insert or update
  on document_type_setting for each row execute function document_type_setting_not_note();

-- ------------------------------------------------------ a collection's link

-- What a link gives, as 0061 made it, but a note in its collection too
-- (the N1 review): the brief has a note inherit collections, and a
-- collection's link gives it as its words, read on the page. Every other
-- rule is as it was — what was ticked or followed, out of the Trash, what
-- its maker may still see and lend, Only me only its maker's and only while
-- the household shares those — and a document with no file, or whose file
-- was removed for good, still goes with nothing.
create or replace function app_link_documents() returns setof uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.document_id
       from share_link s
      where s.id = app_live_share()
        and s.document_id is not null
     union
     select d.id
       from share_link s
       join doc_collection c on c.id = s.collection_id and c.household_id = s.household_id
       join account_household maker
         on maker.account_id = s.created_by and maker.household_id = s.household_id
       join share_link_item t on t.share_id = s.id and t.kind in ('ticked', 'followed')
       join doc_collection_item i on i.collection_id = c.id and i.document_id = t.document_id
       join document d on d.id = t.document_id and d.household_id = s.household_id
      where s.id = app_live_share()
        and d.deleted_at is null
        and case d.visibility
              when 'household' then true
              when 'adults' then maker.role in ('owner', 'adult')
              when 'private' then coalesce(d.owner_member_id = maker.member_id, false)
                                  and app_only_me_shareable()
              else false
            end
        and (d.type_key = 'note'
             or coalesce((select v.file_removed_at is null
                            from document_version v
                           where v.document_id = d.id
                           order by v.version_no desc
                           limit 1), false))
        and (t.kind = 'ticked'
             or (collection_audience_sees(c.audience, d.visibility::text)
                 and collection_audience_sees(s.follow_audience, d.visibility::text)))
        and maker_lends(maker.member_id, d.id, d.visibility, d.owner_member_id, d.type_key) $$;
