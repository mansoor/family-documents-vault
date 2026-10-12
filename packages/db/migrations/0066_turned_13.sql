-- Owners reminded when somebody turns 13 (after 0.7.0, inviting family
-- members to sign up).
--
-- An under-13 is a family profile with no sign-in of their own. The day
-- they turn 13 — on the household's calendar — the owners are told once,
-- in Needs attention and in their daily digest: "Sara is 13 today. They
-- can now have their own sign-in." It is a reminder like any other: made
-- and fallen due by the worker's reminders.tick, delivered once by
-- reminders.deliver (the ledger, reminder_delivery), and done with when an
-- owner dismisses it (acknowledged). What is new is what it is about: a
-- person, not a document. So:
--
--   kind       'turned_13', beside 'derived' and 'manual';
--   member_id  the person it is about (with the household, as every row
--              naming a person does), and document_id null — one or the
--              other, never both;
--
-- one for each person, ever (reminder_turned_13): a 13th birthday comes
-- once, and a dismissed reminder is not made again.
--
-- It is the owners' alone: an adult, a teen and a viewer are given none of
-- them, read or written, whatever they ask. The vault itself (the worker)
-- and the owners are. That is said in the reminders' own rule for each kind
-- of caller (reminder_actor, 0030), not in a rule beside it: a second rule
-- asking who is asking would let a restore's check go on passing with the
-- first one gone. Who is given a reminder about a document is as it was.
--
-- A reminder's deliveries (reminder_delivery: its id, the day and the
-- channel) follow it: somebody signed in is given those of the reminders
-- they are given, and no other — before, every one in the household. They
-- name no person and no document, but they say that a reminder the reader
-- cannot see was sent, and when (the review, INV-8).
--
-- Every query that lists or delivers a document's reminders joins its
-- document, so none of them ever meets one of these.

alter table reminder add column member_id uuid;
alter table reminder
  add constraint reminder_member_fk foreign key (member_id, household_id)
    references member (id, household_id) on delete cascade;
alter table reminder alter column document_id drop not null;

alter table reminder drop constraint reminder_kind_check;
alter table reminder
  add constraint reminder_kind_check check (kind in ('derived', 'manual', 'turned_13'));

-- About a document, or about a person: one of them.
alter table reminder
  add constraint reminder_about_one check (
    case kind
      when 'turned_13' then document_id is null and member_id is not null
      else document_id is not null and member_id is null
    end);

create unique index reminder_turned_13 on reminder (household_id, member_id)
  where kind = 'turned_13';

-- The owners' alone: read, made, changed and removed by an owner or by the
-- vault, never by anybody else signed in; a document's, as before.
alter policy reminder_actor on reminder
  using (case app_actor()
           when 'account' then member_id is null or app_role() = 'owner'
           when 'system' then true
           else false
         end);

-- Its deliveries, as the reminder is given.
alter policy reminder_delivery_actor on reminder_delivery
  using (case app_actor()
           when 'account' then reminder_id in (select r.id from reminder r)
           when 'system' then true
           else false
         end);
