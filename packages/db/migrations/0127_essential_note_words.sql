-- An Essential note's words kept out of the search index (0.9.0-dev.87).
--
-- A note (0078) whose words are behind "Confirm it's you" — an Only me one,
-- or an Essential one — shows its title and its date in a list, in search
-- and on Home, and nothing of its words until it is confirmed to be them:
-- no first words, no snippet, and no match inside them. An Only me
-- document's notes were never in the index (0033); an Essential note's
-- words are left out here too, so a search by a word of them finds nothing.
-- Its title, its tags and the rest stay in, as any document's.
--
-- The index again, as 0105 made it, with that one condition added to the
-- notes' part. Made Essential, or not, the row's index follows at once (a
-- generated column). A migration is nobody's edit: no document's updated_at
-- moves, and no audit event is written.

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
                        and not (type_key is not distinct from 'note' and is_essential)
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
