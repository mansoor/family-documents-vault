-- No longer needed (0.9.0; the owner's ask of 23 Oct 2026): a document kept,
-- found and shared as ever, whose expiry no longer says anything — an EAD
-- card made unnecessary by a green card. Not Superseded (S1), which is the
-- same paper renewed: this is a paper something else made unnecessary.
--
--   no_longer_needed_at / _by   when it was marked, and whose sign-in did
--                               it: somebody signed in marks as themselves,
--                               now. A sign-in removed takes the name off,
--                               not the moment.
--   no_longer_needed_reason     why, in up to 200 characters, plain; or,
--   no_longer_needed_reason_sealed  on an Only me document, sealed under its
--                               owner's member key where its notes are
--                               (0033, binding "no-longer-needed:<id>") —
--                               never both, never plain on one, never sealed
--                               on another.
--   replaced_by                 the document that took its place, one the
--                               marker could see; it goes (null) with that
--                               document when it is removed for good.
--
-- Who marks it, or marks it needed again: whoever may change it — an owner
-- or an adult who can see it, a teen only their own — as the API asks first,
-- and this holds for whatever else writes (document_no_longer_needed_rule).
-- What it points to as its replacement is one they can see. The vault
-- itself (system) and the owning role (a restore, the migrations) are not
-- held to it.
--
-- While it is marked it has no open reminder (scheduled, due or snoozed):
-- the API resolves them as it marks, makes none, and the worker's scan
-- passes it by; and nothing writes one open (reminder_not_for_unneeded).

alter table document
  add column no_longer_needed_at timestamptz,
  add column no_longer_needed_by uuid references account(id) on delete set null,
  add column no_longer_needed_reason text,
  add column no_longer_needed_reason_sealed bytea,
  add column replaced_by uuid references document(id) on delete set null,
  add constraint document_no_longer_needed_whole
    check (no_longer_needed_by is null or no_longer_needed_at is not null),
  -- Why, and by what, only while it is marked.
  add constraint document_no_longer_needed_details
    check (no_longer_needed_at is not null
           or (no_longer_needed_reason is null
               and no_longer_needed_reason_sealed is null
               and replaced_by is null)),
  add constraint document_no_longer_needed_reason_length
    check (no_longer_needed_reason is null
           or char_length(no_longer_needed_reason) between 1 and 200),
  -- Sealed on an Only me document, and plain on no other.
  add constraint document_no_longer_needed_reason_sealed
    check ((no_longer_needed_reason is null or visibility <> 'private')
           and (no_longer_needed_reason_sealed is null or visibility = 'private')),
  add constraint document_not_replaced_by_itself
    check (replaced_by is distinct from id);

create index document_replaced_by_idx on document (replaced_by) where replaced_by is not null;

-- Whether the caller, signed in, sees document `d` as every list does
-- (seenDocument in the API): Everyone's, Adults only for an owner or an
-- adult, Only me for its owner. A restricted viewer's grant is the row
-- rules' (0054), applied to whatever this reads.
create function document_seen_by_caller(
  p_visibility visibility,
  p_owner uuid
) returns boolean
  language sql stable parallel safe
  set search_path = pg_catalog, public, pg_temp as
  $$ select case p_visibility
              when 'household' then true
              when 'adults' then coalesce(app_role() in ('owner', 'adult'), false)
              when 'private' then coalesce(p_owner = app_member(), false)
              else false
            end $$;

create function document_no_longer_needed_rule() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.no_longer_needed_at is not null or new.replaced_by is not null then
      raise exception 'a document is marked no longer needed once it is in the vault'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  -- Nothing of it changed.
  if (new.no_longer_needed_at, new.no_longer_needed_by, new.no_longer_needed_reason,
      new.no_longer_needed_reason_sealed, new.replaced_by)
     is not distinct from
     (old.no_longer_needed_at, old.no_longer_needed_by, old.no_longer_needed_reason,
      old.no_longer_needed_reason_sealed, old.replaced_by) then
    return new;
  end if;
  -- A foreign key's own cascade: the sign-in that marked it removed, or the
  -- document that replaced it removed for good (by an owner who need not
  -- see this one). Only that column, to null: every other the same, but the
  -- generated ones, which a BEFORE trigger is not given yet.
  if pg_trigger_depth() > 1
     and ((new.no_longer_needed_by is null and old.no_longer_needed_by is not null
           and (to_jsonb(new) - array['no_longer_needed_by', 'search_tsv', 'tag_keys', 'tag_labels'])
               = (to_jsonb(old) - array['no_longer_needed_by', 'search_tsv', 'tag_keys', 'tag_labels']))
          or (new.replaced_by is null and old.replaced_by is not null
              and (to_jsonb(new) - array['replaced_by', 'search_tsv', 'tag_keys', 'tag_labels'])
                  = (to_jsonb(old) - array['replaced_by', 'search_tsv', 'tag_keys', 'tag_labels']))) then
    return new;
  end if;
  -- Whoever may change it, and sees it: an owner or an adult, a teen only
  -- their own. (Its reason moving between plain and sealed as it is made
  -- Only me or seen again is a write by whoever may change who sees it,
  -- which is somebody who may change it: held here too.)
  if coalesce(app_role() not in ('owner', 'adult', 'teen'), true)
     or (app_role() = 'teen' and old.owner_member_id is distinct from app_member())
     or not document_seen_by_caller(old.visibility, old.owner_member_id) then
    raise exception 'only whoever may change a document marks it no longer needed, or needed again'
      using errcode = 'insufficient_privilege';
  end if;
  -- Marked (or marked again by somebody else): as themselves, now.
  if new.no_longer_needed_at is not null
     and (old.no_longer_needed_at is null
          or new.no_longer_needed_at is distinct from old.no_longer_needed_at
          or new.no_longer_needed_by is distinct from old.no_longer_needed_by)
     and (new.no_longer_needed_by is distinct from app_account()
          or new.no_longer_needed_at is distinct from now()) then
    raise exception 'a document is marked no longer needed by whoever marks it, as they mark it'
      using errcode = 'insufficient_privilege';
  end if;
  -- What replaced it: another document in the vault, out of the Trash, that
  -- they can see — the row rules too, for whoever is restricted.
  if new.replaced_by is not null and new.replaced_by is distinct from old.replaced_by
     and not exists (select 1 from document d
                      where d.id = new.replaced_by
                        and d.household_id = new.household_id
                        and d.deleted_at is null
                        and document_seen_by_caller(d.visibility, d.owner_member_id)) then
    raise exception 'a document is replaced by one its marker can see'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger document_no_longer_needed_rule before insert or update on document
  for each row execute function document_no_longer_needed_rule();

-- No reminder of a document marked no longer needed is open, whoever
-- writes it — made, snoozed again, put back by an Undo, or by the owning
-- role. With the owner's rights, so it holds for a caller the row rules
-- would not show the document to; and so that it tells such a caller
-- nothing (the review, I4), somebody signed in writes an open reminder only
-- for a document they can see — refused alike, marked or not, for any
-- other. A trigger's function, which nothing can call but its trigger.
create function reminder_not_for_unneeded() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  d record;
begin
  if new.document_id is null
     or new.status not in ('scheduled', 'due', 'snoozed')
     or not (tg_op = 'INSERT' or old.status is distinct from new.status
             or old.document_id is distinct from new.document_id
             or old.fire_at is distinct from new.fire_at
             or old.snoozed_until is distinct from new.snoozed_until) then
    return new;
  end if;
  select doc.visibility, doc.owner_member_id, doc.no_longer_needed_at
    into d
    from document doc
   where doc.id = new.document_id and doc.household_id = new.household_id;
  if not found then
    return new;
  end if;
  if app_actor() = 'account'
     and not document_seen_by_caller(d.visibility, d.owner_member_id) then
    raise exception 'a reminder is only for a document its writer can see'
      using errcode = 'insufficient_privilege';
  end if;
  if d.no_longer_needed_at is not null then
    raise exception 'a document that is no longer needed is reminded of nothing'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger reminder_not_for_unneeded before insert or update on reminder
  for each row execute function reminder_not_for_unneeded();
