-- Each version's own details (0.9.0; the owner's word of 7 Nov 2026: "the
-- versions are completely separate copies with separate set of content and
-- metadata but share some uniqueness that binds them together").
--
-- What every version of a document shares stays on `document`: its id,
-- title, person, kind, who sees it, collections, tags, where the original
-- is kept, notes, Essential, No longer needed. What is a version's own —
-- its file and pages, its dates, its number, who issued it and its kind's
-- details — is the document's row for the CURRENT version, as it always
-- was, so reminders, status, search, the table, shares and exports work as
-- before; and, for each version a newer one has replaced, frozen here.
--
--   details_kept_at     when this version's details were frozen onto it:
--                       when a newer version replaced it. Null for the
--                       current version (its details are the document's),
--                       and for one replaced before 0.9.0, whose details
--                       were never kept — nothing is guessed or backfilled.
--   issued_on … issued_by
--                       as the document's own columns, plain, as they are
--                       there (an Only me document's too).
--   extra / extra_sealed
--                       its kind's details: plain, or — on an Only me
--                       document — sealed under its owner's member key,
--                       bound to this version ("version-extra:<id>"),
--                       moved between the two as the document's are when
--                       it is made Only me or seen again.
--   details_unconfirmed this version's details are still the version
--                       before's, copied when it was added, and nobody has
--                       confirmed them for it (Use these, or Edit).
--   renewal_prior       what "Use these" changed (the dates and number it
--   renewal_undo_until  replaced, its derived reminders as they were, and
--                       the last line of the activity log then), for its
--                       Undo, as a batch's new version keeps it (0067);
--                       until when, on the database's clock.

alter table document_version
  add column details_kept_at timestamptz,
  add column issued_on date,
  add column issued_precision date_precision,
  add column expires_on date,
  add column expires_precision date_precision,
  add column identifier text,
  add column issued_by text,
  add column extra jsonb not null default '{}'::jsonb,
  add column extra_sealed bytea,
  add column details_unconfirmed boolean not null default false,
  add column renewal_prior jsonb,
  add column renewal_undo_until timestamptz,
  add constraint version_issued_precision_requires_date
    check ((issued_on is null) = (issued_precision is null)),
  add constraint version_expires_precision_requires_date
    check ((expires_on is null) = (expires_precision is null)),
  -- Kept details only on a version that kept them; never plain and sealed at once.
  add constraint version_details_only_when_kept
    check (details_kept_at is not null
           or (issued_on is null and expires_on is null and identifier is null
               and issued_by is null and extra = '{}'::jsonb and extra_sealed is null)),
  add constraint version_extra_plain_or_sealed
    check (extra_sealed is null or extra = '{}'::jsonb),
  add constraint version_renewal_undo_whole
    check ((renewal_prior is null) = (renewal_undo_until is null));
