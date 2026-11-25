-- What a connected app lists or is fed, on each document's own Activity
-- (0.9.0-dev.101).
--
-- 1. A list page or the feed writes an `app.listed` line on every document
--    it hands an app, at most once an app a document a household day: the
--    day, as the vault worked it out, is in the line's detail (`day`).
--    Before writing, the vault asks which of the page's documents already
--    have the day's line from that app: up to a page of documents at once,
--    each with one such line a day for as long as the app keeps reading
--    it. An index of those lines alone, by document, app and day, finds
--    each in one step, without reading every line a document has.
--
-- 2. Taking back what was filed (Undo, 0064 and 0067) is refused once the
--    document has reached anybody but its uploader: a line about it by
--    somebody else among them. A listing is not such a line: an app that
--    polls every few minutes would otherwise make every paper it may read
--    impossible to take back the moment it is filed, though the app was
--    only told it is there. Its details read (`app.read`), its file
--    downloaded, a link made to it, still are. Both checks, as they stand,
--    with `app.listed` left out of the log's lines and nothing else changed.

create index audit_event_app_listed_idx
  on audit_event (object_id, (detail->>'app_id'), (detail->>'day'))
  where action = 'app.listed';

-- 0067's, as it stands, but an app's listing is not reaching anybody.
create or replace function incoming_file_document_reached(p_document uuid) returns boolean
  language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  hh constant uuid := app_household();
  acct constant uuid := app_account();
  born timestamptz;
begin
  if app_actor() is distinct from 'account'
     or not exists (select 1 from incoming_file f
                     where f.household_id = hh
                       and f.document_id = p_document
                       and f.state = 'accepted'
                       and f.batch_id is not null
                       and not f.as_version
                       and f.undo_until > now()
                       and f.decided_by = acct
                       and f.requester_member_id = app_member()) then
    return null;
  end if;
  select d.created_at into born from document d where d.id = p_document;
  -- Every row its removal would take, held first, each table in its key's order.
  perform 1 from document_version where document_id = p_document order by id for update;
  perform 1 from reminder where document_id = p_document order by id for update;
  perform 1 from doc_collection_item where document_id = p_document
   order by collection_id for update;
  perform 1 from share_link_item where document_id = p_document order by share_id for update;
  perform 1 from share_page where document_id = p_document
   order by share_id, version_id, n for update;
  perform 1 from share_page_failure where document_id = p_document
   order by share_id, version_id for update;
  perform 1 from share_session_use where document_id = p_document
   order by session_id, kind for update;
  perform 1 from document_link where a = p_document or b = p_document order by a, b for update;
  perform 1 from private_notice where document_id = p_document order by member_id for update;
  perform 1 from document_text where document_id = p_document order by version_id for update;
  perform 1 from document_text_sealed where document_id = p_document
   order by version_id for update;
  perform 1 from offline_fill o
   where o.version_id in (select v.id from document_version v where v.document_id = p_document)
   order by o.session_id, o.version_id for update;
  perform 1 from upload_idempotency where document_id = p_document
   order by idempotency_key for update;
  -- Then the log, as appendAudit takes it.
  perform pg_advisory_xact_lock(hashtext('audit:' || hh::text));
  return exists (select 1 from share_link l where l.document_id = p_document)
      or exists (select 1 from share_link_item t
                  where t.document_id = p_document and t.kind <> 'left_out')
      or exists (select 1 from share_page s where s.document_id = p_document)
      or exists (select 1 from share_page_failure s where s.document_id = p_document)
      or exists (select 1 from audit_event e
                  where e.household_id = hh
                    and e.object_type = 'document' and e.object_id = p_document
                    and e.action <> 'app.listed'
                    and (e.actor_account_id is distinct from acct or e.actor_label is not null))
      -- Its reminders snoozed or acknowledged by somebody else (N2).
      or exists (select 1 from audit_event e
                  where e.household_id = hh
                    and e.object_type = 'reminder'
                    and e.object_id in (select m.id from reminder m
                                         where m.document_id = p_document)
                    and (e.actor_account_id is distinct from acct or e.actor_label is not null))
      or exists (select 1 from doc_collection_item i
                  where i.document_id = p_document and i.added_by is distinct from acct)
      or exists (select 1 from reminder m
                  where m.document_id = p_document and m.created_by is not null
                    and m.created_by <> acct)
      or exists (select 1 from document_link k where k.a = p_document or k.b = p_document)
      -- An export of the vault by somebody else, begun since it was filed:
      -- it may hold the document (the I3 check, N8).
      or exists (select 1 from export x
                  where x.household_id = hh
                    and x.requested_by is distinct from acct
                    and x.created_at >= born);
end $$;

-- 0067's, as it stands, but an app's listing is not reaching anybody.
create or replace function incoming_file_version_reached(p_version uuid) returns boolean
  language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  hh constant uuid := app_household();
  acct constant uuid := app_account();
  doc uuid;
  since timestamptz;
  since_line bigint;
  no int;
begin
  if app_actor() is distinct from 'account' then
    return null;
  end if;
  select f.document_id, f.decided_at into doc, since
    from incoming_file f
   where f.household_id = hh
     and f.version_id = p_version
     and f.state = 'accepted'
     and f.batch_id is not null
     and f.as_version
     and f.undo_until > now()
     and f.decided_by = acct
     and f.requester_member_id = app_member();
  if doc is null then
    return null;
  end if;
  select v.version_no into no from document_version v where v.id = p_version;
  -- Every row that goes with the version, held first; and the document's reminders.
  perform 1 from reminder where document_id = doc order by id for update;
  perform 1 from share_page where version_id = p_version
   order by share_id, version_id, n for update;
  perform 1 from share_page_failure where version_id = p_version
   order by share_id, version_id for update;
  perform 1 from document_text where version_id = p_version for update;
  perform 1 from document_text_sealed where version_id = p_version for update;
  perform 1 from offline_fill where version_id = p_version
   order by session_id, version_id for update;
  perform 1 from upload_idempotency where version_id = p_version
   order by idempotency_key for update;
  -- Then the log, as appendAudit takes it.
  perform pg_advisory_xact_lock(hashtext('audit:' || hh::text));
  -- The line that said it was added, by them: everything after it is since.
  select max(e.id) into since_line
    from audit_event e
   where e.household_id = hh
     and e.object_type = 'document' and e.object_id = doc
     and e.action = 'document.version_added'
     and e.actor_account_id = acct
     and (e.detail ->> 'version_no')::int = no;
  if since_line is null then
    return true;
  end if;
  return exists (select 1 from share_page s where s.version_id = p_version)
      or exists (select 1 from share_page_failure s where s.version_id = p_version)
      or exists (select 1 from offline_fill o
                   join session s on s.id = o.session_id
                  where o.version_id = p_version and s.account_id is distinct from acct)
      or exists (select 1 from share_link l where l.document_id = doc and l.created_at >= since)
      or exists (select 1 from share_session_use u where u.document_id = doc and u.used_at >= since)
      or exists (select 1 from audit_event e
                  where e.household_id = hh and e.id > since_line
                    and e.object_type = 'document' and e.object_id = doc
                    and e.action <> 'app.listed'
                    and (e.actor_account_id is distinct from acct or e.actor_label is not null))
      or exists (select 1 from audit_event e
                  where e.household_id = hh and e.id > since_line
                    and e.object_type = 'reminder'
                    and e.object_id in (select m.id from reminder m where m.document_id = doc)
                    and (e.actor_account_id is distinct from acct or e.actor_label is not null))
      or exists (select 1 from doc_collection_item i
                  where i.document_id = doc and i.added_at >= since
                    and i.added_by is distinct from acct)
      or exists (select 1 from reminder m
                  where m.document_id = doc and m.created_at >= since
                    and m.created_by is not null and m.created_by <> acct)
      or exists (select 1 from export x
                  where x.household_id = hh
                    and x.requested_by is distinct from acct
                    and (x.created_at >= since or x.state in ('queued', 'running')));
end $$;
