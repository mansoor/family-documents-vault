-- A second factor for someone with no account (iteration 5.20).
--
-- A link made since 5.16 (`flow = 'v2'`) can ask for more than itself, in
-- any combination:
--
--   secret_kind       a PIN (four digits the vault made up, as since 0.5.0)
--                     or a password (made up by the vault, or typed by the
--                     sharer: 8 characters or more), its argon2 hash kept in
--                     pin_hash as a PIN's always was. A row with a hash and
--                     no kind is a PIN's, as every one before this was.
--   code_email        an emailed 6-digit code, sent only to this address,
--                     which the sharer typed, and only through the
--                     operator's mail server (FDV_SMTP_URL, A21), never the
--                     household's, which an owner can point anywhere. The
--                     recipient never types an address, and sees it masked.
--                     The address is cleared when the link ends.
--   this_device_only  the first browser that opens it is the only one it
--                     opens in: Open binds a device cookie, kept here as
--                     device_hash (the SHA-256 of the link and the cookie),
--                     and another browser is refused.
--
-- Every failed factor — a PIN, a password, a code — uses up the one counter
-- of ten the link has had since 0.5.0 (`attempts`, A23), reserved before it
-- is checked; so do the codes' own five tries each (share_code.attempts).
--
-- Each is a v2 link's alone, as 0037 said they would be.

-- ------------------------------------------------------------- the link

alter table share_link
  add column secret_kind text
    constraint share_link_secret_kind check (secret_kind in ('pin', 'password')),
  add column code_email text
    constraint share_link_code_email check (char_length(code_email) between 3 and 254
                                            and position('@' in code_email) > 1),
  add column this_device_only boolean not null default false,
  add column device_hash bytea;

update share_link set secret_kind = 'pin' where pin_hash is not null;

alter table share_link
  -- A kind of secret has its hash.
  add constraint share_link_secret_hashed check (secret_kind is null or pin_hash is not null),
  add constraint share_link_password_v2 check (flow = 'v2' or secret_kind is distinct from 'password'),
  add constraint share_link_code_email_v2 check (flow = 'v2' or code_email is null),
  add constraint share_link_this_device_v2 check (flow = 'v2' or not this_device_only),
  -- Only a link for one device is bound to one.
  add constraint share_link_device_bound check (this_device_only or device_hash is null);

-- What protects a link is fixed when it is made, whoever asks — the vault
-- included: its secret, and whether it is for one device. A device is bound
-- once, by the first Open that works, and never moved. The address a code
-- goes to only ever goes, and only once the link has ended — taken back,
-- run out, locked, or opened as often as it allows — so no live link loses
-- its code by any route. And it goes in the very statement that ends the
-- link, by whichever route: the one that takes it back, the tenth wrong
-- try (made as the link, which cannot see its own share once locked), the
-- last open. A link whose end has simply passed has it cleared by the
-- worker's nightly prune.
create function share_link_factors_fixed() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.revoked_at is not null
     or new.attempts >= 10
     or (new.max_opens is not null and new.open_count >= new.max_opens) then
    new.code_email := null;
  end if;
  if new.pin_hash is distinct from old.pin_hash
     or new.secret_kind is distinct from old.secret_kind
     or new.this_device_only is distinct from old.this_device_only then
    raise exception 'a link keeps the protection it was made with'
      using errcode = 'check_violation';
  end if;
  if new.device_hash is distinct from old.device_hash and old.device_hash is not null then
    raise exception 'a link stays with the device it was first opened on'
      using errcode = 'check_violation';
  end if;
  if new.code_email is distinct from old.code_email and (
       new.code_email is not null
       or not (new.revoked_at is not null
               or new.expires_at <= now()
               or new.attempts >= 10
               or (new.max_opens is not null and new.open_count >= new.max_opens))) then
    raise exception 'the address a link''s code goes to is cleared only when the link has ended'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger share_link_factors_fixed before update on share_link
  for each row execute function share_link_factors_fixed();

-- What a link may change on its own share (0030, 0041): its counts, each
-- only upwards; and now, binding the device it is first opened on, and
-- clearing its code's address once it has ended (share_link_factors_fixed
-- says when).
create or replace function share_link_link_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() = 'link' and (
       (to_jsonb(new) - array['open_count', 'last_opened_at', 'attempts', 'downloads_used',
                              'device_hash', 'code_email'])
         is distinct from
       (to_jsonb(old) - array['open_count', 'last_opened_at', 'attempts', 'downloads_used',
                              'device_hash', 'code_email'])
       or new.open_count < old.open_count
       or new.attempts < old.attempts
       or new.downloads_used < old.downloads_used
       or (new.device_hash is distinct from old.device_hash and new.device_hash is null)
       or (new.code_email is distinct from old.code_email and new.code_email is not null)) then
    raise exception 'a share link may only count its opens, downloads and wrong tries, bind its device and clear its code''s address'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------ the session

-- What was proved to open it: the link alone (null), its PIN or password,
-- an emailed code, or both.
alter table share_session drop constraint share_session_verified_by_check;
alter table share_session add constraint share_session_verified_by
  check (verified_by in ('pin', 'password', 'code', 'pin+code', 'password+code'));

-- ------------------------------------------------------------- the codes
--
-- One row a code sent: when, until when (10 minutes), how many tries it has
-- had (5 at most), and when it opened the link — once. The code itself is
-- never kept: code_hash is an HMAC-SHA256 under a key derived from the
-- master key (share-code-hmac), over the link, this row and the code, so a
-- dump or a backup cannot be searched for it — a plain hash of six digits
-- is reversed at once. A newer code ends the ones before it. The rows are
-- also what the sends are counted by: 3 in 15 minutes and 10 in a day, a
-- link. The worker clears them a day after they were sent, and with their
-- link; a restore deletes every one.

create table share_code (
  id           uuid primary key,
  household_id uuid not null references household(id) on delete cascade,
  share_id     uuid not null,
  flow         text not null default 'v2' constraint share_code_v2_only check (flow = 'v2'),
  code_hash    bytea not null constraint share_code_hash_length check (octet_length(code_hash) = 32),
  sent_at      timestamptz not null default now(),
  expires_at   timestamptz not null,
  attempts     int not null default 0 constraint share_code_attempts check (attempts between 0 and 5),
  used_at      timestamptz,
  constraint share_code_ten_minutes check (expires_at <= sent_at + interval '10 minutes'),
  foreign key (share_id, household_id, flow)
    references share_link (id, household_id, flow) on delete cascade
);
create index share_code_share_idx on share_code (share_id, sent_at);

alter table share_code enable row level security;
create policy share_code_tenant on share_code
  using (household_id = app_household()) with check (household_id = app_household());

-- A rule for each kind of caller (0030's, for this table). A link reaches
-- the codes of its own share: it sends them, tries them, and uses one. The
-- vault's own: every row, to clear them away. Nobody else — the family
-- included: a code is between the vault and the person the link is for.
create policy share_code_actor on share_code as restrictive
  using (case app_actor()
           when 'system' then true
           when 'link' then share_id = app_share()
           else false
         end);

-- A code, once sent, keeps what it is: its hash, its link and when it was
-- sent. Its tries only go up, it is used once, and its end only comes
-- sooner. Whoever asks.
create function share_code_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.code_hash is distinct from old.code_hash
     or new.share_id is distinct from old.share_id
     or new.household_id is distinct from old.household_id
     or new.sent_at is distinct from old.sent_at
     or new.attempts < old.attempts
     or (old.used_at is not null and new.used_at is distinct from old.used_at)
     or new.expires_at > old.expires_at then
    raise exception 'a code keeps what it was sent as: its tries only go up, and it is used once'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger share_code_writes before update on share_code
  for each row execute function share_code_writes();

-- ------------------------------------------------- the activity log (0042)
--
-- A link writes its own lines, and now one more: a code sent, with the
-- address masked. Held as 0042 holds the rest: under its own name, about
-- its own document or collection (or a document it gives), chained to the
-- log's head, and within a few minutes of now.
alter policy audit_event_link_insert on audit_event
  with check (case app_actor()
                when 'link' then actor_account_id is null
                                 and action in ('share.opened', 'share.viewed',
                                                'share.downloaded', 'share.locked',
                                                'share.code_sent')
                                 and detail->>'share_id' = app_share()::text
                                 and actor_label is not distinct from app_link_label()
                                 and object_type in ('document', 'collection')
                                 and app_link_may_name(object_type, object_id)
                                 and prev_hash is not distinct from audit_chain_head(household_id)
                                 and at between clock_timestamp() - interval '15 minutes'
                                            and clock_timestamp() + interval '15 minutes'
                else true
              end);
