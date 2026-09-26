-- A rule for each kind of caller (iteration 5.6).
--
-- Since 5.5 every transaction tells the database who is asking: app.actor
-- is 'account', 'system', 'link', 'upload' or 'anonymous', with the member,
-- role, share or upload request it is for. Until now nothing read it. These
-- policies do, on the document and every table that hangs off it, so what a
-- caller is given no longer rests on the application's checks alone:
--
--   account    what the application's own rules allow: every row here.
--              5.32 narrows it for a viewer given only some documents.
--   system     every row: the worker's jobs, and the API's few lookups
--              before a caller is known (withSystem, on an allow-list).
--   link       reads the one document its share was made for, the newest
--              version of its file, and the share itself: only while the
--              share is live (not taken back, not expired, not locked by
--              wrong PINs), its maker can still see the document, and the
--              document is not in the Trash — the checks shares.ts makes on
--              every open, made here too. Not the document's text,
--              reminders or links to other documents, and never another
--              document of the household. It writes only its own share's
--              counts of opens and wrong PINs, and only upwards: it adds,
--              changes and takes away nothing else. 5.19 adds the items of
--              a list share.
--   upload     nothing. 5.21 gives it tables of its own.
--   anonymous  nothing: a sign-in, invitation or reset page has no business
--              with documents.
--   no actor   nothing.
--
-- * Each policy is RESTRICTIVE, so it is ANDed with the table's tenant
--   policy: the household is still the first wall, and this is a second.
-- * Each rule is an allow-list, `case app_actor() when ... else false end`,
--   never `<>` or `not in`. Once a pooled connection has run a scope, an
--   unset setting reads as '' rather than NULL, and a deny-list would let ''
--   through. The functions below read '' as NULL, as app_household() does,
--   and NULL matches no `when`.
-- * With no WITH CHECK, a policy's rule applies to the rows written as well
--   as to the rows read.
-- * The page previews (0027) are columns of document_version, and covered
--   with it.
-- * A live share's own row stays writable by its link: a wrong PIN must
--   still be counted. A trigger keeps that write to the counts.
-- * Every function here that runs with the owner's rights puts pg_temp last
--   in its path, so a temporary table cannot stand in for one it reads; the
--   older ones are brought in line at the end.

create function app_actor() returns text
  language sql stable parallel safe as
  $$ select nullif(current_setting('app.actor', true), '')::text $$;

create function app_member() returns uuid
  language sql stable parallel safe as
  $$ select nullif(current_setting('app.member_id', true), '')::uuid $$;

create function app_role() returns text
  language sql stable parallel safe as
  $$ select nullif(current_setting('app.role', true), '')::text $$;

create function app_share() returns uuid
  language sql stable parallel safe as
  $$ select nullif(current_setting('app.share_id', true), '')::uuid $$;

create function app_upload_request() returns uuid
  language sql stable parallel safe as
  $$ select nullif(current_setting('app.upload_request_id', true), '')::uuid $$;

-- The document the asking link was made for, while the link is live, its
-- maker can still see the document and the document is not in the Trash;
-- otherwise null. These are ShareService.live()'s checks (shares.ts): 10 is
-- its MAX_PIN_ATTEMPTS, and the visibility case is canSee() with the roles
-- of document.see_adults (packages/shared/src/roles.ts). Change them
-- together. It reads with the owner's rights, as share_link_household()
-- does: share_link's rule needs document and document's rule needs
-- share_link, and a policy that reads a table whose policy reads it back is
-- refused as recursion.
create function app_shared_document() returns uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.document_id
       from share_link s
       join document d on d.id = s.document_id
       join account_household maker
         on maker.account_id = s.created_by and maker.household_id = s.household_id
      where s.id = app_share()
        and s.household_id = app_household()
        and s.revoked_at is null
        and s.expires_at > now()
        and s.attempts < 10
        and d.deleted_at is null
        and case d.visibility
              when 'household' then true
              when 'adults' then maker.role in ('owner', 'adult')
              when 'private' then d.owner_member_id = maker.member_id
              else false
            end $$;
grant execute on function app_shared_document() to fdv_app;

-- The newest version of that document's file: the one the share page gives.
create function app_shared_version() returns uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select v.id
       from document_version v
      where v.document_id = app_shared_document()
      order by v.version_no desc
      limit 1 $$;
grant execute on function app_shared_version() to fdv_app;

-- ------------------------------------------------------------ the document

create policy document_actor on document as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then id = (select app_shared_document())
           else false
         end);

-- Its file, one row per version; a link is given the newest.
create policy document_version_actor on document_version as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then id = (select app_shared_version())
           else false
         end);

-- A link sees its own share, and no other made for the same document.
create policy share_link_actor on share_link as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'link' then id = app_share() and document_id = (select app_shared_document())
           else false
         end);

-- What a link may change on its own share: its counts of opens (and when)
-- and of wrong PINs, each only upwards. When it ends, its PIN and whom it
-- is for are the sharer's. A rule cannot say which columns change, so a
-- trigger does; it compares every column but those three, so a column
-- added later is the sharer's too.
create function share_link_link_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() = 'link' and (
       (to_jsonb(new) - array['open_count', 'last_opened_at', 'attempts'])
         is distinct from (to_jsonb(old) - array['open_count', 'last_opened_at', 'attempts'])
       or new.open_count < old.open_count
       or new.attempts < old.attempts) then
    raise exception 'a share link may only count its opens and wrong PINs'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger share_link_link_writes before update on share_link
  for each row execute function share_link_link_writes();

-- A link reads: adding, changing or taking away a document, a file or a
-- share is for somebody signed in, or the vault itself. The one write a
-- link makes is to its own share's row (share_link_actor above), and an
-- insert there is refused by that rule already: a new share has another id.

create policy document_actor_insert on document as restrictive for insert
  with check (case app_actor() when 'account' then true when 'system' then true else false end);
create policy document_actor_update on document as restrictive for update
  using (case app_actor() when 'account' then true when 'system' then true else false end);
create policy document_actor_delete on document as restrictive for delete
  using (case app_actor() when 'account' then true when 'system' then true else false end);

create policy document_version_actor_insert on document_version as restrictive for insert
  with check (case app_actor() when 'account' then true when 'system' then true else false end);
create policy document_version_actor_update on document_version as restrictive for update
  using (case app_actor() when 'account' then true when 'system' then true else false end);
create policy document_version_actor_delete on document_version as restrictive for delete
  using (case app_actor() when 'account' then true when 'system' then true else false end);

create policy share_link_actor_delete on share_link as restrictive for delete
  using (case app_actor() when 'account' then true when 'system' then true else false end);

-- ------------------------------------------- the family's, not a link's

-- What is written on the document's pages; sealed for an Only me one.
create policy document_text_actor on document_text as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

create policy document_text_sealed_actor on document_text_sealed as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

-- A reminder's note and its deliveries are the household's.
create policy reminder_actor on reminder as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

create policy reminder_delivery_actor on reminder_delivery as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

-- A link between two documents names the other one.
create policy document_link_actor on document_link as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

-- A phone's copy of a version, and who has been told a document is Only me.
create policy offline_fill_actor on offline_fill as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

create policy private_notice_actor on private_notice as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

-- A capture's retry guard, which names the document it made.
create policy upload_idempotency_actor on upload_idempotency as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

-- A household's export: the whole archive, and the key to it.
create policy export_actor on export as restrictive
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           else false
         end);

-- ------------------------------------- the owner's rights, pg_temp last

alter function setup_complete() set search_path = pg_catalog, public, pg_temp;
alter function vault_display_name() set search_path = pg_catalog, public, pg_temp;
alter function invitation_household(bytea) set search_path = pg_catalog, public, pg_temp;
alter function share_link_household(bytea) set search_path = pg_catalog, public, pg_temp;
alter function assert_owner_remains() set search_path = pg_catalog, public, pg_temp;
