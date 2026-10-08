import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EncryptStream, EnvKeyProvider, newKey, ScopeKeys, wrapKey } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueue } from '../queue.js';
import {
  drawNextBatchItem,
  sendBatchPreviews,
  sweepBatches,
  workBatchPreviews,
  type DrawItem,
} from './batches.js';
import { scanIncoming, sweepIncoming, tellWaiting, type IncomingDeps } from './incoming.js';
import type { ItemProposer } from './proposal-thread.js';

/**
 * Many documents at once (Phase 6, I1), in the worker: a batch's items
 * drawn one at a time a household, each household taking its turn, never
 * crowding out a household's single adds or the files sent to it; nobody
 * told of them; and a batch past its end removed with what is undecided.
 */

const MASTER = 'batches-test-master-key-with-32-bytes-or-more';

describe.skipIf(!testAdminUrl())('a batch’s items, in the worker', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let root: string;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  /** Two households: each an uploader, their member key and their vault. */
  const homes: Record<'a' | 'b', { hh: string; member: string; account: string; vault: string }> =
    {} as never;
  let deps: IncomingDeps;
  const told: string[] = [];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    admin.on('error', () => undefined);
    root = await mkdtemp(path.join(tmpdir(), 'fdv-batches-'));
    for (const name of ['a', 'b'] as const) {
      const hh = randomUUID();
      await admin.query("insert into household (id, name, timezone) values ($1, $2, 'UTC')", [
        hh,
        `Home ${name}`,
      ]);
      const member = (
        await admin.query<{ id: string }>(
          'insert into member (household_id, display_name) values ($1, $2) returning id',
          [hh, `Uploader ${name}`],
        )
      ).rows[0]?.id as string;
      const account = (
        await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
          `${name}-${stamp}@batches.test`,
        ])
      ).rows[0]?.id as string;
      await admin.query(
        "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'adult')",
        [account, hh, member],
      );
      const vault = await withSystem(db, hh, async (trx) => {
        await keys.mintHouseholdKeys(trx, hh);
        await keys.mintMemberKey(trx, hh, member, null);
        const v = await trx
          .insertInto('vault')
          .values({ household_id: hh, kind: 'local', label: 'test', status: 'ok' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('household')
          .set({ active_vault_id: v.id })
          .where('id', '=', hh)
          .execute();
        return v.id;
      });
      homes[name] = { hh, member, account, vault };
    }
    deps = {
      admin,
      db,
      keys,
      credentialsKey: Buffer.alloc(32),
      localRoot: root,
      log: () => undefined,
      // Anybody told of anything is written down here: nobody should be.
      tell: {
        vapid: { publicKey: 'public', privateKey: 'private', subject: 'mailto:v@batches.test' },
        smtpKey: Buffer.alloc(32),
        baseUrl: 'https://vault.batches.test',
        deliver: async (_d, device) => {
          told.push(device.id ?? '');
          return 'sent';
        },
      },
    };
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    await rm(root, { recursive: true, force: true });
  });

  /** A batch of the home's uploader, ending when said. */
  const batch = async (home: 'a' | 'b', endsInDays = 30) =>
    (
      await admin.query<{ id: string }>(
        `insert into intake_batch (household_id, created_by, member_id, created_at, ends_at)
         values ($1, $2, $3, now() - interval '1 day' * (30 - $4::int),
                 now() + interval '1 day' * $4::int)
         returning id`,
        [homes[home].hh, homes[home].account, homes[home].member, endsInDays],
      )
    ).rows[0]?.id as string;

  /** An item that has arrived, its bytes (as stored) and a page beside it. */
  const item = async (
    home: 'a' | 'b',
    batchId: string,
    opts: { state?: string; arrived?: string; mime?: string } = {},
  ) => {
    const { hh, member, vault } = homes[home];
    const id = randomUUID();
    const key = `${hh}/batches/${batchId}/${randomBytes(8).toString('hex')}.enc`;
    const adapter = new LocalAdapter(root);
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    // Its bytes encrypted under its own key, as the API stores them: words to read (I2).
    const fileKey = newKey();
    const enc = new EncryptStream(fileKey);
    await Promise.all([
      adapter.put(key, enc),
      pipeline(Readable.from([Buffer.from(`the words of ${id}`)]), enc),
    ]);
    await adapter.put(`${key}.p1.enc`, Readable.from([Buffer.from('a page')]));
    const scope = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: member }),
    );
    const state = opts.state ?? 'received';
    await admin.query(
      `insert into incoming_file (id, household_id, batch_id, review_by, requester_member_id, state,
                                  original_name, mime, byte_size, sha256, cipher_bytes, cipher_sha256,
                                  storage_key, vault_id, file_key_wrapped, wrapped_by_scope, scope,
                                  scan_state, read_state, received_at, submitted_at,
                                  decided_at, object_removed_at)
       values ($1, $2, $3, 'me', $4, $5, 'scan.pdf', $6, 10, $7, 38, $8, $9, $10, $11, $12, 'member',
               'unscanned', 'waiting', $13::timestamptz, $13::timestamptz,
               case when $5 in ('accepted', 'rejected') then now() end,
               case when $5 in ('accepted', 'rejected') then now() end)`,
      [
        id,
        hh,
        batchId,
        member,
        state,
        opts.mime ?? 'application/pdf',
        randomBytes(32),
        randomBytes(32),
        key,
        vault,
        wrapKey(fileKey, scope.key, `incoming:${id}`),
        scope.id,
        opts.arrived ?? new Date().toISOString(),
      ],
    );
    return { id, key };
  };

  const there = (key: string) =>
    stat(path.join(root, key)).then(
      () => true,
      () => false,
    );
  const previewOf = async (id: string) =>
    (
      await admin.query<{ preview_state: string }>(
        'select preview_state from incoming_file where id = $1',
        [id],
      )
    ).rows[0]?.preview_state;

  it('a batch is drawn one item at a time a household, each household taking its turn', async () => {
    const order: string[] = [];
    // Drawing stood in for: written down, and recorded as the real one would
    // record a kind it does not draw.
    const draw: DrawItem = async (d, hh, f) => {
      order.push(f.id);
      await withSystem(d.db, hh, (trx) =>
        trx
          .updateTable('incoming_file')
          .set({ preview_state: 'unsupported', preview_pages: 0 })
          .where('id', '=', f.id)
          .execute(),
      );
    };
    const big = await batch('a');
    const small = await batch('b');
    const t = Date.now();
    const a1 = await item('a', big, { arrived: new Date(t - 3000).toISOString() });
    const a2 = await item('a', big, { arrived: new Date(t - 2000).toISOString() });
    const a3 = await item('a', big, { arrived: new Date(t - 1000).toISOString() });
    const b1 = await item('b', small, { arrived: new Date(t).toISOString() });
    const boss: PgBoss = createQueue({ connectionString: tdb.adminUrl, migrate: true });
    boss.on('error', () => undefined);
    await boss.start();
    try {
      await boss.createQueue('batch.previews', { policy: 'stately' });
      // As the API sends them: household A's first, as its 200 arrive (one
      // waits, whatever more are sent), then household B's one.
      await sendBatchPreviews(boss, homes.a.hh);
      await sendBatchPreviews(boss, homes.a.hh);
      await sendBatchPreviews(boss, homes.a.hh);
      await sendBatchPreviews(boss, homes.b.hh);
      await workBatchPreviews(boss, deps, { draw, pollingIntervalSeconds: 0.5 });
      for (let i = 0; i < 200 && order.length < 4; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // B's one waited for one of A's, not for all of them.
      expect(order).toEqual([a1.id, b1.id, a2.id, a3.id]);
    } finally {
      await boss.stop({ graceful: false });
    }
  }, 60_000);

  it('with reading added (I2), a job draws one item and reads one, and each household still takes its turn', async () => {
    // Clear what earlier tests left waiting.
    await admin.query(
      "update incoming_file set state = 'rejected', decided_at = now(), original_name = null, sha256 = null, text_sealed = null, proposals_sealed = null where state = 'received'",
    );
    const order: string[] = [];
    const draw: DrawItem = async (d, hh, f) => {
      order.push(`draw ${f.id}`);
      await withSystem(d.db, hh, (trx) =>
        trx
          .updateTable('incoming_file')
          .set({ preview_state: 'unsupported', preview_pages: 0 })
          .where('id', '=', f.id)
          .execute(),
      );
    };
    // Reading stood in for at the extraction and the thread: written down by the words read.
    const ids = new Map<string, string>();
    const proposer: ItemProposer = {
      propose: async (text) => {
        order.push(`read ${ids.get(text) ?? text}`);
        return { state: 'done', proposal: {} };
      },
    };
    const big = await batch('a');
    const small = await batch('b');
    const t = Date.now();
    const a1 = await item('a', big, { arrived: new Date(t - 3000).toISOString() });
    const a2 = await item('a', big, { arrived: new Date(t - 2000).toISOString() });
    const a3 = await item('a', big, { arrived: new Date(t - 1000).toISOString() });
    const b1 = await item('b', small, { arrived: new Date(t).toISOString() });
    for (const i of [a1, a2, a3, b1]) ids.set(`the words of ${i.id}`, i.id);
    const boss: PgBoss = createQueue({ connectionString: tdb.adminUrl, migrate: true });
    boss.on('error', () => undefined);
    await boss.start();
    try {
      await boss.createQueue('batch.previews', { policy: 'stately' });
      await sendBatchPreviews(boss, homes.a.hh);
      await sendBatchPreviews(boss, homes.b.hh);
      await workBatchPreviews(boss, deps, {
        draw,
        pollingIntervalSeconds: 0.5,
        read: {
          maxPages: 5,
          proposer,
          tools: { pdftoppm: false, magick: false, tesseract: false },
          extract: async (file) => {
            const { readFile } = await import('node:fs/promises');
            return { text: await readFile(file, 'utf8'), source: 'pdf', textPages: 1, ocrPages: 0 };
          },
        },
      });
      const states = async () =>
        (
          await admin.query<{ read_state: string }>(
            'select read_state from incoming_file where id = any($1::uuid[]) order by received_at',
            [[a1.id, a2.id, a3.id, b1.id]],
          )
        ).rows.map((r) => r.read_state);
      for (let i = 0; i < 300 && (await states()).some((r) => r !== 'read'); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // Each job: one item drawn, then that one read, before anything else;
      // A's in the order they came; and B's waited for a job of A's, never
      // for all of them. (Which of A's next job and B's the queue takes
      // first after a1 is the queue's own order, by when each was sent.)
      expect(order).toHaveLength(8);
      for (let i = 0; i < 8; i += 2) {
        expect(order[i + 1]?.replace('read ', 'draw ')).toBe(order[i]);
      }
      const drawn = order.filter((o) => o.startsWith('draw ')).map((o) => o.slice(5));
      expect(drawn.filter((id) => id !== b1.id)).toEqual([a1.id, a2.id, a3.id]);
      expect(drawn.indexOf(b1.id)).toBeGreaterThan(0);
      expect(drawn.indexOf(b1.id)).toBeLessThan(drawn.indexOf(a3.id));
      expect(await states()).toEqual(['read', 'read', 'read', 'read']);
    } finally {
      await boss.stop({ graceful: false });
    }
  }, 60_000);

  it('the job draws only a batch’s items, and the scan of files sent in never draws them', async () => {
    const b = await batch('a');
    const waiting = await item('a', b, { mime: 'text/plain' });
    // A file sent through a request, waiting to be scanned, in the same household.
    const request = (
      await admin.query<{ id: string }>(
        `insert into upload_request (household_id, created_by, requester_member_id, title, token_hash,
                                     expires_at)
         values ($1, $2, $3, 'Tax', $4, now() + interval '1 day') returning id`,
        [homes.a.hh, homes.a.account, homes.a.member, randomBytes(32)],
      )
    ).rows[0]?.id as string;
    const scope = await withSystem(db, homes.a.hh, (trx) =>
      keys.unwrap(trx, { householdId: homes.a.hh, kind: 'member', memberId: homes.a.member }),
    );
    const sentIn = randomUUID();
    await admin.query(
      `insert into incoming_file (id, household_id, request_id, review_by, requester_member_id, state,
                                  original_name, mime, byte_size, sha256, cipher_bytes, cipher_sha256,
                                  storage_key, vault_id, file_key_wrapped, wrapped_by_scope, scope,
                                  received_at, submitted_at)
       values ($1, $2, $3, 'me', $4, 'received', 'w2.txt', 'text/plain', 10, $5, 38, $6, $7, $8, $9,
               $10, 'member', now(), now())`,
      [
        sentIn,
        homes.a.hh,
        request,
        homes.a.member,
        randomBytes(32),
        randomBytes(32),
        `${homes.a.hh}/incoming/${request}/x.enc`,
        homes.a.vault,
        wrapKey(newKey(), scope.key, `incoming:${sentIn}`),
        scope.id,
      ],
    );
    // The scan of files sent in: the request's file, and not the item.
    await scanIncoming(deps, { household_id: homes.a.hh });
    expect(await previewOf(sentIn)).toBe('unsupported');
    expect(await previewOf(waiting.id)).toBe('none');
    // The batch's job: the item (a kind it does not draw, said so), never the file sent in.
    await admin.query("update incoming_file set preview_state = 'none' where id = $1", [sentIn]);
    let r = await drawNextBatchItem(deps, { household_id: homes.a.hh });
    expect(r.drawn).toBe(waiting.id);
    expect(await previewOf(waiting.id)).toBe('unsupported');
    r = await drawNextBatchItem(deps, { household_id: homes.a.hh });
    expect(r).toEqual({ drawn: null, more: false });
    expect(await previewOf(sentIn)).toBe('none');
    // Nobody is told of an item, ready as it is.
    told.length = 0;
    await admin.query(
      `insert into device (household_id, account_id, kind, endpoint, p256dh, auth)
       values ($1, $2, 'web_push', 'https://push.batches.test/a', 'p256dh', 'auth')`,
      [homes.a.hh, homes.a.account],
    );
    await admin.query('delete from incoming_file where id = $1', [sentIn]);
    expect(await tellWaiting(deps, homes.a.hh)).toBe(0);
    expect(told).toEqual([]);
  });

  it('a batch past its end goes, with what is undecided in it; one still open stays', async () => {
    const ended = await batch('b', -1);
    const open = await batch('b', 5);
    const waiting = await item('b', ended);
    const accepted = await item('b', ended, { state: 'accepted' });
    const kept = await item('b', open);
    const report = await sweepIncoming(deps);
    expect(report.batchesRemoved).toBeGreaterThanOrEqual(1);
    expect(report.batchItemsRemoved).toBeGreaterThanOrEqual(1);
    expect(await there(waiting.key)).toBe(false);
    expect(await there(`${waiting.key}.p1.enc`)).toBe(false);
    const rows = await admin.query<{ id: string }>(
      'select id from incoming_file where id = any($1::uuid[])',
      [[waiting.id, accepted.id, kept.id]],
    );
    expect(rows.rows.map((r) => r.id)).toEqual([kept.id]);
    const batches = await admin.query<{ id: string }>(
      'select id from intake_batch where id = any($1::uuid[])',
      [[ended, open]],
    );
    expect(batches.rows.map((r) => r.id)).toEqual([open]);
    expect(await there(kept.key)).toBe(true);
    // Again, nothing more.
    expect(await sweepBatches(deps, homes.b.hh, new Date())).toEqual({ batches: 0, items: 0 });
  });

  it('items left undrawn by a lost job are sent again by the sweep, one job for the household', async () => {
    const b = await batch('a');
    await item('a', b, { arrived: new Date(Date.now() - 3_600_000).toISOString() });
    const sent: string[] = [];
    await sweepIncoming({ ...deps, sendBatchPreviews: async (hh) => void sent.push(hh) });
    expect(sent).toEqual([homes.a.hh]);
  });

  it('items drawn and left unread by a lost job are sent again by the sweep too (I2)', async () => {
    await admin.query(
      "update incoming_file set state = 'rejected', decided_at = now(), original_name = null, sha256 = null, text_sealed = null, proposals_sealed = null where state = 'received'",
    );
    const b = await batch('b');
    const left = await item('b', b, { arrived: new Date(Date.now() - 3_600_000).toISOString() });
    await admin.query(
      "update incoming_file set preview_state = 'ready', preview_pages = 1 where id = $1",
      [left.id],
    );
    const sent: string[] = [];
    await sweepIncoming({ ...deps, sendBatchPreviews: async (hh) => void sent.push(hh) });
    expect(sent).toEqual([homes.b.hh]);
    // Read since: nothing to send.
    await admin.query("update incoming_file set read_state = 'read' where id = $1", [left.id]);
    sent.length = 0;
    await sweepIncoming({ ...deps, sendBatchPreviews: async (hh) => void sent.push(hh) });
    expect(sent).toEqual([]);
  });
});
