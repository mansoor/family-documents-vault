import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CreateBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { BACKUP_OFFSITE_KEY_PURPOSE, deriveKey, sealBackupOffsiteSecret } from '@fdv/crypto';
import { createDb, createPool, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { OffsiteError, type OffsiteBucket } from '@fdv/storage';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OwnersAlert } from '../ai-send.js';
import { copyOffsite, noticeOffsite, offsiteCopyFile } from './backup-offsite.js';
import { RESTORE_UNDO } from './restore.js';

/**
 * The off-site copy of the nightly backups (0.9.0-dev.76): the backup file as
 * it is, to a bucket an owner set in Settings → Backups and turned on; what
 * became of it kept on the setting; the owners told once an incident when
 * it fails or is late; and never while the database holds more than one
 * household.
 */

const MASTER = 'offsite-test-master-secret-with-32-bytes!!';
const KEY = deriveKey(MASTER, BACKUP_OFFSITE_KEY_PURPOSE);
const SECRET = 'the-bucket-secret-key';

describe('the off-site copy job', () => {
  it('names a backup in the backups directory, and nothing else', () => {
    expect(offsiteCopyFile('/data/backups', { file: 'fdv-2026-11-20T02-30-00-000Z.sql.enc' })).toBe(
      path.join('/data/backups', 'fdv-2026-11-20T02-30-00-000Z.sql.enc'),
    );
    for (const data of [
      { file: '../.env' },
      { file: '/etc/passwd' },
      { file: 'fdv-2026-11-20T02-30-00-000Z.sql.enc.partial' },
      {},
      null,
    ]) {
      expect(offsiteCopyFile('/data/backups', data)).toBeNull();
    }
  });
});

describe.skipIf(!testAdminUrl())('the off-site backup copy', () => {
  let vault: TestDatabase;
  let admin: pg.Pool;
  let appPool: pg.Pool;
  let db: Db;
  let hh: string;
  let dir: string;
  let file: string;
  const log: unknown[][] = [];
  const told: OwnersAlert[] = [];
  /** What the copy was given, and what it answers. */
  const sent: { bucket: OffsiteBucket; file: string }[] = [];
  let fails: OffsiteError | null = null;
  /** Each prune asked for, and what runs as the upload goes (a change saved meanwhile). */
  const pruned: number[] = [];
  let during: (() => Promise<void>) | null = null;

  const deps = () => ({
    admin,
    db,
    key: KEY,
    log: (...a: unknown[]) => void log.push(a),
    upload: async (bucket: OffsiteBucket, f: string) => {
      sent.push({ bucket, file: f });
      if (during) await during();
      if (fails) throw fails;
      return { key: `vault/${path.basename(f)}`, bytes: 123 };
    },
    prune: async (_b: OffsiteBucket, keep: number) => {
      pruned.push(keep);
      return [];
    },
  });
  const notice = () =>
    noticeOffsite({
      admin,
      db,
      tell: async (a) => {
        told.push(a);
      },
    });
  const row = async () =>
    (
      await admin.query<{
        last_result: string | null;
        last_problem: string | null;
        last_copy_at: Date | null;
        last_copy_object: string | null;
        last_copy_bytes: string | null;
        alerted_at: Date | null;
      }>('select * from backup_offsite where household_id = $1', [hh])
    ).rows[0];
  const turnOn = async () => {
    await admin.query('delete from backup_offsite');
    await admin.query(
      `insert into backup_offsite (household_id, endpoint, region, bucket, prefix, access_key_id,
                                   secret_encrypted, status, enabled, enabled_at)
       values ($1, 'https://s3.example.test', 'us-east-1', 'family-backups', 'vault', 'AKID',
               $2, 'ok', true, now())`,
      [
        hh,
        sealBackupOffsiteSecret(KEY, SECRET, hh, {
          endpoint: 'https://s3.example.test',
          bucket: 'family-backups',
          accessKeyId: 'AKID',
        }),
      ],
    );
  };

  beforeAll(async () => {
    vault = await createTestDatabase();
    admin = new pg.Pool({ connectionString: vault.adminUrl, max: 2 });
    appPool = createPool(vault.appUrl, 2);
    db = createDb(appPool);
    hh = randomUUID();
    await admin.query("insert into household (id, name) values ($1, 'Copied')", [hh]);
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'One') returning id",
      [hh],
    );
    const a = await admin.query<{ id: string }>(
      'insert into account (email) values ($1) returning id',
      [`offsite-${hh}@example.test`],
    );
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [a.rows[0]?.id, hh, m.rows[0]?.id],
    );
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-offsite-'));
    file = path.join(dir, 'fdv-2026-11-20T02-30-00-000Z.sql.enc');
    await writeFile(file, randomBytes(64));
  });
  afterAll(async () => {
    await appPool?.end();
    await admin?.end();
    await vault?.drop();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    log.length = 0;
    told.length = 0;
    sent.length = 0;
    pruned.length = 0;
    during = null;
    fails = null;
    await turnOn();
  });

  it('copies nothing while it is off', async () => {
    await admin.query('update backup_offsite set enabled = false');
    expect(await copyOffsite(deps(), file)).toEqual({ copied: 0, failed: 0 });
    expect(sent).toEqual([]);
  });

  it('copies the backup as it is, with the secret opened, and says so on the setting', async () => {
    expect(await copyOffsite(deps(), file)).toEqual({ copied: 1, failed: 0 });
    expect(sent).toEqual([
      {
        bucket: {
          endpoint: 'https://s3.example.test',
          region: 'us-east-1',
          bucket: 'family-backups',
          prefix: 'vault',
          pathStyle: true,
          accessKeyId: 'AKID',
          secretAccessKey: SECRET,
        },
        file,
      },
    ]);
    expect(await row()).toMatchObject({
      last_result: 'ok',
      last_problem: null,
      last_copy_object: 'vault/fdv-2026-11-20T02-30-00-000Z.sql.enc',
      last_copy_bytes: '123',
    });
    // Nothing in the log is the secret.
    expect(JSON.stringify(log)).not.toContain(SECRET);
    // Nothing to tell.
    expect(await notice()).toBe(0);
  });

  it('a copy that failed is kept as a reason, and the owners are told once, until one goes', async () => {
    fails = new OffsiteError('credentials_rejected', 'InvalidAccessKeyId: the provider said so');
    expect(await copyOffsite(deps(), file)).toEqual({ copied: 0, failed: 1 });
    expect(await row()).toMatchObject({
      last_result: 'failed',
      last_problem: 'credentials_rejected',
    });
    expect(await notice()).toBe(1);
    expect(told[0]?.subject).toBe('Your backups could not be copied off-site');
    expect(told[0]?.body).toMatch(/access key ID or secret key was not accepted/);
    expect(told[0]?.body).not.toContain('the provider said so');
    // The same incident: not told again, however many nights it fails.
    await copyOffsite(deps(), file);
    expect(await notice()).toBe(0);
    // A copy that goes ends it; the next failure is told again.
    fails = null;
    await copyOffsite(deps(), file);
    expect((await row())?.alerted_at).toBeNull();
    fails = new OffsiteError('unreachable', 'ECONNREFUSED');
    await copyOffsite(deps(), file);
    expect(await notice()).toBe(1);
    expect(told).toHaveLength(2);
  });

  it('a copy late by two days is told of, once, though nothing failed', async () => {
    await copyOffsite(deps(), file);
    expect(await notice()).toBe(0);
    await admin.query(
      "update backup_offsite set last_copy_at = now() - interval '3 days', enabled_at = now() - interval '10 days'",
    );
    expect(await notice()).toBe(1);
    expect(told[0]?.subject).toBe('Your backups have not been copied off-site lately');
    expect(await notice()).toBe(0);
    // Turned on again: a new incident may be told of.
    await admin.query(
      "update backup_offsite set enabled_at = now() - interval '3 days' + interval '1 second'",
    );
    await admin.query("update backup_offsite set alerted_at = now() - interval '4 days'");
    expect(await notice()).toBe(1);
  });

  it('a failure fixed and the copy turned on again is not told of before the next try', async () => {
    fails = new OffsiteError('credentials_rejected', 'no');
    await copyOffsite(deps(), file);
    expect(await notice()).toBe(1);
    // The owner fixes the key and turns it on again: the old failure is not
    // this incident's, so nothing is told until the next copy is tried.
    await admin.query(
      "update backup_offsite set enabled_at = now() + interval '1 second', alerted_at = null",
    );
    expect(await notice()).toBe(0);
    fails = null;
    await copyOffsite(deps(), file);
    expect(await notice()).toBe(0);
    expect(told).toHaveLength(1);
  });

  it('removes nothing with a key that may not delete', async () => {
    await copyOffsite(deps(), file);
    expect(pruned).toEqual([30]);
    await admin.query('update backup_offsite set can_delete = false');
    expect(await copyOffsite(deps(), file)).toEqual({ copied: 1, failed: 0 });
    expect(pruned).toEqual([30]);
  });

  it('a bucket saved while a copy ran is not said to have had it', async () => {
    during = async () => {
      await admin.query(
        "update backup_offsite set bucket = 'new-bucket', enabled = false, status = 'untested'",
      );
    };
    await copyOffsite(deps(), file);
    expect(await row()).toMatchObject({ last_result: null, last_copy_object: null });
  });

  it('says late after the days it is given: two unless said', async () => {
    await copyOffsite(deps(), file);
    await admin.query(
      "update backup_offsite set last_copy_at = now() - interval '3 days', enabled_at = now() - interval '10 days'",
    );
    const later = (lateDays: number) =>
      noticeOffsite({ admin, db, tell: async (a) => void told.push(a), lateDays });
    expect(await later(7)).toBe(0);
    expect(await later(2)).toBe(1);
    expect(told[0]?.body).toMatch(/for more than 2 days/);
  });

  it('a restore turns the copy off and untested: no old bucket is copied to, nobody told', async () => {
    await copyOffsite(deps(), file);
    await admin.query('update backup_offsite set can_delete = true');
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(RESTORE_UNDO);
      const { rows } = await client.query<Record<string, unknown>>(
        'select enabled, status, last_tested_at, test_problem, can_delete from backup_offsite',
      );
      expect(rows).toEqual([
        {
          enabled: false,
          status: 'untested',
          last_tested_at: null,
          test_problem: null,
          can_delete: null,
        },
      ]);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('a secret that does not open is said so, and nothing is sent', async () => {
    await admin.query("update backup_offsite set bucket = 'somebody-elses'");
    expect(await copyOffsite(deps(), file)).toEqual({ copied: 0, failed: 1 });
    expect(sent).toEqual([]);
    expect((await row())?.last_problem).toBe('secret_unopened');
  });

  it('never copies a database that holds more than one household', async () => {
    const other = randomUUID();
    await admin.query("insert into household (id, name) values ($1, 'Another')", [other]);
    try {
      expect(await copyOffsite(deps(), file)).toEqual({ copied: 0, failed: 1 });
      expect(sent).toEqual([]);
      expect((await row())?.last_problem).toBe('several_households');
    } finally {
      await admin.query('delete from household where id = $1', [other]);
    }
  });
});

const S3_ENDPOINT = process.env.S3_TEST_ENDPOINT ?? '';

describe.skipIf(!testAdminUrl() || !S3_ENDPOINT)('the off-site copy, to a real bucket', () => {
  it('copies the file and keeps the newest of its own', async () => {
    const vault = await createTestDatabase();
    const admin = new pg.Pool({ connectionString: vault.adminUrl, max: 2 });
    const appPool = createPool(vault.appUrl, 2);
    const dir = await mkdtemp(path.join(tmpdir(), 'fdv-offsite-'));
    const creds = {
      accessKeyId: process.env.S3_TEST_KEY ?? 'fdv',
      secretAccessKey: process.env.S3_TEST_SECRET ?? 'fdv-minio-test',
    };
    const bucket = `fdv-offsite-w-${randomBytes(4).toString('hex')}`;
    const s3 = new S3Client({
      endpoint: S3_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: creds,
    });
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      const hh = randomUUID();
      await admin.query("insert into household (id, name) values ($1, 'Real')", [hh]);
      await admin.query(
        `insert into backup_offsite (household_id, endpoint, region, bucket, prefix, access_key_id,
                                     secret_encrypted, retain_count, status, enabled, enabled_at)
         values ($1, $2, 'us-east-1', $3, 'nightly', $4, $5, 2, 'ok', true, now())`,
        [
          hh,
          S3_ENDPOINT,
          bucket,
          creds.accessKeyId,
          sealBackupOffsiteSecret(KEY, creds.secretAccessKey, hh, {
            endpoint: S3_ENDPOINT,
            bucket,
            accessKeyId: creds.accessKeyId,
          }),
        ],
      );
      const deps = { admin, db: createDb(appPool), key: KEY, log: () => undefined };
      for (const day of ['01', '02', '03']) {
        const f = path.join(dir, `fdv-2026-11-${day}T02-30-00-000Z.sql.enc`);
        await writeFile(f, randomBytes(256));
        expect(await copyOffsite(deps, f)).toEqual({ copied: 1, failed: 0 });
      }
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      expect((listed.Contents ?? []).map((o) => o.Key).sort()).toEqual([
        'nightly/fdv-2026-11-02T02-30-00-000Z.sql.enc',
        'nightly/fdv-2026-11-03T02-30-00-000Z.sql.enc',
      ]);
    } finally {
      s3.destroy();
      await appPool.end();
      await admin.end();
      await vault.drop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
