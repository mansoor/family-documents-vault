-- A create made twice is made once (0.9.0-dev.45): POST /api/v1/documents
-- takes an Idempotency-Key, as uploads have since 0.4.8 (upload_idempotency).
-- The phone writes notes offline; when a send's answer is lost (a timeout, a
-- proxy's 502/503/504) it cannot tell whether the note was made, and sends it
-- again under the same key.
--
--   create_idempotency   one row a key of one signed-in account, as the
--                        person it is, in one household: what the first
--                        request was (its fingerprint, a SHA-256 of its
--                        method, route and canonical body), and what it
--                        made (the document's id, and the status it was
--                        answered with).
--
-- Nothing of the document is kept here: no title, no words, no details —
-- only the hash, the id and the status. The row is written in the same
-- transaction as the document it names: claimed first (under an advisory
-- lock of the key's own, which a second, simultaneous try waits on), then
-- given the document's id. A create that fails leaves no row, so the same
-- key works again once the request is put right; one that commits commits
-- its key with it.
--
-- A key lasts 24 hours. One older is no key (the API deletes it before
-- claiming the same key again), and the worker's daily sweep deletes the
-- rest. A document removed for good takes its keys with it (the foreign key
-- below), as it takes everything that names it: a later try under such a key
-- makes a new document.
--
-- A key is its account's alone, as the person it is in the household: the
-- person is part of the key itself, so an account whose sign-in is moved to
-- somebody else (removed, and invited again as another person) neither
-- replays what it made as the first nor is blocked by a key it can no
-- longer see. Nobody else is given a row of it — an owner, another adult, a
-- share link, an upload link, a signed-out page or a caller who says
-- nothing — and nobody writes anybody else's; the vault itself (the
-- worker's sweep) reads and deletes them all.

create table create_idempotency (
  household_id        uuid not null references household(id) on delete cascade,
  account_id          uuid not null references account(id) on delete cascade,
  -- Who that account is in this household, as it was signed in.
  member_id           uuid not null,
  -- 1 to 255 printable ASCII characters, as sent; a UUID is usual.
  idempotency_key     text not null
                        constraint create_idempotency_key check (idempotency_key ~ '^[ -~]{1,255}$'),
  request_fingerprint text not null
                        constraint create_idempotency_fingerprint
                          check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Null only inside the transaction that is making it.
  document_id         uuid,
  status              smallint not null default 201
                        constraint create_idempotency_status check (status between 200 and 299),
  created_at          timestamptz not null default now(),
  primary key (household_id, account_id, member_id, idempotency_key),
  -- Their person gone, or out of the household: their keys go with them.
  foreign key (member_id, household_id) references member (id, household_id) on delete cascade,
  -- The document removed for good (5.24): its keys go with it.
  foreign key (document_id, household_id) references document (id, household_id) on delete cascade
);
create index create_idempotency_document_idx on create_idempotency (document_id);
-- The worker's sweep: keys past their 24 hours.
create index create_idempotency_created_idx on create_idempotency (created_at);

alter table create_idempotency enable row level security;

create policy create_idempotency_tenant on create_idempotency
  using (household_id = app_household()) with check (household_id = app_household());

-- Its account signed in, as the member it is here, and the vault; nobody
-- else. With no WITH CHECK the rule holds for what is written too: an
-- account writes only its own.
create policy create_idempotency_actor on create_idempotency as restrictive
  using (case app_actor()
           when 'account' then account_id = app_account() and member_id = app_member()
           when 'system' then true
           else false
         end);
