import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  binding,
  CHUNK_SIZE,
  DecryptStream,
  deriveKey,
  EncryptStream,
  EnvKeyProvider,
  HEADER_BYTES,
  KEK_PURPOSE,
  newKey,
  openIdentity,
  openPrivate,
  ScopeKeys,
  sealIdentity,
  wrapKey,
} from '@fdv/crypto';
import {
  applyPrivileges,
  createDb,
  createPool,
  listMigrations,
  migrateUp,
  withSystem,
} from '@fdv/db';
import {
  createEmptyDatabase,
  createTestDatabase,
  privilegeSnapshot,
  testAdminUrl,
  type TestDatabase,
} from '@fdv/db/testing';
import { readAll } from '@fdv/storage';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupDatabase } from './backup.js';
import { libpqConnection } from './libpq.js';
import { restoreSummary } from '../restore-summary.js';
import {
  backupBefore,
  checkRestored,
  newestBackup,
  restoreBackup,
  RestoreIncomplete,
  RestoreRefused,
  restoreDrill,
} from './restore.js';

/**
 * A backup is only as good as the vault it gives back.
 *
 * Until 0.4.5 the nightly dump, taken without privileges, came back as a
 * database the application role could not read at all, and the drill —
 * counting rows as the owner — said all was well.
 */

const MASTER = 'restore-test-master-secret-at-least-32-bytes';
const KEY = deriveKey(MASTER, 'database-backup');
/** The vault's scope keys, under the same master key: what a restore seals with (0.5.8). */
const KEYS = new ScopeKeys(new EnvKeyProvider(MASTER));
const quiet = () => undefined;
const TAG = 16; // AES-GCM tag after each sealed chunk
/** A person's photo as a backup holds it: sealed bytes, whatever they are (0040). */
const PHOTO_SEALED = randomBytes(600);
/** The first person's identity details, as the backup holds them sealed (0050). */
const IDENTITY_SEED = {
  shared: { given_name: 'One', ids: [{ id: 'p1', kind: 'passport', number: 'RESTORE-P-1' }] },
  only_me: { notes: 'restored, and still mine' },
} as const;

/**
 * pg_dump and psql of the server's own major version, as the worker image
 * pairs them. A newer pg_dump writes settings an older server refuses
 * (pg_dump 17 sets transaction_timeout), so a mismatched pair would fail
 * for a reason the vault never meets. Returns the folder to put first on
 * PATH ('' for PATH as it is), or null if there is no such pair here.
 */
async function matchingPgBin(): Promise<string | null> {
  const url = testAdminUrl();
  if (!url) return null;
  const server = await withClient(url, (c) =>
    c.query<{ v: string }>("select current_setting('server_version_num') as v"),
  );
  const major = Math.floor(Number(server.rows[0]?.v) / 10000);
  const candidates = [
    process.env.FDV_TEST_PG_BIN,
    '',
    `/usr/lib/postgresql/${major}/bin`, // Debian and Ubuntu, CI's runner
    `/usr/libexec/postgresql${major}`, // Alpine, the worker image
  ].filter((d): d is string => d !== undefined);
  for (const dir of candidates) {
    const tool = (name: string) => (dir ? path.join(dir, name) : name);
    try {
      const dump = execFileSync(tool('pg_dump'), ['--version'], { encoding: 'utf8' });
      execFileSync(tool('psql'), ['--version'], { stdio: 'ignore' });
      if (Number(/(\d+)/.exec(dump.replace(/^[^)]*\)/, ''))?.[1]) === major) return dir;
    } catch {
      // not here
    }
  }
  return null;
}
const PG_BIN = await matchingPgBin().catch(() => null);
// On CI the round trip must run; anywhere else it runs when it can.
const MUST_RESTORE = process.env.CI === 'true';

async function withClient<T>(url: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

const snapshot = (url: string) => withClient(url, privilegeSnapshot);
const sql = (url: string, text: string, params: unknown[] = []) =>
  withClient(url, (c) => c.query<Record<string, unknown>>(text, params));

/** pg-boss's tables, installed by the owner as the API's start does, with a job in them. */
async function installQueue(url: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: url,
    schema: 'pgboss',
    migrate: true,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  await boss.createQueue('restore.test');
  await boss.send('restore.test', { hello: 'world' });
  await boss.stop({ graceful: false });
}

/**
 * A household with two people, three documents and somebody signed in —
 * and what a backup should not bring back as it was: a password-reset link
 * still out, a request to demote the other owner that is past its seven
 * days, and a browser registered for notifications before 0.4.2.
 */
async function seed(url: string): Promise<string> {
  const hh = randomUUID();
  await withClient(url, async (c) => {
    await c.query("insert into household (id, name, timezone) values ($1, 'Restored', 'UTC')", [
      hh,
    ]);
    const m = await c.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'One'), ($1, 'Two') returning id",
      [hh],
    );
    const a = await c.query<{ id: string }>(
      'insert into account (email) values ($1) returning id',
      [`restore-${hh}@example.test`],
    );
    const account = a.rows[0]?.id;
    await c.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [account, hh, m.rows[0]?.id],
    );
    await c.query(
      `insert into session (account_id, household_id, refresh_hash, expires_at)
       values ($1, $2, $3, now() + interval '30 days')`,
      [account, hh, randomBytes(32)],
    );
    await c.query('insert into document (household_id) select $1 from generate_series(1, 3)', [hh]);
    // An export, made and still to be downloaded (5.27: a restore ends it);
    // and one that failed, which never could be (and is not counted).
    await c.query(
      `insert into export (household_id, requested_by, state, expires_at)
       values ($1, $2, 'done', now() + interval '7 days'), ($1, $2, 'failed', null)`,
      [hh, account],
    );
    // Collections of documents, where the schema has them (0036): one for
    // everyone and the first member's Only me, each with all three in it.
    // A schema from before 0039 has them by their old names, as a backup
    // made then does.
    const schema = await c.query<{ collections: boolean; lists: boolean }>(
      `select to_regclass('public.doc_collection') is not null as collections,
              to_regclass('public.doc_list') is not null as lists`,
    );
    const names = schema.rows[0]?.collections
      ? { table: 'doc_collection', items: 'doc_collection_item', key: 'collection_id' }
      : schema.rows[0]?.lists
        ? { table: 'doc_list', items: 'doc_list_item', key: 'list_id' }
        : null;
    if (names) {
      await c.query(
        `insert into ${names.table} (household_id, name, audience, owner_member_id)
         values ($1, 'For the broker', 'everyone', $2), ($1, 'Divorce', 'only_me', $2)`,
        [hh, m.rows[0]?.id],
      );
      await c.query(
        `insert into ${names.items} (${names.key}, document_id, household_id, position)
         select c.id, d.id, $1, (row_number() over (partition by c.id order by d.id))::int
           from ${names.table} c join document d on d.household_id = c.household_id
          where c.household_id = $1`,
        [hh],
      );
    }

    // People's photos, where the schema has them (0040): the first member's
    // made, the second's still on its way when the backup was taken.
    const photos = await c.query<{ has: boolean }>(
      "select to_regclass('public.member_photo') is not null as has",
    );
    if (photos.rows[0]?.has) {
      const vault = await c.query<{ id: string }>(
        "insert into vault (household_id, kind, label) values ($1, 'local', 'This computer') returning id",
        [hh],
      );
      await c.query(
        `insert into member_photo (household_id, member_id, state, sealed, ready_at)
         values ($1, $2, 'ready', $3, now())`,
        [hh, m.rows[0]?.id, PHOTO_SEALED],
      );
      await c.query(
        `insert into member_photo
           (household_id, member_id, state, source_key, source_vault_id, source_key_wrapped)
         values ($1, $2, 'processing', $3, $4, '\\x00')`,
        [hh, m.rows[1]?.id, `${hh}/members/${m.rows[1]?.id}/incoming/x.enc`, vault.rows[0]?.id],
      );
    }

    const b = await c.query<{ id: string }>(
      'insert into account (email) values ($1) returning id',
      [`restore-other-${hh}@example.test`],
    );
    const other = b.rows[0]?.id;
    await c.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [other, hh, m.rows[1]?.id],
    );
    await c.query(
      `insert into owner_change_request
         (household_id, target_account, requested_by, action, opens_at, lapses_at)
       values ($1, $2, $3, 'demote', now() - interval '1 day', now() + interval '20 days')`,
      [hh, other, account],
    );
    // And one about the first owner that lapsed long ago: over already, so
    // the restore leaves it as it is rather than calling it refused.
    await c.query(
      `insert into owner_change_request
         (household_id, target_account, requested_by, action, requested_at, opens_at, lapses_at)
       values ($1, $2, $3, 'demote', now() - interval '60 days', now() - interval '53 days',
               now() - interval '30 days')`,
      [hh, account, other],
    );
    await c.query(
      `insert into password_reset (account_id, token_hash, issued_by, expires_at)
       values ($1, $2, 'self', now() + interval '1 hour')`,
      [account, randomBytes(32)],
    );
    // And a link an owner was given to hand over, where the schema has them
    // (0052): ended by the restore with every other.
    const handover = await c.query<{ has: boolean }>(
      `select exists (select 1 from pg_attribute
                       where attrelid = 'public.password_reset'::regclass
                         and attname = 'handover' and not attisdropped) as has`,
    );
    if (handover.rows[0]?.has) {
      await c.query(
        `insert into password_reset
           (account_id, token_hash, issued_by, household_id, issued_by_account, handover, expires_at)
         values ($1, $2, 'owner', $3, $4, true, now() + interval '1 hour')`,
        [other, randomBytes(32), hh, account],
      );
    }
    await c.query(
      `insert into device (household_id, account_id, endpoint, p256dh, auth, session_id)
       values ($1, $2, $3, 'k', 'a', null)`,
      [hh, account, `https://push.example.test/${hh}`],
    );
    // Share links, where the schema has them (0016): one live, one taken
    // back, one run out; and, where it has sessions (0037), the live one
    // open in somebody's browser.
    const links = await c.query<{ has: boolean }>(
      "select to_regclass('public.share_link') is not null as has",
    );
    if (links.rows[0]?.has) {
      await c.query(
        `insert into share_link (household_id, document_id, token_hash, created_by, expires_at, revoked_at)
         select $1, d.id, v.hash, $2, v.expires_at, v.revoked_at
           from (select id from document where household_id = $1 limit 1) d,
                (values ($3::bytea, now() + interval '7 days', null::timestamptz),
                        ($4::bytea, now() + interval '7 days', now() - interval '1 day'),
                        ($5::bytea, now() - interval '1 day', null::timestamptz))
                  as v(hash, expires_at, revoked_at)`,
        [hh, account, randomBytes(32), randomBytes(32), randomBytes(32)],
      );
      // And, where the schema has them (0042), a live link to the collection
      // for everyone, made with one of its documents.
      const collectionLinks = await c.query<{ has: boolean }>(
        "select to_regclass('public.share_link_item') is not null as has",
      );
      if (collectionLinks.rows[0]?.has) {
        const made = await c.query<{ id: string; collection_id: string }>(
          `insert into share_link (household_id, collection_id, token_hash, created_by, expires_at)
           select $1, c.id, $2, $3, now() + interval '7 days'
             from doc_collection c where c.household_id = $1 and c.audience = 'everyone'
           returning id, collection_id`,
          [hh, randomBytes(32), account],
        );
        await c.query(
          `insert into share_link_item (share_id, household_id, collection_id, document_id, position)
           select $1, $2, $3, i.document_id, 1
             from doc_collection_item i where i.collection_id = $3
            order by i.position limit 1`,
          [made.rows[0]?.id, hh, made.rows[0]?.collection_id],
        );
      }
      const sessions = await c.query<{ has: boolean }>(
        "select to_regclass('public.share_session') is not null as has",
      );
      if (sessions.rows[0]?.has) {
        await c.query(
          `insert into share_session (household_id, share_id, cookie_hash, expires_at)
           select $1, s.id, $2, now() + interval '1 hour' from share_link s
            where s.household_id = $1 and s.revoked_at is null and s.expires_at > now()
              and s.document_id is not null`,
          [hh, randomBytes(32)],
        );
        // And, where the schema counts them (0041), the download that
        // session has had.
        const uses = await c.query<{ has: boolean }>(
          "select to_regclass('public.share_session_use') is not null as has",
        );
        if (uses.rows[0]?.has) {
          await c.query(
            `insert into share_session_use (household_id, session_id, share_id, document_id, kind)
             select $1, s.id, s.share_id, l.document_id, 'downloaded'
               from share_session s join share_link l on l.id = s.share_id
              where s.household_id = $1`,
            [hh],
          );
        }
      }
      // And, where the schema has them (0043), a code emailed for the live
      // document's link, not used yet.
      const codes = await c.query<{ has: boolean }>(
        "select to_regclass('public.share_code') is not null as has",
      );
      if (codes.rows[0]?.has) {
        await c.query(
          `insert into share_code (id, household_id, share_id, code_hash, expires_at)
           select gen_random_uuid(), $1, s.id, $2, now() + interval '10 minutes' from share_link s
            where s.household_id = $1 and s.revoked_at is null and s.expires_at > now()
              and s.document_id is not null`,
          [hh, randomBytes(32)],
        );
      }
    }
    // Requests to send documents, where the schema has them (0044): one
    // live, open in a sender's browser with a code on its way, and one
    // taken back.
    const requests = await c.query<{ has: boolean }>(
      "select to_regclass('public.upload_request') is not null as has",
    );
    if (requests.rows[0]?.has) {
      await c.query(
        `insert into upload_request
           (household_id, created_by, requester_member_id, title, token_hash, expires_at, revoked_at)
         values ($1, $2, $3, 'Tax papers', $4, now() + interval '30 days', null),
                ($1, $2, $3, 'Taken back', $5, now() + interval '30 days', now() - interval '1 day')`,
        [hh, account, m.rows[0]?.id, randomBytes(32), randomBytes(32)],
      );
      await c.query(
        `insert into upload_session (household_id, request_id, cookie_hash, expires_at)
         select $1, id, $2, now() + interval '1 hour' from upload_request
          where household_id = $1 and revoked_at is null`,
        [hh, randomBytes(32)],
      );
      await c.query(
        `insert into upload_code (household_id, request_id, code_hash, expires_at)
         select $1, id, $2, now() + interval '5 minutes' from upload_request
          where household_id = $1 and revoked_at is null`,
        [hh, randomBytes(32)],
      );
      // And, where the schema looks after them (0047), files sent through
      // the live request: two waiting — one whose bytes are kept, one whose
      // bytes go after the backup is made (filed, refused, or removed after
      // 30 days) — and one filed, its bytes not yet known to be gone.
      const reviewed = await c.query<{ has: boolean }>(
        `select exists (select 1 from pg_attribute
                         where attrelid = to_regclass('public.incoming_file')
                           and attname = 'object_removed_at' and not attisdropped) as has`,
      );
      if (reviewed.rows[0]?.has) {
        const scope = await c.query<{ id: string }>(
          "insert into scope_key (household_id, kind, key_wrapped) values ($1, 'adults', '\\x00') returning id",
          [hh],
        );
        const kept = await c.query<{ id: string }>(
          "insert into vault (household_id, kind, label) values ($1, 'local', 'Incoming') returning id",
          [hh],
        );
        await c.query(
          `insert into incoming_file
             (household_id, request_id, review_by, requester_member_id, state, original_name,
              mime, byte_size, sha256, cipher_bytes, cipher_sha256, storage_key, vault_id,
              file_key_wrapped, wrapped_by_scope, scope, received_at, submitted_at, decided_at)
           select $1, r.id, r.review_by, r.requester_member_id, f.state, 'x.pdf',
                  'application/pdf', 1, '\\x00', 1, '\\x00',
                  $4::text || '/incoming/' || f.name || '.enc',
                  $2, '\\x00', $3, 'member', now(), now(),
                  case when f.state = 'accepted' then now() end
             from upload_request r,
                  (values ('kept', 'received'), ('gone', 'received'), ('filed', 'accepted'))
                    as f(name, state)
            where r.household_id = $1 and r.revoked_at is null`,
          [hh, kept.rows[0]?.id, scope.rows[0]?.id, hh],
        );
      }
    }
    // People's identity details, where the schema has them (0050): the
    // first person's shared part under the household's identity key, their
    // Only me part under their own member key, each sealed as the API seals
    // it; the household's audience all adults, and a widening to the whole
    // family waiting for its notice.
    const identity = await c.query<{ has: boolean }>(
      "select to_regclass('public.member_identity') is not null as has",
    );
    if (identity.rows[0]?.has) {
      const kek = deriveKey(MASTER, KEK_PURPOSE);
      const person = m.rows[0]?.id as string;
      for (const part of ['shared', 'only_me'] as const) {
        const ref =
          part === 'shared'
            ? { householdId: hh, kind: 'identity' as const }
            : { householdId: hh, kind: 'member' as const, memberId: person };
        const key = newKey();
        const scope = await c.query<{ id: string }>(
          `insert into scope_key (household_id, kind, member_id, key_wrapped)
           values ($1, $2, $3, $4) returning id`,
          [hh, ref.kind, part === 'shared' ? null : person, wrapKey(key, kek, binding(ref))],
        );
        const sealed = sealIdentity(
          key,
          { householdId: hh, memberId: person, part },
          IDENTITY_SEED[part],
        );
        await c.query(
          `insert into member_identity
             (household_id, member_id, part, sealed, dek_wrapped, wrapped_by_scope, filled)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [hh, person, part, sealed.sealed, sealed.dek_wrapped, scope.rows[0]?.id, ['given_name']],
        );
      }
      await c.query("update household set identity_audience = 'adults' where id = $1", [hh]);
      await c.query(
        `insert into notice_request (household_id, kind, subject, requested_by, notice_until)
         values ($1, 'identity_audience', 'family', $2, now() + interval '72 hours')`,
        [hh, account],
      );
    }
  });
  return hh;
}

/** A copy of the migrations up to a version: an older release's schema. */
async function migrationsUpTo(version: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fdv-migrations-'));
  for (const m of await listMigrations()) {
    if (m.version <= version) await copyFile(m.file, path.join(dir, path.basename(m.file)));
  }
  return dir;
}

async function migrate(url: string, opts: { dir?: string; privileges?: boolean } = {}) {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrateUp(pool, opts.dir, undefined, { privileges: opts.privileges ?? true });
  } finally {
    await pool.end();
  }
}

const tablesIn = async (url: string) =>
  (
    await withClient(url, (c) =>
      c.query<{ n: number }>(
        `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'`,
      ),
    )
  ).rows[0]?.n;

/** A dump undone, changed and sealed again under the same key. */
async function reseal(file: string, change: (plain: string) => string): Promise<string> {
  const dec = new DecryptStream(KEY);
  createReadStream(file).pipe(dec);
  const plain = change((await readAll(dec)).toString('utf8'));
  const out = `${file}.${randomBytes(3).toString('hex')}.enc`;
  await pipeline(
    Readable.from([Buffer.from(plain)]),
    new EncryptStream(KEY),
    createWriteStream(out),
  );
  return out;
}

// What a load without privileges does: the application role keeps nothing,
// and the default privileges are gone.
const STRIP = `
revoke all on all tables in schema public, pgboss from fdv_app;
revoke all on all sequences in schema public, pgboss from fdv_app;
revoke all on all functions in schema public, pgboss from fdv_app;
revoke all on schema public, pgboss from fdv_app;
alter default privileges in schema public revoke all on tables from fdv_app;
alter default privileges in schema public revoke all on sequences from fdv_app;
alter default privileges in schema pgboss revoke all on tables from fdv_app;
alter default privileges in schema pgboss revoke all on sequences from fdv_app;
alter default privileges in schema pgboss revoke all on functions from fdv_app;`;

describe.skipIf(!testAdminUrl())("the application role's privileges", () => {
  let db: TestDatabase;
  let fromMigrations: string[];

  beforeAll(async () => {
    // What the migrations alone give — not the shared template, which is
    // built with the privileges already applied and so could not disagree.
    db = await createEmptyDatabase();
    await migrate(db.adminUrl, { privileges: false });
    await installQueue(db.adminUrl);
    fromMigrations = await snapshot(db.adminUrl);
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  });

  it('privileges.ts gives exactly what the migrations give, adding nothing and taking nothing', async () => {
    // The reference covers what matters: the queue, and the narrowed tables.
    expect(fromMigrations).toContain('rel public.audit_event fdv_app INSERT');
    expect(fromMigrations).not.toContain('rel public.audit_event fdv_app UPDATE');
    expect(fromMigrations).toContain('rel public.instance fdv_app SELECT');
    expect(fromMigrations).not.toContain('rel public.instance fdv_app INSERT');
    expect(fromMigrations.some((l) => l.startsWith('rel pgboss.'))).toBe(true);

    await withClient(db.adminUrl, applyPrivileges);
    expect(await snapshot(db.adminUrl)).toEqual(fromMigrations);
  });

  it("a database that has lost them — as a backup loads — is given them back by the vault's start", async () => {
    await sql(db.adminUrl, STRIP);
    const stripped = await snapshot(db.adminUrl);
    expect(stripped.filter((l) => / fdv_app /.test(l))).toEqual([]);

    await migrate(db.adminUrl); // nothing to migrate: this is every later start
    expect(await snapshot(db.adminUrl)).toEqual(fromMigrations);
  });

  it('can be applied to a database from an older release, before its migrations run', async () => {
    const older = await createEmptyDatabase();
    const dir = await migrationsUpTo(13); // before invitations, share links, the instance
    try {
      await migrate(older.adminUrl, { dir, privileges: false });
      await sql(older.adminUrl, STRIP);
      await withClient(older.adminUrl, applyPrivileges);
      const { rows } = await sql(
        older.adminUrl,
        `select has_table_privilege('fdv_app', 'public.household', 'select') as ok`,
      );
      expect(rows[0]?.ok).toBe(true);
    } finally {
      await older.drop();
      await rm(dir, { recursive: true, force: true });
    }
    // Thirteen migrations on an empty database, while the rest of the suite
    // runs: more than the default 5 s under load.
  }, 30_000);
});

describe.skipIf(!testAdminUrl())('checking a restored vault', () => {
  let vault: TestDatabase;
  const target = () => ({ adminUrl: vault.adminUrl, appUrl: vault.appUrl });

  beforeAll(async () => {
    vault = await createTestDatabase();
    await installQueue(vault.adminUrl);
    await seed(vault.adminUrl);
  }, 120_000);
  afterAll(async () => {
    await vault?.drop();
  });

  it('passes a vault the application role can read, and counts what it sees', async () => {
    const report = await checkRestored(target());
    expect(report).toMatchObject({ households: 1, members: 2, documents: 3 });
  });

  it('notices a table the application role cannot read', async () => {
    await sql(vault.adminUrl, 'revoke select on public.household from fdv_app');
    await expect(checkRestored(target())).rejects.toThrow(/cannot read .*household/);
    await sql(vault.adminUrl, 'grant select on public.household to fdv_app');
  });

  it('notices a table whose privacy wall is down', async () => {
    await sql(vault.adminUrl, 'alter table public.member disable row level security');
    await expect(checkRestored(target())).rejects.toThrow(/row-level security is off on member/);
    await sql(vault.adminUrl, 'alter table public.member enable row level security');
  });

  it('notices a table a stranger could read', async () => {
    // A policy that lets everybody in is still a policy; the check looks at
    // what a household that is not this one actually sees.
    await sql(vault.adminUrl, 'create policy everybody on public.document using (true)');
    await expect(checkRestored(target())).rejects.toThrow(/not its own in document/);
    await sql(vault.adminUrl, 'drop policy everybody on public.document');
  });

  it('a restore passes with built-in types that belong to no household', async () => {
    // Built-in types and the library's fields belong to no household, and
    // every household reads them (0031): that is not a stranger seeing
    // somebody else's rows. A household's own type, setting and field are
    // still its own, and still checked.
    const hh = (await sql(vault.adminUrl, 'select id from household')).rows[0]?.id as string;
    const shared = await sql(
      vault.adminUrl,
      `select (select count(*)::int from document_type where household_id is null) as types,
              (select count(*)::int from document_attribute where household_id is null) as fields`,
    );
    expect(shared.rows[0]?.types).toBeGreaterThan(0);
    expect(shared.rows[0]?.fields).toBeGreaterThan(0);
    await sql(
      vault.adminUrl,
      `insert into document_type (key, label, category, household_id)
         values ('h_restored22', 'Immigration case', 'legal', '${hh}');
       insert into document_type_setting (household_id, type_key, hidden)
         values ('${hh}', 'passport', true);
       insert into document_attribute (household_id, key, label, kind)
         values ('${hh}', 'h_restored22', 'Case number', 'text')`,
    );
    try {
      expect(await checkRestored(target())).toMatchObject({ households: 1, documents: 3 });

      // A household's own type opened to everybody is still caught.
      await sql(vault.adminUrl, 'create policy everybody on public.document_type using (true)');
      try {
        await expect(checkRestored(target())).rejects.toThrow(/not its own in document_type/);
      } finally {
        await sql(vault.adminUrl, 'drop policy everybody on public.document_type');
      }
    } finally {
      await sql(
        vault.adminUrl,
        `delete from document_attribute where household_id is not null;
         delete from document_type_setting;
         delete from document_type where household_id is not null`,
      );
    }
  });

  it('notices a caller who says nothing being given documents', async () => {
    // 0030's rule for the document, opened up: the tenant wall still holds,
    // but within the household a transaction that names no actor sees all.
    const { rows } = await sql(
      vault.adminUrl,
      `select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = 'document_actor'`,
    );
    const rule = rows[0]?.rule as string;
    await sql(
      vault.adminUrl,
      `alter policy document_actor on public.document using ((${rule}) or app_actor() is null)`,
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(/says nothing is given its documents/);
    } finally {
      await sql(vault.adminUrl, `alter policy document_actor on public.document using (${rule})`);
    }
    expect(await checkRestored(target())).toMatchObject({ documents: 3 });
  });

  it('notices a table that lost its rule for each kind of caller, or a link free to rewrite its share', async () => {
    const { rows } = await sql(
      vault.adminUrl,
      `select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = 'reminder_actor'`,
    );
    const rule = rows[0]?.rule as string;
    await sql(vault.adminUrl, 'drop policy reminder_actor on public.reminder');
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule for each kind of caller on reminder/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `create policy reminder_actor on public.reminder as restrictive using (${rule})`,
      );
    }

    // The read rule on the files gone, the write rules left: the files are
    // open to a signed-out page, and that is noticed (5.6 review).
    const { rows: file } = await sql(
      vault.adminUrl,
      `select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = 'document_version_actor'`,
    );
    const fileRule = file[0]?.rule as string;
    await sql(vault.adminUrl, 'drop policy document_version_actor on public.document_version');
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule for each kind of caller on document_version/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `create policy document_version_actor on public.document_version as restrictive using (${fileRule})`,
      );
    }

    // A rule opened up in place: it asks nobody anything.
    await sql(
      vault.adminUrl,
      'alter policy document_version_actor on public.document_version using (true)',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule for each kind of caller on document_version/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `alter policy document_version_actor on public.document_version using (${fileRule})`,
      );
    }

    // A rule that still asks, but lets a signed-out page through: the
    // documents are there to be given, and that is noticed.
    const { rows: doc } = await sql(
      vault.adminUrl,
      `select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = 'document_actor'`,
    );
    const docRule = doc[0]?.rule as string;
    await sql(
      vault.adminUrl,
      `alter policy document_actor on public.document using ((${docRule}) or app_actor() = 'anonymous')`,
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /a signed-out page is given its documents \(document\)/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `alter policy document_actor on public.document using (${docRule})`,
      );
    }

    // The link's trigger off, or on for a replica only (which never fires
    // for the vault's own sessions).
    for (const how of ['disable trigger', 'enable replica trigger']) {
      await sql(vault.adminUrl, `alter table public.share_link ${how} share_link_link_writes`);
      try {
        await expect(checkRestored(target()), how).rejects.toThrow(
          /guard the vault relies on is missing/,
        );
      } finally {
        await sql(
          vault.adminUrl,
          'alter table public.share_link enable trigger share_link_link_writes',
        );
      }
    }
    expect(await checkRestored(target())).toMatchObject({ documents: 3 });
  });

  it("notices 0031's types left open: a view reading as its owner, a rule gone, a key free to move", async () => {
    await sql(vault.adminUrl, 'alter view public.effective_document_type reset (security_invoker)');
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /effective_document_type would read with its owner's rights/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        'alter view public.effective_document_type set (security_invoker = true)',
      );
    }

    const { rows } = await sql(
      vault.adminUrl,
      `select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = 'document_type_setting_actor'`,
    );
    const rule = rows[0]?.rule as string;
    await sql(
      vault.adminUrl,
      'drop policy document_type_setting_actor on public.document_type_setting',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule for each kind of caller on document_type_setting/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `create policy document_type_setting_actor on public.document_type_setting as restrictive using (${rule})`,
      );
    }

    await sql(
      vault.adminUrl,
      'alter table public.document_type disable trigger document_type_fixed',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(/guard the vault relies on is missing/);
    } finally {
      await sql(
        vault.adminUrl,
        'alter table public.document_type enable trigger document_type_fixed',
      );
    }
    expect(await checkRestored(target())).toMatchObject({ documents: 3 });
  });

  it('notices an Only me collection open to the whole family, or collections that lost their rule (0036)', async () => {
    const ruleOf = async (name: string) =>
      (
        await sql(
          vault.adminUrl,
          `select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = '${name}'`,
        )
      ).rows[0]?.rule as string;
    const onlyMe = await ruleOf('doc_collection_only_me');
    const restoreRule = () =>
      sql(
        vault.adminUrl,
        `alter policy doc_collection_only_me on public.doc_collection using (${onlyMe})`,
      );

    // Opened up in place: nothing asks which member is asking.
    await sql(
      vault.adminUrl,
      'alter policy doc_collection_only_me on public.doc_collection using (true)',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule keeps a member's own to them on doc_collection/,
      );
    } finally {
      await restoreRule();
    }
    // Still asking, but letting somebody who made none through.
    await sql(
      vault.adminUrl,
      `alter policy doc_collection_only_me on public.doc_collection using ((${onlyMe}) or app_member() is null)`,
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /an Only me collection is open to somebody signed in who is not given it/,
      );
    } finally {
      await restoreRule();
    }

    // The items' rule for each kind of caller, gone.
    const items = await ruleOf('doc_collection_item_actor');
    await sql(
      vault.adminUrl,
      'drop policy doc_collection_item_actor on public.doc_collection_item',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule for each kind of caller on doc_collection_item/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `create policy doc_collection_item_actor on public.doc_collection_item as restrictive using (${items})`,
      );
    }
    // The guard that keeps an owner to marking deleted a collection nobody can
    // change any more, and to nothing else, turned off.
    await sql(
      vault.adminUrl,
      'alter table public.doc_collection disable trigger doc_collection_owner_writes',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(/guard the vault relies on is missing/);
    } finally {
      await sql(
        vault.adminUrl,
        'alter table public.doc_collection enable trigger doc_collection_owner_writes',
      );
    }
    expect(await checkRestored(target())).toMatchObject({ documents: 3 });
  });

  it("notices a person's photo open to a caller it is not for, or photos that lost their rule (0040)", async () => {
    const actor = (
      await sql(
        vault.adminUrl,
        "select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = 'member_photo_actor'",
      )
    ).rows[0]?.rule as string;
    const put = () =>
      sql(
        vault.adminUrl,
        `alter policy member_photo_actor on public.member_photo using (${actor})`,
      );
    // Anybody signed in, whatever their role or whoever they are.
    await sql(
      vault.adminUrl,
      `alter policy member_photo_actor on public.member_photo
         using ((${actor}) or (app_actor() = 'account' and app_member() is null))`,
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /a person's photo is open to somebody signed in who is not given it/,
      );
    } finally {
      await put();
    }
    // Every kind of caller, a link and a signed-out page among them.
    await sql(vault.adminUrl, 'drop policy member_photo_actor on public.member_photo');
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule for each kind of caller on member_photo/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `create policy member_photo_actor on public.member_photo as restrictive using (${actor})`,
      );
    }
    expect(await checkRestored(target())).toMatchObject({ documents: 3 });
  });

  it("notices a share link let into the household's other tables, or its snapshot unguarded (0042)", async () => {
    const ruleOf = async (name: string) =>
      (
        await sql(
          vault.adminUrl,
          `select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = '${name}'`,
        )
      ).rows[0]?.rule as string;

    // The rule that keeps a link to its sharer's own row, gone.
    const members = await ruleOf('member_link');
    await sql(vault.adminUrl, 'drop policy member_link on public.member');
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule keeps a share link out of member/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `create policy member_link on public.member as restrictive using (${members})`,
      );
    }
    // Still asking, but letting a link through to every membership.
    const memberships = await ruleOf('account_household_link');
    await sql(
      vault.adminUrl,
      `alter policy account_household_link on public.account_household
         using ((${memberships}) or app_actor() = 'link')`,
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /a share link it never made is given account_household/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `alter policy account_household_link on public.account_household using (${memberships})`,
      );
    }
    // The sign-ins, which belong to no household, opened to a link: their
    // wall down, or their rule letting it through.
    await sql(vault.adminUrl, 'alter table public.account disable row level security');
    try {
      await expect(checkRestored(target())).rejects.toThrow(/row-level security is off on account/);
    } finally {
      await sql(vault.adminUrl, 'alter table public.account enable row level security');
    }
    const accounts = await ruleOf('credential_not_a_link');
    await sql(
      vault.adminUrl,
      'alter policy credential_not_a_link on public.credential using (true)',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule keeps a share link out of credential/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `alter policy credential_not_a_link on public.credential using (${accounts})`,
      );
    }
    // A collection's snapshot, its rule for each kind of caller gone.
    const snapshotRule = await ruleOf('share_link_item_actor');
    await sql(vault.adminUrl, 'drop policy share_link_item_actor on public.share_link_item');
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule for each kind of caller on share_link_item/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `create policy share_link_item_actor on public.share_link_item as restrictive using (${snapshotRule})`,
      );
    }
    // A view-only link's pages that could not be drawn, their rule opened
    // up in place: it asks nobody anything.
    const failedRule = await ruleOf('share_page_failure_actor');
    await sql(
      vault.adminUrl,
      'alter policy share_page_failure_actor on public.share_page_failure using (true)',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule for each kind of caller on share_page_failure/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `alter policy share_page_failure_actor on public.share_page_failure using (${failedRule})`,
      );
    }
    // And what a link is to, free to change.
    await sql(
      vault.adminUrl,
      'alter table public.share_link disable trigger share_link_target_fixed',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(/guard the vault relies on is missing/);
    } finally {
      await sql(
        vault.adminUrl,
        'alter table public.share_link enable trigger share_link_target_fixed',
      );
    }
    expect(await checkRestored(target())).toMatchObject({ documents: 3 });
  });

  it("notices a link's emailed codes open to a caller, or what protects a link unguarded (0043)", async () => {
    const rule = (
      await sql(
        vault.adminUrl,
        "select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = 'share_code_actor'",
      )
    ).rows[0]?.rule as string;
    // The codes' rule opened up in place: it asks nobody anything.
    await sql(vault.adminUrl, 'alter policy share_code_actor on public.share_code using (true)');
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule for each kind of caller on share_code/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `alter policy share_code_actor on public.share_code using (${rule})`,
      );
    }
    // Still asking, but letting a link through to every link's codes.
    await sql(
      vault.adminUrl,
      `alter policy share_code_actor on public.share_code using ((${rule}) or app_actor() = 'link')`,
    );
    await sql(
      vault.adminUrl,
      `insert into share_code (id, household_id, share_id, code_hash, expires_at)
       select gen_random_uuid(), s.household_id, s.id, '\\x${'00'.repeat(32)}'::bytea,
              now() + interval '5 minutes'
         from share_link s where s.flow = 'v2' limit 1`,
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /a share link it never made is given its documents \(share_code\)/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `alter policy share_code_actor on public.share_code using (${rule})`,
      );
      await sql(vault.adminUrl, 'delete from share_code');
    }
    // And the guards: a link's protection free to change, or a code's.
    for (const [table, trigger] of [
      ['share_link', 'share_link_factors_fixed'],
      ['share_code', 'share_code_writes'],
    ] as const) {
      await sql(vault.adminUrl, `alter table public.${table} disable trigger ${trigger}`);
      try {
        await expect(checkRestored(target())).rejects.toThrow(
          /guard the vault relies on is missing/,
        );
      } finally {
        await sql(vault.adminUrl, `alter table public.${table} enable trigger ${trigger}`);
      }
    }
    expect(await checkRestored(target())).toMatchObject({ documents: 3 });
  });

  it("notices an upload link let into the household's other tables, or its lines unguarded (0044, A74)", async () => {
    const ruleOf = async (name: string) =>
      (
        await sql(
          vault.adminUrl,
          `select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = '${name}'`,
        )
      ).rows[0]?.rule as string;
    // The rule that keeps an upload link to its requester's own row, gone:
    // the share link's, beside it, does not count for it.
    const members = await ruleOf('member_upload');
    await sql(vault.adminUrl, 'drop policy member_upload on public.member');
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule keeps an upload link out of member/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `create policy member_upload on public.member as restrictive using (${members})`,
      );
    }
    // Still asking, but letting an upload link through to every sign-in.
    const sessions = await ruleOf('session_upload');
    await sql(
      vault.adminUrl,
      `alter policy session_upload on public.session using ((${sessions}) or app_actor() = 'upload')`,
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /an upload link it never made is given session/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `alter policy session_upload on public.session using (${sessions})`,
      );
    }
    // And its lines in the activity log, unguarded.
    await sql(
      vault.adminUrl,
      'alter table public.audit_event disable trigger audit_event_upload_line',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(/guard the vault relies on is missing/);
    } finally {
      await sql(
        vault.adminUrl,
        'alter table public.audit_event enable trigger audit_event_upload_line',
      );
    }
    expect(await checkRestored(target())).toMatchObject({ documents: 3 });
  });

  it('notices a request for one person to review open to others, or upload tables that lost their rule (0044)', async () => {
    const ruleOf = async (name: string) =>
      (
        await sql(
          vault.adminUrl,
          `select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = '${name}'`,
        )
      ).rows[0]?.rule as string;
    const request = await ruleOf('upload_request_actor');
    await sql(
      vault.adminUrl,
      `alter policy upload_request_actor on public.upload_request
         using ((${request}) or (app_actor() = 'account' and app_member() is null))`,
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /a request for one person to review is open to somebody signed in who is not given it/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `alter policy upload_request_actor on public.upload_request using (${request})`,
      );
    }
    const session = await ruleOf('upload_session_actor');
    await sql(vault.adminUrl, 'drop policy upload_session_actor on public.upload_session');
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule for each kind of caller on upload_session/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `create policy upload_session_actor on public.upload_session as restrictive using (${session})`,
      );
    }
    await sql(
      vault.adminUrl,
      'alter table public.incoming_file disable trigger incoming_file_upload_writes',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(/guard the vault relies on is missing/);
    } finally {
      await sql(
        vault.adminUrl,
        'alter table public.incoming_file enable trigger incoming_file_upload_writes',
      );
    }
    expect(await checkRestored(target())).toMatchObject({ documents: 3 });
  });

  it("notices what was moved to the owners open to an adult, or a reviewer's writes unguarded (0047)", async () => {
    const ruleOf = async (name: string) =>
      (
        await sql(
          vault.adminUrl,
          `select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = '${name}'`,
        )
      ).rows[0]?.rule as string;
    // The live request's files, moved to the owners (as the worker moves them).
    await sql(
      vault.adminUrl,
      `update upload_request set review_by = 'adults', moved_to_owners_at = now()
        where revoked_at is null;
       update incoming_file set owners_only = true`,
    );
    try {
      expect(await checkRestored(target())).toMatchObject({ documents: 3 });
      const moved = await ruleOf('incoming_file_moved');
      await sql(
        vault.adminUrl,
        `alter policy incoming_file_moved on public.incoming_file
           using ((${moved}) or app_role() = 'adult')`,
      );
      try {
        await expect(checkRestored(target())).rejects.toThrow(
          /what was moved to the owners \(incoming_file\) is open to an adult/,
        );
      } finally {
        await sql(
          vault.adminUrl,
          `alter policy incoming_file_moved on public.incoming_file using (${moved})`,
        );
      }
      const request = await ruleOf('upload_request_moved');
      await sql(vault.adminUrl, 'drop policy upload_request_moved on public.upload_request');
      try {
        await expect(checkRestored(target())).rejects.toThrow(
          /no rule keeps what was moved to the owners theirs on upload_request/,
        );
      } finally {
        await sql(
          vault.adminUrl,
          `create policy upload_request_moved on public.upload_request as restrictive using (${request})`,
        );
      }
      await sql(
        vault.adminUrl,
        'alter table public.incoming_file disable trigger incoming_file_account_writes',
      );
      try {
        await expect(checkRestored(target())).rejects.toThrow(
          /guard the vault relies on is missing/,
        );
      } finally {
        await sql(
          vault.adminUrl,
          'alter table public.incoming_file enable trigger incoming_file_account_writes',
        );
      }
      // And a decided file's bytes left to be removed as its row goes.
      await sql(
        vault.adminUrl,
        'alter table public.incoming_file disable trigger incoming_file_leaves_bytes',
      );
      try {
        await expect(checkRestored(target())).rejects.toThrow(
          /guard the vault relies on is missing/,
        );
      } finally {
        await sql(
          vault.adminUrl,
          'alter table public.incoming_file enable trigger incoming_file_leaves_bytes',
        );
      }
    } finally {
      await sql(
        vault.adminUrl,
        `update incoming_file set owners_only = false;
         update upload_request set review_by = 'me', moved_to_owners_at = null
          where revoked_at is null`,
      );
    }
    expect(await checkRestored(target())).toMatchObject({ documents: 3 });
  });

  it('notices an audit log that can be changed', async () => {
    await sql(vault.adminUrl, 'grant update on public.audit_event to fdv_app');
    await expect(checkRestored(target())).rejects.toThrow(/no longer append-only/);
    await sql(vault.adminUrl, 'revoke update on public.audit_event from fdv_app');

    await sql(
      vault.adminUrl,
      'alter table public.audit_event disable trigger audit_event_no_update',
    );
    await expect(checkRestored(target())).rejects.toThrow(/guard the vault relies on is missing/);
    await sql(
      vault.adminUrl,
      'alter table public.audit_event enable trigger audit_event_no_update',
    );

    expect(await checkRestored(target())).toMatchObject({ households: 1 });
  });

  it("notices a removed document's tombstone left open, or a request to remove left to anybody (0045)", async () => {
    // Who could see it, changeable: the activity log would follow the change.
    await sql(vault.adminUrl, 'grant update on public.document_tombstone to fdv_app');
    await expect(checkRestored(target())).rejects.toThrow(/tombstone can be changed or removed/);
    await sql(vault.adminUrl, 'revoke update on public.document_tombstone from fdv_app');
    // Its rule for each kind of caller gone.
    await sql(
      vault.adminUrl,
      'alter policy document_tombstone_actor on document_tombstone using (true)',
    );
    await expect(checkRestored(target())).rejects.toThrow(
      /no rule for each kind of caller on document_tombstone/,
    );
    await sql(
      vault.adminUrl,
      `alter policy document_tombstone_actor on document_tombstone
         using (case app_actor() when 'account' then true when 'system' then true else false end)`,
    );
    // Asking to remove a document for good, left to anybody.
    await sql(
      vault.adminUrl,
      'alter table public.document disable trigger document_purge_request_owner',
    );
    await expect(checkRestored(target())).rejects.toThrow(/guard the vault relies on is missing/);
    await sql(
      vault.adminUrl,
      'alter table public.document enable trigger document_purge_request_owner',
    );
    expect(await checkRestored(target())).toMatchObject({ households: 1 });
  });

  it("notices a person's Only me identity details open to others, or identity details and notices that lost their rules (0050)", async () => {
    const qual = async (name: string) =>
      (
        await sql(
          vault.adminUrl,
          `select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = '${name}'`,
        )
      ).rows[0]?.rule as string;
    const actor = await qual('member_identity_actor');
    const onlyMe = await qual('member_identity_only_me');
    // The rule for each kind of caller gone: a caller who says nothing is
    // given the shared parts.
    await sql(vault.adminUrl, 'drop policy member_identity_actor on public.member_identity');
    try {
      await expect(checkRestored(target())).rejects.toThrow(/member_identity/);
    } finally {
      await sql(
        vault.adminUrl,
        `create policy member_identity_actor on public.member_identity as restrictive using (${actor})`,
      );
    }
    // Both rules open to anybody signed in, as each still reads: an Only me
    // part is somebody else's to read.
    await sql(
      vault.adminUrl,
      `alter policy member_identity_only_me on public.member_identity using (true);
       alter policy member_identity_actor on public.member_identity
         using (case app_actor() when 'account' then app_member() is null or true
                                 when 'system' then true when 'link' then false
                                 when 'upload' then false else false end)`,
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /a person's Only me identity details is open to somebody signed in/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `alter policy member_identity_only_me on public.member_identity using (${onlyMe});
         alter policy member_identity_actor on public.member_identity using (${actor})`,
      );
    }
    // The notices' rule for each kind of caller, gone.
    const notices = await qual('notice_request_actor');
    await sql(vault.adminUrl, 'drop policy notice_request_actor on public.notice_request');
    try {
      await expect(checkRestored(target())).rejects.toThrow(/notice_request/);
    } finally {
      await sql(
        vault.adminUrl,
        `create policy notice_request_actor on public.notice_request as restrictive using (${notices})`,
      );
    }
    // Each rule the vault relies on by name, dropped in turn (the 5.26
    // review): a rule for each kind of caller that names the role must not
    // stand in for the one that says who writes.
    const definition = async (name: string) =>
      (
        await sql(
          vault.adminUrl,
          `select c.relname as tbl, p.polcmd as cmd,
                  pg_get_expr(p.polqual, p.polrelid) as qual,
                  pg_get_expr(p.polwithcheck, p.polrelid) as checked
             from pg_policy p join pg_class c on c.oid = p.polrelid
            where p.polname = '${name}'`,
        )
      ).rows[0] as { tbl: string; cmd: string; qual: string | null; checked: string | null };
    const recreate = (
      name: string,
      d: { tbl: string; cmd: string; qual: string | null; checked: string | null },
    ) => {
      const cmd = { '*': 'all', r: 'select', a: 'insert', w: 'update', d: 'delete' }[d.cmd];
      return `create policy ${name} on public.${d.tbl} as restrictive for ${cmd}${
        d.qual ? ` using (${d.qual})` : ''
      }${d.checked ? ` with check (${d.checked})` : ''}`;
    };
    for (const name of [
      'member_identity_only_me',
      'member_identity_writer_insert',
      'member_identity_writer_update',
      'notice_request_actor_insert',
      'notice_request_actor_update',
    ]) {
      const d = await definition(name);
      await sql(vault.adminUrl, `drop policy ${name} on public.${d.tbl}`);
      try {
        await expect(checkRestored(target()), name).rejects.toThrow(
          new RegExp(`no rule says .*${name}`),
        );
      } finally {
        await sql(vault.adminUrl, recreate(name, d));
      }
    }
    // And each still there by name, but letting through what it is there
    // to stop: tried, as the vault's callers would be.
    for (const [name, changed, refused] of [
      [
        'member_identity_writer_update',
        `alter policy member_identity_writer_update on public.member_identity using (true)`,
        /a viewer may change their own identity details/,
      ],
      [
        'member_identity_writer_update',
        `alter policy member_identity_writer_update on public.member_identity
           using (app_role() is distinct from 'viewer')`,
        /a teen may change somebody else's identity details/,
      ],
      [
        'member_identity_writer_insert',
        `alter policy member_identity_writer_insert on public.member_identity with check (true)`,
        /a viewer may write identity details/,
      ],
      [
        'notice_request_actor_insert',
        `alter policy notice_request_actor_insert on public.notice_request with check (true)`,
        /somebody signed in who is no owner may ask for a notice/,
      ],
    ] as const) {
      const d = await definition(name);
      await sql(vault.adminUrl, changed);
      try {
        await expect(checkRestored(target()), name).rejects.toThrow(refused);
      } finally {
        await sql(vault.adminUrl, `drop policy ${name} on public.${d.tbl}`);
        await sql(vault.adminUrl, recreate(name, d));
      }
    }
    // Each of their guards, off.
    for (const [table, trigger] of [
      ['notice_request', 'notice_request_fixed'],
      ['household', 'household_identity_audience_guard'],
      ['member_identity', 'member_identity_versioned'],
    ]) {
      await sql(vault.adminUrl, `alter table public.${table} disable trigger ${trigger}`);
      try {
        await expect(checkRestored(target()), trigger).rejects.toThrow(
          /guard the vault relies on is missing/,
        );
      } finally {
        await sql(vault.adminUrl, `alter table public.${table} enable trigger ${trigger}`);
      }
    }
    expect(await checkRestored(target())).toMatchObject({ households: 1 });
    // Sixteen checks of the whole vault: more than the default 15 s in a
    // container on CI (it timed out so, 5.26 review round).
  }, 60_000);

  it("notices a person's details open to anybody to change, or their version unguarded (0046)", async () => {
    const rule = (
      await sql(
        vault.adminUrl,
        "select pg_get_expr(polqual, polrelid) as rule from pg_policy where polname = 'member_change_actor'",
      )
    ).rows[0]?.rule as string;
    // The rule gone: anybody signed in changes anybody.
    await sql(vault.adminUrl, 'drop policy member_change_actor on public.member');
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule says who may change a person's details/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `create policy member_change_actor on public.member as restrictive for update using (${rule})`,
      );
    }
    // Still there, but asking nobody's role.
    await sql(vault.adminUrl, 'alter policy member_change_actor on public.member using (true)');
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule says who may change a person's details/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `alter policy member_change_actor on public.member using (${rule})`,
      );
    }
    // The version, free to stay where it was.
    await sql(vault.adminUrl, 'alter table public.member disable trigger member_versioned');
    try {
      await expect(checkRestored(target())).rejects.toThrow(/guard the vault relies on is missing/);
    } finally {
      await sql(vault.adminUrl, 'alter table public.member enable trigger member_versioned');
    }
    // A sign-in, free to be given to somebody recorded as passed away.
    await sql(
      vault.adminUrl,
      'alter table public.account_household disable trigger account_household_not_deceased',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(/guard the vault relies on is missing/);
    } finally {
      await sql(
        vault.adminUrl,
        'alter table public.account_household enable trigger account_household_not_deceased',
      );
    }
    expect(await checkRestored(target())).toMatchObject({ households: 1 });
  });

  it('notices the rule for who locks a sign-in gone (0051)', async () => {
    await sql(
      vault.adminUrl,
      'alter table public.account_household disable trigger account_household_suspension',
    );
    try {
      await expect(checkRestored(target())).rejects.toThrow(/guard the vault relies on is missing/);
    } finally {
      await sql(
        vault.adminUrl,
        'alter table public.account_household enable trigger account_household_suspension',
      );
    }
    expect(await checkRestored(target())).toMatchObject({ households: 1 });
  });

  it("notices what keeps an owner's hand-over link from a person with something private gone (0052)", async () => {
    // Each kind of private thing waits for a reset being spent.
    for (const table of [
      'document',
      'doc_collection',
      'member_identity',
      'upload_request',
      'incoming_file',
      'export',
    ]) {
      const trigger = `${table}_private_gained`;
      await sql(vault.adminUrl, `alter table public.${table} disable trigger ${trigger}`);
      try {
        await expect(checkRestored(target()), trigger).rejects.toThrow(
          /guard the vault relies on is missing/,
        );
      } finally {
        await sql(vault.adminUrl, `alter table public.${table} enable trigger ${trigger}`);
      }
    }
    // And whose reset links somebody signed in reaches.
    const { rows } = await sql(
      vault.adminUrl,
      `select pg_get_expr(polqual, polrelid) as qual from pg_policy
        where polname = 'password_reset_account'`,
    );
    const qual = (rows[0] as { qual: string }).qual;
    await sql(vault.adminUrl, 'drop policy password_reset_account on public.password_reset');
    try {
      await expect(checkRestored(target())).rejects.toThrow(
        /no rule says .*password_reset_account/,
      );
    } finally {
      await sql(
        vault.adminUrl,
        `create policy password_reset_account on public.password_reset as restrictive using (${qual})`,
      );
    }
    expect(await checkRestored(target())).toMatchObject({ households: 1 });
  });

  it("notices a restricted viewer's rules gone, a rule that gives more than the grant, or a restriction's guards gone (0054)", async () => {
    // Every table a restricted viewer is narrowed in: its rule gone, the
    // restore fails closed.
    const rules = (
      await sql(
        vault.adminUrl,
        `select c.relname as tbl, p.polname as name, p.polcmd as cmd,
                pg_get_expr(p.polqual, p.polrelid) as qual
           from pg_policy p join pg_class c on c.oid = p.polrelid
          where p.polname like '%\\_restricted' order by c.relname`,
      )
    ).rows as Array<{ tbl: string; name: string; cmd: string; qual: string }>;
    expect(rules.map((r) => r.tbl)).toEqual(
      [
        'audit_event',
        'doc_collection',
        'doc_collection_item',
        'document',
        'document_link',
        'document_text',
        'document_text_sealed',
        'document_tombstone',
        'document_type',
        'document_version',
        'household_profile',
        'incoming_file',
        'member',
        'member_identity',
        'member_photo',
        'offline_fill',
        'private_notice',
        'reminder',
        'reminder_delivery',
        'share_link',
        'share_link_item',
        'share_page',
        'share_page_failure',
        'share_session_use',
        'upload_idempotency',
      ].sort(),
    );
    for (const r of rules) {
      const command = r.cmd === 'r' ? 'for select' : '';
      await sql(vault.adminUrl, `drop policy ${r.name} on public.${r.tbl}`);
      try {
        await expect(checkRestored(target()), r.tbl).rejects.toThrow(
          new RegExp(`no rule keeps a restricted viewer to their grant on ${r.tbl}`),
        );
      } finally {
        await sql(
          vault.adminUrl,
          `create policy ${r.name} on public.${r.tbl} as restrictive ${command} using (${r.qual})`,
        );
      }
    }

    // A restricted person, with nothing granted: the document's rule there,
    // but giving everything, fails the restore too.
    const { rows: people } = await sql(
      vault.adminUrl,
      "select id, household_id from member where display_name = 'Two'",
    );
    const two = people[0] as { id: string; household_id: string };
    await sql(
      vault.adminUrl,
      'insert into access_restriction (member_id, household_id) values ($1, $2)',
      [two.id, two.household_id],
    );
    try {
      expect(await checkRestored(target())).toMatchObject({ households: 1 });
      const qual = rules.find((r) => r.name === 'document_restricted')?.qual as string;
      await sql(
        vault.adminUrl,
        'alter policy document_restricted on public.document using (app_restricted() or true)',
      );
      try {
        await expect(checkRestored(target())).rejects.toThrow(
          /a restricted person would see 3 documents, but their restriction gives 0/,
        );
      } finally {
        await sql(
          vault.adminUrl,
          `alter policy document_restricted on public.document using (${qual})`,
        );
      }

      // Its guards: a viewer's alone, confirmed for somebody with Only me
      // documents, and confirmed again with a sign-in given back.
      for (const [table, trigger] of [
        ['access_restriction', 'access_restriction_guard'],
        ['access_restriction_type', 'access_restriction_type_household'],
        ['account_household', 'account_household_restriction_reconfirm'],
      ]) {
        await sql(vault.adminUrl, `alter table public.${table} disable trigger ${trigger}`);
        try {
          await expect(checkRestored(target()), trigger).rejects.toThrow(
            /guard the vault relies on is missing/,
          );
        } finally {
          await sql(vault.adminUrl, `alter table public.${table} enable trigger ${trigger}`);
        }
      }

      // Who reads one: the owners and the person. Opened to anybody signed
      // in, or with the rule for each kind of caller gone, it fails.
      const actorRule = async (name: string) =>
        (
          (
            await sql(
              vault.adminUrl,
              `select pg_get_expr(polqual, polrelid) as qual from pg_policy where polname = $1`,
              [name],
            )
          ).rows[0] as { qual: string }
        ).qual;
      // (Still naming the member, so that it is what the rule gives that is
      // caught, not only how it reads.)
      const own = await actorRule('access_restriction_actor');
      await sql(
        vault.adminUrl,
        `alter policy access_restriction_actor on public.access_restriction
           using (case app_actor()
                    when 'account' then true or coalesce(member_id = app_member(), false)
                    when 'system' then true
                    else false
                  end)`,
      );
      try {
        await expect(checkRestored(target())).rejects.toThrow(
          /a person's restriction is open to somebody signed in who is not given it/,
        );
      } finally {
        await sql(
          vault.adminUrl,
          `alter policy access_restriction_actor on public.access_restriction using (${own})`,
        );
      }
      for (const table of [
        'access_restriction_member',
        'access_restriction_type',
        'access_restriction_collection',
      ]) {
        const qual = await actorRule(`${table}_actor`);
        await sql(vault.adminUrl, `drop policy ${table}_actor on public.${table}`);
        try {
          await expect(checkRestored(target()), table).rejects.toThrow(
            new RegExp(`no rule for each kind of caller on ${table}`),
          );
        } finally {
          await sql(
            vault.adminUrl,
            `create policy ${table}_actor on public.${table} as restrictive using (${qual})`,
          );
        }
      }

      // Who writes one: an owner or the vault, never the person.
      const { rows: writers } = await sql(
        vault.adminUrl,
        `select pg_get_expr(polqual, polrelid) as qual from pg_policy
          where polname = 'access_restriction_writer_delete'`,
      );
      await sql(
        vault.adminUrl,
        'drop policy access_restriction_writer_delete on public.access_restriction',
      );
      try {
        await expect(checkRestored(target())).rejects.toThrow(
          /no rule says .*access_restriction_writer_delete/,
        );
      } finally {
        await sql(
          vault.adminUrl,
          `create policy access_restriction_writer_delete on public.access_restriction
             as restrictive for delete using (${(writers[0] as { qual: string }).qual})`,
        );
      }
    } finally {
      await sql(vault.adminUrl, 'delete from access_restriction where member_id = $1', [two.id]);
    }
    expect(await checkRestored(target())).toMatchObject({ households: 1 });
  }, 120_000);
});

describe('the connection for pg_dump and psql', () => {
  it('goes in the environment, password and settings and all', () => {
    expect(
      libpqConnection(
        'postgres://fdv:p%40ss%2Fword@db.example:5433/fdv?sslmode=verify-full&sslrootcert=/certs/ca.pem&connect_timeout=5',
      ),
    ).toEqual({
      env: {
        PGHOST: 'db.example',
        PGPORT: '5433',
        PGUSER: 'fdv',
        PGPASSWORD: 'p@ss/word',
        PGDATABASE: 'fdv',
        PGSSLMODE: 'verify-full',
        PGSSLROOTCERT: '/certs/ca.pem',
        PGCONNECT_TIMEOUT: '5',
      },
      args: [],
    });
    expect(libpqConnection('postgres://fdv@[::1]/x').env.PGHOST).toBe('::1');
    // A socket, named the way libpq's URIs allow.
    expect(libpqConnection('postgres:///fdv?host=/var/run/postgresql&user=fdv').env).toEqual({
      PGDATABASE: 'fdv',
      PGHOST: '/var/run/postgresql',
      PGUSER: 'fdv',
    });
  });

  it('keeps a setting it cannot pass that way, rather than drop it', () => {
    const url = 'postgres://fdv:pw@db.example/fdv?keepalives_idle=30';
    expect(libpqConnection(url)).toEqual({ env: {}, args: ['--dbname', url] });
    const hosts = 'postgres://fdv:pw@one.example:5432,two.example:5432/fdv';
    expect(libpqConnection(hosts).args).toEqual(['--dbname', hosts]);
  });
});

describe('the newest backup', () => {
  it('is picked by the time in its name, and nothing else in the folder counts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fdv-newest-'));
    try {
      expect(await newestBackup(dir)).toBeNull();
      for (const f of [
        'fdv-2026-09-23T02-30-00-000Z.sql.enc',
        'fdv-2026-09-24T02-30-00-000Z.sql.enc',
        'fdv-2026-09-22T02-30-00-000Z.sql.enc',
        // Still being written, or cut short by a crash: not a backup yet.
        'fdv-2026-09-25T02-30-00-000Z.sql.enc.partial',
        'notes.txt',
      ]) {
        await writeFile(path.join(dir, f), 'x');
      }
      const newest = path.join(dir, 'fdv-2026-09-24T02-30-00-000Z.sql.enc');
      expect(await newestBackup(dir)).toBe(newest);
      expect(await backupBefore(newest, dir)).toBe(
        path.join(dir, 'fdv-2026-09-23T02-30-00-000Z.sql.enc'),
      );
      expect(
        await backupBefore(path.join(dir, 'fdv-2026-09-22T02-30-00-000Z.sql.enc'), dir),
      ).toBeNull();
      expect(await newestBackup(path.join(dir, 'missing'))).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!testAdminUrl())('a restore without psql', () => {
  it('says so, leaves the database empty and the drill leaves nothing behind', async () => {
    const t = await createEmptyDatabase();
    const dir = await mkdtemp(path.join(tmpdir(), 'fdv-nopsql-'));
    const saved = process.env.PATH;
    try {
      const file = path.join(dir, 'fdv-2026-09-24T02-30-00-000Z.sql.enc');
      await writeFile(file, 'not reached');
      process.env.PATH = dir; // nothing called psql in it
      const into = { adminUrl: t.adminUrl, appUrl: t.appUrl };
      await expect(restoreBackup(file, KEY, into, quiet, KEYS)).rejects.toThrow(
        /psql could not be started/,
      );
      await expect(
        restoreDrill({
          file,
          backupKey: KEY,
          keys: KEYS,
          adminUrl: t.adminUrl,
          appUrl: t.appUrl,
          log: quiet,
        }),
      ).rejects.toThrow(/psql could not be started/);
      process.env.PATH = saved;
      expect(await tablesIn(t.adminUrl)).toBe(0);
      const left = await sql(
        t.adminUrl,
        "select datname from pg_database where datname like 'fdv\\_restore\\_drill\\_%'",
      );
      expect(left.rows).toEqual([]);
    } finally {
      process.env.PATH = saved;
      await t.drop();
      await rm(dir, { recursive: true, force: true });
    }
    // Three databases made and dropped while the rest of the suite runs:
    // more than the default 5 s under load (it timed out so in a container),
    // and more than 30 s with the whole gate on one shared server (5.27).
  }, 60_000);
});

// pg_dump and psql are in the worker image and on CI; not on every desk.
describe.skipIf(!testAdminUrl() || (PG_BIN === null && !MUST_RESTORE))('restoring a backup', () => {
  let vault: TestDatabase;
  let dir: string;
  let file: string;
  let known: number;
  let vaultPrivileges: string[];
  /** The household the backup holds. */
  let seeded: string;
  const made: TestDatabase[] = [];
  const empty = async () => {
    const t = await createEmptyDatabase();
    made.push(t);
    return t;
  };
  const into = (t: TestDatabase) => ({ adminUrl: t.adminUrl, appUrl: t.appUrl });

  beforeAll(async () => {
    if (PG_BIN === null) {
      throw new Error("pg_dump and psql of the test server's major version are needed here");
    }
    if (PG_BIN) process.env.PATH = `${PG_BIN}${path.delimiter}${process.env.PATH ?? ''}`;
    vault = await createTestDatabase();
    await installQueue(vault.adminUrl);
    seeded = await seed(vault.adminUrl);
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-restore-'));
    file = (
      await backupDatabase({
        adminUrl: vault.adminUrl,
        backupKey: KEY,
        dir,
        retainDays: 30,
        log: quiet,
      })
    ).file;
    known = (await listMigrations()).reduce((max, m) => Math.max(max, m.version), 0);
    vaultPrivileges = await snapshot(vault.adminUrl);
  }, 120_000);
  afterAll(async () => {
    for (const t of made) await t.drop();
    await vault?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('comes back exactly as the vault had it, and nothing ended since is live again', async () => {
    const t = await empty();
    const report = await restoreBackup(file, KEY, into(t), quiet, KEYS);
    expect(report).toMatchObject({
      schema: known,
      households: 1,
      members: 2,
      documents: 3,
      sessionsEnded: 1,
      ownerChangesWithdrawn: 1,
    });
    // Every privilege, owner, policy and default — PUBLIC's included — as
    // the vault it came from had them.
    expect(await snapshot(t.adminUrl)).toEqual(vaultPrivileges);
    const { rows } = await sql(
      t.adminUrl,
      `select (select count(*)::int from session where revoked_at is null) as sessions,
              (select count(*)::int from password_reset
                where used_at is null and expires_at > now()) as resets,
              (select count(*)::int from owner_change_request
                where refused_at is null and completed_at is null and withdrawn_at is null
                  and lapses_at > now()) as owner_changes,
              (select count(*)::int from owner_change_request
                where refused_at is not null) as refused,
              (select count(*)::int from owner_change_request
                where withdrawn_why = 'restored') as restored,
              (select count(*)::int from device where session_id is null) as old_devices`,
    );
    // The running request was withdrawn — as withdrawn by the restore, not
    // as refused by anybody — and the lapsed one was left alone.
    expect(rows[0]).toEqual({
      sessions: 0,
      resets: 0,
      owner_changes: 0,
      refused: 0,
      restored: 1,
      old_devices: 0,
    });
    // The job queue came back too, and the vault can use it.
    const jobs = await sql(
      t.appUrl,
      "select count(*)::int as n from pgboss.job where name = 'restore.test'",
    );
    expect(jobs.rows[0]?.n).toBe(1);
  }, 60_000);

  it('identity details come back as they were; a pending widening does not come back, and the audience is the narrowest (5.26)', async () => {
    const t = await empty();
    const report = await restoreBackup(file, KEY, into(t), quiet, KEYS);
    // The report says what the audience was, and that the widening went.
    expect(report.noticesWithdrawn).toBe(1);
    expect(report.identityAudiences).toEqual([{ household_id: seeded, was: 'adults' }]);
    const { rows } = await sql(
      t.adminUrl,
      `select (select identity_audience from household) as audience,
              (select count(*)::int from notice_request
                where completed_at is null and withdrawn_at is null) as waiting,
              (select count(*)::int from notice_request where withdrawn_at is not null) as withdrawn`,
    );
    expect(rows[0]).toEqual({ audience: 'owners_and_self', waiting: 0, withdrawn: 1 });
    // Round trip: each part opens with the vault's own keys, as it was.
    const db = createDb(createPool(t.adminUrl, 1));
    try {
      const parts = await db.selectFrom('member_identity').selectAll().orderBy('part').execute();
      expect(parts.map((r) => r.part)).toEqual(['only_me', 'shared']);
      for (const r of parts) {
        const key = await KEYS.unwrapById(db, r.wrapped_by_scope);
        const ref = { householdId: seeded, memberId: r.member_id, part: r.part };
        expect(openIdentity(key, ref, r)).toEqual(IDENTITY_SEED[r.part]);
      }
    } finally {
      await db.destroy();
    }
    // And through the restored rules, as the vault reads them: the person
    // both parts; an owner who is somebody else, only the shared part.
    const people = await sql(t.adminUrl, 'select id from member order by created_at, id');
    const person = (
      await sql(t.adminUrl, "select member_id from member_identity where part = 'only_me'")
    ).rows[0]?.member_id as string;
    const other = people.rows.map((r) => r.id as string).find((id) => id !== person) as string;
    const seen = async (member: string) => {
      const pool = new pg.Pool({ connectionString: t.appUrl, max: 1 });
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.member_id', $2, true), set_config('app.role', 'owner', true)`,
          [seeded, member],
        );
        return (
          await c.query<{ part: string }>('select part from member_identity order by part')
        ).rows.map((r) => r.part);
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
        await pool.end();
      }
    };
    expect(await seen(person)).toEqual(['only_me', 'shared']);
    expect(await seen(other)).toEqual(['shared']);
  }, 60_000);

  it('identity returns; the report mentions the audience (5.27)', async () => {
    const t = await empty();
    const report = await restoreBackup(file, KEY, into(t), quiet, KEYS);
    // Each part comes back, and opens with the vault's own keys as it was.
    const db = createDb(createPool(t.adminUrl, 1));
    try {
      const parts = await db.selectFrom('member_identity').selectAll().orderBy('part').execute();
      expect(parts.map((r) => r.part)).toEqual(['only_me', 'shared']);
      for (const r of parts) {
        const key = await KEYS.unwrapById(db, r.wrapped_by_scope);
        const ref = { householdId: seeded, memberId: r.member_id, part: r.part };
        expect(openIdentity(key, ref, r)).toEqual(IDENTITY_SEED[r.part]);
      }
    } finally {
      await db.destroy();
    }
    // What restore-backup prints says who can see them now, and what it was.
    const words = restoreSummary(file, report).replace(/\s+/g, ' ');
    expect(words).toContain(
      `Who can see identity details in household ${seeded} went back to the owners and each person (it was all adults).`,
    );
    expect(words).toContain('1 notice still waiting was withdrawn');
    expect(words).toContain('Settings → Family; that waits 72 hours, while everybody is told.');
  }, 60_000);

  it('an export built under a wider audience cannot be downloaded after a restore (5.27)', async () => {
    // The backup's export was made while all adults saw identity details.
    const before = await sql(
      vault.adminUrl,
      'select count(*)::int as n from export where expires_at > now()',
    );
    expect(before.rows[0]?.n).toBe(1);
    const t = await empty();
    const report = await restoreBackup(file, KEY, into(t), quiet, KEYS);
    expect(report.exportsExpired).toBe(1);
    // Expired, as the vault reads it: ExportService.content() answers 410.
    const { rows } = await sql(
      t.adminUrl,
      `select count(*)::int as n from export
        where state = 'done' and (expires_at is null or expires_at > now())`,
    );
    expect(rows[0]?.n).toBe(0);
    expect(restoreSummary(file, report).replace(/\s+/g, ' ')).toContain(
      '1 export that could still be downloaded was ended: each held what its maker could see then.',
    );
  }, 60_000);

  /** People of a household, signed in as each role, for 5.28's tests. */
  const signedIn = async (url: string, hh: string, name: string, role: string) => {
    const m = await sql(
      url,
      'insert into member (household_id, display_name) values ($1, $2) returning id',
      [hh, name],
    );
    const a = await sql(url, 'insert into account (email) values ($1) returning id', [
      `${name.toLowerCase()}-${hh}@example.test`,
    ]);
    await sql(
      url,
      'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
      [a.rows[0]?.id, hh, m.rows[0]?.id, role],
    );
    return m.rows[0]?.id as string;
  };
  const suspensions = async (url: string) =>
    Object.fromEntries(
      (
        await sql(
          url,
          `select m.display_name as name, a.role, a.suspend_reason as reason,
                  a.suspended_until is not null as ends,
                  suspension_in_effect(a.suspended_at, a.suspended_until) as in_effect
             from account_household a join member m on m.id = a.member_id
            order by m.display_name`,
        )
      ).rows.map((r) => [r.name as string, { ...r, name: undefined }]),
    );

  it('a restore from before a lock leaves that person paused until an owner confirms (5.28)', async () => {
    const live = await createTestDatabase();
    made.push(live);
    const backups = await mkdtemp(path.join(tmpdir(), 'fdv-restore-528-'));
    try {
      await installQueue(live.adminUrl);
      const hh = await seed(live.adminUrl);
      await signedIn(live.adminUrl, hh, 'Sara', 'adult');
      await signedIn(live.adminUrl, hh, 'Tariq', 'teen');
      await signedIn(live.adminUrl, hh, 'Accountant', 'viewer');
      // Kemal is locked when the backup is made, until next week; Lina's
      // lock ended yesterday.
      await signedIn(live.adminUrl, hh, 'Kemal', 'adult');
      await signedIn(live.adminUrl, hh, 'Lina', 'adult');
      await sql(
        live.adminUrl,
        `update account_household a set suspended_at = now(), suspend_reason = 'locked',
                suspended_until = now() + interval '7 days', suspend_note = 'away'
           from member m where m.id = a.member_id and m.display_name = 'Kemal'`,
      );
      await sql(
        live.adminUrl,
        `update account_household a set suspended_at = now() - interval '3 days',
                suspend_reason = 'locked', suspended_until = now() - interval '1 day'
           from member m where m.id = a.member_id and m.display_name = 'Lina'`,
      );
      const backup = (
        await backupDatabase({
          adminUrl: live.adminUrl,
          backupKey: KEY,
          dir: backups,
          retainDays: 30,
          log: quiet,
        })
      ).file;
      // After the backup, an owner locks Sara: the backup cannot know.
      await sql(
        live.adminUrl,
        `update account_household a set suspended_at = now(), suspend_reason = 'locked'
           from member m where m.id = a.member_id and m.display_name = 'Sara'`,
      );

      const t = await empty();
      const report = await restoreBackup(backup, KEY, into(t), quiet, KEYS);
      // Sara, Tariq, the accountant and Lina wait for an owner; Kemal stays
      // locked, with no end of its own; the owner can sign in.
      expect(report).toMatchObject({ signInsPaused: 4, locksKept: 1 });
      const after = await suspensions(t.adminUrl);
      expect(after).toMatchObject({
        Sara: { reason: 'restored', ends: false, in_effect: true },
        Tariq: { reason: 'restored', in_effect: true },
        Accountant: { reason: 'restored', in_effect: true },
        Lina: { reason: 'restored', ends: false, in_effect: true },
        Kemal: { reason: 'locked', ends: false, in_effect: true },
        One: { role: 'owner', reason: null, in_effect: false },
      });
      // Turned back on by an owner, as the vault does it (POST
      // /members/{id}/resume): as the application role, signed in as one.
      const owner = await sql(
        t.adminUrl,
        "select account_id, member_id from account_household where role = 'owner'",
      );
      const pool = new pg.Pool({ connectionString: t.appUrl, max: 1 });
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.role', 'owner', true), set_config('app.account_id', $2, true),
                  set_config('app.member_id', $3, true)`,
          [hh, owner.rows[0]?.account_id, owner.rows[0]?.member_id],
        );
        const waiting = await c.query<{ name: string }>(
          `select m.display_name as name from account_household a join member m on m.id = a.member_id
            where a.suspend_reason = 'restored' order by m.display_name`,
        );
        expect(waiting.rows.map((r) => r.name)).toEqual(['Accountant', 'Lina', 'Sara', 'Tariq']);
        const confirmed = await c.query(
          `update account_household a set suspended_at = null, suspend_reason = null
             from member m where m.id = a.member_id and m.display_name = 'Tariq'
              and a.suspend_reason = 'restored'`,
        );
        expect(confirmed.rowCount).toBe(1);
        await c.query('commit');
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
        await pool.end();
      }
      expect((await suspensions(t.adminUrl)).Tariq).toMatchObject({ in_effect: false });
      expect((await suspensions(t.adminUrl)).Sara).toMatchObject({ in_effect: true });
    } finally {
      await rm(backups, { recursive: true, force: true });
    }
  }, 120_000);

  it('a lock that ran out before its person was made an owner neither locks them nor stops the restore, alone or beside another owner (the 5.28 review, D528-1)', async () => {
    const live = await createTestDatabase();
    made.push(live);
    const backups = await mkdtemp(path.join(tmpdir(), 'fdv-restore-528r-'));
    try {
      await installQueue(live.adminUrl);
      const sole = await seed(live.adminUrl);
      const shared = await seed(live.adminUrl);
      // What is left of a lock that ran out by itself, on somebody who is an
      // owner now (written as it was before the trigger cleared it).
      const lapsed = `suspended_at = now() - interval '5 days', suspended_until = now() - interval '2 days',
                      suspend_reason = 'locked', suspend_note = 'long over'`;
      const ownerWith = async (hh: string, name: string, suspension: string) => {
        const id = await signedIn(live.adminUrl, hh, name, 'owner');
        await sql(
          live.adminUrl,
          `update account_household set ${suspension} where member_id = $1`,
          [id],
        );
        return id;
      };
      // Alone: the household's first two owners step down, and Sara is its only owner.
      const sara = await ownerWith(sole, 'Sara Sole', lapsed);
      await sql(
        live.adminUrl,
        `update account_household set role = 'adult'
          where household_id = $1 and role = 'owner' and member_id <> $2`,
        [sole, sara],
      );
      // Beside another owner: Sam's lapsed lock, and Tom's still in force
      // until next week (an owner locked by the vault itself).
      const sam = await ownerWith(shared, 'Sam Shared', lapsed);
      const tom = await ownerWith(
        shared,
        'Tom Shared',
        `suspended_at = now(), suspended_until = now() + interval '7 days', suspend_reason = 'locked'`,
      );
      const backup = (
        await backupDatabase({
          adminUrl: live.adminUrl,
          backupKey: KEY,
          dir: backups,
          retainDays: 30,
          log: quiet,
        })
      ).file;

      const t = await empty();
      const report = await restoreBackup(backup, KEY, into(t), quiet, KEYS);
      // Those two, adults now, wait; Tom's lock, in force, is kept.
      expect(report).toMatchObject({ signInsPaused: 2, locksKept: 1 });
      const rows = await sql(
        t.adminUrl,
        `select member_id, role, suspend_reason, suspended_at is not null as since,
                suspended_until is not null as ends, suspend_note is not null as noted,
                suspension_in_effect(suspended_at, suspended_until) as in_effect
           from account_household where member_id = any($1::uuid[])`,
        [[sara, sam, tom]],
      );
      const byId = Object.fromEntries(rows.rows.map((r) => [r.member_id as string, r]));
      // Nothing is left of the locks that ran out: both sign in.
      for (const id of [sara, sam]) {
        expect(byId[id]).toMatchObject({
          role: 'owner',
          suspend_reason: null,
          since: false,
          ends: false,
          noted: false,
          in_effect: false,
        });
      }
      // An owner's lock is no non-owner's: it keeps its end, and ends by itself.
      expect(byId[tom]).toMatchObject({ suspend_reason: 'locked', ends: true, in_effect: true });
    } finally {
      await rm(backups, { recursive: true, force: true });
    }
  }, 120_000);

  it('a backup from before 0051 is brought up to date, then every sign-in but the owners’ is paused (5.28)', async () => {
    const older = await empty();
    const migrations = await migrationsUpTo(50);
    const olderDir = await mkdtemp(path.join(tmpdir(), 'fdv-restore-0050-'));
    try {
      await migrate(older.adminUrl, { dir: migrations });
      await installQueue(older.adminUrl);
      const hh = await seed(older.adminUrl);
      await signedIn(older.adminUrl, hh, 'Sara', 'adult');
      await signedIn(older.adminUrl, hh, 'Tariq', 'teen');
      const olderFile = (
        await backupDatabase({
          adminUrl: older.adminUrl,
          backupKey: KEY,
          dir: olderDir,
          retainDays: 30,
          log: quiet,
        })
      ).file;
      const t = await empty();
      const report = await restoreBackup(olderFile, KEY, into(t), quiet, KEYS);
      expect(report).toMatchObject({ schema: known, signInsPaused: 2, locksKept: 0 });
      expect(await suspensions(t.adminUrl)).toMatchObject({
        Sara: { reason: 'restored', in_effect: true },
        Tariq: { reason: 'restored', in_effect: true },
        One: { role: 'owner', in_effect: false },
      });
    } finally {
      await rm(migrations, { recursive: true, force: true });
      await rm(olderDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a restricted viewer comes back restricted and paused, and is still restricted once turned back on (5.32)', async () => {
    const live = await createTestDatabase();
    made.push(live);
    const backups = await mkdtemp(path.join(tmpdir(), 'fdv-restore-532-'));
    try {
      await installQueue(live.adminUrl);
      const hh = await seed(live.adminUrl);
      const accountant = await signedIn(live.adminUrl, hh, 'Accountant', 'viewer');
      // One of the owner's own, beside the house's three that belong to nobody.
      await sql(
        live.adminUrl,
        `insert into document (household_id, owner_member_id)
         select $1, m.id from member m where m.household_id = $1 and m.display_name = 'One'`,
        [hh],
      );
      // The accountant sees the house's documents: those of nobody's.
      await sql(
        live.adminUrl,
        `insert into access_restriction (member_id, household_id, include_no_person_docs)
         values ($1, $2, true)`,
        [accountant, hh],
      );
      const backup = (
        await backupDatabase({
          adminUrl: live.adminUrl,
          backupKey: KEY,
          dir: backups,
          retainDays: 30,
          log: quiet,
        })
      ).file;

      const t = await empty();
      const report = await restoreBackup(backup, KEY, into(t), quiet, KEYS);
      expect(report).toMatchObject({ households: 1, documents: 4 });
      expect(await suspensions(t.adminUrl)).toMatchObject({
        Accountant: { role: 'viewer', reason: 'restored', in_effect: true },
      });
      const kept = await sql(
        t.adminUrl,
        'select include_no_person_docs from access_restriction where member_id = $1',
        [accountant],
      );
      expect(kept.rows).toEqual([{ include_no_person_docs: true }]);

      // Turned back on by an owner, as the vault does it.
      await sql(
        t.adminUrl,
        `update account_household set suspended_at = null, suspend_reason = null
          where member_id = $1`,
        [accountant],
      );
      const account = await sql(
        t.adminUrl,
        'select account_id from account_household where member_id = $1',
        [accountant],
      );
      // Signed in as the accountant: the house's three, not the owner's own.
      const pool = new pg.Pool({ connectionString: t.appUrl, max: 1 });
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.role', 'viewer', true), set_config('app.account_id', $2, true),
                  set_config('app.member_id', $3, true)`,
          [hh, account.rows[0]?.account_id, accountant],
        );
        const seen = await c.query<{ n: number }>(
          'select count(*)::int as n from document where owner_member_id is null',
        );
        const all = await c.query<{ n: number }>('select count(*)::int as n from document');
        expect([seen.rows[0]?.n, all.rows[0]?.n]).toEqual([3, 3]);
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
        await pool.end();
      }
    } finally {
      await rm(backups, { recursive: true, force: true });
    }
  }, 120_000);

  it('a backup from before 0054 is brought up to date: nobody is restricted (5.32)', async () => {
    const older = await empty();
    const migrations = await migrationsUpTo(53);
    const olderDir = await mkdtemp(path.join(tmpdir(), 'fdv-restore-0053-'));
    try {
      await migrate(older.adminUrl, { dir: migrations });
      await installQueue(older.adminUrl);
      const hh = await seed(older.adminUrl);
      await signedIn(older.adminUrl, hh, 'Accountant', 'viewer');
      const olderFile = (
        await backupDatabase({
          adminUrl: older.adminUrl,
          backupKey: KEY,
          dir: olderDir,
          retainDays: 30,
          log: quiet,
        })
      ).file;
      const t = await empty();
      const report = await restoreBackup(olderFile, KEY, into(t), quiet, KEYS);
      expect(report).toMatchObject({ schema: known, households: 1, signInsPaused: 1 });
      const { rows } = await sql(
        t.adminUrl,
        `select (select count(*)::int from access_restriction) as restrictions,
                to_regprocedure('public.doc_in_grant(access_grant, uuid, visibility, uuid, text)') is not null as helper`,
      );
      expect(rows[0]).toEqual({ restrictions: 0, helper: true });
    } finally {
      await rm(migrations, { recursive: true, force: true });
      await rm(olderDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('after a restore every link is paused and no session survives', async () => {
    // The backup has a session open, and a download it has had (0041).
    // And a code emailed for it, not used yet (0043).
    const before = await sql(
      vault.adminUrl,
      `select (select count(*)::int from share_session) as sessions,
              (select count(*)::int from share_session_use) as uses,
              (select count(*)::int from share_code) as codes`,
    );
    expect(before.rows[0]).toEqual({ sessions: 1, uses: 1, codes: 1 });
    const t = await empty();
    const report = await restoreBackup(file, KEY, into(t), quiet, KEYS);
    // The live links — the document's, and the collection's (5.19) — and
    // only those: one taken back or run out stays as it was.
    expect(report.linksPaused).toBe(2);
    const { rows } = await sql(
      t.adminUrl,
      `select (select count(*)::int from share_link
                where paused_at is null and revoked_at is null and expires_at > now()) as live,
              (select count(*)::int from share_link where paused_reason = 'restored') as paused,
              (select count(*)::int from share_link where paused_at is not null
                  and (revoked_at is not null or expires_at <= now())) as dead_paused,
              (select count(*)::int from share_session) as sessions,
              (select count(*)::int from share_session_use) as uses,
              (select count(*)::int from share_code) as codes`,
    );
    // What those sessions had had goes with them (0041), and no code
    // emailed for a link survives (0043).
    expect(rows[0]).toEqual({
      live: 0,
      paused: 2,
      dead_paused: 0,
      sessions: 0,
      uses: 0,
      codes: 0,
    });
    // And a link asking as itself, as the vault will let it, reaches nothing.
    const links = (
      await sql(
        t.adminUrl,
        `select id, household_id, collection_id from share_link where paused_at is not null`,
      )
    ).rows as Array<{ id: string; household_id: string; collection_id: string | null }>;
    const reach = (link: { id: string; household_id: string } | undefined) =>
      withClient(t.appUrl, async (c) => {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'link', true),
                  set_config('app.share_id', $2, true)`,
          [link?.household_id, link?.id],
        );
        const { rows: r } = await c.query<{ n: number }>(
          `select (select count(*)::int from document) + (select count(*)::int from share_link)
                + (select count(*)::int from share_link_item)
                + (select count(*)::int from doc_collection) as n`,
        );
        await c.query('commit');
        return r[0]?.n;
      });
    expect(links).toHaveLength(2);
    for (const link of links) expect(await reach(link), link.id).toBe(0);

    // The collection's link came back with what it was made with (0042),
    // and turned back on — an owner's to do — gives that and nothing more.
    const theCollections = links.find((l) => l.collection_id !== null);
    const ticked = await sql(
      t.adminUrl,
      `select count(*)::int as n from share_link_item where share_id = '${theCollections?.id}'`,
    );
    expect(ticked.rows[0]?.n).toBe(1);
    await sql(
      t.adminUrl,
      `update share_link set paused_at = null, paused_reason = null where id = '${theCollections?.id}'`,
    );
    // Its share and its collection. (The documents seeded here have no
    // file, and a collection's link gives none without one — nor, since the
    // 5.19 review, the line of one it does not give.)
    expect(await reach(theCollections)).toBe(2);
  }, 60_000);

  it('after a restore every request is paused', async () => {
    // The backup has a sender's session open, and a code on its way (0044).
    const before = await sql(
      vault.adminUrl,
      `select (select count(*)::int from upload_session) as sessions,
              (select count(*)::int from upload_code) as codes`,
    );
    expect(before.rows[0]).toEqual({ sessions: 1, codes: 1 });
    const t = await empty();
    const report = await restoreBackup(file, KEY, into(t), quiet, KEYS);
    // The live request, and only that: one taken back stays as it was.
    expect(report.requestsPaused).toBe(1);
    const { rows } = await sql(
      t.adminUrl,
      `select (select count(*)::int from upload_request
                where paused_at is null and revoked_at is null and closed_at is null
                  and expires_at > now()) as live,
              (select count(*)::int from upload_request where paused_reason = 'restored') as paused,
              (select count(*)::int from upload_request
                where paused_at is not null and revoked_at is not null) as dead_paused,
              (select count(*)::int from upload_session) as sessions,
              (select count(*)::int from upload_code) as codes`,
    );
    expect(rows[0]).toEqual({ live: 0, paused: 1, dead_paused: 0, sessions: 0, codes: 0 });
    // Its token finds nothing, and its link, asking as itself, reaches nothing.
    const [req] = (
      await sql(
        t.adminUrl,
        'select id, household_id, token_hash from upload_request where paused_at is not null',
      )
    ).rows as Array<{ id: string; household_id: string; token_hash: Buffer }>;
    const reached = await withClient(t.appUrl, async (c) => {
      const found = await c.query('select * from upload_request_find($1)', [req?.token_hash]);
      await c.query('begin');
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'upload', true),
                set_config('app.upload_request_id', $2, true)`,
        [req?.household_id, req?.id],
      );
      const { rows: r } = await c.query<{ n: number }>(
        `select (select count(*)::int from upload_request)
              + (select count(*)::int from upload_request_item)
              + (select count(*)::int from document) as n`,
      );
      await c.query('commit');
      return { found: found.rows.length, n: r[0]?.n };
    });
    expect(reached).toEqual({ found: 0, n: 0 });
  }, 60_000);

  it('files purged since the backup are dropped and reported', async () => {
    // The files as they are now: of the three in the backup, only the first
    // is still kept — the others went after it was made.
    const dir = await mkdtemp(path.join(tmpdir(), 'fdv-restore-files-'));
    try {
      const keptKey = (
        await sql(
          vault.adminUrl,
          "select storage_key from incoming_file where storage_key like '%/kept.enc'",
        )
      ).rows[0]?.storage_key as string;
      await mkdir(path.dirname(path.join(dir, keptKey)), { recursive: true });
      await writeFile(path.join(dir, keptKey), 'its bytes, encrypted');

      // Restored without being told where the files are, nothing is asked or dropped.
      const blind = await restoreBackup(file, KEY, into(await empty()), quiet, KEYS);
      expect(blind.incomingDropped).toBe(0);

      // Nor where the place looks empty — the folder there and none of the
      // files in it, or the folder not there: not mounted yet, the files not
      // copied back yet. Dropping is for good; nothing is (D524-02).
      const bare = await mkdtemp(path.join(tmpdir(), 'fdv-restore-bare-'));
      try {
        for (const localRoot of [bare, path.join(bare, 'not-mounted')]) {
          const u = await empty();
          const looked = await restoreBackup(file, KEY, into(u), quiet, KEYS, {
            credentialsKey: Buffer.alloc(32),
            localRoot,
          });
          expect(looked.incomingDropped).toBe(0);
          const { rows: all } = await sql(
            u.adminUrl,
            `select regexp_replace(storage_key, '^.*/', '') as name,
                    object_removed_at is not null as removed
               from incoming_file order by storage_key`,
          );
          expect(all).toEqual([
            { name: 'filed.enc', removed: false },
            { name: 'gone.enc', removed: false },
            { name: 'kept.enc', removed: false },
          ]);
        }
      } finally {
        await rm(bare, { recursive: true, force: true });
      }

      const t = await empty();
      const report = await restoreBackup(file, KEY, into(t), quiet, KEYS, {
        credentialsKey: Buffer.alloc(32),
        localRoot: dir,
      });
      // The waiting file with nothing left to look at is dropped, and counted.
      expect(report.incomingDropped).toBe(1);
      const { rows } = await sql(
        t.adminUrl,
        `select regexp_replace(storage_key, '^.*/', '') as name, state,
                object_removed_at is not null as removed
           from incoming_file order by storage_key`,
      );
      expect(rows).toEqual([
        // Filed: its row stays (a document's history names it), its bytes known gone.
        { name: 'filed.enc', state: 'accepted', removed: true },
        { name: 'kept.enc', state: 'received', removed: false },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("a household's collections come back, and an Only me collection is still its maker's alone (0036)", async () => {
    const t = await empty();
    await restoreBackup(file, KEY, into(t), quiet, KEYS);
    const { rows: members } = await sql(
      t.adminUrl,
      'select id, household_id from member order by display_name',
    );
    const [first, second] = members as Array<{ id: string; household_id: string }>;
    // As the vault will ask, signed in as each member in turn.
    const collections = await withClient(t.appUrl, async (c) => {
      const as = async (member: { id: string; household_id: string } | undefined) => {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.member_id', $2, true)`,
          [member?.household_id, member?.id],
        );
        const { rows } = await c.query<{ name: string; items: number }>(
          `select l.name, (select count(*)::int from doc_collection_item i where i.collection_id = l.id) as items
             from doc_collection l order by l.name`,
        );
        await c.query('commit');
        return rows;
      };
      return { first: await as(first), second: await as(second) };
    });
    expect(collections).toEqual({
      first: [
        { name: 'Divorce', items: 3 },
        { name: 'For the broker', items: 3 },
      ],
      second: [{ name: 'For the broker', items: 3 }],
    });
    // And a collection is still marked deleted, never taken away, by the vault.
    await expect(sql(t.appUrl, 'delete from doc_collection')).rejects.toThrow(/permission denied/);
  }, 60_000);

  it('photos come back as they were that night, and none is left half made', async () => {
    const t = await empty();
    const report = await restoreBackup(file, KEY, into(t), quiet, KEYS);
    expect(report.photosUnfinished).toBe(1);
    const { rows } = await sql(
      t.adminUrl,
      `select p.state, p.sealed, p.source_key is not null as has_source
         from member_photo p join member m on m.id = p.member_id order by m.display_name`,
    );
    // The first member's, byte for byte; the second's, which the backup
    // caught on its way, failed for the nightly prune to take away.
    expect(rows.map((r) => r.state)).toEqual(['ready', 'failed']);
    expect(Buffer.compare(rows[0]?.sealed as Buffer, PHOTO_SEALED)).toBe(0);
    expect(rows[1]?.has_source).toBe(true);
    // And the vault, asking as the family, sees the one that is ready.
    const [first] = (
      await sql(t.adminUrl, "select id, household_id from member where display_name = 'One'")
    ).rows as Array<{ id: string; household_id: string }>;
    const seen = await withClient(t.appUrl, async (c) => {
      await c.query('begin');
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.member_id', $2, true), set_config('app.role', 'teen', true)`,
        [first?.household_id, first?.id],
      );
      const { rows: r } = await c.query<{ n: number }>(
        "select count(*)::int as n from member_photo where state = 'ready'",
      );
      await c.query('commit');
      return r[0]?.n;
    });
    expect(seen).toBe(1);
  }, 60_000);

  it('a restore from before a removal reports the missing files, and the document says so', async () => {
    // A vault with two documents and their files; backed up; then one of
    // them removed for good (5.24): its files deleted, then its rows.
    const before = await createTestDatabase();
    made.push(before);
    const root = await mkdtemp(path.join(tmpdir(), 'fdv-restore-files-'));
    const backups = await mkdtemp(path.join(tmpdir(), 'fdv-restore-removal-'));
    try {
      const hh = await seed(before.adminUrl);
      const ids = (
        await sql(
          before.adminUrl,
          `with v as (insert into vault (household_id, kind, label) values ('${hh}', 'local', 'v')
                      returning id),
                k as (insert into scope_key (household_id, kind, key_wrapped)
                      values ('${hh}', 'household', '\\x00') returning id),
                d as (select id, row_number() over (order by id) as n from document
                       where household_id = '${hh}' order by id limit 2)
           insert into document_version
             (household_id, document_id, version_no, filename, mime, byte_size, sha256,
              cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope)
           select '${hh}', d.id, g.no, 'scan.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00',
                  '${hh}/' || d.id || '/' || g.no || '/file.pdf.enc', v.id, '\\x00', k.id
             from d, v, k, generate_series(1, d.n::int) as g(no)
           returning id, document_id, storage_key`,
        )
      ).rows as Array<{ id: string; document_id: string; storage_key: string }>;
      // The first document has one version; the second, two.
      expect(ids).toHaveLength(3);
      for (const v of ids) {
        await mkdir(path.dirname(path.join(root, v.storage_key)), { recursive: true });
        await writeFile(path.join(root, v.storage_key), 'ciphertext');
      }
      // And the third in the Trash, an owner's request to remove it standing
      // when the backup was made, a day and more old by now.
      await sql(
        before.adminUrl,
        `update document
            set deleted_at = now() - interval '2 days',
                purge_requested_at = now() - interval '30 hours',
                purge_requested_by = (select account_id from account_household
                                       where household_id = '${hh}' limit 1)
          where household_id = '${hh}'
            and id not in (select document_id from document_version)`,
      );
      const file = (
        await backupDatabase({
          adminUrl: before.adminUrl,
          backupKey: KEY,
          dir: backups,
          retainDays: 30,
          log: quiet,
        })
      ).file;
      const counts = new Map<string, number>();
      for (const v of ids) counts.set(v.document_id, (counts.get(v.document_id) ?? 0) + 1);
      const removed = [...counts].find(([, n]) => n === 2)?.[0] as string;
      const kept = [...counts].find(([, n]) => n === 1)?.[0] as string;
      // Removed for good after the backup was made: its files are gone.
      for (const v of ids.filter((x) => x.document_id === removed)) {
        await rm(path.join(root, v.storage_key));
      }

      const t = await empty();
      const report = await restoreBackup(file, KEY, into(t), quiet, KEYS, {
        credentialsKey: deriveKey(MASTER, 'vault-credentials'),
        localRoot: root,
      });
      // The report lists each version whose file is gone, by its document.
      const byId = (a: { version_id: string }, b: { version_id: string }) =>
        a.version_id < b.version_id ? -1 : 1;
      expect([...report.filesRemoved].sort(byId)).toEqual(
        ids
          .filter((v) => v.document_id === removed)
          .map((v) => ({ household_id: hh, document_id: removed, version_id: v.id }))
          .sort(byId),
      );
      expect(report.filesUnchecked).toBe(0);
      expect(report.documents).toBe(3);
      // The owner's request ended with the restore (D524-03): asked again,
      // and the filer told again, before anything is removed.
      expect(report.purgeRequestsCleared).toBe(1);
      const asked = await sql(
        t.adminUrl,
        'select count(*)::int as n from document where purge_requested_at is not null',
      );
      expect(asked.rows[0]?.n).toBe(0);

      // And the document says so, as the vault reads it: its versions are
      // marked removed for good; the other's file is there, and unmarked.
      const seen = await withClient(t.appUrl, async (c) => {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true)`,
          [hh],
        );
        const { rows } = await c.query<{ document_id: string; removed: boolean }>(
          `select document_id, file_removed_at is not null as removed from document_version
            order by document_id, version_no`,
        );
        await c.query('commit');
        return rows;
      });
      expect(seen.filter((r) => r.document_id === removed).map((r) => r.removed)).toEqual([
        true,
        true,
      ]);
      expect(seen.filter((r) => r.document_id === kept).map((r) => r.removed)).toEqual([false]);

      // Told nothing of where the files are, a restore marks nothing.
      const blind = await empty();
      const unmarked = await restoreBackup(file, KEY, into(blind), quiet, KEYS);
      expect(unmarked).toMatchObject({
        filesRemoved: [],
        filesUnchecked: 0,
        filesUncheckedWhy: [],
      });
      const none = await sql(
        blind.adminUrl,
        'select count(*)::int as n from document_version where file_removed_at is not null',
      );
      expect(none.rows[0]?.n).toBe(0);

      // Told, but the files are not in place yet — an empty folder, a volume
      // not mounted (D524-02): nothing is marked, and the report says why.
      const bare = await mkdtemp(path.join(tmpdir(), 'fdv-restore-bare-'));
      try {
        const early = await empty();
        const r = await restoreBackup(file, KEY, into(early), quiet, KEYS, {
          credentialsKey: deriveKey(MASTER, 'vault-credentials'),
          localRoot: bare,
        });
        expect(r.filesRemoved).toEqual([]);
        expect(r.filesUnchecked).toBe(3);
        expect(r.filesUncheckedWhy.join(' ')).toMatch(/None of the 3 file\(s\)/);
        const unmarkedEarly = await sql(
          early.adminUrl,
          'select count(*)::int as n from document_version where file_removed_at is not null',
        );
        expect(unmarkedEarly.rows[0]?.n).toBe(0);
      } finally {
        await rm(bare, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(backups, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses a database that is not empty, and leaves it as it was', async () => {
    await expect(restoreBackup(file, KEY, into(vault), quiet, KEYS)).rejects.toBeInstanceOf(
      RestoreRefused,
    );
    expect(await checkRestored(into(vault))).toMatchObject({ households: 1, documents: 3 });
  });

  it('restores nothing from a backup cut short, even after most of it has been loaded', async () => {
    // The whole dump, then padding, so that the file is three chunks and
    // the first carries every statement. Cut after the second: psql has
    // run the entire dump by the time the cut is found.
    const padded = await reseal(file, (plain) => {
      expect(plain.length).toBeLessThan(CHUNK_SIZE);
      return plain + '-- padding\n'.repeat(Math.ceil((2.5 * CHUNK_SIZE) / 11));
    });
    const cut = `${padded}.cut`;
    await writeFile(
      cut,
      (await readFile(padded)).subarray(0, HEADER_BYTES + 2 * (CHUNK_SIZE + TAG)),
    );
    const t = await empty();
    await expect(restoreBackup(cut, KEY, into(t), quiet, KEYS)).rejects.toThrow(
      /could not be read/,
    );
    expect(await tablesIn(t.adminUrl)).toBe(0);
  }, 60_000);

  it('refuses, whole, a backup from a newer release', async () => {
    const newer = await reseal(
      file,
      (plain) =>
        `${plain}\ninsert into public.schema_migration (version, name) values (${known + 1}, 'later');\n`,
    );
    const t = await empty();
    await expect(restoreBackup(newer, KEY, into(t), quiet, KEYS)).rejects.toThrow(
      new RegExp(`newer release .*schema ${known + 1}\\), and this one only knows schema ${known}`),
    );
    expect(await tablesIn(t.adminUrl)).toBe(0);
  }, 60_000);

  it('refuses, whole, a file that is not a backup of a vault', async () => {
    const other = await reseal(file, () => 'create table public.stray (x int);\n');
    const t = await empty();
    await expect(restoreBackup(other, KEY, into(t), quiet, KEYS)).rejects.toThrow(/not a backup/);
    expect(await tablesIn(t.adminUrl)).toBe(0);
  }, 60_000);

  it('brings a backup from an older release up to date', async () => {
    const older = await empty();
    const migrations = await migrationsUpTo(20); // 0.4.2: before the installation id
    try {
      await migrate(older.adminUrl, { dir: migrations });
      await installQueue(older.adminUrl);
      await seed(older.adminUrl);
      const olderDir = await mkdtemp(path.join(tmpdir(), 'fdv-restore-older-'));
      const olderFile = (
        await backupDatabase({
          adminUrl: older.adminUrl,
          backupKey: KEY,
          dir: olderDir,
          retainDays: 30,
          log: quiet,
        })
      ).file;
      const t = await empty();
      const report = await restoreBackup(olderFile, KEY, into(t), quiet, KEYS);
      // Its live link paused too, once the migrations gave it the means (5.16).
      expect(report).toMatchObject({ schema: known, households: 1, documents: 3, linksPaused: 1 });
      const id = await sql(t.appUrl, 'select instance_id from instance');
      expect(id.rows).toHaveLength(1);
      // A backup older than 0023 cannot say "withdrawn": the running request
      // ends as a lapse does, and 0022 on the way up records both it and the
      // one that had lapsed already. Nobody is said to have refused.
      const ended = await sql(
        t.adminUrl,
        `select (select count(*)::int from owner_change_request where lapsed_at is not null) as lapsed,
                (select count(*)::int from owner_change_request where refused_at is not null) as refused`,
      );
      expect(ended.rows[0]).toEqual({ lapsed: 2, refused: 0 });
      await rm(olderDir, { recursive: true, force: true });
    } finally {
      await rm(migrations, { recursive: true, force: true });
    }
  }, 120_000);

  it('a backup made before 0030 restores, and every household sees its own documents', async () => {
    // 0.5.4: every transaction says who is asking, and nothing reads it yet.
    const older = await empty();
    const migrations = await migrationsUpTo(29);
    const olderDir = await mkdtemp(path.join(tmpdir(), 'fdv-restore-0029-'));
    try {
      await migrate(older.adminUrl, { dir: migrations });
      await installQueue(older.adminUrl);
      const households = [await seed(older.adminUrl), await seed(older.adminUrl)];
      const olderFile = (
        await backupDatabase({
          adminUrl: older.adminUrl,
          backupKey: KEY,
          dir: olderDir,
          retainDays: 30,
          log: quiet,
        })
      ).file;

      // The restore brings it up to date, 0030's rules included, and its
      // check — asking as the vault itself — passes.
      const t = await empty();
      const report = await restoreBackup(olderFile, KEY, into(t), quiet, KEYS);
      expect(report).toMatchObject({ schema: known, households: 2, members: 4, documents: 6 });
      const rules = await sql(
        t.adminUrl,
        `select count(*)::int as n from pg_policy
          where polname = 'document_actor' and not polpermissive`,
      );
      expect(rules.rows[0]?.n).toBe(1);

      // Each household is given its own three documents, by the vault and by
      // somebody signed in; asked with no actor, none.
      for (const hh of households) {
        const seen = await withClient(t.appUrl, async (c) => {
          const as = async (actor: string) => {
            await c.query('begin');
            await c.query(
              `select set_config('app.household_id', $1, true), set_config('app.actor', $2, true)`,
              [hh, actor],
            );
            const { rows } = await c.query<{ n: number }>(
              'select count(*)::int as n from document',
            );
            await c.query('commit');
            return rows[0]?.n;
          };
          return { system: await as('system'), account: await as('account'), none: await as('') };
        });
        expect(seen, hh).toEqual({ system: 3, account: 3, none: 0 });
      }
    } finally {
      await rm(migrations, { recursive: true, force: true });
      await rm(olderDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a backup made before 0038 says which date each reminder is about, and sends none again', async () => {
    // 0.5.14: a derived reminder did not say which date it came from.
    const older = await empty();
    const migrations = await migrationsUpTo(37);
    const olderDir = await mkdtemp(path.join(tmpdir(), 'fdv-restore-0037-'));
    try {
      await migrate(older.adminUrl, { dir: migrations });
      await installQueue(older.adminUrl);
      const hh = await seed(older.adminUrl);
      const made = await withClient(older.adminUrl, async (c) => {
        const { rows } = await c.query<{ id: string; kind: string }>(
          `insert into reminder (household_id, document_id, kind, fire_at, lead_days, note, status)
           select $1, d.id, v.kind, current_date, v.lead, v.note, 'due'
             from (select id from document where household_id = $1 limit 1) d,
                  (values ('derived', 180, null), ('manual', null, 'Ring the broker'))
                    as v(kind, lead, note)
           returning id, kind`,
          [hh],
        );
        await c.query(
          `insert into reminder_delivery (reminder_id, household_id, fire_date, channel)
           select id, $1, current_date, 'push' from reminder where household_id = $1`,
          [hh],
        );
        return rows;
      });
      const olderFile = (
        await backupDatabase({
          adminUrl: older.adminUrl,
          backupKey: KEY,
          dir: olderDir,
          retainDays: 30,
          log: quiet,
        })
      ).file;
      const t = await empty();
      const report = await restoreBackup(olderFile, KEY, into(t), quiet, KEYS);
      expect(report).toMatchObject({ schema: known, households: 1 });
      // Each keeps its id — and with it its line in the ledger, so the
      // digest does not send it again — and says which date it is about.
      const { rows } = await sql(
        t.adminUrl,
        `select r.id, r.kind, r.source,
                (select count(*)::int from reminder_delivery l where l.reminder_id = r.id) as sent
           from reminder r order by r.kind`,
      );
      expect(rows).toEqual(
        [...made]
          .sort((a, b) => a.kind.localeCompare(b.kind))
          .map((r) => ({
            id: r.id,
            kind: r.kind,
            source: r.kind === 'derived' ? 'expires' : null,
            sent: 1,
          })),
      );
    } finally {
      await rm(migrations, { recursive: true, force: true });
      await rm(olderDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a backup from before 0039 restores and migrates to collections', async () => {
    // 0.5.16: collections were lists, in doc_list and doc_list_item.
    const older = await empty();
    const migrations = await migrationsUpTo(38);
    const olderDir = await mkdtemp(path.join(tmpdir(), 'fdv-restore-0038-'));
    try {
      await migrate(older.adminUrl, { dir: migrations });
      await installQueue(older.adminUrl);
      await seed(older.adminUrl);
      const { rows: lists } = await sql(
        older.adminUrl,
        'select id, name, audience, owner_member_id from doc_list order by name',
      );
      const { rows: items } = await sql(
        older.adminUrl,
        'select list_id, document_id, position from doc_list_item order by list_id, position',
      );
      expect(lists).toHaveLength(2);
      expect(items).toHaveLength(6);
      const olderFile = (
        await backupDatabase({
          adminUrl: older.adminUrl,
          backupKey: KEY,
          dir: olderDir,
          retainDays: 30,
          log: quiet,
        })
      ).file;

      // The restore's own check passes: its guards, rules and privileges are
      // found under their new names.
      const t = await empty();
      const report = await restoreBackup(olderFile, KEY, into(t), quiet, KEYS);
      expect(report).toMatchObject({ schema: known, households: 1, documents: 3 });

      // Every row, by its own id, and every item in its place.
      expect(
        (
          await sql(
            t.adminUrl,
            'select id, name, audience, owner_member_id from doc_collection order by name',
          )
        ).rows,
      ).toEqual(lists);
      expect(
        (
          await sql(
            t.adminUrl,
            `select collection_id as list_id, document_id, position
               from doc_collection_item order by collection_id, position`,
          )
        ).rows,
      ).toEqual(items);
      const { rows: gone } = await sql(
        t.adminUrl,
        `select to_regclass('public.doc_list') as list, to_regclass('public.doc_list_item') as item,
                (select count(*)::int from pg_policy where polname like 'doc\\_list%') as policies`,
      );
      expect(gone).toEqual([{ list: null, item: null, policies: 0 }]);

      // As the vault will ask: the Only me one is still its maker's alone,
      // and a collection is still never taken away.
      const { rows: members } = await sql(
        t.adminUrl,
        'select id, household_id from member order by display_name',
      );
      const seenBy = async (member: { id: string; household_id: string }) =>
        withClient(t.appUrl, async (c) => {
          await c.query('begin');
          await c.query(
            `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                    set_config('app.member_id', $2, true)`,
            [member.household_id, member.id],
          );
          const { rows } = await c.query<{ name: string }>(
            'select name from doc_collection order by name',
          );
          await c.query('commit');
          return rows.map((r) => r.name);
        });
      const [first, second] = members as Array<{ id: string; household_id: string }>;
      expect(await seenBy(first as { id: string; household_id: string })).toEqual([
        'Divorce',
        'For the broker',
      ]);
      expect(await seenBy(second as { id: string; household_id: string })).toEqual([
        'For the broker',
      ]);
      await expect(sql(t.appUrl, 'delete from doc_collection')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await rm(migrations, { recursive: true, force: true });
      await rm(olderDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a backup from before 0042 keeps what a view-only link could not draw, a version at a time', async () => {
    // 0.5.20: a view-only link kept the one version whose pages failed, and
    // when, on the link (pages_failed_version, pages_failed_at).
    const older = await empty();
    const migrations = await migrationsUpTo(41);
    const olderDir = await mkdtemp(path.join(tmpdir(), 'fdv-restore-0041-'));
    try {
      await migrate(older.adminUrl, { dir: migrations });
      await installQueue(older.adminUrl);
      const hh = await seed(older.adminUrl);
      const failedAt = new Date(Date.now() - 20 * 60_000);
      const made = await sql(
        older.adminUrl,
        `with v as (insert into vault (household_id, kind, label) values ('${hh}', 'local', 'v')
                    returning id),
              k as (insert into scope_key (household_id, kind, key_wrapped)
                    values ('${hh}', 'household', '\\x00') returning id),
              d as (select id from document where household_id = '${hh}' order by id limit 1),
              ver as (insert into document_version
                        (household_id, document_id, version_no, filename, mime, byte_size, sha256,
                         cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped,
                         wrapped_by_scope)
                      select '${hh}', d.id, 1, 'scan.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00',
                             'k-failed', v.id, '\\x00', k.id from d, v, k
                      returning id, document_id)
         insert into share_link (household_id, document_id, token_hash, created_by, expires_at,
                                 permission, pages_failed_version, pages_failed_at)
         select '${hh}', ver.document_id, '\\x0102', a.account_id, now() + interval '7 days',
                'view', ver.id, '${failedAt.toISOString()}'
           from ver, (select account_id from account_household where household_id = '${hh}'
                       limit 1) a
         returning id, document_id, pages_failed_version`,
      );
      const link = made.rows[0] as {
        id: string;
        document_id: string;
        pages_failed_version: string;
      };
      const olderFile = (
        await backupDatabase({
          adminUrl: older.adminUrl,
          backupKey: KEY,
          dir: olderDir,
          retainDays: 30,
          log: quiet,
        })
      ).file;

      const t = await empty();
      const report = await restoreBackup(olderFile, KEY, into(t), quiet, KEYS);
      expect(report).toMatchObject({ schema: known, households: 1 });
      // The failure moved, the link's own columns went, and the rule is the hour's as before.
      const { rows } = await sql(
        t.adminUrl,
        `select share_id, document_id, version_id, failed_at from share_page_failure`,
      );
      expect(rows).toEqual([
        {
          share_id: link.id,
          document_id: link.document_id,
          version_id: link.pages_failed_version,
          failed_at: failedAt,
        },
      ]);
      const { rows: columns } = await sql(
        t.adminUrl,
        `select count(*)::int as n from pg_attribute
          where attrelid = 'public.share_link'::regclass
            and attname in ('pages_failed_version', 'pages_failed_at') and not attisdropped`,
      );
      expect(columns).toEqual([{ n: 0 }]);
    } finally {
      await rm(migrations, { recursive: true, force: true });
      await rm(olderDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('a restore from before a sealing seals again before the vault opens', async () => {
    // 0.5.7: an Only me document's notes and details were kept plain.
    const older = await empty();
    const migrations = await migrationsUpTo(32);
    const olderDir = await mkdtemp(path.join(tmpdir(), 'fdv-restore-0032-'));
    try {
      await migrate(older.adminUrl, { dir: migrations });
      await installQueue(older.adminUrl);
      const hh = await seed(older.adminUrl);
      const { rows: people } = await sql(
        older.adminUrl,
        `select id from member where household_id = '${hh}' order by display_name limit 1`,
      );
      const member = people[0]?.id as string;
      // Its owner's key, under the vault's master key, as the vault mints it.
      const seeding = createDb(createPool(older.appUrl, 1));
      try {
        await withSystem(seeding, hh, (trx) => KEYS.mintMemberKey(trx, hh, member, null));
      } finally {
        await seeding.destroy();
      }
      const { rows: made } = await sql(
        older.adminUrl,
        `insert into document (household_id, title, owner_member_id, visibility, notes, extra)
         values ('${hh}', 'Old diary', '${member}', 'private', 'The combination is 4471',
                 '{"vin": "OLDVIN0000000001"}')
         returning id`,
      );
      const doc = made[0]?.id as string;
      const olderFile = (
        await backupDatabase({
          adminUrl: older.adminUrl,
          backupKey: KEY,
          dir: olderDir,
          retainDays: 30,
          log: quiet,
        })
      ).file;

      // Restored with another vault's master key, nothing can be sealed, and
      // the restore says so rather than open a vault with them plain.
      const wrongKeys = new ScopeKeys(
        new EnvKeyProvider('another-vaults-master-secret-32-bytes!!'),
      );
      await expect(
        restoreBackup(olderFile, KEY, into(await empty()), quiet, wrongKeys),
      ).rejects.toThrow(/could not be sealed \(.+\); each is in the log/);

      const t = await empty();
      const report = await restoreBackup(olderFile, KEY, into(t), quiet, KEYS);
      expect(report).toMatchObject({ schema: known, households: 1, documents: 4 });
      const { rows } = await sql(
        t.adminUrl,
        `select notes, extra, notes_sealed, extra_sealed, sealed_details, search_tsv::text as terms
           from document where id = '${doc}'`,
      );
      const row = rows[0] as {
        notes: string | null;
        extra: Record<string, unknown>;
        notes_sealed: Buffer | null;
        extra_sealed: Buffer | null;
        sealed_details: string[];
        terms: string;
      };
      // Sealed before the vault opened: nothing plain, nothing in the index.
      expect(row).toMatchObject({ notes: null, extra: {}, sealed_details: ['vin'] });
      expect(row.terms).not.toMatch(/combination|4471|oldvin/);
      // Under its owner's key, as the vault will open it.
      const app = createDb(createPool(t.appUrl, 1));
      try {
        const opened = await withSystem(app, hh, async (trx) =>
          openPrivate(
            (await KEYS.unwrap(trx, { householdId: hh, kind: 'member', memberId: member })).key,
            doc,
            row,
          ),
        );
        expect(opened).toEqual({
          notes: 'The combination is 4471',
          extra: { vin: 'OLDVIN0000000001' },
        });
      } finally {
        await app.destroy();
      }
    } finally {
      await rm(migrations, { recursive: true, force: true });
      await rm(olderDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('the drill restores into a scratch database and leaves nothing behind', async () => {
    const report = await restoreDrill({
      file,
      backupKey: KEY,
      keys: KEYS,
      adminUrl: vault.adminUrl,
      appUrl: vault.appUrl,
      log: quiet,
    });
    expect(report).toMatchObject({ households: 1, members: 2, documents: 3 });
    const left = await sql(
      vault.adminUrl,
      "select datname from pg_database where datname like 'fdv\\_restore\\_drill\\_%'",
    );
    expect(left.rows).toEqual([]);
  }, 60_000);

  it('a check that fails after the load says the backup was loaded', async () => {
    // A vault whose application role cannot sign in: the load succeeds and
    // the check after it cannot.
    const t = await empty();
    const wrong = {
      adminUrl: t.adminUrl,
      appUrl: t.appUrl.replace(/:[^:@/]+@/, ':not-the-password@'),
    };
    await expect(restoreBackup(file, KEY, wrong, quiet, KEYS)).rejects.toBeInstanceOf(
      RestoreIncomplete,
    );
    expect(await tablesIn(t.adminUrl)).toBeGreaterThan(0);
  }, 60_000);
});
