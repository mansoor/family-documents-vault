-- Where the original is kept is the household's (the Phase 5 exit, 5.41;
-- the owner's decision of 6 Oct 2026).
--
-- A document's `physical_location` ("Bedroom safe, top shelf") is seen only
-- by owners, adults and teens: never by a viewer, limited or not, nor a
-- guest (a guest is a viewer), nor anybody with no sign-in — a share link's
-- recipient, an upload's sender. The API answers it as null to them
-- (`seesLocation`, @fdv/shared roles.ts). Knowing where the family keeps
-- its originals is about the house, not the documents.
--
-- A search must not find a document by those words either: "safe" or
-- "bedroom" answered with a document is the location told another way.
-- search_tsv indexed the location at weight C, beside the notes, so nothing
-- could take its words out again. Here it is made again with the location
-- alone at weight D, which no other field uses: the API matches and ranks a
-- search for somebody who may not see locations against
-- `ts_filter(search_tsv, '{a,b,c}')` — the index without the location's
-- words, exactly, and never with them (a word excluded with "-" included,
-- which would otherwise say what the location holds by what it leaves out).
-- For everybody else nothing changes but the location's weight in the
-- ranking, from C to D.
--
-- A migration is nobody's edit: no document's updated_at moves, and no
-- audit event is written.

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
    setweight(to_tsvector('simple', coalesce(physical_location, '')), 'D')
  ) stored;
create index document_search_idx on document using gin (search_tsv);
