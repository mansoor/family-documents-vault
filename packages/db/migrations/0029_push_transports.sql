-- UnifiedPush beside Web Push (iteration 4.13).
--
-- The phone app gets its notifications through the person's own push
-- distributor (ntfy and the like), not Google's: a UnifiedPush endpoint is
-- a Web Push endpoint by another name, encrypted the same way (RFC 8291)
-- with the vault's VAPID keys, so it lives in the same table as a new kind.
-- What it is sent carries no titles and no names — a count, a date, a word
-- saying what happened — because the distributor and every server between
-- can read the envelope's timing, and the phone asks the vault for the rest.
--
-- * device.kind: 'unified_push' joins the kinds a row may be.
-- * device.installation_id: which app installation registered it, so a
--   phone that signs in again replaces its row rather than adding one.
-- * device.consecutive_failures: transient failures (429, 5xx, no answer)
--   count up; the tenth in a row marks the device failed, and one success
--   resets it. A 404 or 410 deletes the row at once; 400, 401, 403 or 413
--   mark it failed at once.
alter table device drop constraint device_kind_check;
alter table device
  add constraint device_kind_check check (kind in ('web_push', 'unified_push', 'apns', 'fcm')),
  add column installation_id uuid,
  add column consecutive_failures int not null default 0;
