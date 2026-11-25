-- The documents somebody opened most recently (0.9.0-dev.102): Home's
-- Recent, its Opened tab.
--
--   document_recent_open  one row a person and document: when they last
--                         opened it — its own page, or beside the list —
--                         as their app said when it opened it (POST
--                         /me/recently-opened). Opened again, its time is
--                         moved on; the newest 50 of a person's are kept.
--
-- Why a table, not the activity log: opening a document's page writes no
-- line there. `document.viewed` is written for each page of its file drawn
-- on screen, and only for a file the vault draws: a document with no file,
-- or one it cannot draw, would never be in the list, and one whose pages a
-- preview drew would be, though nobody opened it. Only the app knows that
-- its person opened a document, and nothing else it fetched in the
-- background — a list, a search, a ⋯ getting ready — is an open.
--
-- It is its person's alone, as their cabinet is (0097, 0099): nobody else
-- is given a row of it — an owner, another adult, a share link, an upload
-- link, a signed-out page, a connected app or a caller who says nothing —
-- and nobody writes anybody else's.
--
-- A row never says more than its person may open: the API reads it only
-- joined to its document under the reader's own rules (row-level security,
-- and the list's rule for Adults only, Only me and a caregiver's grant),
-- out of the Trash, and leaves notes out. When the paper is made Only me by
-- somebody else, kept to the adults from a teen, a grant ends or it goes to
-- the Trash, it is no longer listed, and comes back if that changes; the
-- row is kept until the paper is removed for good, which takes it with it
-- (the foreign key below), or until 50 newer opens push it out. Their
-- person gone from the household, their rows go with them.
--
-- A migration is nobody's edit: no audit event is written.

create table document_recent_open (
  household_id uuid not null references household(id) on delete cascade,
  member_id    uuid not null,
  document_id  uuid not null,
  opened_at    timestamptz not null default now(),
  primary key (member_id, document_id),
  -- Their person gone, their opens go with them.
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade,
  -- The paper removed for good (5.24), its opens go with it.
  foreign key (document_id, household_id) references document (id, household_id) on delete cascade
);
-- A person's newest first, as Home asks for them.
create index document_recent_open_newest_idx on document_recent_open (member_id, opened_at desc);
-- A paper removed for good finds its rows in one step.
create index document_recent_open_document_idx on document_recent_open (document_id);

alter table document_recent_open enable row level security;

create policy document_recent_open_tenant on document_recent_open
  using (household_id = app_household()) with check (household_id = app_household());

-- Its person signed in, and the vault; nobody else. With no WITH CHECK the
-- rule holds for what is written too: a person writes only their own.
create policy document_recent_open_actor on document_recent_open as restrictive
  using (case app_actor()
           when 'account' then member_id = app_member()
           when 'system' then true
           else false
         end);

-- Nothing of it, read or written, while a transaction acts for an app (0110).
create policy document_recent_open_no_app on document_recent_open as restrictive for all
  using ((select current_setting('app.actor', true)) is distinct from 'connected_app')
  with check ((select current_setting('app.actor', true)) is distinct from 'connected_app');
