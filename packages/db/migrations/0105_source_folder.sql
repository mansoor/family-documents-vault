-- The folder a paper came from, kept on the document (0.9.0, C4: "Bring
-- your tree"; the owner's idea 6 of 13 Nov 2026).
--
-- An item added from a folder — Add → Many documents with a folder chosen
-- or dropped, a subfolder of the scanner folder (0068), a computer's watched
-- folder (0070) — says where it was ("Taxes/2025"), sealed on the item
-- (0071) for as long as its batch lasts, at most 30 days. Filed as a new
-- document, that path is now kept on it:
--
--   source_folder   the folders it was in, under the folder chosen or
--                   watched, without the file's own name, as @fdv/shared
--                   `itemFolder` tidies them: segments joined by `/`, at
--                   most 512 characters. Never the file's name, never a
--                   whole path on somebody's computer.
--
-- It is the household's own filing, as where the original is kept is: the
-- API answers it as null to a viewer, limited or not, a guest, a link and
-- a page signed out, exactly as `physical_location` (5.41, 0058), and only
-- whoever sees that may filter by it. So its words go in search_tsv at
-- weight D, beside the location's and the place's (0104), which
-- `searchedWords` leaves out for them (ts_filter '{a,b,c}').
--
-- A person's cabinet may ask it (`source_folder`, the folder exactly,
-- whatever the case): "Keep this folder tree as my cabinet" draws a folder
-- for each folder their papers came from (GET /cabinet/from-folders).
--
-- Who writes it (the trigger, behind the API's own rules): it is set only
-- as a document is made, by somebody signed in who sees where originals are
-- kept, and is never changed after — only forgotten (set to null), by such
-- somebody, through an edit the API holds to whoever may change the
-- document. A new version filed from a folder leaves it as it is.
--
-- A migration is nobody's edit: no document's updated_at moves, and no
-- audit event is written. Documents filed before this keep none: the batch
-- items still holding a folder are sealed under their uploader's key, which
-- a migration does not have.

alter table document
  add column source_folder text
    constraint document_source_folder_path check (
      source_folder is null
      or (char_length(source_folder) between 1 and 512
          and source_folder !~ '(^/|/$|//|\\)'
          and btrim(source_folder) = source_folder));

-- What a cabinet's folder asks: the folder exactly, whatever the case.
create index document_source_folder_idx on document (household_id, lower(source_folder))
  where source_folder is not null;

-- Who writes it: set as a document is made, forgotten after, never changed.
create function document_source_folder_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.source_folder is not distinct from old.source_folder then
    return new;
  end if;
  if tg_op = 'INSERT' and new.source_folder is null then
    return new;
  end if;
  -- Whoever sees where originals are kept (5.41): an owner, an adult, a teen.
  if coalesce(app_role() not in ('owner', 'adult', 'teen'), true) then
    raise exception 'only whoever sees where originals are kept says which folder a paper came from'
      using errcode = 'insufficient_privilege';
  end if;
  -- Kept as it came, or forgotten: never another folder.
  if tg_op = 'UPDATE' and new.source_folder is not null then
    raise exception 'the folder a paper came from is kept as it came, or forgotten'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger document_source_folder_rule
  before insert or update of source_folder on document
  for each row execute function document_source_folder_rule();

-- The index again, with the folder's words beside the location's and the
-- place's, at weight D: a search by "taxes" finds the papers that came from
-- a folder of that name, for whoever sees where originals are kept, and for
-- nobody else. Its `/` is a word's edge.
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
                coalesce(original_place[3], '')), 'D') ||
    setweight(to_tsvector('simple', replace(coalesce(source_folder, ''), '/', ' ')), 'D')
  ) stored;
create index document_search_idx on document using gin (search_tsv);
