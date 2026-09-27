-- A person's photo (iteration 5.17c).
--
-- One small square picture of each person, for Home, People and their
-- profile. The family sees everyone's; a viewer — an accountant or an
-- attorney with a sign-in — sees only their own, and initials for everyone
-- else (A65), as with birthdays (family.details).
--
-- Nothing of the file somebody chose is kept. The API never decodes an
-- image: it seals the upload as it arrives into a temporary object in the
-- vault (<household>/members/<person>/incoming/<photo>.enc), under a fresh
-- file key wrapped by the household key, and queues `member.photo`. The
-- worker opens it, turns it upright, crops it, strips every tag (EXIF, GPS)
-- and makes one 512-pixel square JPEG, which is sealed here, in `sealed`,
-- under the household key and bound to the household, the person and the
-- photo; then the upload is deleted. A file it cannot use is deleted as
-- well. No filename, size or EXIF is kept: nothing of the file but the
-- square's pixels.
--
-- One ready photo per person, and at most one on its way (processing) or
-- refused (failed): a new one replaces whatever was unfinished. The upload
-- columns are cleared once the square is made or refused, and a ready row
-- has none.
--
-- Who may read a row, beyond its household (member_photo_actor): the vault
-- itself; somebody signed in whose role is one of family.details' (owner,
-- adult, teen: roles.ts), or who is the person themselves. A share link, an
-- upload link, a signed-out page and a caller who says nothing read none.
-- And only while the reader may see the person (member_photo_person): when
-- 5.32 narrows who a viewer sees, their photos narrow with them, by person
-- and by photo, with nothing to remember. Both are restrictive, with no WITH
-- CHECK, so they hold what is written as well as what is read.
--
-- Grants come from the default privileges (0001): the application role
-- reads and writes it, and deletes a row outright.

-- What a photo's second key names: a person of the photo's own household.
alter table member add constraint member_id_household_key unique (id, household_id);

create table member_photo (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references household(id) on delete cascade,
  member_id          uuid not null,
  state              text not null default 'processing'
                       check (state in ('processing', 'ready', 'failed')),
  -- The part chosen, as fractions of the upright picture
  -- ({"x", "y", "size"}); null for the middle.
  crop               jsonb check (crop is null or jsonb_typeof(crop) = 'object'),
  -- The finished square, sealed: iv (12) || ciphertext || tag (16). The
  -- JPEG is at most 256 KiB, so this is at most that and the 28 bytes of
  -- the seal.
  sealed             bytea check (sealed is null or octet_length(sealed) <= 262144 + 28),
  -- The upload on its way, cleared once it is made or refused.
  source_key         text,
  source_vault_id    uuid references vault(id) on delete set null,
  source_key_wrapped bytea,
  created_by         uuid references account(id) on delete set null,
  created_at         timestamptz not null default now(),
  ready_at           timestamptz,
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade,
  constraint member_photo_source_whole
    check ((source_key is null) = (source_key_wrapped is null)),
  constraint member_photo_ready
    check (state <> 'ready'
           or (sealed is not null and ready_at is not null
               and source_key is null and source_key_wrapped is null and source_vault_id is null)),
  constraint member_photo_unfinished_unsealed check (state = 'ready' or sealed is null)
);
create unique index member_photo_one_ready on member_photo (member_id) where state = 'ready';
create unique index member_photo_one_unfinished on member_photo (member_id) where state <> 'ready';
create index member_photo_household_idx on member_photo (household_id);

alter table member_photo enable row level security;
create policy member_photo_tenant on member_photo
  using (household_id = app_household()) with check (household_id = app_household());

-- The roles of family.details (packages/shared/src/roles.ts), read as
-- doc_collection_changes reads app_role() (0036, renamed by 0039): each
-- named, so a role added later is nobody's until it is taught here.
-- Change them together;
-- visibility-rule.test.ts holds them equal.
create policy member_photo_actor on member_photo as restrictive
  using (case app_actor()
           when 'system' then true
           when 'account' then case app_role()
                                 when 'owner' then true
                                 when 'adult' then true
                                 when 'teen' then true
                                 else false
                               end
                               or coalesce(member_id = app_member(), false)
           else false
         end);

-- A photo of somebody the reader is not given is not given either.
create policy member_photo_person on member_photo as restrictive
  using (exists (select 1 from member where id = member_id));
