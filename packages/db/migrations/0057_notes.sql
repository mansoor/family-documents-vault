-- Notes you can write (iteration 5.35, A30, A31, A32).
--
-- A document has one note (A30), written in a small Markdown that each app
-- draws as its own elements, never as HTML (@fdv/shared, notes.ts). What the
-- note says stays where it always was: `notes`, or sealed under its owner's
-- key in `notes_sealed` for an Only me document (0033, A31). This adds who
-- last changed its words, and when:
--
--   notes_updated_at   when the words last changed: written, changed or
--                      taken away. Only the words move it — the API compares
--                      them, as it holds them open — so an edit to anything
--                      else, the same words saved again, a move to or from
--                      Only me, or the private.seal job leaves it alone.
--   notes_updated_by   whose sign-in changed them; kept with the line in the
--                      activity log (`document.notes_changed`), which never
--                      holds the words.
--
-- Who may read them is who may read the row: the document's rules already
-- decide that, for every kind of caller (0030) and for a restricted viewer
-- (0054), row by row, and these are two more of its columns. Nothing new is
-- given to anybody: `updated_by` beside them has said as much since 0006,
-- and the API names the person only to those the activity log names them
-- to (a viewer is told the moment alone). A share link reads its document's
-- row, as before, and is handed neither.
--
-- What the database holds to, whoever writes: somebody signed in stamps a
-- note as themselves and now — never in another's name, nor at another
-- time — and a stamp never names somebody without a moment. The vault
-- itself (a restore, a migration) is not asked.
--
-- The function puts pg_temp last in its path.

alter table document
  add column notes_updated_at timestamptz,
  add column notes_updated_by uuid references account(id) on delete set null,
  -- A sign-in removed takes its name off the stamp, not the moment.
  add constraint document_notes_stamp_whole
    check (notes_updated_by is null or notes_updated_at is not null);

create function document_notes_stamp() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  stamped boolean;
begin
  if tg_op = 'INSERT' then
    stamped := new.notes_updated_by is not null or new.notes_updated_at is not null;
  else
    -- A new moment, or a new name. A name taken off (its sign-in removed,
    -- the foreign key's own update) is neither.
    stamped := new.notes_updated_at is distinct from old.notes_updated_at
               or (new.notes_updated_by is not null
                   and new.notes_updated_by is distinct from old.notes_updated_by);
  end if;
  if stamped and app_actor() = 'account'
     and (new.notes_updated_by is distinct from app_account()
          or new.notes_updated_at is distinct from now()) then
    raise exception 'a note is stamped by whoever changed it, as they change it'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger document_notes_stamp before insert or update on document
  for each row execute function document_notes_stamp();
