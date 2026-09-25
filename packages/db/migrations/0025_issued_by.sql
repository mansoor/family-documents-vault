-- Who issued a document: "Issued by", a field of its own.
--
-- A family keeps several bank statements, bills and letters from the same
-- months. The type and the date alone do not say which is which; the issuer
-- does — "Bank statement · Barclays · Sep 2026". Until now the idea lived
-- under a different name in each type's own fields (institution, provider,
-- lender, insurer…), inside document.extra, where nothing showed it, listed
-- it or searched it.
--
-- Now: document.issued_by, backfilled from those fields, which leave both
-- the type's field list and the document's extra (one place for the value,
-- so the two can never drift apart). Each type keeps its own word for it as
-- issued_by_label ("Bank", "Provider", "Insurer"…; null reads "Issued by").
-- Search matches it, weighted just below the title.
--
-- A migration is nobody's edit: updated_at and updated_by stay as they are,
-- and no audit event is written.

alter table document add column issued_by text;
alter table document_type add column issued_by_label text;

create temporary table issuer_field (type_key text primary key, field text not null) on commit drop;
insert into issuer_field (type_key, field) values
  ('passport', 'issuing_country'),
  ('insurance_policy', 'insurer'),
  ('tax_form', 'issuer'),
  ('bank_statement', 'institution'),
  ('loan', 'lender'),
  ('medical_record', 'provider'),
  ('diploma', 'institution'),
  ('employment_contract', 'employer'),
  ('utility_bill', 'provider'),
  ('warranty', 'vendor'),
  ('pet_record', 'vet');

-- The type's own word for it, and its field list without it.
update document_type t
   set issued_by_label = (
         select e->>'label' from jsonb_array_elements(t.fields) e where e->>'key' = f.field
       ),
       fields = coalesce(
         (select jsonb_agg(e order by i)
            from jsonb_array_elements(t.fields) with ordinality x(e, i)
           where e->>'key' <> f.field),
         '[]'::jsonb
       ),
       pack_version = t.pack_version + 1
  from issuer_field f
 where t.key = f.type_key;

-- Values that fit the field as the API takes it move; anything else (not a
-- string, blank, over 200 characters) stays where it was, so a stored value
-- can never fail an edit that sends it back. Documents in the bin too.
-- Tidied as the API tidies: every run of white space (tabs and line breaks
-- too) becomes one space first, then the ends are trimmed.
with moved as (
  select d.id, f.field, btrim(regexp_replace(d.extra->>f.field, '\s+', ' ', 'g')) as value
    from document d
    join issuer_field f on f.type_key = d.type_key
   where d.issued_by is null
     and jsonb_typeof(d.extra->f.field) = 'string'
)
update document d
   set issued_by = m.value,
       extra = d.extra - m.field
  from moved m
 where d.id = m.id
   and m.value <> ''
   and char_length(m.value) <= 200;

-- Search: the issuer, weighted with the tags, below the title. A generated
-- column's expression cannot be changed in place on PostgreSQL 16, so it is
-- made again (dropping it drops its index).
alter table document drop column search_tsv;
alter table document add column search_tsv tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(identifier, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(issued_by, '')), 'B') ||
    setweight(to_tsvector('simple', fdv_tags_text(tags)), 'B') ||
    setweight(to_tsvector('simple', coalesce(physical_location, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(notes, '')), 'C')
  ) stored;
create index document_search_idx on document using gin (search_tsv);

-- The household's issuers, for the filter chips and the card's suggestions.
create index document_issued_by_idx on document (household_id, lower(issued_by))
  where issued_by is not null and deleted_at is null;
