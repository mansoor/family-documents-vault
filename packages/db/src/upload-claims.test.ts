import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMigrations, migrateUp } from './migrate.js';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0024 and the upload keys made before it.
 *
 * Keys written by 0.4.7 and earlier are all finished uploads. They keep
 * answering retries after the upgrade, which needs to know who made each
 * (the uploader of its version) and what for (a first version was a
 * capture, a later one a new version of a document).
 */
describe.skipIf(!testAdminUrl())('migration 0024: upload keys made before it', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let dir: string;
  const hh = randomUUID();
  const keys = { first: randomUUID(), second: randomUUID(), later: randomUUID() };
  let account = '';

  beforeAll(async () => {
    tdb = await createEmptyDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    // 0.4.7's schema.
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-0023-'));
    for (const m of await listMigrations()) {
      if (m.version <= 23) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);

    await admin.query("insert into household (id, name) values ($1, 'Keys')", [hh]);
    account = (
      await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
        `keys-${hh}@example.test`,
      ])
    ).rows[0]?.id as string;
    const vault = (
      await admin.query<{ id: string }>(
        "insert into vault (household_id, kind, label) values ($1, 'local', 'This computer') returning id",
        [hh],
      )
    ).rows[0]?.id;
    const scope = (
      await admin.query<{ id: string }>(
        "insert into scope_key (household_id, kind, key_wrapped) values ($1, 'household', '\\x00') returning id",
        [hh],
      )
    ).rows[0]?.id;
    const doc = (
      await admin.query<{ id: string }>(
        "insert into document (household_id, title) values ($1, 'Passport') returning id",
        [hh],
      )
    ).rows[0]?.id;
    for (const [n, key] of [
      [1, keys.first],
      [2, keys.second],
    ] as const) {
      const v = (
        await admin.query<{ id: string }>(
          `insert into document_version
             (household_id, document_id, version_no, filename, mime, byte_size, sha256, cipher_bytes,
              cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope, uploaded_by)
           values ($1, $2, $3, 'p.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00', $4, $5, '\\x00', $6, $7)
           returning id`,
          [hh, doc, n, `${hh}/${doc}/v${n}.enc`, vault, scope, account],
        )
      ).rows[0]?.id;
      await admin.query(
        `insert into upload_idempotency (idempotency_key, household_id, document_id, version_id, created_at)
         values ($1, $2, $3, $4, now() - make_interval(days => $5))`,
        [key, hh, doc, v, 10 - n],
      );
    }
    // A document made without a file, whose first file came a day later.
    const bare = (
      await admin.query<{ id: string }>(
        "insert into document (household_id, title, created_at) values ($1, 'Lease', now() - interval '1 day') returning id",
        [hh],
      )
    ).rows[0]?.id;
    const v = (
      await admin.query<{ id: string }>(
        `insert into document_version
           (household_id, document_id, version_no, filename, mime, byte_size, sha256, cipher_bytes,
            cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope, uploaded_by)
         values ($1, $2, 1, 'l.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00', $3, $4, '\\x00', $5, $6)
         returning id`,
        [hh, bare, `${hh}/${bare}/v1.enc`, vault, scope, account],
      )
    ).rows[0]?.id;
    await admin.query(
      `insert into upload_idempotency (idempotency_key, household_id, document_id, version_id, created_at)
       values ($1, $2, $3, $4, now() - interval '1 day')`,
      [keys.later, hh, bare, v],
    );
  }, 60_000);
  afterAll(async () => {
    await admin?.end();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('records who made each key and what for, as done', async () => {
    await migrateUp(admin);
    const { rows } = await admin.query<{
      key: string;
      account_id: string;
      state: string;
      request_kind: string;
      same_time: boolean;
    }>(
      `select idempotency_key as key, account_id, state, request_kind, claimed_at = created_at as same_time
         from upload_idempotency order by created_at`,
    );
    expect(rows).toEqual([
      {
        key: keys.first,
        account_id: account,
        state: 'done',
        request_kind: 'capture',
        same_time: true,
      },
      {
        key: keys.second,
        account_id: account,
        state: 'done',
        request_kind: 'version',
        same_time: true,
      },
      {
        key: keys.later,
        account_id: account,
        state: 'done',
        request_kind: 'version',
        same_time: true,
      },
    ]);
  });

  it('a done key must say what it made, and a pending one must carry its nonce', async () => {
    await expect(
      admin.query(
        "insert into upload_idempotency (idempotency_key, household_id, state) values ($1, $2, 'done')",
        [randomUUID(), hh],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        "insert into upload_idempotency (idempotency_key, household_id, state) values ($1, $2, 'pending')",
        [randomUUID(), hh],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `insert into upload_idempotency (idempotency_key, household_id, state, request_kind, claim_nonce)
         values ($1, $2, 'pending', 'capture', $3)`,
        [randomUUID(), hh, randomUUID()],
      ),
    ).resolves.toBeDefined();
  });
});
