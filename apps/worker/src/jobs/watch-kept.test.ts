import { randomBytes, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { localToday, watchIgnored } from '@fdv/shared';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  nodeFs,
  WatchRunner,
  type WatchDeps,
  type WatchOptions,
  type WatchRound,
} from './watch-folder.js';

/**
 * The scanner folder chosen in Settings, and kept scans (0.9.0, O1), in
 * the worker:
 *
 *  - a folder an owner chose is looked in only while it is inside the
 *    roots by its real path — no link out of them — and none of the
 *    vault's own folders nor above one; asked every round, never once, and
 *    what the worker found said for Settings;
 *  - a scan safely stored is moved to processed/<the household's date>/,
 *    its subfolders kept, never over another name ("name (2)"), and
 *    deleted once it has been there the owner's number of days — not
 *    before; 0 deletes it at once; processed/ is never taken from; and a
 *    file put in a kept scan's place is not deleted in its stead.
 *
 * Links are made where the system lets this user (a junction on Windows;
 * all of it in CI's node:22-alpine run, as uid 1000). A folder chosen is a
 * path in the worker's container, starting with / (0076 says so): those
 * tests run on Linux alone.
 */

const MASTER = 'watch-kept-test-master-key-with-32-bytes-or-more';
const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
const WINDOWS = process.platform === 'win32';
const DAY = 24 * 60 * 60_000;

describe.skipIf(!testAdminUrl())('the scanner folder chosen in Settings, and kept scans', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let vaultRoot: string;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  let hh: string;
  let member: string;
  const runners: WatchRunner[] = [];
  const logs: string[] = [];
  const dirs: string[] = [];
  let clock = Date.now();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 4));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 3 });
    admin.on('error', () => undefined);
    vaultRoot = await fsp.mkdtemp(path.join(tmpdir(), 'fdv-kept-vault-'));
    hh = randomUUID();
    // Auckland: its date is a day ahead of UTC's for half of every day.
    await admin.query(
      "insert into household (id, name, timezone) values ($1, 'Home', 'Pacific/Auckland')",
      [hh],
    );
    member = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Ann') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    const account = (
      await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
        `ann-${stamp}@kept.test`,
      ])
    ).rows[0]?.id as string;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [account, hh, member],
    );
    await withSystem(db, hh, async (trx) => {
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
    });
  }, 60_000);

  afterEach(async () => {
    for (const r of runners.splice(0)) await r.stop();
    for (const d of dirs.splice(0)) await fsp.rm(d, { recursive: true, force: true });
    await admin.query('delete from incoming_file where household_id = $1', [hh]);
    await admin.query('delete from intake_batch where household_id = $1', [hh]);
    await admin.query('delete from watch_folder where household_id = $1', [hh]);
    await admin.query('delete from watch_kept where household_id = $1', [hh]);
    logs.length = 0;
    clock = Date.now();
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
    await fsp.rm(vaultRoot, { recursive: true, force: true });
  });

  const folder = async (prefix = 'fdv-kept-') => {
    const d = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), prefix)));
    dirs.push(d);
    return d;
  };
  const turnOn = (o: { dir?: string | null; keep?: number } = {}) =>
    admin.query(
      `insert into watch_folder (household_id, enabled, member_id, dir, keep_days)
       values ($1, true, $2, $3, $4)
       on conflict (household_id) do update set enabled = true, member_id = $2, dir = $3, keep_days = $4`,
      [hh, member, o.dir ?? null, o.keep ?? 7],
    );
  const deps = (): WatchDeps => ({
    admin,
    db,
    keys,
    credentialsKey: Buffer.alloc(32),
    localRoot: vaultRoot,
    log: (level, msg, extra) => logs.push(JSON.stringify({ level, msg, ...extra })),
    itemKey: Buffer.alloc(32, 9),
    maxBytes: 64 * 1024,
    sendBatchPreviews: async () => undefined,
  });
  const runner = (opts: Partial<WatchOptions> & { dir: string | null }) => {
    const r = new WatchRunner(deps(), { lockUrl: tdb.appUrl, now: () => clock, ...opts });
    runners.push(r);
    return r;
  };
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
  const linkDir = (target: string, at: string) =>
    fsp.symlink(target, at, WINDOWS ? 'junction' : 'dir');
  const items = async () =>
    (
      await admin.query<{ original_name: string }>(
        'select original_name from incoming_file where household_id = $1 order by created_at, id',
        [hh],
      )
    ).rows.map((r) => r.original_name);
  const found = async () =>
    (
      await admin.query<{ dir_state: string | null; dir_seen: string | null }>(
        'select dir_state, dir_seen from watch_folder where household_id = $1',
        [hh],
      )
    ).rows[0];
  /** Every file under a folder, by its path from it. */
  const tree = async (dir: string) =>
    (await fsp.readdir(dir, { recursive: true }))
      .map((n) => String(n).split(path.sep).join('/'))
      .sort();
  /** The scans the vault recorded as kept, by their path from the folder. */
  const keptRows = async () =>
    (
      await admin.query<{ rel: string }>(
        'select rel from watch_kept where household_id = $1 order by kept_at, rel',
        [hh],
      )
    ).rows.map((r) => r.rel);
  const foreign = async () =>
    (
      await admin.query<{ processed_foreign: boolean }>(
        'select processed_foreign from watch_folder where household_id = $1',
        [hh],
      )
    ).rows[0]?.processed_foreign;
  const keptLeft = async () =>
    (
      await admin.query<{ kept_left: number }>(
        'select kept_left from watch_folder where household_id = $1',
        [hh],
      )
    ).rows[0]?.kept_left;
  /** What the worker said of kept scans changed since, and of files it has no record of. */
  const keptSaid = async () =>
    (
      await admin.query<{ kept_changed: number; kept_untracked: number; kept_reconcile: boolean }>(
        'select kept_changed, kept_untracked, kept_reconcile from watch_folder where household_id = $1',
        [hh],
      )
    ).rows[0];
  /** A file system that gives no birth time (an older kernel, a network share): Node says 0. */
  const unborn: typeof nodeFs = {
    ...nodeFs,
    lstat: (async (p: Parameters<typeof fsp.lstat>[0], o?: { bigint?: boolean }) => {
      const st = await fsp.lstat(p, o as never);
      if (!o?.bigint) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as object, st, {
        birthtimeNs: 0n,
        birthtime: new Date(0),
        birthtimeMs: 0n,
      });
    }) as typeof fsp.lstat,
  };
  /** As the worker's clock is moved on, the file's own time stays the system's: set it back. */
  const age = (days: number) => {
    clock = Date.now() + days * DAY;
  };

  // ------------------------------------------------------------ the folder chosen

  it.skipIf(WINDOWS)(
    'looks in a folder chosen inside the roots, and says so; one outside them is refused and never looked in',
    async () => {
      const root = await folder('fdv-kept-root-');
      const outside = await folder('fdv-kept-outside-');
      const chosen = path.join(root, 'office');
      await fsp.mkdir(chosen);
      const scan = await write(chosen, 'scan.pdf', PDF('office'));
      const decoy = await write(outside, 'deed.pdf', PDF('outside'));
      // Outside the roots: refused, every round, and nothing in it touched.
      await turnOn({ dir: outside, keep: 0 });
      const r = runner({ dir: null, roots: [root], ownDirs: [vaultRoot] });
      for (let i = 0; i < 2; i++) {
        const round = await settle(r);
        expect(round.state).toBe('refused');
        expect(round.outcomes).toEqual([]);
      }
      expect(await found()).toEqual({ dir_state: 'refused', dir_seen: outside });
      expect(await there(decoy)).toBe(true);
      expect(await tree(outside)).toEqual(['deed.pdf']);
      // Inside: looked in, and said ready.
      await turnOn({ dir: chosen, keep: 0 });
      const round = await settle(r);
      expect(round.state).toBe('ready');
      expect(round.outcomes).toMatchObject([{ rel: 'scan.pdf', kind: 'added' }]);
      expect(await there(scan)).toBe(false);
      expect(await found()).toEqual({ dir_state: 'ready', dir_seen: chosen });
      // The roots, and the vault's own folders, as the worker has them: for the API.
      const { rows } = await admin.query<{ roots: string[]; own_dirs: string[] }>(
        'select roots, own_dirs from watch_dir',
      );
      expect(rows[0]).toEqual({ roots: [root], own_dirs: [vaultRoot] });
    },
  );

  it.skipIf(WINDOWS)(
    'a link inside the roots that leads out of them is refused — asked again every round, so one swapped in later is too',
    async () => {
      const root = await folder('fdv-kept-root-');
      const outside = await folder('fdv-kept-outside-');
      const decoy = await write(outside, 'secret.pdf', PDF('secret'));
      const real = path.join(root, 'real');
      await fsp.mkdir(real);
      const via = path.join(root, 'via');
      await linkDir(outside, via);
      await turnOn({ dir: via, keep: 0 });
      const r = runner({ dir: null, roots: [root], ownDirs: [vaultRoot] });
      expect((await settle(r)).state).toBe('refused');
      expect(await there(decoy)).toBe(true);
      expect(await found()).toMatchObject({ dir_state: 'refused' });
      // A real folder, then swapped for a link out between rounds: refused from that round on.
      await turnOn({ dir: real, keep: 0 });
      expect((await settle(r)).state).toBe('ready');
      await fsp.rm(real, { recursive: true });
      await linkDir(outside, real);
      const after = await settle(r);
      expect(after.state).toBe('refused');
      expect(after.outcomes).toEqual([]);
      expect(await there(decoy)).toBe(true);
      expect(await tree(outside)).toEqual(['secret.pdf']);
    },
  );

  it.skipIf(WINDOWS)(
    'never looks in one of the vault’s own folders, inside one, or above one — FDV_WATCH_DIR included',
    async () => {
      const root = await folder('fdv-kept-root-');
      const own = path.join(root, 'vault-files');
      await fsp.mkdir(path.join(own, 'inner'), { recursive: true });
      const kept = await write(own, 'inner/file.pdf', PDF('the vault’s own'));
      const r = runner({ dir: null, roots: [root], ownDirs: [own] });
      for (const dir of [root, own, path.join(own, 'inner')]) {
        await turnOn({ dir, keep: 0 });
        const round = await settle(r);
        expect(round.state, dir).toBe('refused');
        expect(round.outcomes, dir).toEqual([]);
      }
      expect(await there(kept)).toBe(true);
      // FDV_WATCH_DIR, the operator's own, is refused as one of the vault's folders too.
      await admin.query('update watch_folder set dir = null where household_id = $1', [hh]);
      // Another worker's, the first one gone: it holds the lock now.
      await r.stop();
      const env = runner({ dir: own, roots: [], ownDirs: [own] });
      expect((await settle(env)).state).toBe('refused');
      expect((await admin.query('select state from watch_dir')).rows[0]).toEqual({
        state: 'refused',
      });
      expect(await there(kept)).toBe(true);
    },
  );

  // ------------------------------------------------------------ kept scans

  it('keeps a stored scan in processed/<the household’s date>/, its folders kept, never over another', async () => {
    const dir = await folder();
    await turnOn({ keep: 7 });
    const r = runner({ dir, roots: [dir] });
    // 11:30 UTC on 17 Oct is already 18 Oct in Auckland.
    clock = Date.parse('2026-10-17T11:30:00Z');
    const day = localToday('Pacific/Auckland', new Date(clock));
    expect(day).toBe('2026-10-18');
    await write(dir, 'Passports/Ahmed/scan.pdf', PDF('one'));
    await write(dir, 'top.pdf', PDF('top'));
    expect((await settle(r)).outcomes).toMatchObject([
      { rel: 'Passports/Ahmed/scan.pdf', kind: 'added' },
      { rel: 'top.pdf', kind: 'added' },
    ]);
    expect(await tree(path.join(dir, 'processed'))).toEqual([
      // The vault's own: its marker says so (the O1 review, M2).
      '.fdv-processed',
      day,
      `${day}/Passports`,
      `${day}/Passports/Ahmed`,
      `${day}/Passports/Ahmed/scan.pdf`,
      `${day}/top.pdf`,
    ]);
    // Another of the same name the same day: "name (2)", the first left as it was.
    await write(dir, 'Passports/Ahmed/scan.pdf', PDF('two'));
    expect((await settle(r)).outcomes).toMatchObject([
      { rel: 'Passports/Ahmed/scan.pdf', kind: 'added' },
    ]);
    const kept = path.join(dir, 'processed', day, 'Passports', 'Ahmed');
    expect((await fsp.readdir(kept)).sort()).toEqual(['scan (2).pdf', 'scan.pdf']);
    expect((await fsp.readFile(path.join(kept, 'scan.pdf'))).includes('one')).toBe(true);
    expect((await fsp.readFile(path.join(kept, 'scan (2).pdf'))).includes('two')).toBe(true);
    // Made the vault's own: 0700, where the system has modes.
    if (!WINDOWS) {
      expect((await fsp.stat(path.join(dir, 'processed'))).mode & 0o777).toBe(0o700);
      expect((await fsp.stat(kept)).mode & 0o777).toBe(0o700);
    }
    // And never taken again from there.
    expect(watchIgnored(`processed/${day}/top.pdf`)).toBe(true);
    expect((await settle(r)).outcomes).toEqual([]);
    expect(await items()).toEqual(['scan.pdf', 'top.pdf', 'scan.pdf']);
  });

  it('deletes a kept scan once it has been there the owner’s days, and not before; 0 deletes at once', async () => {
    const dir = await folder();
    await turnOn({ keep: 7 });
    const r = runner({ dir, roots: [dir] });
    await write(dir, 'a.pdf', PDF('a'));
    await settle(r);
    const day = localToday('Pacific/Auckland', new Date(clock));
    const kept = path.join(dir, 'processed', day, 'a.pdf');
    expect(await there(kept)).toBe(true);
    // Not yet: six days and 23 hours.
    age(7 - 1 / 24);
    await r.tick();
    expect(await there(kept)).toBe(true);
    // Seven days and an hour: gone, and its day's folder with it.
    age(7 + 1 / 24);
    await r.tick();
    expect(await there(kept), logs.join(' | ')).toBe(false);
    expect(await there(path.join(dir, 'processed', day))).toBe(false);
    expect(await there(path.join(dir, 'processed'))).toBe(true);

    // 0: a stored scan is deleted at once, as before 0.9.0 — and what was kept goes too.
    clock = Date.now();
    await write(dir, 'b.pdf', PDF('b'));
    await settle(r);
    const keptB = path.join(
      dir,
      'processed',
      localToday('Pacific/Auckland', new Date(clock)),
      'b.pdf',
    );
    expect(await there(keptB)).toBe(true);
    await admin.query('update watch_folder set keep_days = 0 where household_id = $1', [hh]);
    clock += 61_000;
    await r.tick();
    expect(await there(keptB)).toBe(false);
    const c = await write(dir, 'c.pdf', PDF('c'));
    expect((await settle(r)).outcomes).toMatchObject([{ rel: 'c.pdf', kind: 'added' }]);
    expect(await there(c)).toBe(false);
    expect(await tree(path.join(dir, 'processed'))).toEqual(['.fdv-processed']);
  });

  it('a file put in a kept scan’s place is not deleted in its stead', async () => {
    const dir = await folder();
    await turnOn({ keep: 1 });
    let swap: (() => Promise<void>) | null = null;
    const r = runner({
      dir,
      roots: [dir],
      beforeExpire: async () => {
        await swap?.();
      },
    });
    await write(dir, 'scan.pdf', PDF('kept'));
    await settle(r);
    const kept = path.join(
      dir,
      'processed',
      localToday('Pacific/Auckland', new Date(clock)),
      'scan.pdf',
    );
    // Due, and as it is about to go, somebody puts another file at its name.
    swap = async () => {
      await fsp.rm(kept);
      await fsp.writeFile(kept, 'somebody else’s');
      swap = null;
    };
    age(2);
    await r.tick();
    expect(await fsp.readFile(kept, 'utf8')).toBe('somebody else’s');
    // A link left at a kept scan's name: never followed, never deleted through.
    const outside = await folder('fdv-kept-outside-');
    const target = await write(outside, 'deed.pdf', PDF('deed'));
    const dayDir = path.dirname(kept);
    if (!WINDOWS) {
      await fsp.symlink(target, path.join(dayDir, 'link.pdf'));
    }
    await linkDir(outside, path.join(dayDir, 'linked-folder'));
    age(400);
    await r.tick();
    expect(await there(target)).toBe(true);
    expect(await tree(outside)).toEqual(['deed.pdf']);
  });

  it('a processed/ that is a link is never kept in nor looked through: the scan is deleted instead', async () => {
    const dir = await folder();
    const outside = await folder('fdv-kept-outside-');
    const decoy = await write(outside, 'old.pdf', PDF('old'));
    await linkDir(outside, path.join(dir, 'processed'));
    await turnOn({ keep: 7 });
    const r = runner({ dir, roots: [dir] });
    const scan = await write(dir, 'scan.pdf', PDF('scan'));
    expect((await settle(r)).outcomes).toMatchObject([{ rel: 'scan.pdf', kind: 'added' }]);
    expect(await there(scan)).toBe(false);
    age(30);
    await r.tick();
    expect(await tree(outside)).toEqual(['old.pdf']);
    expect(await there(decoy)).toBe(true);
  });

  // ------------------------------------------------------------ the O1 review

  it('a processed/ the family made is never adopted: nothing in it is touched or added, and Settings is told (M2, PoC 1)', async () => {
    const dir = await folder();
    // The reviewer's PoC: a folder of their own called processed, made before.
    const tax = await write(dir, 'processed/tax-2019.pdf', PDF('tax'));
    await turnOn({ keep: 7 });
    const r = runner({ dir, roots: [dir] });
    const scan = await write(dir, 'scan.pdf', PDF('scan'));
    expect((await settle(r)).outcomes).toMatchObject([{ rel: 'scan.pdf', kind: 'added' }]);
    // Stored, and deleted as before 0.9.0: never kept in a folder the vault didn't make.
    expect(await there(scan)).toBe(false);
    expect(await tree(path.join(dir, 'processed'))).toEqual(['tax-2019.pdf']);
    expect(await keptRows()).toEqual([]);
    expect(await foreign()).toBe(true);
    age(400);
    await r.tick();
    expect(await fsp.readFile(tax, 'utf8')).toContain('tax');
    // Moved away, the vault makes its own, and says so no longer.
    await fsp.rename(path.join(dir, 'processed'), path.join(await folder('fdv-kept-moved-'), 'p'));
    clock = Date.now();
    await write(dir, 'next.pdf', PDF('next'));
    await settle(r);
    expect(await foreign()).toBe(false);
    expect((await tree(path.join(dir, 'processed')))[0]).toBe('.fdv-processed');
  });

  it('a kept scan whose change time moves (a chmod, an xattr, Samba’s DOS attributes) is still known by its birth time, and deleted in time (the O1 re-check, 1)', async () => {
    const dir = await folder();
    await turnOn({ keep: 1 });
    const r = runner({ dir, roots: [dir] });
    await write(dir, 'a.pdf', PDF('a'));
    await settle(r);
    const kept = path.join(
      dir,
      'processed',
      localToday('Pacific/Auckland', new Date(clock)),
      'a.pdf',
    );
    const born = (await fsp.lstat(kept, { bigint: true })).birthtimeNs;
    // The reviewer's PoC: its mode changed, so its change time moved.
    const before = (await fsp.lstat(kept, { bigint: true })).ctimeNs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fsp.chmod(kept, 0o400);
    expect((await fsp.lstat(kept, { bigint: true })).ctimeNs).not.toBe(before);
    const { rows } = await admin.query<{ born: string | null }>(
      'select born from watch_kept where household_id = $1',
      [hh],
    );
    if (born === 0n) {
      // No birth time here: the next test says what happens then.
      expect(rows[0]?.born).toBeNull();
      return;
    }
    expect(rows[0]?.born).toBe(String(born));
    age(2);
    await r.tick();
    expect(await there(kept)).toBe(false);
    expect(await keptRows()).toEqual([]);
    expect(await keptSaid()).toMatchObject({ kept_changed: 0 });
  });

  it('with no birth time to tell, a kept scan whose change time moved is left in place, its record kept, and counted for Settings (the O1 re-check, 1)', async () => {
    const dir = await folder();
    await turnOn({ keep: 1 });
    const r = runner({ dir, roots: [dir], fs: unborn });
    await write(dir, 'a.pdf', PDF('a'));
    await write(dir, 'b.pdf', PDF('b'));
    await settle(r);
    const day = localToday('Pacific/Auckland', new Date(clock));
    const a = path.join(dir, 'processed', day, 'a.pdf');
    const b = path.join(dir, 'processed', day, 'b.pdf');
    const { rows } = await admin.query<{ born: string | null }>(
      'select born from watch_kept where household_id = $1',
      [hh],
    );
    expect(rows.map((x) => x.born)).toEqual([null, null]);
    // The reviewer's PoC, on one of them.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fsp.chmod(a, 0o400);
    age(2);
    await r.tick();
    // Maybe the very scan, maybe a file on its inode: never deleted, never forgotten.
    expect(await there(a)).toBe(true);
    expect(await there(b)).toBe(false);
    expect(await keptRows()).toEqual([`processed/${day}/a.pdf`]);
    expect(await keptSaid()).toMatchObject({ kept_changed: 1 });
    age(400);
    await r.tick();
    expect(await there(a)).toBe(true);
    expect(await keptSaid()).toMatchObject({ kept_changed: 1 });
    // Deleted by hand: the record let go, and the count with it.
    await fsp.chmod(a, 0o600);
    await fsp.rm(a);
    clock += 2 * 60_000;
    await r.tick();
    expect(await keptRows()).toEqual([]);
    expect(await keptSaid()).toMatchObject({ kept_changed: 0 });
  });

  it('after a restore, the scans kept since are counted, never deleted, until they are gone (the O1 re-check, 2)', async () => {
    const dir = await folder();
    await turnOn({ keep: 1 });
    const r = runner({ dir, roots: [dir] });
    await write(dir, 'before.pdf', PDF('before'));
    await write(dir, 'since.pdf', PDF('since'));
    await settle(r);
    const day = localToday('Pacific/Auckland', new Date(clock));
    const before = path.join(dir, 'processed', day, 'before.pdf');
    const since = path.join(dir, 'processed', day, 'since.pdf');
    // A restore puts back the records as they were when the backup was
    // made, and asks the worker to look (restoreBackup's RECONCILE_KEPT).
    await admin.query('delete from watch_kept where household_id = $1 and rel like $2', [
      hh,
      '%since.pdf',
    ]);
    await admin.query('update watch_folder set kept_reconcile = true where household_id = $1', [
      hh,
    ]);
    clock += 2 * 60_000;
    await r.tick();
    expect(await keptSaid()).toEqual({ kept_changed: 0, kept_untracked: 1, kept_reconcile: false });
    age(400);
    await r.tick();
    // The one recorded goes in time; the one not is never deleted.
    expect(await there(before)).toBe(false);
    expect(await there(since)).toBe(true);
    expect(await keptSaid()).toMatchObject({ kept_untracked: 1 });
    // Deleted by hand: counted no longer.
    await fsp.rm(since);
    clock += 2 * 60_000;
    await r.tick();
    expect(await keptSaid()).toMatchObject({ kept_untracked: 0 });
  });

  it('only the scans the vault kept are ever deleted: anything else saved into processed/ is never touched, nor added (M2, PoC 2)', async () => {
    const dir = await folder();
    await turnOn({ keep: 1 });
    const r = runner({ dir, roots: [dir] });
    await write(dir, 'a.pdf', PDF('a'));
    await settle(r);
    const day = localToday('Pacific/Auckland', new Date(clock));
    const kept = path.join(dir, 'processed', day, 'a.pdf');
    expect(await there(kept)).toBe(true);
    expect(await keptRows()).toEqual([`processed/${day}/a.pdf`]);
    // The reviewer's PoC: the scanner (or anybody) saves into processed/.
    const fromScanner = await write(dir, `processed/${day}/from-the-scanner.pdf`, PDF('scanner'));
    const family = await write(dir, 'processed/tax-2019.pdf', PDF('tax'));
    age(30);
    await r.tick();
    expect(await there(kept)).toBe(false);
    expect(await keptRows()).toEqual([]);
    expect(await there(fromScanner)).toBe(true);
    expect(await there(family)).toBe(true);
    age(400);
    await r.tick();
    expect(await there(fromScanner)).toBe(true);
    expect(await there(family)).toBe(true);
    expect(await items()).toEqual(['a.pdf']);
  });

  it.skipIf(WINDOWS)(
    'kept scans are deleted wherever they were kept while that folder may be used; else Settings is told they are left (L1)',
    async () => {
      const root = await folder('fdv-kept-root-');
      const a = path.join(root, 'a');
      const b = path.join(root, 'b');
      await fsp.mkdir(a);
      await fsp.mkdir(b);
      await turnOn({ dir: a, keep: 7 });
      const r = runner({ dir: null, roots: [root], ownDirs: [vaultRoot] });
      await write(a, 'one.pdf', PDF('one'));
      await settle(r);
      const day = localToday('Pacific/Auckland', new Date(clock));
      const one = path.join(a, 'processed', day, 'one.pdf');
      expect(await there(one)).toBe(true);
      // Another folder chosen: what was kept in the first still goes, in time.
      await turnOn({ dir: b, keep: 7 });
      await write(b, 'two.pdf', PDF('two'));
      await settle(r);
      const two = path.join(b, 'processed', day, 'two.pdf');
      expect(await there(two)).toBe(true);
      age(8);
      await r.tick();
      expect(await there(one)).toBe(false);
      expect(await there(two)).toBe(false);
      expect(await keptLeft()).toBe(0);
      // Kept in b, then b no longer one the vault may use: left, and said.
      clock = Date.now();
      await write(b, 'three.pdf', PDF('three'));
      await settle(r);
      const three = path.join(
        b,
        'processed',
        localToday('Pacific/Auckland', new Date(clock)),
        'three.pdf',
      );
      expect(await there(three)).toBe(true);
      await r.stop();
      await turnOn({ dir: a, keep: 7 });
      const narrower = runner({ dir: null, roots: [a], ownDirs: [vaultRoot] });
      await settle(narrower);
      expect(await keptLeft()).toBe(1);
      age(30);
      await narrower.tick();
      expect(await there(three)).toBe(true);
      expect(await keptLeft()).toBe(1);
    },
  );

  it.skipIf(WINDOWS)(
    'only the household with the scanner folder on says how long its scans are kept: another’s setting for the same folder never deletes them (L2)',
    async () => {
      const root = await folder('fdv-kept-root-');
      const chosen = path.join(root, 'office');
      await fsp.mkdir(chosen);
      // Another household, its scanner folder off, once set to the same folder with no days.
      const other = randomUUID();
      await admin.query("insert into household (id, name) values ($1, 'Next door')", [other]);
      try {
        await admin.query(
          `insert into watch_folder (household_id, enabled, dir, keep_days) values ($1, false, $2, 0)`,
          [other, chosen],
        );
        await turnOn({ dir: chosen, keep: 7 });
        const r = runner({ dir: null, roots: [root], ownDirs: [vaultRoot] });
        await write(chosen, 'scan.pdf', PDF('scan'));
        await settle(r);
        const kept = path.join(
          chosen,
          'processed',
          localToday('Pacific/Auckland', new Date(clock)),
          'scan.pdf',
        );
        expect(await there(kept)).toBe(true);
        clock += 2 * 60_000;
        await r.tick();
        age(3);
        await r.tick();
        expect(await there(kept)).toBe(true);
      } finally {
        await admin.query('delete from household where id = $1', [other]);
      }
    },
  );

  it.skipIf(WINDOWS)(
    'one of the vault’s own folders mounted inside the folder, or the folder inside one mounted elsewhere, is known by its device and inode (M4)',
    async () => {
      const root = await folder('fdv-kept-root-');
      const mounts = await folder('fdv-kept-mounts-');
      const chosen = path.join(root, 'scans');
      const inner = path.join(chosen, 'vault-data');
      await fsp.mkdir(inner, { recursive: true });
      const theirs = await write(inner, 'object.pdf', PDF('the vault’s own'));
      const scan = await write(chosen, 'scan.pdf', PDF('scan'));
      // A bind mount, as the system shows one: the vault's own folder at a
      // path of its own (FDV_LOCAL_VAULT_DIR), the very folder (device and
      // inode) seen inside the scanner folder — no link a real path reveals.
      const alias = path.join(mounts, 'vault');
      await fsp.symlink(inner, alias);
      const bindFs = {
        ...nodeFs,
        realpath: (async (p: string, o?: unknown) =>
          String(p).startsWith(alias)
            ? String(p)
            : fsp.realpath(p, o as undefined)) as typeof fsp.realpath,
      };
      await turnOn({ dir: chosen, keep: 0 });
      const r = runner({ dir: null, roots: [root], ownDirs: [vaultRoot, alias], fs: bindFs });
      const round = await settle(r);
      expect(round.state).toBe('ready');
      expect(round.outcomes).toMatchObject([{ rel: 'scan.pdf', kind: 'added' }]);
      expect(await there(scan)).toBe(false);
      expect(await there(theirs)).toBe(true);
      expect(await items()).toEqual(['scan.pdf']);
      await r.stop();
      // One of the vault's own folders, mounted elsewhere too: a folder
      // chosen inside it is refused, by the device and inode of the folders
      // above the one chosen.
      const sub = path.join(root, 'sub');
      const deeper = path.join(sub, 'scans');
      await fsp.mkdir(deeper, { recursive: true });
      const up = path.join(mounts, 'up');
      await fsp.symlink(sub, up);
      const upFs = {
        ...nodeFs,
        realpath: (async (p: string, o?: unknown) =>
          String(p).startsWith(up)
            ? String(p)
            : fsp.realpath(p, o as undefined)) as typeof fsp.realpath,
      };
      await turnOn({ dir: deeper, keep: 0 });
      const r2 = runner({ dir: null, roots: [root], ownDirs: [vaultRoot, up], fs: upFs });
      const later = await write(deeper, 'later.pdf', PDF('later'));
      const refused = await settle(r2);
      expect(refused.state).toBe('refused');
      expect(refused.outcomes).toEqual([]);
      expect(await there(later)).toBe(true);
    },
  );

  it.skipIf(WINDOWS)(
    'a root that is / or holds the vault’s own folders is refused, said in the log and to Settings (M4)',
    async () => {
      const root = await folder('fdv-kept-root-');
      const chosen = path.join(root, 'scans');
      await fsp.mkdir(chosen);
      const scan = await write(chosen, 'scan.pdf', PDF('scan'));
      await turnOn({ dir: chosen, keep: 0 });
      for (const roots of [['/'], [path.dirname(vaultRoot)], [path.dirname(root)]]) {
        const r = runner({ dir: null, roots, ownDirs: [vaultRoot] });
        logs.length = 0;
        const round = await settle(r);
        expect(round.state, roots[0]).toBe('refused');
        expect(round.outcomes).toEqual([]);
        expect(
          (await admin.query<{ refused_roots: string[] }>('select refused_roots from watch_dir'))
            .rows[0]?.refused_roots,
        ).toEqual(roots);
        expect(logs.some((l) => l.includes('scanner roots refused'))).toBe(true);
        await r.stop();
      }
      expect(await there(scan)).toBe(true);
    },
  );

  it.skipIf(WINDOWS)(
    'a folder swapped for a link out of the roots after its probe: nothing in it is touched (M1, PoC 3)',
    async () => {
      const root = await folder('fdv-kept-root-');
      const outside = await folder('fdv-kept-outside-');
      const chosen = path.join(root, 'scans');
      await fsp.mkdir(chosen);
      // The same name, size and time inside and out, so the file outside
      // looks like the one seen settling.
      const decoy = await write(outside, 'deed.pdf', PDF('deed'));
      const twin = await write(chosen, 'deed.pdf', PDF('deed'));
      const t = new Date(Date.now() - 60_000);
      await fsp.utimes(decoy, t, t);
      await fsp.utimes(twin, t, t);
      let probes = 0;
      const swapFs: typeof nodeFs = {
        ...nodeFs,
        unlink: async (p: Parameters<typeof fsp.unlink>[0]) => {
          await fsp.unlink(p);
          const at = String(p);
          if (path.basename(at).startsWith('.fdv-probe-') && path.dirname(at) === chosen) {
            // The reviewer's PoC: checked and probed, then swapped.
            if (++probes === 2) {
              await fsp.rename(chosen, `${chosen}-was`);
              await fsp.symlink(outside, chosen);
            }
          }
        },
      };
      await turnOn({ dir: chosen, keep: 0 });
      const r = runner({ dir: null, roots: [root], ownDirs: [vaultRoot], fs: swapFs });
      const first = await r.tick();
      expect(first.state).toBe('ready');
      clock += 11_000;
      const second = await r.tick();
      expect(probes).toBe(2);
      expect(second.state).toBe('refused');
      expect(second.outcomes).toEqual([]);
      expect(await fsp.readFile(decoy, 'utf8')).toContain('deed');
      expect(await tree(outside)).toEqual(['deed.pdf']);
      expect(await items()).toEqual([]);
    },
  );
});
