-- My cabinet (0.9.0, C1; the owner's idea of 13 Nov 2026): each person's
-- own cabinets, drawers and folders, the way they file paper at home.
--
--   cabinet_layout   one row a person of a household: their layout, as
--                    JSON — cabinets, each with drawers, each with folders,
--                    every folder a saved filter of GET /documents (the
--                    API checks each with the list's own parser, and its
--                    size). `version` counts each save, so a save made to a
--                    layout changed meanwhile, in another window or on
--                    another device, is refused rather than laid over it.
--
-- A layout is its person's alone. Nobody else is given a row of it — an
-- owner, another adult, a share link, an upload link, a signed-out page or
-- a caller who says nothing — and nobody writes anybody else's. What a
-- folder holds is never kept here: its documents and its counts are worked
-- out as the list works them out, for whoever asks, every time.

create table cabinet_layout (
  household_id uuid not null references household(id) on delete cascade,
  member_id    uuid not null,
  layout       jsonb not null
                 constraint cabinet_layout_object check (jsonb_typeof(layout) = 'object')
                 -- The API keeps it to 512 KiB; this is the database's own floor.
                 constraint cabinet_layout_size check (octet_length(layout::text) <= 1048576),
  version      integer not null default 1 constraint cabinet_layout_version check (version >= 1),
  updated_at   timestamptz not null default now(),
  primary key (household_id, member_id),
  -- Their person gone, or out of the household: the layout goes with them.
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade
);

alter table cabinet_layout enable row level security;

create policy cabinet_layout_tenant on cabinet_layout
  using (household_id = app_household()) with check (household_id = app_household());

-- Its person signed in, and the vault; nobody else. With no WITH CHECK the
-- rule holds for what is written too: a person writes only their own.
create policy cabinet_layout_actor on cabinet_layout as restrictive
  using (case app_actor()
           when 'account' then member_id = app_member()
           when 'system' then true
           else false
         end);
