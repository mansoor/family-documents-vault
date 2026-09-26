-- A type's details are kept, searched and exported (iteration 5.8).
--
-- A document's type asks for details of its own — a car's VIN and plate, a
-- policy's cover — kept in document.extra under each field's key. From
-- here the API checks them against the type, and the search finds them.
--
-- * Search: the details' words and numbers, weighted with the issuer and
--   the tags, below the title — only for a document the family or the
--   adults can see. An Only me document's details stay out of the index,
--   as its pages' text always has: 5.9 seals them, and the owner's private
--   search pass finds them there.
-- * The built-ins ask for what makes each one of use (A9): a passport its
--   number and expiry, a driving licence its expiry, an insurance policy
--   its insurer and expiry. Nothing is ever refused for want of one (A7):
--   documents without them read "Needs a passport number" until somebody
--   adds it. A vehicle registration's plate waits for 5.10: it is one of
--   the type's own details, and no screen can add one before then, so every
--   car would read Needs info with nothing to be done about it.
--
-- A migration is nobody's edit: no document's updated_at moves, and no
-- audit event is written.

-- ------------------------------------------------------------------ search

-- The words of a document's details: each text, choice and number, and a
-- date's date — not its precision, which would make "month" find every
-- document with a date to the month. A yes or a no says nothing to search
-- for. The search's snippet shows the same words.
create function fdv_details_text(extra jsonb) returns text
  language sql immutable parallel safe as $$
  select coalesce(string_agg(case jsonb_typeof(v) when 'object' then v->>'date'
                                                  else v #>> '{}' end, ' '), '')
    from jsonb_each(case jsonb_typeof(extra) when 'object' then extra else '{}'::jsonb end)
           as e(k, v)
   where jsonb_typeof(v) in ('string', 'number')
      or (jsonb_typeof(v) = 'object' and jsonb_typeof(v->'date') = 'string') $$;

-- A generated column's expression cannot be changed in place on PostgreSQL
-- 16, so it is made again, as 0025 made it (dropping it drops its index).
-- Which documents' details are indexed is an allow-list, so a kind of
-- visibility added later is kept out until somebody says otherwise.
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
    setweight(to_tsvector('simple', coalesce(physical_location, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(notes, '')), 'C')
  ) stored;
create index document_search_idx on document using gin (search_tsv);

-- ------------------------------------------------- the built-ins' required

-- A passport: its number, by that name, and its expiry.
update document_type
   set core = core || jsonb_build_object(
         'identifier', core->'identifier' || '{"required": true, "label": "Passport number"}',
         'expires', core->'expires' || '{"required": true}'),
       pack_version = pack_version + 1
 where key = 'passport' and household_id is null;

-- A driving licence: its expiry.
update document_type
   set core = core || jsonb_build_object('expires', core->'expires' || '{"required": true}'),
       pack_version = pack_version + 1
 where key = 'drivers_licence' and household_id is null;

-- An insurance policy: who insured it ("Insurer", 0025's word) and its expiry.
update document_type
   set core = core || jsonb_build_object(
         'issued_by', core->'issued_by' || '{"required": true}',
         'expires', core->'expires' || '{"required": true}'),
       pack_version = pack_version + 1
 where key = 'insurance_policy' and household_id is null;

-- A vehicle registration: its plate, called what people call it (required
-- from 5.10, when the card can ask for it).
update document_type t
   set fields = (select jsonb_agg(case when e->>'key' = 'plate'
                                       then e || '{"label": "Registration plate"}'
                                       else e end
                                  order by i)
                   from jsonb_array_elements(t.fields) with ordinality x(e, i)),
       pack_version = t.pack_version + 1
 where t.key = 'vehicle_registration' and t.household_id is null;

update document_attribute
   set label = 'Registration plate'
 where key = 'plate' and household_id is null;
