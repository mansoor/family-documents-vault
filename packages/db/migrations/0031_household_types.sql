-- Document types belong to the household (iteration 5.7).
--
-- Until now every vault had the same fixed list of types, reference data
-- with no household and no row-level security. A family keeps papers the
-- list does not know, and the list says things about the family it should
-- be able to change: that a will is looked at every year, that a passport
-- number is called a passport number. From here:
--
-- * document_type holds the built-ins (household_id null) and each
--   household's own types. A household's own is household data, behind the
--   policies like everything else it keeps: a type's name can say a lot
--   ("Immigration case"). Everybody reads the built-ins; nobody, through
--   the application role, can write one (the 4.1c note), so a release's
--   pack upgrades, as 0025 was, still reach every vault.
-- * document_type_setting holds a household's changes to a built-in: hidden,
--   the fixed fields, its own fields, lead times, who sees it by default,
--   usually Essential. The built-in itself stays as it was (A8).
-- * document_attribute is the library of fields a type can ask for; the
--   built-in ones are today's field keys.
-- * effective_document_type is what a household's types are: the built-ins
--   with its settings applied, and its own. It is security_invoker, so it
--   answers each caller with the caller's own rights.
--
-- A household's own keys are 'h_' and ten base32 characters, chosen once
-- and never changed, so that something holding a key (5.32's restrictions)
-- always means the same type.
--
-- The policies are allow-lists, as 0030's are: `case app_actor() when …
-- else false end`, and app_household() reads '' as NULL, so a transaction
-- that says nothing is given the built-ins and nothing of any household.

-- ------------------------------------------------------ the fixed fields

-- A type's fixed fields — the columns every document has — each shown or
-- not, required or not, and with its own label or the app's word (null):
-- identifier, issued_by, issued, expires, physical_location, tags, notes.
-- Always all seven, whatever is kept. Each says what the first of these
-- says about it:
--   over     a household's change to a built-in, key by key;
--   the type's own columns, for the two they said before core: its word
--            for who issued it (issued_by_label, 0025) and whether it
--            expires (expiry_driver) — so a release's pack upgrade of either
--            still shows, and core can never disagree with them;
--   base     the type's core;
--   otherwise shown, not required, in the app's word.
create function fdv_type_core(base jsonb, over jsonb, issuer text, expires boolean)
  returns jsonb language sql immutable parallel safe as $$
  select jsonb_object_agg(k,
           jsonb_build_object('shown', true, 'required', false, 'label', null)
           || case jsonb_typeof(base->k) when 'object' then base->k else '{}'::jsonb end
           || case k when 'issued_by' then jsonb_build_object('label', issuer)
                     when 'expires' then jsonb_build_object('shown', expires)
                     else '{}'::jsonb end
           || case jsonb_typeof(over->k) when 'object' then over->k else '{}'::jsonb end)
    from unnest(array['identifier', 'issued_by', 'issued', 'expires',
                      'physical_location', 'tags', 'notes']) k $$;

-- ------------------------------------------------------------- the types

alter table document_type
  add column household_id uuid references household(id) on delete cascade,
  add column archived_at  timestamptz,
  add column created_by   uuid references account(id) on delete set null,
  add column updated_at   timestamptz not null default now(),
  add column core         jsonb not null default '{}',
  add column short_label  text,
  add column issuer_noun  text;

-- A built-in's key is a plain word; a household's is its own, and cannot
-- be mistaken for one a later release adds.
alter table document_type add constraint document_type_key_shape check (
  case when household_id is null then key !~ '^h_' else key ~ '^h_[a-z2-7]{10}$' end);

create index document_type_household_idx on document_type (household_id)
  where household_id is not null;

-- A key, once given, is the type's for good, and so is its household.
create function document_type_fixed() returns trigger
  language plpgsql as $$
begin
  if new.key <> old.key or new.household_id is distinct from old.household_id then
    raise exception 'a document type keeps its key and its household'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger document_type_fixed before update on document_type
  for each row execute function document_type_fixed();

-- The built-ins as the card shows them today: every fixed field, except an
-- expiry for a type that has none; nothing required yet (5.8 adds that).
-- Each field of their own is not required either.
update document_type t
   set core = fdv_type_core('{}', '{}', t.issued_by_label, t.expiry_driver is not null),
       fields = coalesce(
         (select jsonb_agg(jsonb_build_object('required', false) || e order by i)
            from jsonb_array_elements(t.fields) with ordinality x(e, i)),
         '[]'::jsonb),
       pack_version = t.pack_version + 1
 where t.household_id is null;

-- Each built-in's short name and the noun it takes after its issuer: the
-- words packages/shared kept in code until now (titles.ts), which it still
-- falls back on for a vault older than this.
update document_type t
   set short_label = w.short_label
  from (values ('national_id', 'National ID'),
               ('visa', 'Visa'),
               ('marriage_certificate', 'Marriage certificate'),
               ('will', 'Will'),
               ('property_deed', 'Property deed'),
               ('vehicle_registration', 'Vehicle registration'),
               ('tax_form', 'Tax form'),
               ('bank_statement', 'Bank statement'),
               ('loan', 'Loan'),
               ('medical_record', 'Medical record'),
               ('diploma', 'Diploma'),
               ('employment_contract', 'Employment contract'),
               ('utility_bill', 'Bill'),
               ('warranty', 'Warranty'),
               ('pet_record', 'Pet record')) w(key, short_label)
 where t.key = w.key and t.household_id is null;

update document_type t
   set issuer_noun = w.noun
  from (values ('bank_statement', 'statement'),
               ('utility_bill', 'bill'),
               ('insurance_policy', 'policy'),
               ('tax_form', 'tax form'),
               ('tax_return', 'tax return'),
               ('loan', 'loan statement'),
               ('employment_contract', 'contract'),
               ('warranty', 'receipt')) w(key, noun)
 where t.key = w.key and t.household_id is null;

alter table document_type enable row level security;

-- Everybody reads the built-ins; a household reads its own. A household
-- writes only its own: a built-in has no household, so no write reaches it.
create policy document_type_read on document_type for select
  using (household_id is null or household_id = app_household());
create policy document_type_insert on document_type for insert
  with check (household_id = app_household());
create policy document_type_update on document_type for update
  using (household_id = app_household()) with check (household_id = app_household());
create policy document_type_delete on document_type for delete
  using (household_id = app_household());

-- A household's own types, by who is asking: the family and the vault; a
-- link, only the type of the document it was made for (its page names it);
-- anybody else, none. Writing is for somebody signed in, or the vault.
create policy document_type_actor on document_type as restrictive for select
  using (household_id is null
         or case app_actor()
              when 'account' then true
              when 'system' then true
              when 'link' then key = (select d.type_key from document d
                                       where d.id = (select app_shared_document()))
              else false
            end);
create policy document_type_actor_insert on document_type as restrictive for insert
  with check (case app_actor() when 'account' then true when 'system' then true else false end);
create policy document_type_actor_update on document_type as restrictive for update
  using (case app_actor() when 'account' then true when 'system' then true else false end);
create policy document_type_actor_delete on document_type as restrictive for delete
  using (case app_actor() when 'account' then true when 'system' then true else false end);

grant select, insert, update, delete on document_type to fdv_app;

-- ------------------------------------ a household's changes to a built-in

-- Null in a column leaves the built-in's own; core is changed key by key
-- (fdv_type_core). The built-in row is never touched.
create table document_type_setting (
  household_id       uuid not null references household(id) on delete cascade,
  type_key           text not null references document_type(key) on delete cascade,
  hidden             boolean not null default false,
  core               jsonb not null default '{}',
  fields             jsonb,
  reminder_leads     int[],
  default_visibility visibility,
  usually_essential  boolean,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references account(id) on delete set null,
  primary key (household_id, type_key)
);

alter table document_type_setting enable row level security;
create policy document_type_setting_tenant on document_type_setting
  using (household_id = app_household()) with check (household_id = app_household());
create policy document_type_setting_actor on document_type_setting as restrictive
  using (case app_actor() when 'account' then true when 'system' then true else false end);

grant select, insert, update, delete on document_type_setting to fdv_app;

-- ------------------------------------------------- the attribute library

create table document_attribute (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid references household(id) on delete cascade,
  key          text not null,
  label        text not null,
  kind         text not null check (kind in ('text', 'long_text', 'date', 'year', 'number',
                                                'money', 'choice', 'yes_no')),
  choices      text[],
  constraint document_attribute_choices check (
    case when kind = 'choice' then coalesce(cardinality(choices), 0) > 0
         else choices is null end),
  constraint document_attribute_key_shape check (
    case when household_id is null then key !~ '^h_' else key ~ '^h_[a-z2-7]{10}$' end),
  unique nulls not distinct (household_id, key)
);

-- Today's fields, each once: its label where it is first asked for.
insert into document_attribute (key, label, kind)
select distinct on (e->>'key') e->>'key', e->>'label', e->>'kind'
  from document_type t, jsonb_array_elements(t.fields) e
 where t.household_id is null
 order by e->>'key', t.sort_order;

alter table document_attribute enable row level security;
create policy document_attribute_read on document_attribute for select
  using (household_id is null or household_id = app_household());
create policy document_attribute_insert on document_attribute for insert
  with check (household_id = app_household());
create policy document_attribute_update on document_attribute for update
  using (household_id = app_household()) with check (household_id = app_household());
create policy document_attribute_delete on document_attribute for delete
  using (household_id = app_household());
create policy document_attribute_actor on document_attribute as restrictive
  using (household_id is null
         or case app_actor() when 'account' then true when 'system' then true else false end);

grant select, insert, update, delete on document_attribute to fdv_app;

-- ------------------------------------------------------ what is in effect

-- A household's types: each built-in with the household's setting on it,
-- and the household's own. `hidden` is hidden by the household, or
-- archived. The expiry follows the Expires field: a household that
-- switches it off on a built-in has a type that does not expire, and one
-- that switches it on has one that does. Read with the caller's own rights
-- (security_invoker): another household's types and settings are not
-- there to be merged.
create view effective_document_type with (security_invoker = true) as
select t.key,
       t.household_id,
       t.household_id is null as builtin,
       t.label,
       t.category,
       t.locale,
       coalesce(s.fields, t.fields) as fields,
       case when c.core->'expires'->'shown' = 'true'::jsonb
            then coalesce(t.expiry_driver, 'expires_on') end as expiry_driver,
       coalesce(s.reminder_leads, t.reminder_leads) as reminder_leads,
       coalesce(s.usually_essential, t.usually_essential) as usually_essential,
       coalesce(s.default_visibility, t.default_visibility) as default_visibility,
       t.sort_order,
       t.pack_version,
       c.core,
       c.core->'issued_by'->>'label' as issued_by_label,
       t.short_label,
       t.issuer_noun,
       coalesce(s.hidden, false) or t.archived_at is not null as hidden,
       t.archived_at,
       greatest(t.updated_at, s.updated_at) as updated_at
  from document_type t
  left join document_type_setting s
    on t.household_id is null and s.type_key = t.key and s.household_id = app_household()
  cross join lateral (
    select fdv_type_core(t.core, s.core, t.issued_by_label, t.expiry_driver is not null) as core
  ) c;

-- Read only: a type is changed where it is kept.
grant select on effective_document_type to fdv_app;
revoke insert, update, delete on effective_document_type from fdv_app;

-- ------------------------------------------------- which types are in use

-- "Is any document of this type left?" — the default list keeps a hidden
-- type while one is (5.7), and 5.11 asks before removing one.
create index document_by_type_idx on document (household_id, type_key)
  where deleted_at is null;
