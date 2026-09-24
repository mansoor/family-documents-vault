import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDb, createPool, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pruneUploads } from './uploads.js';

/**
 * The nightly sweep of upload keys: done keys go after 180 days, and a
 * claim whose try died goes after a day, with its temporary object.
 */
describe.skipIf(!testAdminUrl())('pruning upload keys', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let root: string;
  const hh = randomUUID();
  const vault = randomUUID();
  const now = new Date('2026-09-24T04:25:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const keys = {
    oldDone: randomUUID(),
    recentDone: randomUUID(),
    deadClaim: randomUUID(),
    liveClaim: randomUUID(),
  };
  const deadObject = `${hh}/some-document/incoming/${keys.deadClaim}.nonce.enc`;
  const liveObject = `${hh}/some-document/incoming/${keys.liveClaim}.nonce.enc`;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 2));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    root = await mkdtemp(path.join(tmpdir(), 'fdv-prune-'));
    await admin.query("insert into household (id, name) values ($1, 'Sweep')", [hh]);
    await admin.query(
      "insert into vault (id, household_id, kind, label) values ($1, $2, 'local', 'This computer')",
      [vault, hh],
    );
    const account = (
      await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
        `sweep-${hh}@example.test`,
      ])
    ).rows[0]?.id;
    const doc = (
      await admin.query<{ id: string }>(
        'insert into document (household_id, title) values ($1, $2) returning id',
        [hh, 'Swept'],
      )
    ).rows[0]?.id;
    const insert = (key: string, state: 'done' | 'pending', claimed: Date, temp: string | null) =>
      admin.query(
        `insert into upload_idempotency
           (idempotency_key, household_id, account_id, state, request_kind, document_id,
            claim_nonce, claimed_at, temp_key, temp_vault_id)
         values ($1, $2, $3, $4, 'capture', $5, $6, $7, $8, $9)`,
        [
          key,
          hh,
          account,
          state,
          state === 'done' ? doc : null,
          state === 'pending' ? randomUUID() : null,
          claimed,
          temp,
          temp ? vault : null,
        ],
      );
    // A done key names the version it made (a check constraint says so).
    const scope = (
      await admin.query<{ id: string }>(
        "insert into scope_key (household_id, kind, key_wrapped) values ($1, 'household', '\\x00') returning id",
        [hh],
      )
    ).rows[0]?.id;
    const version = async () =>
      (
        await admin.query<{ id: string }>(
          `insert into document_version
             (household_id, document_id, version_no, filename, mime, byte_size, sha256,
              cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope)
           values ($1, $2, (select coalesce(max(version_no), 0) + 1 from document_version where document_id = $2),
                   'a.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00', $3, $4, '\\x00', $5)
           returning id`,
          [hh, doc, `${hh}/${randomUUID()}.enc`, vault, scope],
        )
      ).rows[0]?.id;
    for (const [key, days] of [
      [keys.oldDone, 181],
      [keys.recentDone, 179],
    ] as const) {
      await insert(key, 'pending', ago(days), null);
      await admin.query(
        "update upload_idempotency set state = 'done', document_id = $2, version_id = $3 where idempotency_key = $1",
        [key, doc, await version()],
      );
    }
    await insert(keys.deadClaim, 'pending', ago(2), deadObject);
    await insert(keys.liveClaim, 'pending', ago(0.1), liveObject);
    for (const o of [deadObject, liveObject]) {
      await mkdir(path.dirname(path.join(root, o)), { recursive: true });
      await writeFile(path.join(root, o), 'half an upload');
    }
  }, 60_000);
  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const exists = (p: string) =>
    stat(path.join(root, p)).then(
      () => true,
      () => false,
    );

  it('done keys older than 180 days are pruned; a claim whose try died goes after a day, with its object', async () => {
    const r = await pruneUploads({
      admin,
      app: db,
      credentialsKey: Buffer.alloc(32),
      localRoot: root,
      now: () => now,
    });
    expect(r).toEqual({ done: 1, abandoned: 1 });
    const left = await admin.query<{ idempotency_key: string }>(
      'select idempotency_key from upload_idempotency where household_id = $1 order by idempotency_key',
      [hh],
    );
    expect(left.rows.map((x) => x.idempotency_key).sort()).toEqual(
      [keys.recentDone, keys.liveClaim].sort(),
    );
    expect(await exists(deadObject)).toBe(false);
    // A try still running keeps its bytes.
    expect(await exists(liveObject)).toBe(true);
  });
});
