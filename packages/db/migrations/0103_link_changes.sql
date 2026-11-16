-- Links changed after they are made, and requests shown again (0.9.0, LK;
-- the owner's decision of 15 Nov 2026).
--
-- Until now a share link kept the protection it was made with (0043, 0088)
-- and the copy it was made with (0085), and a request to send documents was
-- shown once. Now:
--
--   * whoever made a link may change its properties while it works — when
--     it ends, view or download, its PIN or password, whom it is for, how
--     often it opens, whether its page shows the title — never what it is
--     to (share_link_target_fixed holds), its emailed or texted code, nor
--     "this browser only". A new PIN or password replaces the old one, in
--     the sealed copy too, so showing it again shows the new one.
--   * a request keeps a sealed copy of its link and the password the vault
--     made up, as a share link does (0085), for whoever asked to see again;
--     and whoever asked may change its properties while it works — when it
--     ends, its password, whom it is for, its visits, files and size, the
--     kinds of file it takes and whether it closes once sent — never what it
--     asks for, who looks at what comes in, its code or its one browser.
--
-- Each row now has a version, moved on by every change its maker makes: the
-- API's ETag for If-Match, as a person's emergency information's is (0102).
-- Neither a link nor a request's own sender moves it.
--
-- And a secret version, moved on only when its PIN or password is replaced
-- or taken away. Each session keeps the secret version of the row it was
-- opened against, read with the secret it checked, and is refused once they
-- differ: a page opened with the old PIN closes at its next request, even
-- one in use as the change was made (which the change's removal of the
-- sessions passes over, so as never to wait on it).

alter table share_link
  add column version int not null default 1
    constraint share_link_version check (version >= 1),
  add column secret_version int not null default 1
    constraint share_link_secret_version check (secret_version >= 1);

alter table share_session
  add column secret_version int not null default 1
    constraint share_session_secret_version check (secret_version >= 1);

alter table upload_request
  add column version int not null default 1
    constraint upload_request_version check (version >= 1),
  add column secret_version int not null default 1
    constraint upload_request_secret_version check (secret_version >= 1),
  add column link_copy_sealed bytea
    -- 12 bytes of IV, 16 of tag, and the link and its password as JSON.
    constraint upload_request_copy_length check (octet_length(link_copy_sealed) between 29 and 4096);

alter table upload_session
  add column secret_version int not null default 1
    constraint upload_session_secret_version check (secret_version >= 1);

-- 0088's rule, with one way through: what protects a link is fixed when it is
-- made, but its PIN or password, which its maker may replace — signed in as
-- themselves, while the link has not been taken back, and in the change that
-- moves its version on (never as the vault's own jobs, nor as anybody else).
-- "This browser only" stays as it was made. The address and the number a
-- code goes to only ever go, and only once the link has ended.
create or replace function share_link_factors_fixed() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.revoked_at is not null
     or new.attempts >= 10
     or (new.max_opens is not null and new.open_count >= new.max_opens) then
    new.code_email := null;
    new.code_phone := null;
  end if;
  if (new.pin_hash is distinct from old.pin_hash
      or new.secret_kind is distinct from old.secret_kind)
     and not coalesce(app_actor() = 'account'
                      and old.created_by = app_account()
                      and old.revoked_at is null
                      and old.flow = 'v2'
                      and new.version > old.version
                      and new.secret_version > old.secret_version, false) then
    raise exception 'a link keeps the protection it was made with'
      using errcode = 'check_violation';
  end if;
  -- Its secret version moves on with its PIN or password, and only so.
  if new.secret_version is distinct from old.secret_version
     and (new.secret_version < old.secret_version
          or (new.pin_hash is not distinct from old.pin_hash
              and new.secret_kind is not distinct from old.secret_kind)) then
    raise exception 'a link''s secret version moves on with its PIN or password alone'
      using errcode = 'check_violation';
  end if;
  -- Its properties (the owner's decision of 16 Nov 2026): changed by its
  -- maker, or by an owner of the household, signed in, in a change that
  -- moves its version on; never by anybody else signed in. (Its secret and
  -- its copy are its maker's alone, above and in share_link_copy_kept.)
  if app_actor() = 'account'
     and (new.expires_at, new.permission, new.max_opens, new.max_downloads,
          new.recipient_label, new.show_title)
         is distinct from
         (old.expires_at, old.permission, old.max_opens, old.max_downloads,
          old.recipient_label, old.show_title)
     and not coalesce((old.created_by = app_account() or app_role() = 'owner')
                      and old.revoked_at is null
                      and new.version > old.version, false) then
    raise exception 'a link is changed by whoever made it, or an owner'
      using errcode = 'check_violation';
  end if;
  if new.this_device_only is distinct from old.this_device_only then
    raise exception 'a link keeps the protection it was made with'
      using errcode = 'check_violation';
  end if;
  if new.device_hash is distinct from old.device_hash and old.device_hash is not null then
    raise exception 'a link stays with the device it was first opened on'
      using errcode = 'check_violation';
  end if;
  if (new.code_email is distinct from old.code_email
      or new.code_phone is distinct from old.code_phone) and (
       new.code_email is not null and new.code_email is distinct from old.code_email
       or new.code_phone is not null and new.code_phone is distinct from old.code_phone
       or not (new.revoked_at is not null
               or new.expires_at <= now()
               or new.attempts >= 10
               or (new.max_opens is not null and new.open_count >= new.max_opens))) then
    raise exception 'the address a link''s code goes to is cleared only when the link has ended'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- 0085's rule, with the same way through: a copy is kept as a link is made,
-- or not at all, and nobody puts one on a link afterwards. Its maker,
-- changing its PIN or password, seals the new one into the copy it was made
-- with — only into one that is there, and only in the statement that changes
-- the PIN or password — or lets go of one that no longer opens. Taken back,
-- a link forgets it, whoever asks; the
-- owning role, outside any household, moves it onto another master key.
create or replace function share_link_copy_kept() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.revoked_at is not null then
    new.link_copy_sealed := null;
    return new;
  end if;
  if new.link_copy_sealed is distinct from old.link_copy_sealed and app_actor() is not null
     and not coalesce(app_actor() = 'account'
                      and old.created_by = app_account()
                      and old.link_copy_sealed is not null
                      and new.pin_hash is distinct from old.pin_hash, false) then
    raise exception 'a link keeps the copy it was made with'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- A request's copy and password, as a link's: kept as it is made, or not at
-- all; its password replaced only by whoever asked, signed in as themselves,
-- while it has not been taken back, in the change that moves its version on
-- — and the copy only with it. Taken back, it forgets its copy, whoever
-- asks. Its code and its one browser stay as it was made. The owning role,
-- outside any household (app_actor() is then null), is held to none of it,
-- as before. (An upload link changes neither: upload_request_upload_writes,
-- 0044, refuses it any column but its counts.)
create function upload_request_changes_kept() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.revoked_at is not null then
    new.link_copy_sealed := null;
  end if;
  if app_actor() is null then
    return new;
  end if;
  if (new.secret_hash is distinct from old.secret_hash
      or new.secret_kind is distinct from old.secret_kind)
     and not coalesce(app_actor() = 'account'
                      and old.created_by = app_account()
                      and old.revoked_at is null
                      and new.version > old.version
                      and new.secret_version > old.secret_version, false) then
    raise exception 'a request keeps the password it was made with'
      using errcode = 'check_violation';
  end if;
  if new.secret_version is distinct from old.secret_version
     and (new.secret_version < old.secret_version
          or (new.secret_hash is not distinct from old.secret_hash
              and new.secret_kind is not distinct from old.secret_kind)) then
    raise exception 'a request''s secret version moves on with its password alone'
      using errcode = 'check_violation';
  end if;
  if new.revoked_at is null
     and new.link_copy_sealed is distinct from old.link_copy_sealed
     and not coalesce(app_actor() = 'account'
                      and old.created_by = app_account()
                      and old.link_copy_sealed is not null
                      and new.secret_hash is distinct from old.secret_hash, false) then
    raise exception 'a request keeps the copy it was made with'
      using errcode = 'check_violation';
  end if;
  -- Its properties, and what it asks for in words (16 Nov 2026): by whoever
  -- asked, or an owner of the household who may see it, in a change that
  -- moves its version on.
  if app_actor() = 'account'
     and (new.recipient_label, new.expires_at, new.max_visits, new.max_files,
          new.max_total_bytes, new.accept_types, new.close_after_submit,
          new.title, new.message)
         is distinct from
         (old.recipient_label, old.expires_at, old.max_visits, old.max_files,
          old.max_total_bytes, old.accept_types, old.close_after_submit,
          old.title, old.message)
     and not coalesce((old.created_by = app_account() or app_role() = 'owner')
                      and old.revoked_at is null
                      and new.version > old.version, false) then
    raise exception 'a request is changed by whoever asked, or an owner'
      using errcode = 'check_violation';
  end if;
  if new.email_code is distinct from old.email_code
     or new.this_device_only is distinct from old.this_device_only then
    raise exception 'a request keeps the protection it was made with'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger upload_request_changes_kept before update on upload_request
  for each row execute function upload_request_changes_kept();

-- ------------------------------------------------- a request emailed (LK)
--
-- A request's link emailed to its recipient by the vault (the owner's
-- decision of 16 Nov 2026), as a share link's is (0094): through the
-- operator's mail server alone (A21), from the sealed copy above, by
-- whoever asked alone; never with its password, a code or what it asks for.
--
--   upload_request_email   one row an email sent: which request, who sent
--                          it, when, whether a short message went with it
--                          (never the message), and where it went, masked
--                          (j•••@e•••.com), never the address. The rows are
--                          what the sends are counted by: 3 a request and 20
--                          an account in a day.

create table upload_request_email (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  -- Null once its request is removed for good: the row stays, to be counted.
  request_id   uuid,
  sent_by      uuid not null references account(id) on delete cascade,
  to_masked    text not null
                 constraint upload_request_email_masked
                 check (char_length(to_masked) between 3 and 40 and position('•' in to_masked) > 0),
  with_message boolean not null default false,
  sent_at      timestamptz not null default now(),
  foreign key (request_id, household_id)
    references upload_request (id, household_id) on delete set null (request_id)
);
create index upload_request_email_request_idx on upload_request_email (request_id, sent_at);
create index upload_request_email_sender_idx on upload_request_email (sent_by, sent_at);

alter table upload_request_email enable row level security;
create policy upload_request_email_tenant on upload_request_email
  using (household_id = app_household()) with check (household_id = app_household());

-- Whoever sent it reads it, and the vault every row; nobody else.
create policy upload_request_email_actor on upload_request_email as restrictive
  using (case app_actor()
           when 'system' then true
           when 'account' then sent_by = app_account()
           else false
         end);

-- Written as themselves, by whoever asked, while the request has not been
-- taken back.
create policy upload_request_email_actor_insert on upload_request_email as restrictive for insert
  with check (case app_actor()
                when 'system' then true
                when 'account' then
                  sent_by = app_account()
                  and exists (select 1 from upload_request r
                               where r.id = upload_request_email.request_id
                                 and r.household_id = upload_request_email.household_id
                                 and r.created_by = app_account()
                                 and r.revoked_at is null)
                else false
              end);

-- Once sent, a row is what it was.
create policy upload_request_email_actor_update on upload_request_email as restrictive for update
  using (false) with check (false);
create policy upload_request_email_actor_delete on upload_request_email as restrictive for delete
  using (app_actor() = 'system');

