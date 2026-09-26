-- Only me notes and details are sealed (iteration 5.9).
--
-- An Only me document's pages have been sealed under its owner's member key
-- since 0007. Its notes and its type's details were not: they sat in plain
-- text in this table, in search_tsv (its notes; 0032 kept its details out)
-- and in every nightly backup. From here they are sealed as its pages are.
--
-- * notes_sealed and extra_sealed hold them, sealed under the owner's
--   member key and bound to the document (@fdv/crypto, private-values.ts).
--   SQL holds no keys, so the documents already Only me are sealed by the
--   worker's private.seal job, one document per transaction, which empties
--   the plain columns; a restore runs it again before the vault opens.
-- * sealed_details names the details that have a value, by key, written
--   while they are open: what an Only me document still needs ("Needs a
--   registration plate") is worked out from it and its type as it is now,
--   without opening anything.
-- * Only an Only me document holds anything sealed. The rule is an
--   allow-list, so a kind of visibility added later holds nothing sealed
--   until somebody says otherwise.
-- * search_tsv is made again with the notes, like the details (0032), only
--   for a document the family or the adults can see: an Only me document's
--   notes leave the index now, before the job has sealed them.
--
-- A migration is nobody's edit: no document's updated_at moves, and no
-- audit event is written.

alter table document add column notes_sealed bytea;
alter table document add column extra_sealed bytea;
alter table document add column sealed_details text[] not null default '{}';

alter table document add constraint sealed_only_private check (
  visibility = 'private'
  or (notes_sealed is null and extra_sealed is null and sealed_details = '{}'));

-- ------------------------------------------------------------------ search

-- As 0032 made it, but for the notes (which 0007 indexed for everybody).
alter table document drop column search_tsv;
alter table document add column search_tsv tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(identifier, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(issued_by, '')), 'B') ||
    setweight(to_tsvector('simple', fdv_tags_text(tags)), 'B') ||
    setweight(case when visibility in ('household', 'adults')
                   then to_tsvector('simple', fdv_details_text(extra))
                   else ''::tsvector end, 'B') ||
    setweight(to_tsvector('simple', coalesce(physical_location, '')), 'C') ||
    setweight(case when visibility in ('household', 'adults')
                   then to_tsvector('simple', coalesce(notes, ''))
                   else ''::tsvector end, 'C')
  ) stored;
create index document_search_idx on document using gin (search_tsv);

-- The last wall: nobody who asks through the API writes an Only me
-- document's notes or details in plain text. The API seals them; an edit
-- that raced a move to Only me, or a path somebody forgets, is refused here
-- rather than kept, and in every backup. A value an older release left is
-- not a new write, so an edit of something else still goes through. The
-- vault itself (system: the worker, whose private.seal only ever empties
-- them) and the owning role's own maintenance (no actor) are not held to it.
create function document_private_plain() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is not null and app_actor() <> 'system' and new.visibility = 'private' and (
       (new.notes is not null
          and (tg_op = 'INSERT' or new.notes is distinct from old.notes))
    or (new.extra is not null and new.extra <> '{}'::jsonb
          and (tg_op = 'INSERT' or new.extra is distinct from old.extra))) then
    raise exception 'an Only me document''s notes and details are kept sealed'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger document_private_plain before insert or update on document
  for each row execute function document_private_plain();
