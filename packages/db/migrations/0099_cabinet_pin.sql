-- Pins in somebody's cabinet (0.9.0, C2; the owner's idea 7 of 13 Nov 2026):
-- a paper a person pins into one of their own folders by hand, for papers
-- that fit no folder's question ("that one letter about the house").
--
--   cabinet_pin   one row a person, folder and paper. The folder is one of
--                 the person's own layout (cabinet_layout, 0097), by its id
--                 there; the paper is the household's document.
--
-- A pin is its person's own arrangement, never a write to the paper: a
-- caregiver may pin a paper a grant lets them read, a viewer one they are
-- given. It is theirs alone, as their layout is: nobody else is given a row
-- of it — an owner, another adult, a share link, an upload link, a
-- signed-out page or a caller who says nothing — and nobody writes
-- anybody else's.
--
-- A pin never says more than its person may open: the API reads a pin only
-- joined to its document under the reader's own rules (row-level security,
-- and the list's rule for Adults only, Only me and a caregiver's grant), out
-- of the Trash. When the paper is made Only me by somebody else, kept to the
-- adults from a teen, a grant ends or the paper goes to the Trash, the pin
-- shows and counts no more, and says nothing; it is kept, as the paper is,
-- until the paper is removed for good, which takes its pins with it (the
-- foreign key below), or the person unpins it. Their layout gone — they
-- left the household — their pins go with it.
--
-- Why a table, not ids in the layout's JSON: a paper removed for good must
-- take its pins with it, and only a foreign key does that for every way a
-- paper is removed (the purge job, a household deleted, a restore); a pin
-- is written one at a time, beside the layout's version, never racing a
-- whole layout's save; and the database keeps each row its person's, as it
-- keeps their layout.

create table cabinet_pin (
  household_id uuid not null references household(id) on delete cascade,
  member_id    uuid not null,
  -- A folder of the person's layout, by its id there (`CABINET_NODE_ID`).
  folder_id    text not null
                 constraint cabinet_pin_folder_id check (folder_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  document_id  uuid not null,
  pinned_at    timestamptz not null default now(),
  primary key (household_id, member_id, folder_id, document_id),
  -- Their layout gone (their person left), their pins go with it.
  foreign key (household_id, member_id)
    references cabinet_layout (household_id, member_id) on delete cascade,
  -- The paper removed for good (5.24), its pins go with it.
  foreign key (document_id, household_id) references document (id, household_id) on delete cascade
);
create index cabinet_pin_document_idx on cabinet_pin (document_id);

alter table cabinet_pin enable row level security;

create policy cabinet_pin_tenant on cabinet_pin
  using (household_id = app_household()) with check (household_id = app_household());

-- Its person signed in, and the vault; nobody else. With no WITH CHECK the
-- rule holds for what is written too: a person writes only their own.
create policy cabinet_pin_actor on cabinet_pin as restrictive
  using (case app_actor()
           when 'account' then member_id = app_member()
           when 'system' then true
           else false
         end);
