-- Connected apps file automatically (0.9.0, APP4).
--
-- An owner may switch on, per app, "File when everything is sure and
-- complete" (connected_app.auto_file, there since 0109), or switch it on
-- for a backfill's window alone (backfill_auto_file). The worker, having
-- read an item such an app sent, asks the API to file it; the API files it
-- only if it is still Ready and sure, as its person, checking all of it
-- again.
--
-- A send its person took back with Undo after it was filed — by Accept all
-- Ready or by itself, the Undo is one and the same — is never filed
-- automatically again: they chose to look at it. The database keeps that,
-- as it follows the Inbox item, so no Undo can forget to.

alter table connected_app_intake
  add column auto_file_held boolean not null default false;

-- 0110's, as it stands, and (APP4) a send taken back by an Undo held from
-- filing automatically.
create or replace function connected_app_intake_follows() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.state = 'received' then
      update connected_app_intake
         set state = 'removed', removed_reason = 'expired', decided_at = now(), hints_sealed = null
       where incoming_file_id = old.id and state = 'waiting';
    end if;
    return old;
  end if;
  if new.state = 'accepted' and old.state = 'received' then
    update connected_app_intake
       set state = 'filed', document_id = new.document_id, version_id = new.version_id,
           made_document = not new.as_version,
           decided_at = now(), hints_sealed = null
     where incoming_file_id = new.id and state = 'waiting';
  elsif new.state = 'rejected' and old.state = 'received' then
    update connected_app_intake
       set state = 'removed', removed_reason = 'declined', decided_at = now(), hints_sealed = null
     where incoming_file_id = new.id and state = 'waiting';
  elsif new.state = 'received' and old.state = 'accepted' then
    -- Taken back by an Undo: waiting again, as if never filed — nor let go
    -- of, so filing it again gives the app its document — and never filed
    -- automatically again.
    update connected_app_intake
       set state = 'waiting', document_id = null, version_id = null, decided_at = null,
           made_document = false, unlinked_at = null, auto_file_held = true
     where incoming_file_id = new.id and state = 'filed';
  end if;
  return new;
end $$;
