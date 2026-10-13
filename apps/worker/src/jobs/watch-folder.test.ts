import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EnvKeyProvider, ScopeKeys, unwrapKey } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { BATCH_MAX_FILES, scannerDay, watchIgnored } from '@fdv/shared';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { decryptToBuffer } from './process-version.js';
import {
  checkWatchDir,
  looksComplete,
  WATCH_LOCK_KEY,
  watchItemKey,
  watchKindOf,
  WatchRunner,
  type WatchDeps,
  type WatchFs,
  type WatchOptions,
  type WatchRound,
} from './watch-folder.js';

/**
 * The scanner folder (0.8.0, S3), in the worker: a file taken once it has
 * stood still and looks complete, added to its person's batch of the day as
 * Add → Many documents adds one, and deleted; temp names, hidden files and
 * rejected/ left alone; nothing outside the folder ever read, written or
 * removed — through a link, a junction, a hard link or a folder swapped
 * mid-round; never two items of one file, whatever stops between storing
 * and deleting; what cannot be added moved to rejected/ with its reason and
 * its person told first; one runner however many workers, and a lost lock
 * stops the round; the setting asked again as each file is placed; paused
 * while its person cannot have files added, or the vault cannot store them;
 * the folder known to be missing or read-only; and what it adds its
 * person's alone.
 *
 * The tests of links, swaps and permissions run wherever the system can
 * make them: all of them on Linux (the worker's own, and CI's node:22-alpine
 * run); on Windows a folder link is a junction, and a file link or the
 * /proc check is skipped.
 */

const MASTER = 'watch-folder-test-master-key-with-32-bytes-or-more';
const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
/** A PNG's signature, a header, and its IEND: complete as far as its ends go. */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const LINUX = process.platform === 'linux';
const WINDOWS = process.platform === 'win32';
const ROOT_USER = process.getuid?.() === 0;

describe.skipIf(!testAdminUrl())('the scanner folder, in the worker', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let root: string;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  let hh: string;
  let vault: string;
  /** The family: an owner, two adults, a teen and a viewer, each with a sign-in. */
  const people: Record<
    'owner' | 'adult' | 'other' | 'teen' | 'viewer',
    { member: string; account: string }
  > = {} as never;
  const sent: string[] = [];
  const runners: WatchRunner[] = [];
  const dirs: string[] = [];
  let clock = Date.now();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 4));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 3 });
    admin.on('error', () => undefined);
    root = await fsp.mkdtemp(path.join(tmpdir(), 'fdv-watch-vault-'));
    hh = randomUUID();
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'Home', 'Pacific/Auckland')",
      [hh],
    );
    for (const [name, role] of [
      ['owner', 'owner'],
      ['adult', 'adult'],
      ['other', 'adult'],
      ['teen', 'teen'],
      ['viewer', 'viewer'],
    ] as const) {
      const member = (
        await admin.query<{ id: string }>(
          'insert into member (household_id, display_name) values ($1, $2) returning id',
          [hh, name],
        )
      ).rows[0]?.id as string;
      const account = (
        await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
          `${name}-${stamp}@watch.test`,
        ])
      ).rows[0]?.id as string;
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [account, hh, member, role],
      );
      people[name] = { member, account };
    }
    vault = await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      for (const p of Object.values(people)) await keys.mintMemberKey(trx, hh, p.member, null);
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
  }, 60_000);

  afterEach(async () => {
    for (const r of runners.splice(0)) await r.stop();
    for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
    await admin.query('delete from incoming_file where household_id = $1', [hh]);
    await admin.query('delete from intake_batch where household_id = $1', [hh]);
    await admin.query('delete from watch_notice where household_id = $1', [hh]);
    await admin.query('delete from watch_folder where household_id = $1', [hh]);
    await admin.query("update account_household set role = 'adult' where member_id = $1", [
      people.adult.member,
    ]);
    sent.length = 0;
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const folder = async () => {
    const d = await fsp.mkdtemp(path.join(tmpdir(), 'fdv-watch-'));
    dirs.push(d);
    return d;
  };
  const turnOn = (who: keyof typeof people = 'adult') =>
    admin.query(
      `insert into watch_folder (household_id, enabled, member_id) values ($1, true, $2)
       on conflict (household_id) do update set enabled = true, member_id = $2`,
      [hh, people[who].member],
    );
  const deps = (over: Partial<WatchDeps> = {}): WatchDeps => ({
    admin,
    db,
    keys,
    credentialsKey: Buffer.alloc(32),
    localRoot: root,
    log: () => undefined,
    itemKey: Buffer.alloc(32, 7),
    maxBytes: 64 * 1024,
    sendBatchPreviews: async (h) => {
      sent.push(h);
    },
    ...over,
  });
  const runner = (
    dir: string | null,
    over: Partial<WatchDeps> = {},
    fs?: WatchFs,
    opts: Partial<WatchOptions> = {},
  ) => {
    const r = new WatchRunner(deps(over), {
      dir,
      lockUrl: tdb.appUrl,
      now: () => clock,
      ...(fs ? { fs } : {}),
      ...opts,
    });
    runners.push(r);
    return r;
  };
  /** Node's own, with some of it stood in for. */
  const fsWith = (over: Partial<WatchFs>): WatchFs => ({ ...fsp, ...over });
  /** Seen, then seen again once it has stood still: what the second look did. */
  const settle = async (r: WatchRunner): Promise<WatchRound> => {
    await r.tick();
    clock += 11_000;
    return r.tick();
  };
  const write = async (dir: string, rel: string, bytes: Buffer) => {
    const abs = path.join(dir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, bytes);
    return abs;
  };
  const there = (p: string) =>
    fsp.lstat(p).then(
      () => true,
      () => false,
    );
  /** A link to a folder: a junction on Windows, which needs no privilege. */
  const linkDir = (target: string, at: string) =>
    fsp.symlink(target, at, WINDOWS ? 'junction' : 'dir');
  /** A link to a file, where the system lets this user make one. */
  const linkFile = async (target: string, at: string) => {
    try {
      await fsp.symlink(target, at, 'file');
      return true;
    } catch (err) {
      if (WINDOWS) return false;
      throw err;
    }
  };
  const items = async () =>
    (
      await admin.query<{
        id: string;
        state: string;
        requester_member_id: string;
        original_name: string;
        batch_name: string;
        watch_day: string;
        mime: string;
        storage_key: string;
        file_key_wrapped: Buffer;
        wrapped_by_scope: string;
        read_state: string;
        scope: string;
        review_by: string;
        idempotency_key: string;
      }>(
        `select f.id, f.state, f.requester_member_id, f.original_name, b.name as batch_name,
                b.watch_day::text, f.mime, f.storage_key, f.file_key_wrapped, f.wrapped_by_scope,
                f.read_state, f.scope, f.review_by, f.idempotency_key
           from incoming_file f join intake_batch b on b.id = f.batch_id
          where f.household_id = $1 order by f.created_at, f.id`,
        [hh],
      )
    ).rows;
  const setting = async () =>
    (
      await admin.query<{ paused_reason: string | null; stuck_files: number }>(
        'select paused_reason, stuck_files from watch_folder where household_id = $1',
        [hh],
      )
    ).rows[0];
  const pausedAs = async () => (await setting())?.paused_reason;
  const notes = async () =>
    (
      await admin.query<{ member_id: string; file_name: string; reason: string }>(
        'select member_id, file_name, reason from watch_notice where household_id = $1 order by file_name, reason',
        [hh],
      )
    ).rows;
  /** Every file under a folder outside the scanner folder, and its bytes: what must not change. */
  const snapshot = async (dir: string) => {
    const out: Record<string, string> = {};
    for (const n of (await fsp.readdir(dir, { recursive: true })).map(String).sort()) {
      const p = path.join(dir, n);
      const st = await fsp.lstat(p);
      if (st.isFile())
        out[n] = createHash('sha256')
          .update(await fsp.readFile(p))
          .digest('hex');
    }
    return out;
  };

  // ------------------------------------------------------------ taking a file

  it('takes a file once its size and time have stood still for 10 s, into its person’s batch of the day, and deletes it', async () => {
    const dir = await folder();
    await turnOn('adult');
    const r = runner(dir);
    const scan = await write(dir, 'scan-0001.pdf', PDF('first part'));
    // Seen once: waits.
    expect((await r.tick()).outcomes).toEqual([]);
    clock += 5_000;
    expect((await r.tick()).outcomes).toEqual([]);
    // Still being written: it grew, so it waits again from now.
    await fsp.appendFile(scan, PDF('second part'));
    clock += 6_000;
    expect((await r.tick()).outcomes).toEqual([]);
    clock += 9_000;
    expect((await r.tick()).outcomes).toEqual([]);
    expect(await there(scan)).toBe(true);
    clock += 2_000;
    const round = await r.tick();
    expect(round.outcomes).toMatchObject([{ rel: 'scan-0001.pdf', kind: 'added' }]);
    // Deleted once stored; the item is the adult's, in "Scanner, <day>".
    expect(await there(scan)).toBe(false);
    const [item, ...more] = await items();
    expect(more).toEqual([]);
    const day = scannerDay('Pacific/Auckland', new Date(clock));
    expect(item).toMatchObject({
      state: 'received',
      requester_member_id: people.adult.member,
      original_name: 'scan-0001.pdf',
      batch_name: day.name,
      watch_day: day.day,
      mime: 'application/pdf',
      read_state: 'waiting',
      scope: 'member',
      review_by: 'me',
    });
    // Encrypted under the adult's own member key, and exactly the file.
    const plain = await withSystem(db, hh, async (trx) => {
      const scope = await keys.unwrapById(trx, item?.wrapped_by_scope as string);
      const fileKey = unwrapKey(item?.file_key_wrapped as Buffer, scope, `incoming:${item?.id}`);
      return decryptToBuffer(new LocalAdapter(root), item?.storage_key as string, fileKey);
    });
    expect(plain.equals(Buffer.concat([PDF('first part'), PDF('second part')]))).toBe(true);
    const stored = await fsp.readFile(path.join(root, item?.storage_key as string));
    expect(stored.includes(Buffer.from('first part'))).toBe(false);
    // Its pages drawn and read as any item's: the household's job sent.
    expect(sent).toEqual([hh]);
    // A second file the same day goes in the same batch.
    await write(dir, 'scan-0002.png', PNG);
    expect((await settle(r)).outcomes).toMatchObject([{ rel: 'scan-0002.png', kind: 'added' }]);
    const both = await items();
    expect(new Set(both.map((i) => i.batch_name)).size).toBe(1);
    expect(both[1]?.mime).toBe('image/png');
  });

  it('waits as long as FDV_WATCH_STABLE_SECONDS says (10 by default)', async () => {
    expect(
      loadConfig({ DATABASE_URL: 'postgres://x/y', FDV_MASTER_KEY: 'k'.repeat(43) })
        .FDV_WATCH_STABLE_SECONDS,
    ).toBe(10);
    const dir = await folder();
    await turnOn('adult');
    const r = runner(dir, {}, undefined, { stableMs: 30_000 });
    await write(dir, 'slow.pdf', PDF('slow'));
    expect((await settle(r)).outcomes).toEqual([]);
    clock += 20_000;
    expect((await r.tick()).outcomes).toMatchObject([{ rel: 'slow.pdf', kind: 'added' }]);
  });

  it('waits for a file that looks unfinished, then takes it anyway after its grace; never holds a valid file up for long', async () => {
    expect(
      loadConfig({ DATABASE_URL: 'postgres://x/y', FDV_MASTER_KEY: 'k'.repeat(43) })
        .FDV_WATCH_INCOMPLETE_GRACE_SECONDS,
    ).toBe(120);
    const dir = await folder();
    await turnOn('adult');
    const said: Array<{ msg: string; extra: string }> = [];
    const r = runner(dir, {
      log: (_l, msg, extra) => said.push({ msg, extra: JSON.stringify(extra ?? {}) }),
    });
    // A PDF with no end yet, a JPEG cut off, one whose tail is space set aside…
    await write(dir, 'cut.pdf', Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n'));
    await write(dir, 'cut.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
    await write(dir, 'zeros.pdf', Buffer.concat([PDF('zeros'), Buffer.alloc(4096)]));
    // …a motion photo (a JPEG, then a video after its end), a PDF with more
    // than a kilobyte after its %%EOF, and a TIFF whose last strip is blank paper.
    const motion = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 9, 9]),
      Buffer.from([0xff, 0xd9]),
      Buffer.from('\0\0\0\x18ftypmp42'),
      Buffer.alloc(8192, 7),
    ]);
    await write(dir, 'motion.jpg', motion);
    await write(dir, 'appended.pdf', Buffer.concat([PDF('appended'), Buffer.alloc(2048, 0x41)]));
    await write(
      dir,
      'blank-bottom.tif',
      Buffer.concat([Buffer.from('II*\0\x08\0\0\0'), Buffer.alloc(8192)]),
    );
    // A JPEG with a little after its end marker is complete at once.
    await write(
      dir,
      'trailer.jpg',
      Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]),
        Buffer.from([0xff, 0xd9]),
        Buffer.alloc(40, 3),
      ]),
    );
    const round = await settle(r);
    expect(round.outcomes.map((o) => [o.rel, o.kind])).toEqual([
      ['appended.pdf', 'waiting'],
      ['blank-bottom.tif', 'added'],
      ['cut.jpg', 'waiting'],
      ['cut.pdf', 'waiting'],
      ['motion.jpg', 'waiting'],
      ['trailer.jpg', 'added'],
      ['zeros.pdf', 'waiting'],
    ]);
    // Finished after all: taken.
    await fsp.appendFile(path.join(dir, 'cut.jpg'), Buffer.from([0xff, 0xd9]));
    clock += 30_000;
    await r.tick();
    clock += 11_000;
    const done = await r.tick();
    expect(done.outcomes.find((o) => o.rel === 'cut.jpg')?.kind).toBe('added');
    // Its grace over: every one taken, none rejected, nobody told of any.
    clock += 120_000;
    const late = await r.tick();
    expect(late.outcomes.map((o) => [o.rel, o.kind])).toEqual([
      ['appended.pdf', 'added'],
      ['cut.pdf', 'added'],
      ['motion.jpg', 'added'],
      ['zeros.pdf', 'added'],
    ]);
    expect(await notes()).toEqual([]);
    expect((await items()).length).toBe(7);
    // Said in the log once each, and never by name.
    const taken = said.filter((s) => s.msg.includes('looked unfinished'));
    expect(taken).toHaveLength(4);
    for (const s of taken) expect(s.extra).not.toMatch(/cut|motion|zeros|appended/);
    // The rule itself, by its ends alone.
    expect(looksComplete('application/pdf', PDF('x'), PDF('x'), 1)).toBe(true);
    expect(looksComplete('image/jpeg', motion, motion.subarray(-1024), motion.length)).toBe(false);
    expect(looksComplete('image/tiff', Buffer.from('II*\0'), Buffer.alloc(1024), 9000)).toBe(true);
    expect(looksComplete('image/png', PNG, PNG, PNG.length)).toBe(true);
    expect(looksComplete('image/png', PNG, PNG.subarray(0, 12), PNG.length)).toBe(false);
    const zip = Buffer.concat([
      Buffer.from('PK\x03\x04....'),
      Buffer.from('PK\x05\x06'),
      Buffer.alloc(18, 1),
    ]);
    expect(
      looksComplete(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        zip,
        zip,
        zip.length,
      ),
    ).toBe(true);
    expect(
      looksComplete(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        zip,
        zip.subarray(0, 8),
        zip.length,
      ),
    ).toBe(false);
    const webp = Buffer.from('RIFF\x0c\x00\x00\x00WEBPVP8 ', 'latin1');
    expect(looksComplete('image/webp', webp, webp, 20)).toBe(true);
    expect(looksComplete('image/webp', webp, webp, 40)).toBe(false);
  });

  it('leaves temp names, hidden files and rejected/ alone, and takes files in folders inside it', async () => {
    const dir = await folder();
    await turnOn('adult');
    const r = runner(dir);
    const left = [
      '.hidden.pdf',
      '~scan.pdf',
      'scan.pdf.tmp',
      'SCAN.PART',
      '.sync/inside.pdf',
      'rejected/old.pdf',
      'rejected/old.pdf.txt',
      'Thumbs.db',
    ];
    for (const rel of left) await write(dir, rel, PDF(rel));
    await write(dir, 'Letters/2026/bill.pdf', PDF('bill'));
    const round = await settle(r);
    expect(round.outcomes).toMatchObject([{ rel: 'Letters/2026/bill.pdf', kind: 'added' }]);
    for (const rel of left) expect(await there(path.join(dir, rel)), rel).toBe(true);
    expect(await there(path.join(dir, 'Letters/2026/bill.pdf'))).toBe(false);
    // Only its name is kept: the folders it was in are not.
    expect((await items()).map((i) => i.original_name)).toEqual(['bill.pdf']);
    // The rule itself, word by word.
    expect(left.map(watchIgnored)).toEqual(left.map(() => true));
    expect(['scan.pdf', 'Letters/bill.pdf', 'rejectedness/x.pdf'].map(watchIgnored)).toEqual([
      false,
      false,
      false,
    ]);
  });

  // ------------------------------------------------------------ the folder's own, and nothing else

  it('never reads, adds or deletes anything through a linked folder, a junction or a linked file', async () => {
    const dir = await folder();
    const outside = await folder();
    await turnOn('adult');
    await write(outside, 'secret.pdf', PDF('outside the folder'));
    await write(outside, 'deep/also.pdf', PDF('outside, deeper'));
    const before = await snapshot(outside);
    await linkDir(outside, path.join(dir, 'Swapped'));
    await linkDir(path.join(outside, 'deep'), path.join(dir, 'Inner'));
    const fileLinked = await linkFile(path.join(outside, 'secret.pdf'), path.join(dir, 'link.pdf'));
    await write(dir, 'own.pdf', PDF('the folder’s own'));
    const opened: string[] = [];
    const watching = fsWith({
      open: (async (p: string, flags: number) => {
        opened.push(String(p));
        return fsp.open(p, flags);
      }) as WatchFs['open'],
    });
    const r = runner(dir, {}, watching);
    const round = await settle(r);
    expect(round.outcomes).toMatchObject([{ rel: 'own.pdf', kind: 'added' }]);
    expect((await items()).map((i) => i.original_name)).toEqual(['own.pdf']);
    // Nothing outside opened, nothing outside changed, the links left where they are.
    expect(opened.filter((p) => !p.endsWith('own.pdf'))).toEqual([]);
    expect(await snapshot(outside)).toEqual(before);
    expect(await there(path.join(dir, 'Swapped'))).toBe(true);
    if (fileLinked) expect(await there(path.join(dir, 'link.pdf'))).toBe(true);
    expect(await notes()).toEqual([]);
  });

  it('a hard link to a file elsewhere is never read: it is moved aside as a linked copy, and the other left as it was', async () => {
    const dir = await folder();
    const outside = await folder();
    await turnOn('adult');
    const elsewhere = await write(outside, 'payslip.pdf', PDF('a payslip kept elsewhere'));
    const before = await snapshot(outside);
    await fsp.link(elsewhere, path.join(dir, 'payslip.pdf'));
    const read: number[] = [];
    const r = runner(
      dir,
      {},
      fsWith({
        open: (async (p: string, flags: number | string, mode?: number) => {
          const fh = await fsp.open(p, flags, mode);
          const real = fh.read.bind(fh);
          fh.read = async (...a: Parameters<typeof fh.read>) => {
            read.push(1);
            return real(...a);
          };
          return fh;
        }) as WatchFs['open'],
      }),
    );
    const round = await settle(r);
    expect(round.outcomes).toMatchObject([
      { rel: 'payslip.pdf', kind: 'rejected', reason: 'linked' },
    ]);
    expect(read).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await snapshot(outside)).toEqual(before);
    expect(await there(path.join(dir, 'payslip.pdf'))).toBe(false);
    expect(await fsp.readFile(path.join(dir, 'rejected', 'payslip.pdf.txt'), 'utf8')).toMatch(
      /linked copy of a file kept somewhere else/,
    );
    expect((await notes()).map((n) => n.reason)).toEqual(['linked']);
  });

  it('a folder swapped for a link to another as the file is opened: a different file there is never read nor deleted', async () => {
    const dir = await folder();
    const outside = await folder();
    await turnOn('adult');
    await write(dir, 'Letters/bill.pdf', PDF('the bill listed'));
    const decoy = await write(
      outside,
      'Letters/bill.pdf',
      PDF('a file outside with the same name'),
    );
    const before = await snapshot(outside);
    let swapped = false;
    const r = runner(
      dir,
      {},
      fsWith({
        open: (async (p: string, flags: number | string, mode?: number) => {
          if (!swapped && String(p).endsWith('bill.pdf')) {
            swapped = true;
            await fsp.rename(path.join(dir, 'Letters'), path.join(dir, '.gone'));
            await linkDir(path.join(outside, 'Letters'), path.join(dir, 'Letters'));
          }
          return fsp.open(p, flags, mode);
        }) as WatchFs['open'],
      }),
    );
    const round = await settle(r);
    expect(swapped).toBe(true);
    expect(round.outcomes.map((o) => o.kind)).toEqual(['later']);
    expect(await items()).toEqual([]);
    expect(await snapshot(outside)).toEqual(before);
    expect(await there(decoy)).toBe(true);
  });

  it('a folder moved outside and linked back as the file is opened: the very file, now outside, is never read (Linux: /proc; elsewhere: its real path)', async () => {
    const dir = await folder();
    const outside = await folder();
    await turnOn('adult');
    await write(dir, 'Letters/deed.pdf', PDF('the deed'));
    let swapped = false;
    const r = runner(
      dir,
      {},
      fsWith({
        open: (async (p: string, flags: number | string, mode?: number) => {
          if (!swapped && String(p).endsWith('deed.pdf')) {
            swapped = true;
            // The same file — same device, same inode — but no longer in the folder.
            await fsp.rename(path.join(dir, 'Letters'), path.join(outside, 'Letters'));
            await linkDir(path.join(outside, 'Letters'), path.join(dir, 'Letters'));
          }
          return fsp.open(p, flags, mode);
        }) as WatchFs['open'],
      }),
    );
    const round = await settle(r);
    expect(swapped).toBe(true);
    expect(round.outcomes).toMatchObject([{ rel: 'Letters/deed.pdf', kind: 'later' }]);
    expect(await items()).toEqual([]);
    expect(await there(path.join(outside, 'Letters', 'deed.pdf'))).toBe(true);
  });

  it.skipIf(!LINUX)(
    'a file swapped for a link to itself moved outside, as it is opened, is never read (Linux)',
    async () => {
      const dir = await folder();
      const outside = await folder();
      await turnOn('adult');
      const scan = await write(dir, 'deed.pdf', PDF('the deed'));
      let swapped = false;
      const r = runner(
        dir,
        {},
        fsWith({
          open: (async (p: string, flags: number | string, mode?: number) => {
            if (!swapped && String(p).endsWith('deed.pdf')) {
              swapped = true;
              await fsp.rename(scan, path.join(outside, 'deed.pdf'));
              await fsp.symlink(path.join(outside, 'deed.pdf'), scan, 'file');
            }
            return fsp.open(p, flags, mode);
          }) as WatchFs['open'],
        }),
      );
      const round = await settle(r);
      expect(swapped).toBe(true);
      expect(round.outcomes).toMatchObject([{ rel: 'deed.pdf', kind: 'later' }]);
      expect(await items()).toEqual([]);
      expect(await there(path.join(outside, 'deed.pdf'))).toBe(true);
    },
  );

  it('a file swapped for another after it is stored is not deleted: only the file stored is', async () => {
    const dir = await folder();
    await turnOn('adult');
    const scan = await write(dir, 'swap.pdf', PDF('the file stored'));
    const r = runner(dir, {}, undefined, {
      beforePlace: async () => {
        await fsp.rename(scan, path.join(dir, '.kept-aside'));
        await fsp.writeFile(scan, PDF('a new file under the same name'));
      },
    });
    const round = await settle(r);
    expect(round.outcomes).toMatchObject([{ rel: 'swap.pdf', kind: 'added' }]);
    // What was stored is what was opened, and the new file is still there.
    expect(await fsp.readFile(scan, 'utf8')).toMatch(/a new file under the same name/);
  });

  // ------------------------------------------------------------ never twice

  it('a worker that stops between storing and deleting makes no second item, under a new master key too; one removed from the Inbox is added again', async () => {
    const dir = await folder();
    await turnOn('adult');
    const scan = await write(dir, 'deed.pdf', PDF('deed'));
    const said: string[] = [];
    // Stored, and then the delete never happens: the worker stopped.
    const stuck = fsWith({
      unlink: (async (p: string) => {
        if (String(p).endsWith('deed.pdf')) {
          throw Object.assign(new Error('stopped'), { code: 'EIO' });
        }
        return fsp.unlink(p);
      }) as WatchFs['unlink'],
    });
    const first = runner(dir, { log: (_l, m) => said.push(m) }, stuck);
    expect((await settle(first)).outcomes).toMatchObject([{ rel: 'deed.pdf', kind: 'added' }]);
    expect(await there(scan)).toBe(true);
    // Counted for the owners, and said once however often it is tried.
    expect((await setting())?.stuck_files).toBe(1);
    clock += 11 * 60_000;
    await first.tick();
    clock += 11 * 60_000;
    await first.tick();
    expect(said.filter((m) => m.includes('could not be deleted'))).toHaveLength(1);
    await first.stop();
    // The next worker — on a rotated master key, so another item key: the
    // same bytes, the same item — found, and the file deleted.
    const next = runner(dir, { itemKey: Buffer.alloc(32, 9) });
    expect((await settle(next)).outcomes).toMatchObject([{ rel: 'deed.pdf', kind: 'already' }]);
    expect(await there(scan)).toBe(false);
    expect((await items()).length).toBe(1);
    expect((await setting())?.stuck_files).toBe(0);

    // Removed from the Inbox before the file went: added again.
    const again = await write(dir, 'again.pdf', PDF('again'));
    await next.stop();
    const third = runner(
      dir,
      {},
      fsWith({
        unlink: (async (p: string) => {
          if (String(p).endsWith('again.pdf')) {
            throw Object.assign(new Error('stopped'), { code: 'EIO' });
          }
          return fsp.unlink(p);
        }) as WatchFs['unlink'],
      }),
    );
    expect((await settle(third)).outcomes).toMatchObject([{ rel: 'again.pdf', kind: 'added' }]);
    await admin.query(
      `update incoming_file set state = 'rejected', decided_at = now(), original_name = null, sha256 = null
        where original_name = 'again.pdf'`,
    );
    await third.stop();
    const fourth = runner(dir);
    expect((await settle(fourth)).outcomes).toMatchObject([{ rel: 'again.pdf', kind: 'added' }]);
    expect(await there(again)).toBe(false);
    expect((await items()).map((i) => i.state)).toEqual(['received', 'rejected', 'received']);

    // A file with the same path, size and time but other bytes is a file of its own.
    const same = await write(dir, 'same.pdf', PDF('one'));
    const st = await fsp.stat(same);
    expect((await settle(fourth)).outcomes).toMatchObject([{ rel: 'same.pdf', kind: 'added' }]);
    await write(dir, 'same.pdf', PDF('two'));
    await fsp.utimes(same, st.atime, st.mtime);
    expect((await settle(fourth)).outcomes).toMatchObject([{ rel: 'same.pdf', kind: 'added' }]);

    // On its way when the worker stopped: that row (and its object) go, and it is added once.
    const will = await write(dir, 'will.pdf', PDF('will'));
    const wst = await fsp.stat(will);
    const sha = createHash('sha256').update(PDF('will')).digest();
    const key = watchItemKey(
      Buffer.alloc(32, 7),
      hh,
      {
        rel: 'will.pdf',
        size: wst.size,
        mtimeMs: Number((await fsp.stat(will, { bigint: true })).mtimeMs),
      },
      sha,
    );
    const batch = (await items())[0];
    const scope = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: people.adult.member }),
    );
    const halfKey = `${hh}/batches/half-${randomBytes(4).toString('hex')}.enc`;
    await new LocalAdapter(root).put(halfKey, Readable.from([Buffer.from('half')]));
    await admin.query(
      `insert into incoming_file (household_id, batch_id, review_by, requester_member_id, state,
                                  original_name, storage_key, vault_id, file_key_wrapped,
                                  wrapped_by_scope, scope, scan_state, read_state, idempotency_key)
       select $1, f.batch_id, 'me', $2, 'uploading', 'will.pdf', $3, $4, '\\x00', $5, 'member',
              'unscanned', 'waiting', $6
         from incoming_file f where f.id = $7`,
      [hh, people.adult.member, halfKey, vault, scope.id, key, batch?.id],
    );
    expect((await settle(fourth)).outcomes).toMatchObject([{ rel: 'will.pdf', kind: 'added' }]);
    const wills = (await items()).filter((i) => i.idempotency_key === key);
    expect(wills.map((w) => w.state)).toEqual(['received']);
    expect(await there(path.join(root, halfKey))).toBe(false);
    expect(await there(will)).toBe(false);
  });

  // ------------------------------------------------------------ rejected

  it('moves what it cannot add to rejected/, its person told first, with a note saying why', async () => {
    const dir = await folder();
    await turnOn('adult');
    const big = Buffer.concat([PDF('big'), Buffer.alloc(70 * 1024, 0x20)]);
    await write(dir, 'letter.zip', Buffer.from('PK\x03\x04 not a document'));
    await write(dir, 'notes.txt', Buffer.from('hello'));
    await write(dir, 'huge.pdf', big);
    await write(dir, 'blank.pdf', Buffer.alloc(0));
    await write(dir, 'locked.pdf', PDF('locked'));
    // And two of the same name, from two folders.
    await write(dir, 'a/form.bmp', Buffer.from('BM not kept'));
    await write(dir, 'b/form.bmp', Buffer.from('BM not kept either'));
    const unreadable = fsWith({
      open: (async (p: string, flags: number | string, mode?: number) => {
        if (String(p).endsWith('locked.pdf')) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return fsp.open(p, flags, mode);
      }) as WatchFs['open'],
      // As protected_hardlinks refuses a link to a file the worker cannot
      // read: such a file is renamed, never linked.
      link: (async (from: string, to: string) => {
        if (String(from).endsWith('locked.pdf')) {
          throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        }
        return fsp.link(from, to);
      }) as WatchFs['link'],
    });
    const r = runner(dir, {}, unreadable);
    const round = await settle(r);
    const why = Object.fromEntries(
      round.outcomes.map((o) => [o.rel, o.kind === 'rejected' ? [o.reason, o.as] : o.kind]),
    );
    expect(why).toEqual({
      'a/form.bmp': ['unsupported', 'form.bmp'],
      'b/form.bmp': ['unsupported', 'form (2).bmp'],
      'blank.pdf': ['empty', 'blank.pdf'],
      'huge.pdf': ['too_large', 'huge.pdf'],
      'letter.zip': ['unsupported', 'letter.zip'],
      'locked.pdf': ['unreadable', 'locked.pdf'],
      'notes.txt': ['unsupported', 'notes.txt'],
    });
    expect(await items()).toEqual([]);
    const rejected = path.join(dir, 'rejected');
    expect((await fsp.readdir(rejected)).sort()).toEqual(
      ['blank.pdf', 'form (2).bmp', 'form.bmp', 'huge.pdf', 'letter.zip', 'locked.pdf', 'notes.txt']
        .flatMap((n) => [n, `${n}.txt`])
        .sort(),
    );
    const note = (n: string) => fsp.readFile(path.join(rejected, `${n}.txt`), 'utf8');
    expect(await note('letter.zip')).toMatch(/isn’t a kind of file the vault keeps/);
    expect(await note('huge.pdf')).toMatch(
      /larger than the most the vault takes in one file \(64 KB\)/,
    );
    expect(await note('blank.pdf')).toMatch(/It was empty/);
    expect(await note('locked.pdf')).toMatch(/couldn’t read it from the folder/);
    expect(await note('form (2).bmp')).toMatch(/File: form\.bmp \(it was b\/form\.bmp\)/);
    expect(await note('notes.txt')).toMatch(/not encrypted/);
    // Its person told, each by name and why — and nobody else.
    expect(await notes()).toEqual(
      [
        ['blank.pdf', 'empty'],
        ['form.bmp', 'unsupported'],
        ['form.bmp', 'unsupported'],
        ['huge.pdf', 'too_large'],
        ['letter.zip', 'unsupported'],
        ['locked.pdf', 'unreadable'],
        ['notes.txt', 'unsupported'],
      ].map(([file_name, reason]) => ({ member_id: people.adult.member, file_name, reason })),
    );
    // And never looked at again.
    clock += 60_000;
    expect((await settle(r)).outcomes).toEqual([]);
  });

  it('a file it cannot move is left in place: its person told once that it was, the owners counted it — still after a pause — and once moved, told so', async () => {
    const dir = await folder();
    await turnOn('adult');
    const odd = await write(dir, 'odd.gif', Buffer.from('GIF89a'));
    let refuse = true;
    const r = runner(
      dir,
      {},
      fsWith({
        link: (async (from: string, to: string) => {
          if (refuse) throw Object.assign(new Error('no'), { code: 'EACCES' });
          return fsp.link(from, to);
        }) as WatchFs['link'],
      }),
    );
    expect((await settle(r)).outcomes).toMatchObject([{ rel: 'odd.gif', kind: 'later' }]);
    const told = () =>
      admin
        .query<{ file_name: string; left_in_place: boolean }>(
          'select file_name, left_in_place from watch_notice where household_id = $1',
          [hh],
        )
        .then((q) => q.rows);
    expect(await told()).toEqual([{ file_name: 'odd.gif', left_in_place: true }]);
    expect(await there(odd)).toBe(true);
    expect((await setting())?.stuck_files).toBe(1);
    // Tried again: told once, however often.
    clock += 11 * 60_000;
    await r.tick();
    expect(await told()).toEqual([{ file_name: 'odd.gif', left_in_place: true }]);
    // Paused: the folder is not listed, and the owners keep the last count.
    await admin.query(
      "update account_household set suspended_at = now(), suspend_reason = 'locked' where member_id = $1",
      [people.adult.member],
    );
    clock += 11 * 60_000;
    expect((await r.tick()).paused).toBe('locked');
    expect((await setting())?.stuck_files).toBe(1);
    await admin.query(
      'update account_household set suspended_at = null, suspend_reason = null where member_id = $1',
      [people.adult.member],
    );
    // Moved at last: the same note, now saying so; nothing left to count.
    refuse = false;
    clock += 11 * 60_000;
    await r.tick();
    expect((await r.tick()).outcomes.map((o) => o.kind)).toEqual([]);
    expect(await told()).toEqual([{ file_name: 'odd.gif', left_in_place: false }]);
    expect(await there(odd)).toBe(false);
    expect((await setting())?.stuck_files).toBe(0);
  });

  it('a link made to the wrong file is taken back, and a copy that fails or is stopped leaves nothing behind', async () => {
    const dir = await folder();
    await turnOn('adult');
    await write(dir, 'swapped.zip', Buffer.from('PK\x03\x04 not a document'));
    const decoy = await write(dir, '.decoy', Buffer.from('another file'));
    // The name swapped in the instant between the check and the link.
    const r = runner(
      dir,
      {},
      fsWith({
        link: (async (_from: string, to: string) => fsp.link(decoy, to)) as WatchFs['link'],
      }),
    );
    expect((await settle(r)).outcomes).toMatchObject([{ rel: 'swapped.zip', kind: 'later' }]);
    expect(await fsp.readdir(path.join(dir, 'rejected'))).toEqual([]);
    expect(await there(path.join(dir, 'swapped.zip'))).toBe(true);
    expect(await notes()).toEqual([]);
    await r.stop();

    // No links here, and the copy fails part-way: no half copy left.
    const dir2 = await folder();
    await write(
      dir2,
      'copied.zip',
      Buffer.from('PK\x03\x04 not a document, longer than one write'),
    );
    const noLinks = {
      link: (async () => {
        throw Object.assign(new Error('no links'), { code: 'EXDEV' });
      }) as WatchFs['link'],
    };
    const r2 = runner(
      dir2,
      {},
      fsWith({
        ...noLinks,
        open: (async (p: string, flags: number | string, mode?: number) => {
          const fh = await fsp.open(p, flags, mode);
          if (flags === 'wx') {
            fh.write = async () => {
              throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            };
          }
          return fh;
        }) as WatchFs['open'],
      }),
    );
    expect((await settle(r2)).outcomes).toMatchObject([{ rel: 'copied.zip', kind: 'later' }]);
    expect(await fsp.readdir(path.join(dir2, 'rejected'))).toEqual([]);
    expect(await there(path.join(dir2, 'copied.zip'))).toBe(true);
    await r2.stop();

    // And stopped as it copies: no half copy either.
    const dir3 = await folder();
    await write(dir3, 'stopped.zip', Buffer.from('PK\x03\x04 not a document'));
    const stopping: Array<Promise<void>> = [];
    const r3: WatchRunner = runner(
      dir3,
      {},
      fsWith({
        ...noLinks,
        open: (async (p: string, flags: number | string, mode?: number) => {
          if (flags === 'wx' && stopping.length === 0) stopping.push(r3.stop());
          return fsp.open(p, flags, mode);
        }) as WatchFs['open'],
      }),
    );
    await r3.tick();
    clock += 11_000;
    await r3.tick();
    await Promise.all(stopping);
    expect(stopping).toHaveLength(1);
    expect(await fsp.readdir(path.join(dir3, 'rejected'))).toEqual([]);
    expect(await there(path.join(dir3, 'stopped.zip'))).toBe(true);
  });

  it.skipIf(!LINUX || ROOT_USER)(
    'PROBE 1c: a file outside, not to be opened (mode 000), reached through a swapped folder, is never moved nor named (Linux)',
    async () => {
      const dir = await folder();
      const outside = await folder();
      await turnOn('adult');
      await write(dir, 'Letters/bill.pdf', PDF('the bill listed'));
      const secret = await write(outside, 'Letters/bill.pdf', PDF('somebody else’s, unreadable'));
      await fsp.chmod(secret, 0o000);
      let swapped = false;
      const r = runner(
        dir,
        {},
        fsWith({
          open: (async (p: string, flags: number | string, mode?: number) => {
            if (!swapped && String(p).endsWith('bill.pdf')) {
              swapped = true;
              await fsp.rename(path.join(dir, 'Letters'), path.join(dir, '.gone'));
              await fsp.symlink(path.join(outside, 'Letters'), path.join(dir, 'Letters'), 'dir');
            }
            return fsp.open(p, flags, mode);
          }) as WatchFs['open'],
        }),
      );
      try {
        const round = await settle(r);
        expect(swapped).toBe(true);
        expect(round.outcomes).toMatchObject([{ rel: 'Letters/bill.pdf', kind: 'later' }]);
        // Still where it was, never moved, never named.
        expect(await there(secret)).toBe(true);
        expect(await there(path.join(dir, 'rejected'))).toBe(false);
        expect(await notes()).toEqual([]);
        expect(await items()).toEqual([]);
      } finally {
        await fsp.chmod(secret, 0o600);
      }
    },
  );

  it('never writes a note through a link left at its name, nor over another file; and makes rejected/ a folder of its own', async () => {
    const dir = await folder();
    const outside = await folder();
    await turnOn('adult');
    await fsp.mkdir(path.join(dir, 'rejected'));
    const planted = await linkFile(
      path.join(outside, 'written-through.txt'),
      path.join(dir, 'rejected', 'letter.zip.txt'),
    );
    await fsp.writeFile(path.join(dir, 'rejected', 'letter (2).zip'), 'somebody’s own');
    await write(dir, 'letter.zip', Buffer.from('PK\x03\x04 not a document'));
    const r = runner(dir);
    const round = await settle(r);
    expect(round.outcomes).toMatchObject([
      { rel: 'letter.zip', kind: 'rejected', as: planted ? 'letter (3).zip' : 'letter.zip' },
    ]);
    // Nothing written outside; nothing overwritten.
    expect(await fsp.readdir(outside)).toEqual([]);
    expect(await fsp.readFile(path.join(dir, 'rejected', 'letter (2).zip'), 'utf8')).toBe(
      'somebody’s own',
    );
    // rejected/ as a link to somewhere else: nothing moved into it.
    const dir2 = await folder();
    await linkDir(outside, path.join(dir2, 'rejected'));
    await write(dir2, 'other.zip', Buffer.from('PK\x03\x04 not a document'));
    await r.stop();
    const r2 = runner(dir2);
    expect((await settle(r2)).outcomes).toMatchObject([{ rel: 'other.zip', kind: 'later' }]);
    expect(await fsp.readdir(outside)).toEqual([]);
    expect(await there(path.join(dir2, 'other.zip'))).toBe(true);
  });

  it.skipIf(!LINUX || ROOT_USER)(
    'makes rejected/ 0700 and each note 0600, and a name’s control characters never reach a note (Linux)',
    async () => {
      const dir = await folder();
      await turnOn('adult');
      await write(dir, 'evil\nWhy: it is fine.zip', Buffer.from('PK\x03\x04 not a document'));
      const r = runner(dir);
      expect((await settle(r)).outcomes.map((o) => o.kind)).toEqual(['rejected']);
      const rejected = path.join(dir, 'rejected');
      expect((await fsp.stat(rejected)).mode & 0o777).toBe(0o700);
      const [noteName] = (await fsp.readdir(rejected)).filter((n) => n.endsWith('.txt'));
      const note = path.join(rejected, noteName as string);
      expect((await fsp.stat(note)).mode & 0o777).toBe(0o600);
      const text = await fsp.readFile(note, 'utf8');
      expect(text.split('\n').filter((l) => l.startsWith('Why:'))).toHaveLength(1);
      expect(text).toMatch(/File: evilWhy: it is fine\.zip/);
    },
  );

  it('never names a scanned file, or its folders, in the log', async () => {
    const dir = await folder();
    await turnOn('adult');
    await write(dir, 'Clinic/hiv-result-secret.gif', Buffer.from('GIF89a'));
    await write(dir, 'Clinic/biopsy-secret.pdf', PDF('biopsy'));
    const said: string[] = [];
    // A system that names the file in every refusal, as node's own do.
    const refusing = fsWith({
      link: (async (from: string) => {
        throw Object.assign(new Error(`EACCES: permission denied, link '${from}'`), {
          code: 'EACCES',
        });
      }) as WatchFs['link'],
      unlink: (async (p: string) => {
        if (!p.includes('secret')) return fsp.unlink(p);
        throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${p}'`), {
          code: 'EBUSY',
        });
      }) as WatchFs['unlink'],
    });
    const r = runner(
      dir,
      { log: (level, msg, extra) => said.push(JSON.stringify({ level, msg, extra })) },
      refusing,
    );
    const round = await settle(r);
    expect(round.outcomes.map((o) => o.kind).sort()).toEqual(['added', 'later']);
    const log = said.join('\n');
    expect(log).toMatch(/EACCES/);
    expect(log).toMatch(/EBUSY/);
    for (const word of ['secret', 'Clinic', 'hiv', 'biopsy']) expect(log).not.toContain(word);
  });

  it('tells the kinds it keeps from their first bytes alone', () => {
    expect(watchKindOf(PDF('x'), 'x')?.mime).toBe('application/pdf');
    expect(watchKindOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'x')?.mime).toBe('image/jpeg');
    expect(watchKindOf(PNG, 'x')?.mime).toBe('image/png');
    expect(watchKindOf(Buffer.from('II*\0abcd'), 'x')?.mime).toBe('image/tiff');
    expect(watchKindOf(Buffer.from('MM\0*abcd'), 'x')?.mime).toBe('image/tiff');
    expect(watchKindOf(Buffer.from('RIFF1234WEBPVP8 '), 'x')?.mime).toBe('image/webp');
    expect(watchKindOf(Buffer.from('\0\0\0\x18ftypheic\0\0'), 'x')?.mime).toBe('image/heic');
    expect(watchKindOf(Buffer.from('\0\0\0\x18ftypmif1\0\0'), 'x')?.mime).toBe('image/heif');
    expect(watchKindOf(Buffer.from('\0\0\0\x18ftypisom\0\0'), 'x')).toBeNull();
    expect(watchKindOf(Buffer.from('PK\x03\x04....'), 'Letter.DOCX')?.ext).toBe('docx');
    expect(watchKindOf(Buffer.from('PK\x03\x04....'), 'sheet.xlsx')?.ext).toBe('xlsx');
    expect(watchKindOf(Buffer.from('PK\x03\x04....'), 'archive.zip')).toBeNull();
    expect(watchKindOf(Buffer.from('GIF89a'), 'x.gif')).toBeNull();
    // A name says nothing for a PDF: its bytes do.
    expect(watchKindOf(Buffer.from('hello'), 'scan.pdf')).toBeNull();
  });

  // ------------------------------------------------------------ one runner

  it('one runner, held by an advisory lock, however many workers; another takes over when it stops', async () => {
    const dir = await folder();
    await turnOn('adult');
    for (let n = 1; n <= 4; n++) await write(dir, `page-${n}.pdf`, PDF(`page ${n}`));
    const a = runner(dir);
    const b = runner(dir);
    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    expect([ra.ran, rb.ran].sort()).toEqual([false, true]);
    const [holder, waiting] = ra.ran ? [a, b] : [b, a];
    expect(holder.holding).toBe(true);
    expect(waiting.holding).toBe(false);
    clock += 11_000;
    const [h2, w2] = await Promise.all([holder.tick(), waiting.tick()]);
    expect(h2.outcomes.map((o) => o.kind)).toEqual(['added', 'added', 'added', 'added']);
    expect(w2).toEqual({ ran: false, outcomes: [] });
    expect((await items()).length).toBe(4);
    // The holder stops: the other takes the lock at its next look.
    await holder.stop();
    await write(dir, 'page-5.pdf', PDF('page 5'));
    expect((await settle(waiting)).outcomes).toMatchObject([{ rel: 'page-5.pdf', kind: 'added' }]);
    expect(waiting.holding).toBe(true);
    expect((await items()).length).toBe(5);
  });

  it('a lost lock stops the round before the next file, and the worker that lost it never looks again while another holds it', async () => {
    const dir = await folder();
    await turnOn('adult');
    await write(dir, 'one.pdf', PDF('one'));
    await write(dir, 'two.pdf', PDF('two'));
    const killLock = () =>
      admin.query(
        `select pg_terminate_backend(pid) from pg_locks
          where locktype = 'advisory' and classid = 0 and objid = $1 and objsubid = 1
            and database = (select oid from pg_database where datname = current_database())`,
        [WATCH_LOCK_KEY],
      );
    let killed = false;
    const a = runner(dir, {}, undefined, {
      beforePlace: async () => {
        if (!killed) {
          killed = true;
          await killLock();
        }
      },
    });
    const round = await settle(a);
    expect(round.outcomes.map((o) => [o.rel, o.kind])).toEqual([
      ['one.pdf', 'added'],
      ['two.pdf', 'stopped'],
    ]);
    // Another worker takes it, and the first one, asking again, is refused.
    const b = runner(dir);
    expect((await b.tick()).ran).toBe(true);
    expect((await a.tick()).ran).toBe(false);
    expect(a.holding).toBe(false);
  });

  // ------------------------------------------------------------ changed under it

  it('asks again as each file is placed: turned off, pointed elsewhere or its person made a viewer mid-round, nothing is added', async () => {
    const dir = await folder();
    for (const change of [
      () => admin.query('update watch_folder set enabled = false where household_id = $1', [hh]),
      () =>
        admin.query('update watch_folder set member_id = $2 where household_id = $1', [
          hh,
          people.other.member,
        ]),
      () =>
        admin.query("update account_household set role = 'viewer' where member_id = $1", [
          people.adult.member,
        ]),
    ]) {
      await turnOn('adult');
      await admin.query("update account_household set role = 'adult' where member_id = $1", [
        people.adult.member,
      ]);
      const scan = await write(dir, 'mid.pdf', PDF('mid-round'));
      const r = runner(dir, {}, undefined, { beforePlace: async () => void (await change()) });
      const round = await settle(r);
      expect(round.outcomes.map((o) => o.kind)).toEqual([
        expect.stringMatching(/^(stopped|paused)$/),
      ]);
      expect(await items()).toEqual([]);
      expect(await there(scan)).toBe(true);
      await r.stop();
    }
  });

  it('stops between files, and a file on its way is aborted: its row and object removed, the file kept', async () => {
    const dir = await folder();
    await turnOn('adult');
    const scan = await write(dir, 'big.pdf', PDF('on its way'));
    await write(dir, 'next.pdf', PDF('never started'));
    const objects = async () =>
      (await fsp.readdir(root, { recursive: true })).map(String).filter((k) => k.endsWith('.enc'));
    const had = await objects();
    const stopping: Array<Promise<void>> = [];
    const r = runner(dir, {}, undefined, {
      beforePlace: async () => {
        if (stopping.length === 0) stopping.push(r.stop());
      },
    });
    await r.tick();
    clock += 11_000;
    const round = await r.tick();
    await Promise.all(stopping);
    expect(round.outcomes.map((o) => [o.rel, o.kind])).toEqual([['big.pdf', 'stopped']]);
    expect(
      (
        await admin.query('select count(*)::int as n from incoming_file where household_id = $1', [
          hh,
        ])
      ).rows[0],
    ).toEqual({ n: 0 });
    expect(await objects()).toEqual(had);
    expect(await there(scan)).toBe(true);
    expect(await there(path.join(dir, 'next.pdf'))).toBe(true);
  });

  // ------------------------------------------------------------ paused

  it('pauses while its person cannot have files added, or the vault cannot store them, and goes on after', async () => {
    const dir = await folder();
    await turnOn('adult');
    const scan = await write(dir, 'waiting.pdf', PDF('waiting'));
    const r = runner(dir);
    const pausedFor = async (setUp: () => Promise<unknown>, undo: () => Promise<unknown>) => {
      await setUp();
      try {
        const round = await settle(r);
        expect(round.outcomes.filter((o) => o.kind === 'added')).toEqual([]);
        expect(await there(scan)).toBe(true);
        return { said: round.paused, stored: await pausedAs() };
      } finally {
        await undo();
      }
    };
    const signIn = (set: string) =>
      admin.query(`update account_household set ${set} where member_id = $1`, [
        people.adult.member,
      ]);
    // Locked by an owner; waiting for an owner after a restore.
    expect(
      await pausedFor(
        () => signIn("suspended_at = now(), suspend_reason = 'locked'"),
        () => signIn('suspended_at = null, suspend_reason = null'),
      ),
    ).toEqual({ said: 'locked', stored: 'locked' });
    expect(
      await pausedFor(
        () => signIn("suspended_at = now(), suspend_reason = 'restored'"),
        () => signIn('suspended_at = null, suspend_reason = null'),
      ),
    ).toEqual({ said: 'restored', stored: 'restored' });
    // Made a viewer: may no longer add.
    expect(
      await pausedFor(
        () => signIn("role = 'viewer'"),
        () => signIn("role = 'adult'"),
      ),
    ).toEqual({ said: 'cannot_add', stored: 'cannot_add' });
    // The vault has nowhere to keep files.
    expect(
      await pausedFor(
        () => admin.query('update household set active_vault_id = null where id = $1', [hh]),
        () => admin.query('update household set active_vault_id = $2 where id = $1', [hh, vault]),
      ),
    ).toEqual({ said: 'no_storage', stored: 'no_storage' });
    // The day's batch full: the most a batch holds, as for an upload.
    const { day, name } = scannerDay('Pacific/Auckland', new Date(clock));
    expect(
      await pausedFor(
        async () => {
          const b = await admin.query<{ id: string }>(
            `insert into intake_batch (household_id, created_by, member_id, name, watch_day, ends_at)
             values ($1, $2, $3, $4, $5, now() + interval '20 days') returning id`,
            [hh, people.adult.account, people.adult.member, name, day],
          );
          const scope = await withSystem(db, hh, (trx) =>
            keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: people.adult.member }),
          );
          await admin.query(
            `insert into incoming_file (household_id, batch_id, review_by, requester_member_id, state,
                                        original_name, mime, byte_size, sha256, cipher_bytes,
                                        cipher_sha256, storage_key, vault_id, file_key_wrapped,
                                        wrapped_by_scope, scope, scan_state, read_state,
                                        received_at, submitted_at)
             select $1, $2, 'me', $3, 'received', 'x.pdf', 'application/pdf', 1, '\\x00', 1,
                    '\\x00', 'k/' || n, $4, '\\x00', $5, 'member', 'unscanned', 'waiting',
                    now(), now()
               from generate_series(1, $6::int) n`,
            [hh, b.rows[0]?.id, people.adult.member, vault, scope.id, BATCH_MAX_FILES],
          );
        },
        async () => {
          await admin.query('delete from incoming_file where household_id = $1', [hh]);
          await admin.query('delete from intake_batch where household_id = $1', [hh]);
        },
      ),
    ).toEqual({ said: 'day_full', stored: 'day_full' });
    // The vault cannot open their key: this worker's master key is not the vault's.
    const sealed = runner(dir, {
      keys: new ScopeKeys(new EnvKeyProvider(`${MASTER}-not-this-one`)),
    });
    await r.stop();
    const round = await settle(sealed);
    expect(round.paused).toBe('sealed');
    expect(await pausedAs()).toBe('sealed');
    expect(await there(scan)).toBe(true);
    await sealed.stop();
    // Their sign-in taken away; and then gone from the household.
    const back = runner(dir);
    const { rows: had } = await admin.query(
      'select * from account_household where member_id = $1',
      [people.adult.member],
    );
    await admin.query('delete from account_household where member_id = $1', [people.adult.member]);
    expect((await settle(back)).paused).toBe('no_sign_in');
    const kept = had[0] as Record<string, unknown>;
    await admin.query(
      'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
      [kept.account_id, kept.household_id, kept.member_id, kept.role],
    );
    // All well again: added, and no longer paused.
    const going = await settle(back);
    expect(going.paused).toBeNull();
    expect(going.outcomes).toMatchObject([{ rel: 'waiting.pdf', kind: 'added' }]);
    expect(await pausedAs()).toBeNull();
    expect(await there(scan)).toBe(false);
    // Whose Inbox it was, removed from the household: paused, `removed`.
    await admin.query('update watch_folder set member_id = null where household_id = $1', [hh]);
    await write(dir, 'later.pdf', PDF('later'));
    expect((await settle(back)).paused).toBe('removed');
    expect(await pausedAs()).toBe('removed');
  });

  // ------------------------------------------------------------ the folder

  it('says the folder is off, missing, not a folder or read-only, and then looks at nothing', async () => {
    expect(await checkWatchDir(null)).toBe('off');
    const dir = await folder();
    expect(await checkWatchDir(path.join(dir, 'not-here'))).toBe('missing');
    await fsp.writeFile(path.join(dir, 'a-file'), 'x');
    expect(await checkWatchDir(path.join(dir, 'a-file'))).toBe('not_a_folder');
    expect(await checkWatchDir(dir)).toBe('ready');
    // A folder mounted read-only: nothing can be written in it.
    const readOnly = fsWith({
      writeFile: (async () => {
        throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
      }) as WatchFs['writeFile'],
    });
    expect(await checkWatchDir(dir, readOnly)).toBe('not_writable');
    const noAccess = fsWith({
      access: (async (_p: string, mode?: number) => {
        if (mode !== undefined && mode & constants.W_OK) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
      }) as WatchFs['access'],
    });
    expect(await checkWatchDir(dir, noAccess)).toBe('not_writable');
    // Nothing is left behind by the look.
    expect(await fsp.readdir(dir)).toEqual(['a-file']);

    // The worker says so, for the API; adds nothing from a folder it cannot
    // write in; and keeps no pause of its person's while it is so.
    await turnOn('adult');
    await admin.query("update watch_folder set paused_reason = 'sealed' where household_id = $1", [
      hh,
    ]);
    const scan = await write(dir, 'scan.pdf', PDF('scan'));
    const r = runner(dir, {}, readOnly);
    const round = await settle(r);
    expect(round).toMatchObject({ ran: true, state: 'not_writable', outcomes: [] });
    expect(await there(scan)).toBe(true);
    expect(await pausedAs()).toBeNull();
    const said = await admin.query<{ dir: string; state: string }>(
      'select dir, state from watch_dir',
    );
    expect(said.rows).toEqual([{ dir, state: 'not_writable' }]);
    await r.stop();
    // Missing: said too.
    const gone = runner(path.join(dir, 'unmounted'));
    expect((await gone.tick()).state).toBe('missing');
    expect((await admin.query('select state from watch_dir')).rows).toEqual([{ state: 'missing' }]);
    await gone.stop();
    // Not set on this worker: said only when no worker that has it said otherwise just now.
    const unset = runner(null);
    expect(await unset.tick()).toEqual({ ran: false, state: 'off', outcomes: [] });
    expect((await admin.query('select state from watch_dir')).rows).toEqual([{ state: 'missing' }]);
    await admin.query("update watch_dir set checked_at = now() - interval '5 minutes'");
    await unset.tick();
    expect((await admin.query('select dir, state from watch_dir')).rows).toEqual([
      { dir: null, state: 'off' },
    ]);
  });

  it.skipIf(WINDOWS || ROOT_USER)(
    'a folder the vault cannot write in, on this system’s own permissions, is not ready',
    async () => {
      const dir = await folder();
      await fsp.chmod(dir, 0o555);
      try {
        expect(await checkWatchDir(dir)).toBe('not_writable');
      } finally {
        await fsp.chmod(dir, 0o755);
      }
    },
  );

  // ------------------------------------------------------------ whose it is

  it('what it adds is its person’s alone: nobody else is given the batch, the item or the note', async () => {
    const dir = await folder();
    await turnOn('teen');
    await write(dir, 'report.pdf', PDF('school report'));
    await write(dir, 'report.gif', Buffer.from('GIF89a'));
    const r = runner(dir);
    expect((await settle(r)).outcomes.map((o) => o.kind).sort()).toEqual(['added', 'rejected']);
    const app = new pg.Pool({ connectionString: tdb.appUrl, max: 1 });
    try {
      const seen = async (who: keyof typeof people, role: string) => {
        const c = await app.connect();
        try {
          await c.query('begin');
          await c.query(
            `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                    set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                    set_config('app.role', $4, true)`,
            [hh, people[who].account, people[who].member, role],
          );
          const { rows } = await c.query<{ batches: number; items: number; notes: number }>(
            `select (select count(*)::int from intake_batch) as batches,
                    (select count(*)::int from incoming_file) as items,
                    (select count(*)::int from watch_notice) as notes`,
          );
          await c.query('commit');
          return rows[0];
        } finally {
          c.release();
        }
      };
      expect(await seen('teen', 'teen')).toEqual({ batches: 1, items: 1, notes: 1 });
      for (const [who, role] of [
        ['owner', 'owner'],
        ['adult', 'adult'],
        ['other', 'adult'],
        ['viewer', 'viewer'],
      ] as const) {
        expect(await seen(who, role), who).toEqual({ batches: 0, items: 0, notes: 0 });
      }
    } finally {
      await app.end();
    }
  });
});
