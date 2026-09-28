-- Ask someone to send documents: the server (iteration 5.21).
--
-- An owner or an adult asks somebody outside the family — the accountant,
-- the solicitor — to send documents in, without that person joining
-- anything. The request is a link, `/drop#<token>`, on the public-only site
-- (5.16): the token rides in the fragment, which no server sees, and the
-- page posts it in a body. Whoever holds it can put files in and nothing
-- else: the link is write-only. They never see the vault, another sender's
-- files, or even their own once sent.
--
-- What is always on, and cannot be turned off (A20, A40, A41):
--
--   an end        at most 90 days after it was made (FDV_SHARE_MAX_DAYS can
--                 only shorten it);
--   the caps      10 files and 200 MB a request, and FDV_MAX_UPLOAD_BYTES a
--                 file; counted as the bytes arrive, and held here too;
--   the types     PDF and photos, and Word and Excel only when the request
--                 says so; a Word or Excel file with macros, never;
--   review        a file sent in is not a document. It waits here, in
--                 incoming_file, encrypted, until somebody who may review
--                 it looks at it and files it (5.23): nothing searches,
--                 lists, reminds or counts it before then.
--
-- What the requester may add: a password (Argon2, never kept plain), how
-- many times it may be opened, an emailed code (operator mail only, A21),
-- "this device only", and closing after the first sending. Every wrong
-- password or code uses up one counter of ten for the life of the request
-- (A23), reserved before it is checked.
--
-- Who reviews (A43): the person who asked (`me`), and nobody else — not
-- another adult, not an owner — or any owner or adult (`adults`). A file is
-- encrypted from its first byte under the key of whoever reviews it: the
-- requester's own member key, or the adults key. Teens and viewers never
-- see a request, a file, or a line about either.
--
-- A request whose requester can no longer ask (made a teen or a viewer,
-- their sign-in taken away, locked from 5.28) opens nothing: its link
-- answers as one that does not exist, here and in the API (A39); 5.23 moves
-- its waiting files to the owners.
--
-- After a restore every live request is paused for an owner to turn back on
-- (A55), and no session or code survives (restore.ts).
--
-- A rule for each kind of caller (0030's), on every table here:
--
--   account  an owner or an adult: the requests they review, and what hangs
--            off those. Somebody else's review-by-me request, and its files,
--            are not there for them, whatever the query asks.
--   system   everything: the worker, and restore.
--   upload   its own request, while it can be used; its own sessions and
--            codes; the files of its own session, and no other's.
--   link, anonymous, nobody: nothing.

-- A request's second keys: what its items, sessions, codes and files name.
create table upload_request (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references household(id) on delete cascade,
  -- Who asked: their sign-in, and the member they are.
  created_by          uuid not null references account(id),
  requester_member_id uuid not null,
  title               text not null constraint upload_request_title
                        check (char_length(title) between 1 and 120),
  message             text constraint upload_request_message check (char_length(message) <= 2000),
  -- Whom it is for, in the family's words ("Jane, accountant"), and where
  -- an emailed code goes: cleared when the request ends.
  recipient_label     text constraint upload_request_label check (char_length(recipient_label) <= 80),
  recipient_email     text constraint upload_request_email check (char_length(recipient_email) <= 254),
  -- The link's secret, as its SHA-256; the password, as Argon2id.
  token_hash          bytea not null unique,
  secret_hash         text,
  email_code          boolean not null default false,
  this_device_only    boolean not null default false,
  -- The device the first Open bound, as its cookie's SHA-256.
  device_hash         bytea,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  max_visits          int constraint upload_request_max_visits check (max_visits between 1 and 1000),
  visits_used         int not null default 0 constraint upload_request_visits check (visits_used >= 0),
  max_files           int not null default 10
                        constraint upload_request_max_files check (max_files between 1 and 10),
  files_used          int not null default 0 constraint upload_request_files check (files_used >= 0),
  max_total_bytes     bigint not null default 209715200
                        constraint upload_request_max_bytes check (max_total_bytes between 1 and 209715200),
  bytes_used          bigint not null default 0 constraint upload_request_bytes check (bytes_used >= 0),
  accept_types        text not null default 'standard'
                        constraint upload_request_accept check (accept_types in ('standard', 'office')),
  review_by           text not null default 'me'
                        constraint upload_request_review_by check (review_by in ('me', 'adults')),
  -- Hints for whoever reviews, never shown to the sender.
  suggested_member_id uuid references member(id) on delete set null,
  suggested_type_key  text constraint upload_request_type_hint check (char_length(suggested_type_key) <= 64),
  close_after_submit  boolean not null default false,
  attempts            int not null default 0 constraint upload_request_attempts check (attempts between 0 and 10),
  paused_at           timestamptz,
  paused_reason       text constraint upload_request_paused_reason check (paused_reason in ('restored')),
  revoked_at          timestamptz,
  revoked_by          uuid references account(id),
  closed_at           timestamptz,
  -- Sent, with "close after the first sending"; or its requester lost the
  -- right to ask (A39).
  closed_reason       text constraint upload_request_closed_reason
                        check (closed_reason in ('submitted', 'requester_lost_right')),
  -- Never "no end" (A20): a few minutes past 90 days for a client whose
  -- clock is ahead, as a link's (SHARE_END_GRACE_MINUTES).
  constraint upload_request_at_most_90_days
    check (expires_at <= created_at + interval '90 days 5 minutes'),
  constraint upload_request_paused check ((paused_at is null) = (paused_reason is null)),
  constraint upload_request_closed check ((closed_at is null) = (closed_reason is null)),
  constraint upload_request_device check (this_device_only or device_hash is null),
  -- And the counts hold, however many ask at once: each is moved by one
  -- guarded statement (upload-requests.ts), and these are the floor.
  constraint upload_request_files_within check (files_used <= max_files),
  constraint upload_request_bytes_within check (bytes_used <= max_total_bytes),
  constraint upload_request_visits_within check (max_visits is null or visits_used <= max_visits),
  constraint upload_request_id_household_key unique (id, household_id),
  constraint upload_request_reviewer_key unique (id, household_id, review_by, requester_member_id),
  foreign key (requester_member_id, household_id) references member (id, household_id) on delete cascade
);
create index upload_request_household_idx on upload_request (household_id, created_at desc);
create index upload_request_created_by_idx on upload_request (created_by);

-- What the sender is asked for, by name: "W-2", "1099".
create table upload_request_item (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  request_id   uuid not null,
  position     smallint not null constraint upload_request_item_position check (position between 1 and 10),
  label        text not null constraint upload_request_item_label check (char_length(label) between 1 and 80),
  constraint upload_request_item_position_key unique (request_id, position),
  constraint upload_request_item_id_request_key unique (id, request_id),
  foreign key (request_id, household_id) references upload_request (id, household_id) on delete cascade
);

-- An Open that worked, in one browser: its cookie's SHA-256, never the
-- cookie. 30 minutes from its last use, and 4 hours at most, never past its
-- request's end (A26, as a link's).
create table upload_session (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  request_id   uuid not null,
  cookie_hash  bytea not null unique,
  -- What was proved to open it: nothing but the link, or these.
  verified_by  text[] not null default '{}'
                 constraint upload_session_verified_by
                 check (verified_by <@ array['password', 'email_code', 'this_device']::text[]),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  -- Cut to its /24 or /48 (A24).
  ip           inet,
  user_agent   text constraint upload_session_user_agent check (char_length(user_agent) <= 512),
  constraint upload_session_at_most_four_hours check (expires_at <= created_at + interval '4 hours'),
  constraint upload_session_id_request_key unique (id, request_id),
  foreign key (request_id, household_id) references upload_request (id, household_id) on delete cascade
);
create index upload_session_request_idx on upload_session (request_id);

-- An emailed code (as 5.20's for a link): six digits, kept as an HMAC under
-- a key of the server's, so a dump cannot be searched for it. 10 minutes,
-- 5 tries, once.
create table upload_code (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references household(id) on delete cascade,
  request_id   uuid not null,
  code_hash    bytea not null,
  sent_at      timestamptz not null default now(),
  expires_at   timestamptz not null,
  attempts     int not null default 0 constraint upload_code_attempts check (attempts between 0 and 5),
  used_at      timestamptz,
  constraint upload_code_ten_minutes check (expires_at <= sent_at + interval '10 minutes'),
  foreign key (request_id, household_id) references upload_request (id, household_id) on delete cascade
);
create index upload_code_request_idx on upload_code (request_id, sent_at desc);

-- A file sent in: held apart from the documents until somebody reviews it.
--
-- `uploading` while its bytes arrive, encrypted, straight to its object; the
-- row is made first, so a try that dies leaves a row the nightly prune finds
-- and takes away with its object. `received` once whole and within every
-- cap. 5.23 decides it: `accepted` (filed, `version_id` saying which
-- version it became) or `rejected`.
--
-- Who reviews it is its request's, carried here (the key below keeps them
-- equal) so that its rule asks nothing of another table.
create table incoming_file (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references household(id) on delete cascade,
  request_id          uuid not null,
  review_by           text not null,
  requester_member_id uuid not null,
  -- What the sender said it was for, when they chose.
  item_id             uuid,
  -- The session that sent it; null once that session has ended.
  session_id          uuid,
  state               text not null default 'uploading'
                        constraint incoming_file_state
                        check (state in ('uploading', 'received', 'accepted', 'rejected')),
  -- Its name as sent, made safe to show: no folders, no control or
  -- direction characters.
  original_name       text not null constraint incoming_file_name
                        check (char_length(original_name) between 1 and 200),
  -- What its bytes are, never what it was called or said to be.
  mime                text,
  byte_size           bigint constraint incoming_file_size check (byte_size >= 0),
  sha256              bytea,
  cipher_bytes        bigint,
  cipher_sha256       bytea,
  storage_key         text not null unique,
  vault_id            uuid not null references vault(id),
  file_key_wrapped    bytea not null,
  wrapped_by_scope    uuid not null references scope_key(id),
  -- Whose key: the requester's own (`member`) for review-by-me, the adults'.
  scope               text not null constraint incoming_file_scope check (scope in ('adults', 'member')),
  -- A note from the sender: 1,000 characters of plain text.
  sender_note         text constraint incoming_file_note check (char_length(sender_note) <= 1000),
  -- Whether it has been looked at for viruses (5.23, A42).
  scan_state          text not null default 'pending'
                        constraint incoming_file_scan
                        check (scan_state in ('pending', 'unscanned', 'clean', 'infected')),
  created_at          timestamptz not null default now(),
  received_at         timestamptz,
  -- When its sender pressed Finish.
  submitted_at        timestamptz,
  decided_by          uuid references account(id),
  decided_at          timestamptz,
  -- Where it went (5.23): `document_version.uploaded_by` is an account, so
  -- history says a version came from a request through this.
  document_id         uuid references document(id) on delete set null,
  version_id          uuid references document_version(id) on delete set null,
  constraint incoming_file_received_whole
    check (state = 'uploading'
           or (mime is not null and byte_size is not null and sha256 is not null
               and cipher_bytes is not null and cipher_sha256 is not null
               and received_at is not null)),
  -- (Whose key it is under follows who reviews it, but is not held equal
  -- here: 5.23 moves a file from a requester who can no longer review to
  -- the owners, request and files and key together.)
  constraint incoming_file_decided
    check ((state in ('accepted', 'rejected')) = (decided_at is not null)),
  foreign key (request_id, household_id, review_by, requester_member_id)
    references upload_request (id, household_id, review_by, requester_member_id)
    on update cascade on delete cascade,
  foreign key (item_id, request_id) references upload_request_item (id, request_id),
  foreign key (session_id, request_id) references upload_session (id, request_id)
    on delete set null (session_id)
);
create index incoming_file_request_idx on incoming_file (request_id);
create index incoming_file_household_state_idx on incoming_file (household_id, state);
create index incoming_file_session_idx on incoming_file (session_id);

-- ------------------------------------------------------- the walls

alter table upload_request enable row level security;
alter table upload_request_item enable row level security;
alter table upload_session enable row level security;
alter table upload_code enable row level security;
alter table incoming_file enable row level security;

create policy upload_request_tenant on upload_request
  using (household_id = app_household()) with check (household_id = app_household());
create policy upload_request_item_tenant on upload_request_item
  using (household_id = app_household()) with check (household_id = app_household());
create policy upload_session_tenant on upload_session
  using (household_id = app_household()) with check (household_id = app_household());
create policy upload_code_tenant on upload_code
  using (household_id = app_household()) with check (household_id = app_household());
create policy incoming_file_tenant on incoming_file
  using (household_id = app_household()) with check (household_id = app_household());

-- The session an upload link asks from, once it has one.
create function app_upload_session() returns uuid
  language sql stable parallel safe as
  $$ select nullif(current_setting('app.upload_session_id', true), '')::uuid $$;

-- The asking upload link's request, while it can be used: not taken back,
-- closed, paused or past its end, not locked by ten wrong tries, and its
-- requester still an owner or an adult of the household (the roles of
-- upload_request.create, packages/shared/src/roles.ts; change them
-- together). Otherwise null. These are UploadRequestService.live()'s checks
-- (apps/api/src/uploads/requests.ts). It reads with the owner's rights, as
-- app_shared_document() does: the request's rule asks it.
create function app_live_upload_request() returns uuid
  language sql stable parallel safe security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select r.id
       from upload_request r
       join account_household asker
         on asker.account_id = r.created_by
        and asker.household_id = r.household_id
        and asker.member_id = r.requester_member_id
      where r.id = app_upload_request()
        and r.household_id = app_household()
        and r.revoked_at is null
        and r.closed_at is null
        and r.paused_at is null
        and r.expires_at > now()
        and r.attempts < 10
        and asker.role in ('owner', 'adult') $$;
grant execute on function app_live_upload_request() to fdv_app;

-- Which household and request a token names, before either is known, and
-- only while the request can be used: the one question asked with the
-- owner's rights. Everything after asks as the upload link.
create function upload_request_find(p_token_hash bytea)
  returns table (household_id uuid, request_id uuid)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select r.household_id, r.id
       from upload_request r
      where r.token_hash = p_token_hash
        and r.revoked_at is null
        and r.closed_at is null
        and r.paused_at is null
        and r.expires_at > now()
        and r.attempts < 10 $$;
grant execute on function upload_request_find(bytea) to fdv_app;

-- Which household, request and session a cookie belongs to, as
-- share_session_find() answers for a link's.
create function upload_session_find(p_cookie_hash bytea)
  returns table (household_id uuid, request_id uuid, session_id uuid)
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select s.household_id, s.request_id, s.id
       from upload_session s
      where s.cookie_hash = p_cookie_hash
        and s.expires_at > now() $$;
grant execute on function upload_session_find(bytea) to fdv_app;

-- How many bytes of the household's are waiting for review: its cap across
-- every request, which no one request's link can see the rest of.
create function incoming_pending_bytes() returns bigint
  language sql stable security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ select coalesce(sum(byte_size), 0)::bigint
       from incoming_file
      where household_id = app_household()
        and state in ('uploading', 'received') $$;
grant execute on function incoming_pending_bytes() to fdv_app;

-- The requests: its reviewers', the vault's, and an upload link's own. A
-- review-by-me request is its requester's alone (A43); a request for any
-- adult, every owner's and adult's. With no WITH CHECK, what is written is
-- held to it too: nobody makes a request for somebody else to review alone.
create policy upload_request_actor on upload_request as restrictive
  using (case app_actor()
           when 'account' then app_role() in ('owner', 'adult')
                               and (requester_member_id = app_member() or review_by = 'adults')
           when 'system' then true
           when 'upload' then id = (select app_live_upload_request())
           else false
         end);
-- Taken back, never removed, by anybody but the vault.
create policy upload_request_actor_delete on upload_request as restrictive for delete
  using (case app_actor() when 'system' then true else false end);

-- What an upload link may change on its own request: its counts, the
-- device its first Open bound, and closing it once sent — each only as the
-- sending does it. A rule cannot say which columns change, so a trigger
-- does; it compares every column but those, so a column added later is
-- the requester's.
create function upload_request_upload_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() = 'upload' and (
       (to_jsonb(new) - array['visits_used', 'attempts', 'files_used', 'bytes_used',
                              'device_hash', 'closed_at', 'closed_reason', 'recipient_email'])
         is distinct from
       (to_jsonb(old) - array['visits_used', 'attempts', 'files_used', 'bytes_used',
                              'device_hash', 'closed_at', 'closed_reason', 'recipient_email'])
       or new.visits_used < old.visits_used
       or new.attempts < old.attempts
       or (old.device_hash is not null and new.device_hash is distinct from old.device_hash)
       or (old.closed_at is not null
           and (new.closed_at, new.closed_reason) is distinct from (old.closed_at, old.closed_reason))
       or (old.closed_at is null and new.closed_at is not null and new.closed_reason <> 'submitted')
       -- The address may only be cleared.
       or (new.recipient_email is not null and new.recipient_email is distinct from old.recipient_email)) then
    raise exception 'an upload link may only count its visits, tries and files, and close once sent'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger upload_request_upload_writes before update on upload_request
  for each row execute function upload_request_upload_writes();

-- A request's items follow the request; an upload link reads its own.
create policy upload_request_item_actor on upload_request_item as restrictive
  using (case app_actor()
           when 'account' then exists (select 1 from upload_request r where r.id = request_id)
           when 'system' then true
           when 'upload' then request_id = (select app_live_upload_request())
           else false
         end);
create policy upload_request_item_actor_insert on upload_request_item as restrictive for insert
  with check (case app_actor() when 'account' then true when 'system' then true else false end);
create policy upload_request_item_actor_update on upload_request_item as restrictive for update
  using (case app_actor() when 'account' then true when 'system' then true else false end);
create policy upload_request_item_actor_delete on upload_request_item as restrictive for delete
  using (case app_actor() when 'system' then true else false end);

-- Sessions and codes: an upload link makes, uses and ends its own request's
-- — also once the request has stopped, so it can clear them away. The
-- family's: those of the requests they review, to end them.
create policy upload_session_actor on upload_session as restrictive
  using (case app_actor()
           when 'account' then exists (select 1 from upload_request r where r.id = request_id)
           when 'system' then true
           when 'upload' then request_id = app_upload_request()
           else false
         end);
create policy upload_code_actor on upload_code as restrictive
  using (case app_actor()
           when 'account' then exists (select 1 from upload_request r where r.id = request_id)
           when 'system' then true
           when 'upload' then request_id = app_upload_request()
           else false
         end);

-- The files. A review-by-me request's are its requester's alone — not
-- another adult's, not an owner's — and a request for any adult's are the
-- owners' and adults'; never a teen's or a viewer's (A43). An upload link
-- reaches the files of its own session, and no other's: not another
-- sender's, not its own after its session has ended.
create policy incoming_file_actor on incoming_file as restrictive
  using (case app_actor()
           when 'account' then app_role() in ('owner', 'adult')
                               and case review_by
                                     when 'me' then requester_member_id = app_member()
                                     when 'adults' then true
                                     else false
                                   end
           when 'system' then true
           when 'upload' then request_id = app_upload_request() and session_id = app_upload_session()
           else false
         end);
-- Only a sender puts a file in (and the vault): while its request can be
-- used, and on its way.
create policy incoming_file_actor_insert on incoming_file as restrictive for insert
  with check (case app_actor()
                when 'system' then true
                when 'upload' then request_id = (select app_live_upload_request())
                                   and state = 'uploading'
                else false
              end);
-- A sender takes back a file of its own before pressing Finish, never after.
create policy incoming_file_actor_delete on incoming_file as restrictive for delete
  using (case app_actor()
           when 'account' then true
           when 'system' then true
           when 'upload' then submitted_at is null
           else false
         end);

-- What an upload link may change on a file of its own: finishing it (its
-- type, size and hashes, once), and the note and the moment it was sent,
-- once. Who reviews it, whose key, where it is and what became of it are
-- never a sender's. (Its session ending sets session_id to null, as the
-- database does when a session goes: that is allowed whoever ends it.)
create function incoming_file_upload_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() = 'upload'
     and not (new.session_id is null
              and (to_jsonb(new) - 'session_id') = (to_jsonb(old) - 'session_id'))
     and (
       old.submitted_at is not null
       or new.session_id is distinct from old.session_id
       or (to_jsonb(new) - array['state', 'mime', 'byte_size', 'sha256', 'cipher_bytes',
                                 'cipher_sha256', 'received_at', 'sender_note', 'submitted_at'])
            is distinct from
          (to_jsonb(old) - array['state', 'mime', 'byte_size', 'sha256', 'cipher_bytes',
                                 'cipher_sha256', 'received_at', 'sender_note', 'submitted_at'])
       or new.state not in ('uploading', 'received')
       or (old.state = 'received'
           and (new.state, new.mime, new.byte_size, new.sha256, new.cipher_bytes,
                new.cipher_sha256, new.received_at)
               is distinct from
               (old.state, old.mime, old.byte_size, old.sha256, old.cipher_bytes,
                old.cipher_sha256, old.received_at))) then
    raise exception 'an upload link may only finish and send its own files'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger incoming_file_upload_writes before update on incoming_file
  for each row execute function incoming_file_upload_writes();

-- A requester who can no longer ask — made a teen or a viewer, their
-- sign-in taken away — loses their requests (A39): each still open is
-- closed, its address cleared, and its sessions and codes ended. Asked by
-- whoever made the change, in its own transaction, who may not see the
-- requests (a review-by-me request is its requester's alone): so with the
-- owner's rights, in the caller's household, and only for requests that
-- could not be used anyway. Returns the ids it closed, for the log.
create function upload_requests_close_lost() returns setof uuid
  language sql volatile security definer
  set search_path = pg_catalog, public, pg_temp as
  $$ with lost as (
       update upload_request r
          set closed_at = now(), closed_reason = 'requester_lost_right', recipient_email = null
        where r.household_id = app_household()
          and r.closed_at is null
          and r.revoked_at is null
          and not exists (select 1 from account_household a
                           where a.account_id = r.created_by
                             and a.household_id = r.household_id
                             and a.member_id = r.requester_member_id
                             and a.role in ('owner', 'adult'))
       returning r.id),
     sessions as (delete from upload_session where request_id in (select id from lost)),
     codes as (delete from upload_code where request_id in (select id from lost))
     select id from lost $$;
grant execute on function upload_requests_close_lost() to fdv_app;
