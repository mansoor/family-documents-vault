-- An off-site copy of the nightly backups (0.9.0).
--
-- The worker's nightly backup is an encrypted pg_dump written to
-- /data/backups, on the same volume as the files: one lost disk, one
-- `docker volume rm`, and the vault and its backups go together. An owner
-- may now name a bucket on any S3-compatible service (Amazon S3, Backblaze
-- B2, Wasabi, MinIO…) in Settings → Backups, and after each backup the
-- worker copies the encrypted file there as it is — never anything
-- decrypted — and keeps the newest few, removing only its own older copies
-- under the prefix chosen.
--
--   backup_offsite   the household's bucket: its address (none for Amazon
--                    S3 itself, whose address the region gives), region,
--                    bucket, an optional prefix, how it is addressed, the
--                    access key's ID and its secret — sealed under a key
--                    derived from the master key with the household, the
--                    address, the bucket and the access key bound in, never
--                    returned by the API — how many copies to keep, whether
--                    it is on, whether a test passed, and what the worker
--                    last did. An owner's alone. That a test passed, and
--                    what became of each copy, are the vault's word, never an
--                    owner's: an owner may only clear them, back to
--                    untested, and turns the copy on only once a test passed.
--
-- A database dump holds every household's rows, so the worker copies it
-- only while the database holds one household: the self-hosted vault's.

create table backup_offsite (
  household_id      uuid primary key references household(id) on delete cascade,
  -- http or https, a host and maybe a port, and nothing else — no sign-in,
  -- path, query or fragment. None: Amazon S3, by its region.
  endpoint          text
                      constraint backup_offsite_endpoint
                      check (char_length(endpoint) between 8 and 300
                             and endpoint ~ '^https?://[^/?#@[:space:]]+$'),
  region            text
                      constraint backup_offsite_region
                      check (region ~ '^[A-Za-z0-9-]{1,64}$'),
  bucket            text not null
                      constraint backup_offsite_bucket
                      check (bucket ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$'),
  -- A folder inside the bucket: names joined by '/', none of them . or ..,
  -- no leading or trailing '/'. The worker writes, and removes, only there.
  prefix            text
                      constraint backup_offsite_prefix
                      check (char_length(prefix) between 1 and 200
                             and prefix ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
                             and prefix !~ '(^|/)\.\.?(/|$)'),
  -- address/bucket (MinIO and most servers run at home), or bucket.address.
  path_style        boolean not null default true,
  access_key_id     text not null
                      constraint backup_offsite_access_key_id
                      check (access_key_id ~ '^[!-~]{1,128}$'),
  -- AES-256-GCM under deriveKey(master, 'backup-offsite-credentials'), the
  -- household, address, bucket and access key bound in (MASTER_SEALED): it
  -- opens for that bucket alone, and is moved by rotate-master-key, and by
  -- a restore of a backup made under an older key, as the other sealed
  -- secrets are.
  secret_encrypted  bytea
                      constraint backup_offsite_secret
                      check (octet_length(secret_encrypted) between 29 and 4096),
  -- How many of its own copies the worker keeps there; older ones go.
  retain_count      integer not null default 30
                      constraint backup_offsite_retain check (retain_count between 1 and 365),
  enabled           boolean not null default false,
  -- When it was last turned on: a copy is due within two days of it (the
  -- worker's FDV_BACKUP_OFFSITE_LATE_DAYS), and a failure before it is
  -- not this incident's.
  enabled_at        timestamptz,
  -- Whether a test (write a small file there, then delete it) passed.
  status            text not null default 'untested'
                      constraint backup_offsite_status check (status in ('untested', 'ok', 'failed')),
  last_tested_at    timestamptz,
  test_problem      text
                      constraint backup_offsite_test_problem
                      check (test_problem in ('credentials_rejected', 'bucket_missing',
                                              'permission_denied', 'unreachable',
                                              'verification_failed', 'not_found', 'unknown')),
  -- Whether the key may delete there, as the last test found: null until a
  -- test passed. A key that may not (a write-only key, with the bucket's own
  -- lifecycle rule removing old copies) is a choice, not a failure: the
  -- worker then removes nothing.
  can_delete        boolean,
  -- What the worker last did: when it tried, when a copy last went whole,
  -- its name and size, and why the last one did not. A reason, never words
  -- from the provider, never a secret.
  last_attempt_at   timestamptz,
  last_copy_at      timestamptz,
  last_copy_object  text
                      constraint backup_offsite_last_copy_object
                      check (char_length(last_copy_object) between 1 and 300),
  last_copy_bytes   bigint
                      constraint backup_offsite_last_copy_bytes check (last_copy_bytes >= 0),
  last_result       text
                      constraint backup_offsite_last_result check (last_result in ('ok', 'failed')),
  last_problem      text
                      constraint backup_offsite_last_problem
                      check (last_problem in ('credentials_rejected', 'bucket_missing',
                                              'permission_denied', 'unreachable',
                                              'verification_failed', 'not_found', 'unknown',
                                              'several_households', 'secret_unopened')),
  -- When the owners were last told the copy is failing or late: once an
  -- incident, cleared by the next copy that goes.
  alerted_at        timestamptz,
  updated_by        uuid references account(id) on delete set null,
  updated_at        timestamptz not null default now(),
  -- On only once a test of what is saved passed, and with a secret to sign in with.
  constraint backup_offsite_on_tested check (not enabled or (status = 'ok' and secret_encrypted is not null))
);

alter table backup_offsite enable row level security;
create policy backup_offsite_tenant on backup_offsite
  using (household_id = app_household()) with check (household_id = app_household());
-- An owner's alone, and the vault's: nobody else signed in, no link, no
-- signed-out page.
create policy backup_offsite_actor on backup_offsite as restrictive
  using (case app_actor()
           when 'account' then app_role() = 'owner'
           when 'system' then true
           else false
         end);
-- Never a connected app's, whatever else it may read (0110).
create policy backup_offsite_no_app on backup_offsite as restrictive for all
  using ((select current_setting('app.actor', true)) is distinct from 'connected_app')
  with check ((select current_setting('app.actor', true)) is distinct from 'connected_app');

-- An owner writes it as themselves. Whether a test passed, and what became
-- of each copy, are the vault's to say: an owner only ever clears them,
-- back to untested. A new address, bucket, prefix, key or secret waits for
-- a test of its own, and is never copied to before one: changing any of
-- them turns the copy off.
create function backup_offsite_account_writes() returns trigger
  language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app_actor() is distinct from 'account' then
    return new;
  end if;
  if new.updated_by is distinct from app_account() then
    raise exception 'an owner sets up the off-site backup copy as themselves'
      using errcode = 'insufficient_privilege';
  end if;
  if (tg_op = 'INSERT'
      or (new.status, new.last_tested_at, new.test_problem, new.can_delete)
         is distinct from (old.status, old.last_tested_at, old.test_problem, old.can_delete))
     and (new.status <> 'untested' or new.last_tested_at is not null
          or new.test_problem is not null or new.can_delete is not null) then
    raise exception 'whether a test of the off-site copy passed is the vault''s to say'
      using errcode = 'insufficient_privilege';
  end if;
  if (tg_op = 'INSERT' and (new.last_attempt_at, new.last_copy_at, new.last_copy_object,
                            new.last_copy_bytes, new.last_result, new.last_problem,
                            new.alerted_at) is distinct from
                           (null::timestamptz, null::timestamptz, null::text, null::bigint,
                            null::text, null::text, null::timestamptz))
     or (tg_op = 'UPDATE' and (new.last_attempt_at, new.last_copy_at, new.last_copy_object,
                               new.last_copy_bytes, new.last_result, new.last_problem,
                               new.alerted_at)
                              is distinct from
                              (old.last_attempt_at, old.last_copy_at, old.last_copy_object,
                               old.last_copy_bytes, old.last_result, old.last_problem,
                               old.alerted_at)) then
    raise exception 'what became of each off-site copy is the vault''s to say'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and (new.status <> 'untested' or new.enabled)
     and (new.endpoint, new.region, new.bucket, new.prefix, new.path_style,
          new.access_key_id, new.secret_encrypted)
         is distinct from (old.endpoint, old.region, old.bucket, old.prefix, old.path_style,
                           old.access_key_id, old.secret_encrypted) then
    raise exception 'a new bucket, key or secret waits for a test of its own'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger backup_offsite_account_writes before insert or update on backup_offsite
  for each row execute function backup_offsite_account_writes();
