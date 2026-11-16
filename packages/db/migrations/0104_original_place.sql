-- Where the original is, as a place in somebody's cabinet (0.9.0, C3; the
-- owner's idea 5 of 13 Nov 2026): Cabinet › Drawer › Folder, picked from the
-- setter's own layout (cabinet_layout, 0097), beside the free text
-- `physical_location`, which stays for everything else.
--
--   original_place          the path's names — cabinet, drawer, folder — as
--                           the setter had them: a household's fact, read
--                           by whoever sees where originals are kept (5.41,
--                           0058), who need not have the setter's layout.
--   original_place_by       whose layout the folder is in, while it is …
--   original_place_folder   … and the folder there, by its id
--                           (`CABINET_NODE_ID`, as cabinet_pin's).
--
-- While the folder is still in its person's layout the names follow it: the
-- API writes them again as that person saves their layout, renamed. A folder
-- taken out of the layout lets the reference go and keeps the names, as
-- words; so does a layout gone with its person (the foreign key below, and
-- the trigger, which lets the folder's id go with it).
--
-- Who sees it is who sees `physical_location`: the API answers it as null
-- to a viewer, limited or not, a guest, a link and a page signed out, and
-- searches for them never find a document by its words — here, the names
-- are indexed at weight D beside the location's, which `searchedWords`
-- leaves out for them (ts_filter '{a,b,c}'), exactly as 0058 did.
--
-- Who writes it (the trigger, behind the API's own rules): somebody signed
-- in who sees where originals are kept — an owner, an adult, a teen — and
-- only ever a folder of their own; never somebody else's reference, nor its
-- names while it is still somebody else's. Anybody who may change the
-- document may replace or clear the place as a whole.
--
-- A migration is nobody's edit: no document's updated_at moves, and no
-- audit event is written.

alter table document
  add column original_place text[]
    constraint document_original_place_path check (
      original_place is null
      or (cardinality(original_place) = 3
          and array_ndims(original_place) = 1
          and array_position(original_place, null) is null
          and length(original_place[1]) between 1 and 200
          and length(original_place[2]) between 1 and 200
          and length(original_place[3]) between 1 and 200)),
  -- When the place last changed — set, cleared, or its names following a
  -- rename — which is never an edit (updated_at, and so the ETag, stay):
  -- a list's `updated_since` asks for either, so a phone's copy catches up.
  add column place_changed_at timestamptz,
  add column original_place_by uuid,
  add column original_place_folder text
    constraint document_original_place_folder check (
      original_place_folder is null or original_place_folder ~ '^[A-Za-z0-9_-]{1,40}$'),
  -- A reference is a person and their folder, both or neither, and only with names.
  add constraint document_original_place_ref check (
    (original_place_by is null) = (original_place_folder is null)
    and (original_place_by is null or original_place is not null)),
  -- Their layout gone (a guest removed, a household deleted): the names stay as words.
  add constraint document_original_place_layout
    foreign key (household_id, original_place_by)
    references cabinet_layout (household_id, member_id) on delete set null (original_place_by);

-- The documents a person's layout names, found as they save it (and as a
-- layout is removed: the foreign key's own look-up).
create index document_original_place_by_idx on document (household_id, original_place_by)
  where original_place_by is not null;

-- What a phone's `updated_since` finds beside updated_at: the places changed since.
create index document_place_changed_idx on document (household_id, place_changed_at)
  where place_changed_at is not null;

-- Who writes the place, and the reference that goes with a layout.
create function document_original_place_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  -- The foreign key's own cascade: the layout gone, its person with it. The
  -- reference goes whole — the folder's id with the person — and the names
  -- stay, as words.
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1
     and new.original_place_by is null and old.original_place_by is not null
     and new.original_place is not distinct from old.original_place
     and new.original_place_folder is not distinct from old.original_place_folder then
    new.original_place_folder := null;
    return new;
  end if;
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and (new.original_place, new.original_place_by, new.original_place_folder)
         is not distinct from (old.original_place, old.original_place_by, old.original_place_folder) then
    return new;
  end if;
  if tg_op = 'INSERT' and new.original_place is null and new.original_place_by is null then
    return new;
  end if;
  -- Whoever sees where originals are kept (5.41): an owner, an adult, a teen.
  if coalesce(app_role() not in ('owner', 'adult', 'teen'), true) then
    raise exception 'only whoever sees where originals are kept says where one is'
      using errcode = 'insufficient_privilege';
  end if;
  -- A folder of their own, named as they name it: never somebody else's
  -- reference, nor its names while it is still theirs.
  if new.original_place_by is not null
     and new.original_place_by is distinct from app_member()
     and (tg_op = 'INSERT'
          or new.original_place_by is distinct from old.original_place_by
          or new.original_place_folder is distinct from old.original_place_folder
          or new.original_place is distinct from old.original_place) then
    raise exception 'a place in a cabinet is a folder of the setter''s own'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger document_original_place_rule
  before insert or update of original_place, original_place_by, original_place_folder on document
  for each row execute function document_original_place_rule();

-- The index again, with the place's names beside the location's, at weight
-- D: a search by "study cabinet" finds the documents filed there, for
-- whoever sees where originals are kept, and for nobody else.
alter table document drop column search_tsv;
alter table document add column search_tsv tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(identifier, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(issued_by, '')), 'B') ||
    setweight(to_tsvector('simple', fdv_tags_text(tags)), 'B') ||
    setweight(case when visibility in ('household', 'adults')
                   then to_tsvector('simple', fdv_details_text(extra))
                   else ''::tsvector end, 'B') ||
    setweight(case when visibility in ('household', 'adults')
                   then to_tsvector('simple', coalesce(notes, ''))
                   else ''::tsvector end, 'C') ||
    setweight(to_tsvector('simple', coalesce(physical_location, '')), 'D') ||
    setweight(to_tsvector('simple',
                coalesce(original_place[1], '') || ' ' ||
                coalesce(original_place[2], '') || ' ' ||
                coalesce(original_place[3], '')), 'D')
  ) stored;
create index document_search_idx on document using gin (search_tsv);
