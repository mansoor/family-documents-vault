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
    expect(r).toEqual({ done: 1, abandoned: 1, photos: 0, incoming: 0 });
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

  it('a photo left half made for a day goes, with its upload', async () => {
    const member = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Aisha') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    const upload = (name: string) => `${hh}/members/${member}/incoming/${name}.enc`;
    const photo = (state: string, created: Date, source: string | null) =>
      admin.query<{ id: string }>(
        `insert into member_photo
           (household_id, member_id, state, sealed, ready_at, source_key, source_vault_id,
            source_key_wrapped, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [
          hh,
          member,
          state,
          state === 'ready' ? Buffer.alloc(40) : null,
          state === 'ready' ? created : null,
          source,
          source ? vault : null,
          source ? Buffer.alloc(40) : null,
          created,
        ],
      );
    // Made long ago: never touched. Half made two days ago: goes, and its
    // upload with it. (One unfinished per person: the recent one is tried
    // on its own below.)
    const ready = (await photo('ready', ago(30), null)).rows[0]?.id;
    await photo('processing', ago(2), upload('stale'));
    for (const o of [upload('stale'), upload('recent')]) {
      await mkdir(path.dirname(path.join(root, o)), { recursive: true });
      await writeFile(path.join(root, o), 'sealed, half a photo');
    }
    const prune = () =>
      pruneUploads({
        admin,
        app: db,
        credentialsKey: Buffer.alloc(32),
        localRoot: root,
        now: () => now,
      });
    expect(await prune()).toEqual({ done: 0, abandoned: 0, photos: 1, incoming: 0 });
    expect(await exists(upload('stale'))).toBe(false);
    const left = async () =>
      (
        await admin.query<{ id: string; state: string }>(
          'select id, state from member_photo where member_id = $1 order by state',
          [member],
        )
      ).rows;
    expect(await left()).toEqual([{ id: ready, state: 'ready' }]);

    // One still on its way, sent an hour ago, keeps its bytes.
    await photo('processing', ago(1 / 24), upload('recent'));
    expect(await prune()).toEqual({ done: 0, abandoned: 0, photos: 0, incoming: 0 });
    expect(await exists(upload('recent'))).toBe(true);
    expect((await left()).map((r) => r.state)).toEqual(['processing', 'ready']);
  });

  it("a file sent through a request whose try died goes after a day, with its object; an ended request's address is cleared (5.21)", async () => {
    const member = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Asker') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    const account = (
      await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
        `asker-${hh}@example.test`,
      ])
    ).rows[0]?.id as string;
    const scope = (
      await admin.query<{ id: string }>(
        "select id from scope_key where household_id = $1 and kind = 'household'",
        [hh],
      )
    ).rows[0]?.id as string;
    const request = async (revoked: boolean) =>
      (
        await admin.query<{ id: string }>(
          `insert into upload_request
             (household_id, created_by, requester_member_id, title, token_hash, expires_at,
              recipient_email, revoked_at)
           values ($1, $2, $3, 'Tax', $4, now() + interval '1 day', 'jane@example.test', $5)
           returning id`,
          [hh, account, member, Buffer.from(randomUUID()), revoked ? now : null],
        )
      ).rows[0]?.id as string;
    const live = await request(false);
    const takenBack = await request(true);
    // Used up with its address still there, as a backup from before its last
    // visit cleared it would bring it back: an insert, which no trigger sees.
    const usedUp = (
      await admin.query<{ id: string }>(
        `insert into upload_request
           (household_id, created_by, requester_member_id, title, token_hash, expires_at,
            recipient_email, max_visits, visits_used)
         values ($1, $2, $3, 'Tax', $4, now() + interval '1 day', 'jane@example.test', 1, 1)
         returning id`,
        [hh, account, member, Buffer.from(randomUUID())],
      )
    ).rows[0]?.id as string;
    const file = async (name: string, created: Date) => {
      const key = `${hh}/incoming/${live}/${name}.enc`;
      await mkdir(path.dirname(path.join(root, key)), { recursive: true });
      await writeFile(path.join(root, key), 'half a file, sealed');
      await admin.query(
        `insert into incoming_file
           (household_id, request_id, review_by, requester_member_id, original_name, storage_key,
            vault_id, file_key_wrapped, wrapped_by_scope, scope, created_at)
         values ($1, $2, 'me', $3, 'w2.pdf', $4, $5, '\\x00', $6, 'member', $7)`,
        [hh, live, member, key, vault, scope, created],
      );
      return key;
    };
    const dead = await file('dead', ago(2));
    const running = await file('running', ago(0.1));
    const r = await pruneUploads({
      admin,
      app: db,
      credentialsKey: Buffer.alloc(32),
      localRoot: root,
      now: () => now,
    });
    expect(r).toEqual({ done: 0, abandoned: 0, photos: 0, incoming: 1 });
    expect(await exists(dead)).toBe(false);
    expect(await exists(running)).toBe(true);
    const emails = await admin.query<{ id: string; recipient_email: string | null }>(
      'select id, recipient_email from upload_request where household_id = $1',
      [hh],
    );
    expect(Object.fromEntries(emails.rows.map((e) => [e.id, e.recipient_email]))).toEqual({
      [live]: 'jane@example.test',
      [takenBack]: null,
      [usedUp]: null,
    });
  });
});
