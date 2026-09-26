import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CHUNK_SIZE, DecryptStream, deriveKey, EncryptStream, HEADER_BYTES } from '@fdv/crypto';
import { applyPrivileges, listMigrations, migrateUp } from '@fdv/db';
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

const KEY = deriveKey('restore-test-master-secret-at-least-32-bytes', 'database-backup');
const quiet = () => undefined;
const TAG = 16; // AES-GCM tag after each sealed chunk

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
const sql = (url: string, text: string) =>
  withClient(url, (c) => c.query<Record<string, unknown>>(text));

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
    await c.query(
      `insert into device (household_id, account_id, endpoint, p256dh, auth, session_id)
       values ($1, $2, $3, 'k', 'a', null)`,
      [hh, account, `https://push.example.test/${hh}`],
    );
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
      await expect(restoreBackup(file, KEY, into, quiet)).rejects.toThrow(
        /psql could not be started/,
      );
      await expect(
        restoreDrill({ file, backupKey: KEY, adminUrl: t.adminUrl, appUrl: t.appUrl, log: quiet }),
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
  });
});

// pg_dump and psql are in the worker image and on CI; not on every desk.
describe.skipIf(!testAdminUrl() || (PG_BIN === null && !MUST_RESTORE))('restoring a backup', () => {
  let vault: TestDatabase;
  let dir: string;
  let file: string;
  let known: number;
  let vaultPrivileges: string[];
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
    await seed(vault.adminUrl);
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
    const report = await restoreBackup(file, KEY, into(t), quiet);
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

  it('refuses a database that is not empty, and leaves it as it was', async () => {
    await expect(restoreBackup(file, KEY, into(vault), quiet)).rejects.toBeInstanceOf(
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
    await expect(restoreBackup(cut, KEY, into(t), quiet)).rejects.toThrow(/could not be read/);
    expect(await tablesIn(t.adminUrl)).toBe(0);
  }, 60_000);

  it('refuses, whole, a backup from a newer release', async () => {
    const newer = await reseal(
      file,
      (plain) =>
        `${plain}\ninsert into public.schema_migration (version, name) values (${known + 1}, 'later');\n`,
    );
    const t = await empty();
    await expect(restoreBackup(newer, KEY, into(t), quiet)).rejects.toThrow(
      new RegExp(`newer release .*schema ${known + 1}\\), and this one only knows schema ${known}`),
    );
    expect(await tablesIn(t.adminUrl)).toBe(0);
  }, 60_000);

  it('refuses, whole, a file that is not a backup of a vault', async () => {
    const other = await reseal(file, () => 'create table public.stray (x int);\n');
    const t = await empty();
    await expect(restoreBackup(other, KEY, into(t), quiet)).rejects.toThrow(/not a backup/);
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
      const report = await restoreBackup(olderFile, KEY, into(t), quiet);
      expect(report).toMatchObject({ schema: known, households: 1, documents: 3 });
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
      const report = await restoreBackup(olderFile, KEY, into(t), quiet);
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

  it('the drill restores into a scratch database and leaves nothing behind', async () => {
    const report = await restoreDrill({
      file,
      backupKey: KEY,
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
    await expect(restoreBackup(file, KEY, wrong, quiet)).rejects.toBeInstanceOf(RestoreIncomplete);
    expect(await tablesIn(t.adminUrl)).toBeGreaterThan(0);
  }, 60_000);
});
