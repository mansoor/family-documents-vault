-- Pages the vault draws (iteration 4.7).
--
-- The vault renders each page of a version as a JPEG, 1600 px on the long
-- edge, encrypted under the version's own file key and stored beside it
-- (`<storage_key>.p<n>.enc`). Clients show these instead of rendering a
-- PDF themselves: the web's reading view pages through them, and the
-- phone keeps them for offline Essentials.
--
-- * preview_state says where a version's pages are:
--     none         not asked for yet (rendered on first request);
--     queued       a job is on its way (preview_requested_at says when);
--     ready        preview_pages pages are stored;
--     unsupported  a kind of file the vault cannot draw (DOCX, XLSX…);
--     failed       it tried and could not; the file itself is unaffected.
-- * preview_pages is how many pages have a preview: at most 30, the rest
--   are opened by saving a copy. Null until known.
-- * Essentials are drawn eagerly: after processing, when a document
--   becomes Essential, and by a backfill when the worker starts.

alter table document_version add column preview_pages smallint;
alter table document_version add column preview_state text not null default 'none'
  check (preview_state in ('none', 'queued', 'ready', 'unsupported', 'failed'));
alter table document_version add column preview_requested_at timestamptz;
