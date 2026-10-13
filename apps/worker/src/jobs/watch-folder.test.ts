import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnvKeyProvider, ScopeKeys, unwrapKey } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { BATCH_MAX_FILES, scannerDay, watchIgnored } from '@fdv/shared';
import { LocalAdapter } from '@fdv/storage';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decryptToBuffer } from './process-version.js';
import {
  checkWatchDir,
  watchItemKey,
  watchKindOf,
  WatchRunner,
  type WatchDeps,
  type WatchFs,
  type WatchRound,
} from './watch-folder.js';

/**
 * The scanner folder (0.8.0, S3), in the worker: a file taken once it has
 * stood still, added to its person's batch of the day as Add → Many
 * documents adds one, and deleted; temp names, hidden files and rejected/
 * left alone; never two items of one file, whatever stops between storing
 * and deleting; what cannot be added moved to rejected/ with its reason and
 * its person told; one runner however many workers; paused while its person
 * cannot have files added, or the vault cannot store them; the folder known
 * to be missing or read-only; and what it adds its person's alone.
 */

const MASTER = 'watch-folder-test-master-key-with-32-bytes-or-more';
const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

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
  const runner = (dir: string | null, over: Partial<WatchDeps> = {}, fs?: WatchFs) => {
    const r = new WatchRunner(deps(over), {
      dir,
      lockUrl: tdb.appUrl,
      now: () => clock,
      ...(fs ? { fs } : {}),
    });
    runners.push(r);
    return r;
  };
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
    fsp.stat(p).then(
      () => true,
      () => false,
    );
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
  const pausedAs = async () =>
    (
      await admin.query<{ paused_reason: string | null }>(
        'select paused_reason from watch_folder where household_id = $1',
        [hh],
      )
    ).rows[0]?.paused_reason;

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

  // ------------------------------------------------------------ never twice

  it('a worker that stops between storing and deleting makes no second item; one that stops on the way adds it once', async () => {
    const dir = await folder();
    await turnOn('adult');
    const scan = await write(dir, 'deed.pdf', PDF('deed'));
    // Stored, and then the delete never happens: the worker stopped.
    const stuck: WatchFs = {
      ...(await import('node:fs/promises')),
      unlink: async (p) => {
        if (String(p).endsWith('deed.pdf'))
          throw Object.assign(new Error('stopped'), { code: 'EIO' });
        return fsp.unlink(p);
      },
    };
    const first = runner(dir, {}, stuck);
    expect((await settle(first)).outcomes).toMatchObject([{ rel: 'deed.pdf', kind: 'added' }]);
    expect(await there(scan)).toBe(true);
    await first.stop();
    // The next worker: the same file, the same item — found, and the file deleted.
    const next = runner(dir);
    expect((await settle(next)).outcomes).toMatchObject([{ rel: 'deed.pdf', kind: 'already' }]);
    expect(await there(scan)).toBe(false);
    expect((await items()).length).toBe(1);

    // Removed from the Inbox before the file went: still not added again.
    const again = await write(dir, 'again.pdf', PDF('again'));
    const stuck2: WatchFs = {
      ...stuck,
      unlink: async (p) => {
        if (String(p).endsWith('again.pdf'))
          throw Object.assign(new Error('stopped'), { code: 'EIO' });
        return fsp.unlink(p);
      },
    };
    await next.stop();
    const third = runner(dir, {}, stuck2);
    expect((await settle(third)).outcomes).toMatchObject([{ rel: 'again.pdf', kind: 'added' }]);
    await admin.query(
      `update incoming_file set state = 'rejected', decided_at = now(), original_name = null, sha256 = null
        where original_name = 'again.pdf'`,
    );
    await third.stop();
    const fourth = runner(dir);
    expect((await settle(fourth)).outcomes).toMatchObject([{ rel: 'again.pdf', kind: 'already' }]);
    expect(await there(again)).toBe(false);
    expect((await items()).length).toBe(2);

    // On its way when the worker stopped: that row (and its object) go, and it is added once.
    const will = await write(dir, 'will.pdf', PDF('will'));
    const st = await fsp.stat(will);
    const key = watchItemKey(Buffer.alloc(32, 7), hh, {
      rel: 'will.pdf',
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
    const batch = (await items())[0];
    const scope = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: people.adult.member }),
    );
    const halfKey = `${hh}/batches/half-${randomBytes(4).toString('hex')}.enc`;
    await new LocalAdapter(root).put(
      halfKey,
      (await import('node:stream')).Readable.from([Buffer.from('half')]),
    );
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

  it('moves what it cannot add to rejected/, with a note saying why, and tells its person', async () => {
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
    const unreadable: WatchFs = {
      ...(await import('node:fs/promises')),
      open: (async (p: string, flags: string) => {
        if (String(p).endsWith('locked.pdf')) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return fsp.open(p, flags);
      }) as WatchFs['open'],
    };
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
    const notes = await admin.query<{ member_id: string; file_name: string; reason: string }>(
      'select member_id, file_name, reason from watch_notice where household_id = $1 order by file_name, reason',
      [hh],
    );
    expect(notes.rows).toEqual(
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

  it('never names a scanned file, or its folders, in the log', async () => {
    const dir = await folder();
    await turnOn('adult');
    await write(dir, 'Clinic/hiv-result-secret.gif', Buffer.from('GIF89a'));
    await write(dir, 'Clinic/biopsy-secret.pdf', PDF('biopsy'));
    const said: string[] = [];
    // A system that names the file in every refusal, as node's own do.
    const refusing: WatchFs = {
      ...(await import('node:fs/promises')),
      rename: (async (from: string) => {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), {
          code: 'EPERM',
        });
      }) as WatchFs['rename'],
      unlink: (async (p: string) => {
        if (!p.includes('secret')) return fsp.unlink(p);
        throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${p}'`), {
          code: 'EBUSY',
        });
      }) as WatchFs['unlink'],
    };
    const r = runner(
      dir,
      { log: (level, msg, extra) => said.push(JSON.stringify({ level, msg, extra })) },
      refusing,
    );
    const round = await settle(r);
    expect(round.outcomes.map((o) => o.kind).sort()).toEqual(['added', 'later']);
    const log = said.join('\n');
    expect(log).toMatch(/EPERM/);
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
    const firstA = a.tick();
    const firstB = b.tick();
    const [ra, rb] = await Promise.all([firstA, firstB]);
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
    const readOnly: WatchFs = {
      ...(await import('node:fs/promises')),
      writeFile: (async () => {
        throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
      }) as WatchFs['writeFile'],
    };
    expect(await checkWatchDir(dir, readOnly)).toBe('not_writable');
    const noAccess: WatchFs = {
      ...(await import('node:fs/promises')),
      access: (async (_p: string, mode?: number) => {
        if (mode !== undefined && mode & constants.W_OK) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
      }) as WatchFs['access'],
    };
    expect(await checkWatchDir(dir, noAccess)).toBe('not_writable');
    // Nothing is left behind by the look.
    expect(await fsp.readdir(dir)).toEqual(['a-file']);

    // The worker says so, for the API; and adds nothing from a folder it cannot write in.
    await turnOn('adult');
    const scan = await write(dir, 'scan.pdf', PDF('scan'));
    const r = runner(dir, {}, readOnly);
    const round = await settle(r);
    expect(round).toMatchObject({ ran: true, state: 'not_writable', outcomes: [] });
    expect(await there(scan)).toBe(true);
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

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
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
