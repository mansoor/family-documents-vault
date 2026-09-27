-- Lists are called collections (iteration 5.17b, A70).
--
-- The owner's word for a named group of documents gathered for a purpose
-- and shared is "collection": a list reads as a list of names, or a to-do
-- list. So 0036's tables, and everything named after them, are renamed in
-- place. Nothing is copied and nothing is dropped: every row keeps its id,
-- every item its place, and every grant, rule and trigger stays on the
-- same object, which only changes its name. 0036 is left as it was: it is
-- history, and a backup made before this one is brought up to date by it.
--
-- The activity log is not touched. Its rows are hash-chained, so a line
-- already written about a list stays exactly as it was written.

-- ------------------------------------------------------------- the tables

alter table doc_list rename to doc_collection;
alter table doc_list_item rename to doc_collection_item;
alter table doc_collection_item rename column list_id to collection_id;

-- Their keys and checks. A primary key's or a unique constraint's index is
-- renamed with it. (Their ids are uuids: there is no sequence to rename.)
alter table doc_collection rename constraint doc_list_pkey to doc_collection_pkey;
alter table doc_collection rename constraint doc_list_id_household_id_key
  to doc_collection_id_household_id_key;
alter table doc_collection rename constraint doc_list_household_id_fkey
  to doc_collection_household_id_fkey;
alter table doc_collection rename constraint doc_list_owner_member_id_fkey
  to doc_collection_owner_member_id_fkey;
alter table doc_collection rename constraint doc_list_created_by_fkey
  to doc_collection_created_by_fkey;
alter table doc_collection rename constraint doc_list_name_check to doc_collection_name_check;
alter table doc_collection rename constraint doc_list_description_check
  to doc_collection_description_check;
alter table doc_collection rename constraint doc_list_audience_check
  to doc_collection_audience_check;
alter table doc_collection rename constraint doc_list_only_me_owner to doc_collection_only_me_owner;

alter table doc_collection_item rename constraint doc_list_item_pkey to doc_collection_item_pkey;
alter table doc_collection_item rename constraint doc_list_item_list_id_household_id_fkey
  to doc_collection_item_collection_id_household_id_fkey;
alter table doc_collection_item rename constraint doc_list_item_document_id_household_id_fkey
  to doc_collection_item_document_id_household_id_fkey;
alter table doc_collection_item rename constraint doc_list_item_household_id_fkey
  to doc_collection_item_household_id_fkey;
alter table doc_collection_item rename constraint doc_list_item_added_by_fkey
  to doc_collection_item_added_by_fkey;

alter index doc_list_household_idx rename to doc_collection_household_idx;
alter index doc_list_item_document_idx rename to doc_collection_item_document_idx;

-- ------------------------------------------------------------- the rules

-- A rule keeps what it says: it names the table and the column by what
-- they are, not by what they are called, so each goes on asking the same.
alter policy doc_list_tenant on doc_collection rename to doc_collection_tenant;
alter policy doc_list_actor on doc_collection rename to doc_collection_actor;
alter policy doc_list_only_me on doc_collection rename to doc_collection_only_me;
alter policy doc_list_changes on doc_collection rename to doc_collection_changes;
alter policy doc_list_item_tenant on doc_collection_item rename to doc_collection_item_tenant;
alter policy doc_list_item_actor on doc_collection_item rename to doc_collection_item_actor;
alter policy doc_list_item_list on doc_collection_item rename to doc_collection_item_collection;

-- ------------------------------------------------------------- the functions

-- Renamed, each is the same function: doc_collection_changes still calls
-- the stranded check, and the trigger still fires the one it fired. The
-- application role keeps its execute on the stranded check.
alter function list_audience_has(text, text) rename to collection_audience_has;
alter function doc_list_stranded(uuid, text) rename to doc_collection_stranded;
alter function doc_list_owner_writes() rename to doc_collection_owner_writes;
alter trigger doc_list_owner_writes on doc_collection rename to doc_collection_owner_writes;

-- A function's body is kept as it was written, old names and all. The
-- stranded check asks the audience's roles by name, so it is written again
-- as it was, asking by the new one; `create or replace` keeps the function,
-- its grant and its owner.
create or replace function doc_collection_stranded(maker uuid, aud text) returns boolean
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce(aud in ('everyone', 'teens', 'adults', 'only_me'), false)
        and app_household() is not null
        and not exists (
              select 1 from account_household ah
               where ah.household_id = app_household()
                 and ah.member_id = maker
                 and collection_audience_has(ah.role, aud)) $$;

-- And the trigger says "collection" when it refuses. Its rules are 0036's,
-- word for word.
create or replace function doc_collection_owner_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() = 'account'
     and (new.owner_member_id is distinct from old.owner_member_id
          or new.household_id is distinct from old.household_id) then
    raise exception 'a collection keeps its maker and its household'
      using errcode = 'insufficient_privilege';
  end if;
  if app_actor() = 'account'
     and not coalesce(old.owner_member_id = app_member(), false)
     and ((to_jsonb(new) - 'deleted_at') is distinct from (to_jsonb(old) - 'deleted_at')
          or old.deleted_at is not null
          or new.deleted_at is null) then
    raise exception 'only its maker changes a collection; an owner may only mark one deleted'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------- nothing left

-- Should anything named for a list have been missed, the upgrade stops
-- here rather than leave half a rename behind.
do $$
declare
  left_over text;
begin
  select string_agg(name, ', ') into left_over from (
    select c.relname::text as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname like 'doc\_list%'
    union all
    select conname::text from pg_constraint where conname like 'doc\_list%'
    union all
    select polname::text from pg_policy where polname like 'doc\_list%'
    union all
    select tgname::text from pg_trigger where tgname like 'doc\_list%'
    union all
    select p.proname::text from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like 'doc\_list%' or p.proname = 'list_audience_has')
    union all
    select a.attname::text from pg_attribute a
     where a.attrelid in ('doc_collection'::regclass, 'doc_collection_item'::regclass)
       and a.attname like '%list%' and not a.attisdropped
  ) named;
  if left_over is not null then
    raise exception 'still named for a list: %', left_over;
  end if;
end $$;
