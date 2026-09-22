-- Documents and their immutable versions (data model, section 3).

create type date_precision as enum ('day', 'month', 'year');
create type visibility as enum ('household', 'adults', 'private');

-- A document type is a small template: which fields to ask for, which date
-- drives expiry, what lead times a reminder needs, whether it is usually
-- Essential, and which visibility it defaults to.
create table document_type (
  key                text primary key,        -- 'passport', 'vehicle_registration'
  label              text not null,           -- 'Passport'
  category           text not null,           -- 'identity', 'insurance' ...
  locale             text,                    -- null = universal; 'US', 'GB' for packs
  fields             jsonb not null default '[]',  -- [{key,label,kind}] beyond the basics
  expiry_driver      text,                    -- 'expires_on' | 'review_on' | null
  reminder_leads     int[] not null default '{}',  -- days before expiry
  usually_essential  boolean not null default false,
  default_visibility visibility not null default 'household',
  sort_order         int not null default 100,
  pack_version       int not null default 1
);
grant select on document_type to fdv_app;

create table document (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references household(id) on delete cascade,
  type_key          text references document_type(key),
  title             text,
  owner_member_id   uuid references member(id) on delete set null,
  category          text,
  visibility        visibility not null default 'household',

  issued_on         date,
  issued_precision  date_precision,
  expires_on        date,
  expires_precision date_precision,

  identifier        text,
  physical_location text,
  is_essential      boolean not null default false,
  tags              text[] not null default '{}',
  notes             text,
  extra             jsonb not null default '{}',   -- the type's own fields

  status_cache      text,                 -- materialised nightly; never authoritative
  created_at        timestamptz not null default now(),
  created_by        uuid references account(id),
  updated_at        timestamptz not null default now(),
  updated_by        uuid references account(id),
  deleted_at        timestamptz,

  constraint issued_precision_requires_date
    check ((issued_on is null) = (issued_precision is null)),
  constraint expires_precision_requires_date
    check ((expires_on is null) = (expires_precision is null)),
  constraint private_needs_owner
    check (visibility <> 'private' or owner_member_id is not null)
);
create index document_household_idx on document (household_id, deleted_at, updated_at desc);
create index document_owner_idx on document (household_id, owner_member_id);
create index document_category_idx on document (household_id, category);
create index document_tags_idx on document using gin (tags);

create table document_version (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references household(id) on delete cascade,
  document_id      uuid not null references document(id) on delete cascade,
  version_no       int not null,
  filename         text not null,
  mime             text not null,
  byte_size        bigint not null,        -- plaintext bytes
  sha256           bytea not null,         -- of the plaintext, for dedupe and verification
  cipher_bytes     bigint not null,        -- ciphertext bytes actually stored
  cipher_sha256    bytea not null,         -- what the storage adapter verified
  storage_key      text not null,
  vault_id         uuid not null references vault(id),
  file_key_wrapped bytea not null,         -- wrapped by the document's scope key
  wrapped_by_scope uuid not null references scope_key(id),
  page_count       int,
  ocr_status       text not null default 'pending'
                     check (ocr_status in ('pending', 'done', 'failed', 'skipped')),
  uploaded_by      uuid references account(id),
  uploaded_at      timestamptz not null default now(),
  unique (document_id, version_no)
);
create index document_version_doc_idx on document_version (household_id, document_id, version_no desc);

-- A retried upload with the same key must never create a second document.
create table upload_idempotency (
  idempotency_key uuid not null,
  household_id    uuid not null references household(id) on delete cascade,
  document_id     uuid not null references document(id) on delete cascade,
  version_id      uuid references document_version(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (household_id, idempotency_key)
);

-- Related documents, bidirectional (ORG-06). Stored once, smaller id first.
create table document_link (
  household_id  uuid not null references household(id) on delete cascade,
  a             uuid not null references document(id) on delete cascade,
  b             uuid not null references document(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (a, b),
  check (a < b)
);

alter table document enable row level security;
create policy document_tenant on document
  using (household_id = app_household()) with check (household_id = app_household());
alter table document_version enable row level security;
create policy document_version_tenant on document_version
  using (household_id = app_household()) with check (household_id = app_household());
alter table upload_idempotency enable row level security;
create policy upload_idempotency_tenant on upload_idempotency
  using (household_id = app_household()) with check (household_id = app_household());
alter table document_link enable row level security;
create policy document_link_tenant on document_link
  using (household_id = app_household()) with check (household_id = app_household());

grant select, insert, update, delete on document, document_version, upload_idempotency, document_link to fdv_app;

-- ---------------------------------------------------------------- built-in types
insert into document_type
  (key, label, category, fields, expiry_driver, reminder_leads, usually_essential, default_visibility, sort_order) values
  ('birth_certificate', 'Birth certificate', 'identity',
     '[{"key":"registration_no","label":"Registration number","kind":"text"},{"key":"place_of_birth","label":"Place of birth","kind":"text"}]',
     null, '{}', true, 'household', 10),
  ('passport', 'Passport', 'identity',
     '[{"key":"issuing_country","label":"Issuing country","kind":"text"}]',
     'expires_on', '{270,180}', true, 'household', 11),
  ('drivers_licence', 'Driver''s licence', 'identity',
     '[{"key":"class","label":"Class","kind":"text"},{"key":"state","label":"State","kind":"text"}]',
     'expires_on', '{60,14}', true, 'household', 12),
  ('national_id', 'Social security / national ID', 'identity',
     '[]', null, '{}', true, 'adults', 13),
  ('visa', 'Visa / residence permit', 'identity',
     '[{"key":"visa_type","label":"Visa type","kind":"text"},{"key":"sponsor","label":"Sponsor","kind":"text"}]',
     'expires_on', '{120,30}', true, 'household', 14),
  ('marriage_certificate', 'Marriage / divorce certificate', 'legal',
     '[{"key":"jurisdiction","label":"Jurisdiction","kind":"text"}]',
     null, '{}', false, 'adults', 20),
  ('will', 'Will / trust / power of attorney', 'legal',
     '[{"key":"executor","label":"Executor","kind":"text"},{"key":"last_reviewed","label":"Last reviewed","kind":"date"}]',
     'review_on', '{0}', false, 'adults', 21),
  ('property_deed', 'Property deed / lease', 'property',
     '[{"key":"address","label":"Address","kind":"text"},{"key":"parties","label":"Parties","kind":"text"}]',
     'expires_on', '{90}', false, 'adults', 30),
  ('vehicle_registration', 'Vehicle title / registration', 'property',
     '[{"key":"vin","label":"VIN","kind":"text"},{"key":"plate","label":"Plate","kind":"text"}]',
     'expires_on', '{45,7}', false, 'household', 31),
  ('insurance_policy', 'Insurance policy', 'insurance',
     '[{"key":"insurer","label":"Insurer","kind":"text"},{"key":"premium","label":"Premium","kind":"text"},{"key":"coverage","label":"Coverage","kind":"text"}]',
     'expires_on', '{45,14}', false, 'household', 40),
  ('tax_return', 'Tax return', 'tax',
     '[{"key":"tax_year","label":"Tax year","kind":"year"},{"key":"filed_on","label":"Filing date","kind":"date"},{"key":"refund_or_owed","label":"Refund / owed","kind":"text"}]',
     null, '{}', false, 'adults', 50),
  ('tax_form', 'W-2 / 1099 / tax form', 'tax',
     '[{"key":"tax_year","label":"Tax year","kind":"year"},{"key":"issuer","label":"Issuer","kind":"text"}]',
     null, '{}', false, 'adults', 51),
  ('bank_statement', 'Bank / investment statement', 'financial',
     '[{"key":"institution","label":"Institution","kind":"text"},{"key":"account_last4","label":"Account (last 4)","kind":"text"},{"key":"period","label":"Period","kind":"text"}]',
     null, '{}', false, 'adults', 60),
  ('loan', 'Loan / mortgage', 'financial',
     '[{"key":"lender","label":"Lender","kind":"text"},{"key":"account","label":"Account","kind":"text"},{"key":"rate","label":"Rate","kind":"text"}]',
     'expires_on', '{60}', false, 'adults', 61),
  ('medical_record', 'Medical record / immunisation', 'medical',
     '[{"key":"provider","label":"Provider","kind":"text"},{"key":"date_of_service","label":"Date of service","kind":"date"}]',
     null, '{}', false, 'adults', 70),
  ('prescription', 'Prescription', 'medical',
     '[{"key":"medication","label":"Medication","kind":"text"},{"key":"prescriber","label":"Prescriber","kind":"text"},{"key":"refills","label":"Refills","kind":"text"}]',
     'expires_on', '{7}', false, 'adults', 71),
  ('diploma', 'Diploma / transcript', 'education',
     '[{"key":"institution","label":"Institution","kind":"text"},{"key":"year","label":"Year","kind":"year"}]',
     null, '{}', false, 'household', 80),
  ('employment_contract', 'Employment contract / offer', 'work',
     '[{"key":"employer","label":"Employer","kind":"text"},{"key":"start_date","label":"Start date","kind":"date"}]',
     'expires_on', '{60}', false, 'adults', 90),
  ('utility_bill', 'Utility / bill', 'bills',
     '[{"key":"provider","label":"Provider","kind":"text"},{"key":"account","label":"Account","kind":"text"},{"key":"amount","label":"Amount","kind":"text"}]',
     'expires_on', '{7,1}', false, 'household', 100),
  ('warranty', 'Warranty / receipt', 'other',
     '[{"key":"item","label":"Item","kind":"text"},{"key":"vendor","label":"Vendor","kind":"text"},{"key":"purchase_date","label":"Purchase date","kind":"date"}]',
     'expires_on', '{30}', false, 'household', 110),
  ('pet_record', 'Pet records', 'pets',
     '[{"key":"animal","label":"Animal","kind":"text"},{"key":"vet","label":"Vet","kind":"text"}]',
     'expires_on', '{21}', false, 'household', 120),
  ('other', 'Something else', 'other', '[]', null, '{}', false, 'household', 999);
