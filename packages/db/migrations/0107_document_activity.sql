-- A document's activity (0.9.0, DA): the lines about one document, and
-- those of the collections' links that gave it.
--
-- A document's own lines are found by audit_event_document_idx (0074). A
-- collection's link's own lines — made, opened, a ZIP downloaded, emailed,
-- taken back — are written about its collection (object_type
-- 'collection'), naming the link in their detail, and no index reached
-- them: finding them meant reading the household's whole log. They are
-- found by the link, newest first, in the stretch it gave the document.
create index audit_event_share_idx on audit_event ((detail->>'share_id'), id)
  where object_type = 'collection';

-- A removed collection's link that gave a document (0106's tombstone),
-- found by the document.
create index share_link_tombstone_documents_idx on share_link_tombstone
  using gin (document_ids);
