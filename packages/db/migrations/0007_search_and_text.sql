-- Full-text search (FND-01) and OCR text split by scope (FND-07, decision 2).

-- array_to_string is only STABLE; a generated column needs IMMUTABLE. For
-- text[] the result cannot depend on session state, so the wrapper is safe.
create function fdv_tags_text(text[]) returns text
  language sql immutable parallel safe as
  $$ select coalesce(array_to_string($1, ' '), '') $$;

-- The document's own words: title, identifier, tags, notes. Generated, so
-- it can never drift from the columns it indexes.
alter table document add column search_tsv tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(identifier, '')), 'A') ||
    setweight(to_tsvector('simple', fdv_tags_text(tags)), 'B') ||
    setweight(to_tsvector('simple', coalesce(physical_location, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(notes, '')), 'C')
  ) stored;
create index document_search_idx on document using gin (search_tsv);

-- Household and Adults-only documents: OCR text in plain, indexed, fast.
create table document_text (
  version_id   uuid primary key references document_version(id) on delete cascade,
  household_id uuid not null references household(id) on delete cascade,
  document_id  uuid not null references document(id) on delete cascade,
  content      text not null,
  tsv          tsvector generated always as (to_tsvector('simple', content)) stored,
  created_at   timestamptz not null default now()
);
create index document_text_tsv_idx on document_text using gin (tsv);
create index document_text_doc_idx on document_text (household_id, document_id);

-- Private documents: ciphertext under the owner's member scope key, no
-- server-side index. Searched in-session (2.5).
create table document_text_sealed (
  version_id     uuid primary key references document_version(id) on delete cascade,
  household_id   uuid not null references household(id) on delete cascade,
  document_id    uuid not null references document(id) on delete cascade,
  content_cipher bytea not null,
  created_at     timestamptz not null default now()
);
create index document_text_sealed_doc_idx on document_text_sealed (household_id, document_id);

-- Thumbnails are cached encrypted in the vault; the version remembers where.
alter table document_version add column thumbnail_key text;
alter table document_version add column processed_at timestamptz;
alter table document_version add column process_error text;

alter table document_text enable row level security;
create policy document_text_tenant on document_text
  using (household_id = app_household()) with check (household_id = app_household());
alter table document_text_sealed enable row level security;
create policy document_text_sealed_tenant on document_text_sealed
  using (household_id = app_household()) with check (household_id = app_household());

grant select, insert, update, delete on document_text, document_text_sealed to fdv_app;
