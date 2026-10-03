import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DecryptStream, type ScopeKeys } from '@fdv/crypto';
import { createDb, createPool, listMigrations, migrateUp } from '@fdv/db';
import { adapterFromRow, StorageError, type StorageAdapter, type VaultRowLike } from '@fdv/storage';
import { libpqConnection, withDatabase } from './libpq.js';
import { markRemovedFiles, type FileStorage, type RemovedFiles } from './removed-files.js';
import { sealPrivateValues } from './seal.js';

// For a backup made before the master key was rotated.
import { backupKeyFor, onCurrentKey, type MasterKeys, type RekeyReport } from './restore-keys.js';

/**
 * Putting a backup back (NFR-07).
 *
 * A backup is a plain `pg_dump`, encrypted (backup.ts). Restoring loads it
 * into an empty database, then does what the vault's own start would: runs
 * any migrations the backup predates, gives the application role its
 * privileges, which the dump does not carry, and seals the Only me notes
 * and details a backup from before 0.5.8 holds plain (seal.ts). Then it
 * checks the result the way the vault will use it — as the application
 * role, through row-level security — rather than counting rows as the
 * owner, which is all the drill did until 0.4.5, and why it never noticed
 * that a restored vault could not read itself.
 *
 * The load is one transaction, and it is committed only after the whole
 * file has decrypted and authenticated: the last chunk carries the flag
 * that proves nothing was cut off, so until it has been read there is
 * nothing to commit. A truncated, altered or foreign file leaves the
 * database as empty as it was. (pg_dump writes row-level security, the
 * policies and the audit log's trigger last, so a partial load would have
 * been a vault without its privacy wall.)
 *
 * A backup is the past: whatever was revoked or ended since it was made
 * comes back with it. So, in the same transaction, every session is ended
 * — everybody signs in again — and what else can be ended safely is (see
 * UNDO). A share link cannot tell whether it was taken back since, so every
 * live one is paused until an owner turns it back on (5.16, A55), and no
 * session opened with one survives; so is every live request to send
 * documents, with its sessions and codes (5.21). What only the family can
 * decide (passkeys, invitations) is reported.
 *
 * A backup holds only the database (backup.ts). A document removed for good
 * after it was made (5.24) comes back as a record whose file is gone: told
 * where the files are kept (`storage`), the restore looks for every
 * version's file, marks each one not there as removed (file_removed_at) —
 * its document then says "The file was removed for good" instead of
 * failing — and the report lists them. A place that holds none of the files
 * it should is left alone, and said (removed-files.ts).
 */

export interface RestoreTarget {
  /** The owning role, on the database to restore into. */
  adminUrl: string;
  /** The application role, on the same database. */
  appUrl: string;
  /**
   * The master key the vault there runs with and, for a backup made before
   * it was rotated, the key the backup was made with (FDV_MASTER_KEY_PREVIOUS).
   * Given it, the restore opens such a backup and moves what it holds onto
   * the current key; without it, the backup is loaded as it was made. The
   * command line always gives it.
   */
  master?: MasterKeys | undefined;
}

export interface RestoreReport {
  schema: number;
  households: number;
  members: number;
  documents: number;
  versions: number;
  /** A backup made before a rotation: what was moved onto the current master key. */
  rekeyed: RekeyReport | null;
  /** Sessions ended, so that everybody signs in again. */
  sessionsEnded: number;
  /** Requests to change who is an owner, withdrawn: they are asked again, with fresh notice. */
  ownerChangesWithdrawn: number;
  /**
   * Share links paused (5.16): each waits for an owner to turn it back on,
   * in Settings → After a restore, since any revoked after the backup was
   * made would otherwise work again.
   */
  linksPaused: number;
  /**
   * Requests to send documents paused (5.21, A55): each waits for an owner
   * to turn it back on, as a link does, and no sender's session or emailed
   * code survives.
   */
  requestsPaused: number;
  /**
   * People's photos that were on their way when the backup was made
   * (5.17c), marked failed: their jobs are gone, and the nightly prune
   * takes them and their uploads away. Ready photos come back as they were.
   */
  photosUnfinished: number;
  /**
   * Owners' requests to remove a document for good (5.24), ended: a filer's
   * Bring it back made since the backup would otherwise be undone, its 24
   * hours perhaps already past. An owner asks again, and the filer is told
   * again.
   */
  purgeRequestsCleared: number;
  /**
   * Notices still waiting, withdrawn (5.26): a wider audience for identity
   * details withdrawn since the backup was made would otherwise come back.
   * An owner asks again, and everybody is told again.
   */
  noticesWithdrawn: number;
  /**
   * Households whose audience for identity details was wider than the
   * narrowest, and what it was (A34): each is back to the owners and each
   * person, and widening it again goes through the notice.
   */
  identityAudiences: Array<{ household_id: string; was: string }>;
  /**
   * Exports that could still be downloaded, expired (5.27): each was built
   * from what its requester could see then, identity details included, and
   * a restore narrows who sees those, and can bring back an export a
   * narrowing since the backup had ended. Whoever needs one makes it again.
   */
  exportsExpired: number;
  openInvitations: number;
  /**
   * Versions whose file was not where it is kept (5.24): removed for good
   * after the backup was made. Each is marked, and its document says so.
   * Empty when the restore was not told where the files are.
   */
  filesRemoved: Array<{ household_id: string; document_id: string; version_id: string }>;
  /**
   * Versions whose file could not be looked for — where it is kept could not
   * be reached, or held none of the files it should — and so not marked.
   */
  filesUnchecked: number;
  /** Why, a sentence a place. */
  filesUncheckedWhy: string[];
  /**
   * Files sent through a request that were waiting in the backup and whose
   * bytes are gone since — filed, refused, or removed after 30 days (5.23):
   * dropped, since there is nothing left to look at.
   */
  incomingDropped: number;
}

/**
 * Where the files are kept, for a restore to look for each version's file
 * (5.24): the key that opens a vault's bucket credentials, and the folder a
 * local vault's files are in — the worker's own.
 */
export type RestoreStorage = FileStorage;

export type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

/** Refused because the target is not empty: nothing was changed. */
export class RestoreRefused extends Error {}

/** The backup was loaded, but what follows the load failed. */
export class RestoreIncomplete extends Error {}

export async function restoreBackup(
  file: string,
  backupKey: Buffer,
  target: RestoreTarget,
  log: Log,
  /** The vault's scope keys, under its master key: what private.seal seals with. */
  keys: ScopeKeys,
  /** Where the files are kept: each version's is looked for (5.24). */
  storage?: RestoreStorage,
): Promise<RestoreReport> {
  await assertEmpty(target.adminUrl);
  const known = (await listMigrations()).reduce((max, m) => Math.max(max, m.version), 0);
  const key = await backupKeyFor(file, backupKey, target.master?.previous);
  const undone = await load(file, key, target.adminUrl, known);
  log('info', 'backup loaded', { file, ...undone });

  try {
    // Before anything reads it: a backup made before the master key was
    // rotated holds its keys and secrets under the key it was made with.
    const rekeyed = target.master ? await onCurrentKey(target.adminUrl, target.master, log) : null;
    const admin = createPool(target.adminUrl, 1);
    let open: StillOpen;
    let files: RemovedFiles = { filesRemoved: [], filesUnchecked: 0, filesUncheckedWhy: [] };
    let incomingDropped = 0;
    try {
      // What the vault's own start does: bring an older backup up to date,
      // then give the application role its privileges.
      const applied = await migrateUp(admin, undefined, (m) => log('info', `migrate: ${m}`));
      if (applied.length) log('info', 'backup brought up to date', { migrations: applied.length });
      // And what the worker's start does, before the vault opens: a backup
      // can be older than the sealing of its Only me notes and details
      // (0.5.8), and they are not to be plain in the vault for a moment.
      await sealRestored(admin, target.appUrl, keys, log);
      // A backup older than 0.5.14 has nothing to pause links with until
      // the migrations have run: its links are paused now.
      undone.linksPaused += await pauseLinks(admin);
      // A file waiting in the backup whose bytes have gone since (5.23).
      incomingDropped = await dropPurgedIncoming(admin, storage, log);
      open = await stillOpen(admin);
      if (storage) files = await markRemovedFiles(admin, storage, log);
    } finally {
      await admin.end();
    }
    return {
      ...(await checkRestored(target)),
      ...undone,
      ...open,
      ...files,
      rekeyed,
      incomingDropped,
    };
  } catch (err) {
    throw new RestoreIncomplete((err as Error).message, { cause: err });
  }
}

/** private.seal, on the restored database; any document it could not seal fails the restore. */
async function sealRestored(
  admin: ReturnType<typeof createPool>,
  appUrl: string,
  keys: ScopeKeys,
  log: Log,
): Promise<void> {
  const app = createDb(createPool(appUrl, 1));
  try {
    const r = await sealPrivateValues({ admin, app, keys, log });
    if (r.sealed) log('info', 'Only me notes and details sealed', r);
    if (r.failed) {
      // What went wrong, as it went wrong: a connection or a password is as
      // likely as a key (5.9 review), and each document's is in the log.
      throw new Error(
        `${r.failed} Only me document${r.failed === 1 ? "'s" : "s'"} notes and details could not be sealed (${r.firstError ?? 'no reason given'}); each is in the log`,
      );
    }
  } finally {
    await app.destroy();
  }
}

interface Undone {
  sessionsEnded: number;
  ownerChangesWithdrawn: number;
  linksPaused: number;
  requestsPaused: number;
  photosUnfinished: number;
  purgeRequestsCleared: number;
  noticesWithdrawn: number;
  identityAudiences: Array<{ household_id: string; was: string }>;
  exportsExpired: number;
}

interface StillOpen {
  openInvitations: number;
}

/** Every live share link, paused for an owner to turn back on (A55). UNDO says it too. */
const PAUSE_LINKS = `update public.share_link set paused_at = now(), paused_reason = 'restored'
   where paused_at is null and revoked_at is null and expires_at > now() and attempts < 10`;

/**
 * UNDO pauses the links in the load's own transaction when the backup has
 * the column; this does it for a backup from before 0.5.14, once the
 * migrations have added it. After a newer backup it finds nothing left.
 */
async function pauseLinks(admin: ReturnType<typeof createPool>): Promise<number> {
  return (await admin.query(PAUSE_LINKS)).rowCount ?? 0;
}

/**
 * A backup is the past, and the files are the present (5.23): a file sent
 * through a request that was waiting when the backup was made may have
 * been filed, refused or removed after 30 days since, and its bytes with
 * it. Such a row is dropped — there is nothing left to look at, and a
 * reviewer shown it could only be told so — and counted for the report. A
 * decided file's bytes found gone are written down as gone.
 *
 * Dropping is for good, so only where the files are kept clearly holds
 * files, as markRemovedFiles asks (D524-02): a vault that cannot be opened
 * or reached, a local folder that is not there, or a place in which not
 * one of these files and not one of its versions' files is found — a
 * volume not mounted yet, the files not copied back yet — keeps every file
 * of it, and says so: their bytes may well be there.
 */
async function dropPurgedIncoming(
  admin: ReturnType<typeof createPool>,
  storage: RestoreStorage | undefined,
  log: Log,
): Promise<number> {
  if (!storage) return 0;
  const { rows: files } = await admin.query<{
    id: string;
    state: string;
    storage_key: string;
    vault_id: string;
  }>(
    `select id, state, storage_key, vault_id from incoming_file
      where state in ('uploading', 'received')
         or (state in ('accepted', 'rejected') and object_removed_at is null)
      order by id`,
  );
  if (files.length === 0) return 0;
  const { rows: vaults } = await admin.query<VaultRowLike & { id: string }>(
    `select * from vault where id = any($1::uuid[])`,
    [[...new Set(files.map((f) => f.vault_id))]],
  );
  const kept = (vault: string, why: string, extra: Record<string, unknown> = {}) =>
    log('warn', `${why}: its files sent in are kept`, { vault, ...extra });
  let dropped = 0;
  for (const v of vaults) {
    const held = files.filter((f) => f.vault_id === v.id);
    if (v.kind === 'local' && !(await isFolder(storage.localRoot))) {
      kept(v.id, `the folder ${storage.localRoot} is not there`);
      continue;
    }
    let adapter: StorageAdapter;
    try {
      adapter = adapterFromRow(v, storage.credentialsKey, storage.localRoot);
    } catch (err) {
      kept(v.id, 'a place files are kept could not be opened', { err: (err as Error).message });
      continue;
    }
    const gone: typeof held = [];
    let found = 0;
    for (const f of held) {
      const there = await isThere(adapter, f.storage_key);
      if (there === true) found++;
      else if (there === false) gone.push(f);
      else
        log('warn', 'could not ask whether a file sent in is still kept: it is kept', {
          file: f.id,
        });
    }
    if (gone.length === 0) continue;
    if (found === 0 && !(await holdsVersions(admin, adapter, v.id))) {
      kept(v.id, `none of the ${gone.length} file(s) sent in, nor of its documents, is there`);
      continue;
    }
    for (const f of gone) {
      if (f.state === 'uploading' || f.state === 'received') {
        dropped +=
          (await admin.query('delete from incoming_file where id = $1', [f.id])).rowCount ?? 0;
      } else {
        await admin.query('update incoming_file set object_removed_at = now() where id = $1', [
          f.id,
        ]);
      }
    }
  }
  if (dropped)
    log('info', 'files sent in whose bytes are gone since the backup, dropped', { dropped });
  return dropped;
}

const isFolder = (dir: string) =>
  stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );

/** Whether an object is there: yes, no, or null for could not tell. */
const isThere = (adapter: StorageAdapter, key: string) =>
  adapter.stat(key).then(
    () => true as const,
    (err: unknown) => (err instanceof StorageError && err.code === 'not_found' ? false : null),
  );

/** Whether a place holds any of the files of its documents' versions: a few, looked for. */
async function holdsVersions(
  admin: ReturnType<typeof createPool>,
  adapter: StorageAdapter,
  vaultId: string,
): Promise<boolean> {
  const { rows } = await admin.query<{ storage_key: string }>(
    `select storage_key from document_version
      where vault_id = $1 and file_removed_at is null order by uploaded_at desc limit 20`,
    [vaultId],
  );
  for (const r of rows) if ((await isThere(adapter, r.storage_key)) === true) return true;
  return false;
}

/** What the family decides about, not the restore: counted for the report. */
async function stillOpen(admin: ReturnType<typeof createPool>): Promise<StillOpen> {
  const { rows } = await admin.query<{ invitations: number }>(
    `select (select count(*)::int from invitation
              where accepted_at is null and revoked_at is null and expires_at > now()) as invitations`,
  );
  return { openInvitations: rows[0]?.invitations ?? 0 };
}

/**
 * The newest backup in a folder, by name: the names are timestamps, and a
 * copied file's modification time may not be.
 */
export async function newestBackup(dir: string): Promise<string | null> {
  const last = (await backupNames(dir)).at(-1);
  return last ? path.join(dir, last) : null;
}

/** The backup made before this one, in the same folder, if there is one. */
export async function backupBefore(file: string, dir: string): Promise<string | null> {
  const earlier = (await backupNames(dir)).filter((f) => f < path.basename(file)).at(-1);
  return earlier ? path.join(dir, earlier) : null;
}

/** Oldest first. A backup still being written (".partial") is not one yet. */
async function backupNames(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => /^fdv-.*\.sql\.enc$/.test(f))
    .sort();
}

const DRILL_PREFIX = 'fdv_restore_drill_';

/**
 * Restores a backup into a scratch database on the same server, checks it
 * as the application role, and drops it again — also if the drill fails or
 * is interrupted, because the scratch copy holds the whole household.
 */
export async function restoreDrill(opts: {
  file: string;
  backupKey: Buffer;
  keys: ScopeKeys;
  adminUrl: string;
  appUrl: string;
  log: Log;
  master?: RestoreTarget['master'];
}): Promise<RestoreReport> {
  const name = `${DRILL_PREFIX}${Math.floor(Date.now() / 1000)}_${randomUUID().slice(0, 8)}`;
  const root = createPool(withDatabase(opts.adminUrl, 'postgres'), 1);
  const drop = () => root.query(`drop database if exists ${name} with (force)`);
  const onSignal = (signal: NodeJS.Signals) => {
    void drop()
      .catch(() => undefined)
      .finally(() => process.kill(process.pid, signal));
  };
  try {
    await dropStaleDrills(root, opts.log);
    await root.query(`create database ${name}`);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    return await restoreBackup(
      opts.file,
      opts.backupKey,
      {
        adminUrl: withDatabase(opts.adminUrl, name),
        appUrl: withDatabase(opts.appUrl, name),
        master: opts.master,
      },
      opts.log,
      opts.keys,
    );
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await drop().catch((err: unknown) =>
      opts.log('error', 'could not drop the drill database; drop it by hand', {
        database: name,
        err: String(err),
      }),
    );
    await root.end();
  }
}

/** A drill that was killed outright leaves its copy behind; the next one removes it. */
async function dropStaleDrills(root: ReturnType<typeof createPool>, log: Log): Promise<void> {
  const { rows } = await root.query<{ datname: string }>(
    `select datname from pg_database where datname like $1`,
    [`${DRILL_PREFIX}%`],
  );
  const hourAgo = Date.now() / 1000 - 3600;
  for (const { datname } of rows) {
    const started = Number(datname.slice(DRILL_PREFIX.length).split('_')[0]);
    if (!/^[a-z0-9_]+$/.test(datname) || !(started < hourAgo)) continue;
    await root.query(`drop database if exists ${datname} with (force)`);
    log('info', 'removed a copy left behind by an earlier drill', { database: datname });
  }
}

/** Nothing in it yet: no tables, no schemas of ours. */
async function assertEmpty(adminUrl: string): Promise<void> {
  const pool = createPool(adminUrl, 1);
  try {
    const { rows } = await pool.query<{ relations: number; schemas: number }>(`
      select
        (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%') as relations,
        (select count(*)::int from pg_namespace
          where nspname not in ('public', 'pg_catalog', 'information_schema')
            and nspname not like 'pg\\_toast%' and nspname not like 'pg\\_temp%') as schemas`);
    const r = rows[0];
    if (r && (r.relations > 0 || r.schemas > 0)) {
      throw new RestoreRefused(
        'The database is not empty, so nothing was restored into it. A backup goes into an ' +
          'empty database only — see "Restoring" in the README for how to get one without ' +
          'touching your files.',
      );
    }
  } finally {
    await pool.end();
  }
}

/**
 * Decrypts the file into psql, in one transaction that is committed only
 * when the whole file has been read and authenticated, and only if the
 * backup is not from a newer release than this one.
 */
async function load(file: string, key: Buffer, adminUrl: string, known: number): Promise<Undone> {
  // The connection goes in the environment, not on a command line other
  // processes can read.
  const conn = libpqConnection(adminUrl);
  const psql = spawn('psql', ['--no-psqlrc', '--quiet', '--set', 'ON_ERROR_STOP=1', ...conn.args], {
    env: { ...process.env, ...conn.env, PGAPPNAME: 'fdv-restore' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  psql.stdout.on('data', (c: Buffer) => {
    stdout = (stdout + c.toString()).slice(-16000);
  });
  psql.stderr.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve) => {
    psql.on('close', (code) => resolve(code));
    psql.on('error', () => resolve(null));
  });
  try {
    await once(psql, 'spawn');
  } catch (err) {
    throw new Error(`psql could not be started: ${(err as Error).message}`, { cause: err });
  }
  // Whatever goes wrong writing to psql shows in the pipeline or in its exit.
  psql.stdin.on('error', () => undefined);

  psql.stdin.write('begin;\n');
  try {
    await pipeline(createReadStream(file), new DecryptStream(key), psql.stdin, { end: false });
  } catch (err) {
    // The file did not decrypt to the end, or psql stopped on an error.
    // Nothing has been committed: stop psql before it could see the end of
    // its input, and the open transaction dies with the connection.
    psql.kill('SIGKILL');
    await exited;
    throw new Error(
      stderr.trim()
        ? `the backup could not be loaded: ${stderr.trim()}`
        : `the backup could not be read: ${(err as Error).message}`,
      { cause: err },
    );
  }
  psql.stdin.end(`\n${versionGuard(known)}\n${UNDO}\ncommit;\n`);
  const code = await exited;
  if (code !== 0) {
    throw new Error(`the backup could not be loaded (psql exited ${code}): ${stderr.trim()}`);
  }
  const counted = (what: string) =>
    Number(new RegExp(`fdv-restore:${what}=(\\d+)`).exec(stdout)?.[1] ?? 0);
  return {
    sessionsEnded: counted('sessions'),
    ownerChangesWithdrawn: counted('owner_changes'),
    linksPaused: counted('links_paused'),
    requestsPaused: counted('requests_paused'),
    photosUnfinished: counted('photos_unfinished'),
    purgeRequestsCleared: counted('purge_requests'),
    noticesWithdrawn: counted('notices_withdrawn'),
    exportsExpired: counted('exports_expired'),
    identityAudiences: [...stdout.matchAll(/fdv-restore-audience:([0-9a-f-]{36})=([a-z_]+)/g)].map(
      (m) => ({ household_id: m[1] as string, was: m[2] as string }),
    ),
  };
}

/**
 * What a backup brings back that had been ended since it was made, ended
 * again — in the load's own transaction, so that no restored database
 * exists without it. Everybody signs in again (a session revoked since, for
 * a lost phone, would otherwise work); reset links are expired; a request
 * to change who is an owner is withdrawn, to be asked again with fresh
 * notice (one refused since would otherwise be open, and past its seven
 * days); browsers registered for notifications before 0.4.2, which no
 * session ties to, are forgotten; every live share link is paused for an
 * owner to turn back on, since one taken back since would work again, and
 * no session opened with a link survives (5.16), nor a code emailed for one
 * (5.20); and a person's photo that
 * was on its way, whose job the restore did not bring back, is marked
 * failed for the nightly prune to take away with its upload (5.17c). Ready
 * photos come back as they were that night. Every live request to send
 * documents is paused for an owner to turn back on, since one taken back
 * or closed since would open again, and no sender's session or emailed
 * code survives (5.21). And an owner's request to remove a document for
 * good is ended (5.24): a filer's Bring it back made since would otherwise
 * be undone with its 24 hours perhaps already past; an owner asks again,
 * and the filer is told again. Every notice still waiting is withdrawn
 * (5.26): a wider audience for identity details withdrawn since would
 * otherwise come back; and every household's audience for them goes back to
 * the narrowest, the owners and each person, what it was in effect said in
 * the report. Widening it again goes through the notice. And every export
 * still to be downloaded is expired (5.27), as every session is ended: each
 * holds what its requester could see when it was made, identity details
 * included, which the narrowing above may take from them, and one a
 * narrowing since the backup had ended would be served again. Guarded for
 * older schemas.
 */
const UNDO = `create temporary table fdv_restore_undone (what text, n int) on commit drop;
create temporary table fdv_restore_audience (household_id uuid, was text) on commit drop;
do $undo$
declare n int;
begin
  update public.session set revoked_at = now(), revoked_reason = 'restored from a backup'
   where revoked_at is null;
  get diagnostics n = row_count;
  insert into pg_temp.fdv_restore_undone values ('sessions', n);
  if to_regclass('public.password_reset') is not null then
    update public.password_reset set expires_at = now() where used_at is null and expires_at > now();
  end if;
  if to_regclass('public.owner_change_request') is not null then
    -- Only one still running: a lapsed one is over already, and on any
    -- schema (lapsed_at is 0022's) its lapses_at has passed. Nobody
    -- refused it, so it is not written down as a refusal: withdrawn by the
    -- restore (0023), or, on a backup older than that, ended the way a
    -- lapse ends — "no longer counts", which is true.
    if exists (select 1 from pg_attribute where attrelid = 'public.owner_change_request'::regclass
                and attname = 'withdrawn_at' and not attisdropped) then
      update public.owner_change_request set withdrawn_at = now(), withdrawn_why = 'restored'
       where refused_at is null and completed_at is null and withdrawn_at is null
         and lapses_at > now();
    elsif exists (select 1 from pg_attribute where attrelid = 'public.owner_change_request'::regclass
                   and attname = 'lapsed_at' and not attisdropped) then
      update public.owner_change_request set lapses_at = now(), lapsed_at = now()
       where refused_at is null and completed_at is null and lapses_at > now();
    else
      update public.owner_change_request set lapses_at = now()
       where refused_at is null and completed_at is null and lapses_at > now();
    end if;
    get diagnostics n = row_count;
    insert into pg_temp.fdv_restore_undone values ('owner_changes', n);
  end if;
  if exists (select 1 from pg_attribute where attrelid = to_regclass('public.device')
              and attname = 'session_id' and not attisdropped) then
    delete from public.device where session_id is null;
  end if;
  if exists (select 1 from pg_attribute where attrelid = to_regclass('public.share_link')
              and attname = 'paused_at' and not attisdropped) then
    ${PAUSE_LINKS};
    get diagnostics n = row_count;
    insert into pg_temp.fdv_restore_undone values ('links_paused', n);
  end if;
  if to_regclass('public.share_session') is not null then
    delete from public.share_session;
  end if;
  -- A link's emailed codes (5.20): one sent since the backup is not in it,
  -- and one in it may have been used since; every link that asks for one
  -- is paused above anyway. None survives.
  if to_regclass('public.share_code') is not null then
    delete from public.share_code;
  end if;
  if to_regclass('public.upload_request') is not null then
    update public.upload_request set paused_at = now(), paused_reason = 'restored'
     where paused_at is null and revoked_at is null and closed_at is null
       and expires_at > now() and attempts < 10;
    get diagnostics n = row_count;
    insert into pg_temp.fdv_restore_undone values ('requests_paused', n);
    delete from public.upload_session;
    delete from public.upload_code;
  end if;
  if to_regclass('public.member_photo') is not null then
    update public.member_photo set state = 'failed' where state = 'processing';
    get diagnostics n = row_count;
    insert into pg_temp.fdv_restore_undone values ('photos_unfinished', n);
  end if;
  if exists (select 1 from pg_attribute where attrelid = to_regclass('public.document')
              and attname = 'purge_requested_at' and not attisdropped) then
    update public.document set purge_requested_at = null, purge_requested_by = null
     where purge_requested_at is not null;
    get diagnostics n = row_count;
    insert into pg_temp.fdv_restore_undone values ('purge_requests', n);
  end if;
  if to_regclass('public.notice_request') is not null then
    -- What each household's audience was in effect: a widening whose notice
    -- had run out counts, as identity_audience_now() counts it.
    insert into pg_temp.fdv_restore_audience
      select h.id, coalesce((select r.subject from public.notice_request r
                              where r.household_id = h.id and r.kind = 'identity_audience'
                                and r.completed_at is null and r.withdrawn_at is null
                                and r.notice_until <= now()),
                            h.identity_audience)
        from public.household h;
    update public.notice_request set withdrawn_at = now()
     where completed_at is null and withdrawn_at is null;
    get diagnostics n = row_count;
    insert into pg_temp.fdv_restore_undone values ('notices_withdrawn', n);
    update public.household set identity_audience = 'owners_and_self'
     where identity_audience <> 'owners_and_self';
  end if;
  if to_regclass('public.export') is not null then
    update public.export set expires_at = now()
     where state = 'done' and (expires_at is null or expires_at > now());
    get diagnostics n = row_count;
    insert into pg_temp.fdv_restore_undone values ('exports_expired', n);
  end if;
end $undo$;
select 'fdv-restore:' || what || '=' || n from pg_temp.fdv_restore_undone;
select 'fdv-restore-audience:' || household_id || '=' || was from pg_temp.fdv_restore_audience
 where was <> 'owners_and_self' order by household_id;`;

/** Refuses, inside the load's transaction, a backup this release cannot run. */
function versionGuard(known: number): string {
  return `do $guard$
declare made int;
begin
  if to_regclass('public.schema_migration') is null then
    raise exception 'this file is not a backup of a Family Document Vault database';
  end if;
  select max(version) into made from public.schema_migration;
  if made > ${known} then
    raise exception 'this backup was made by a newer release of the vault (database schema %), and this one only knows schema %: restore it with that release or a later one', made, ${known};
  end if;
end $guard$;`;
}

/** The triggers the vault relies on: each by name, table and function. */
const GUARDS = [
  { name: 'audit_event_no_update', table: 'audit_event', fn: 'audit_event_immutable' },
  { name: 'owner_floor', table: 'account_household', fn: 'assert_owner_remains' },
  { name: 'share_link_link_writes', table: 'share_link', fn: 'share_link_link_writes' },
  { name: 'document_type_fixed', table: 'document_type', fn: 'document_type_fixed' },
  // An owner marks deleted a collection nobody can change any more, and nothing else
  // (0036; named so by 0039).
  {
    name: 'doc_collection_owner_writes',
    table: 'doc_collection',
    fn: 'doc_collection_owner_writes',
  },
  // A link keeps the flow it was made with: a new one never opens on an old route (0037).
  { name: 'share_link_flow_fixed', table: 'share_link', fn: 'share_link_flow_fixed' },
  // Only an owner asks, as themselves and now, to remove a document for good (0045).
  {
    name: 'document_purge_request_owner',
    table: 'document',
    fn: 'document_purge_request_owner',
  },
  // And what it was made for: a document, or a collection as ticked, and
  // whether it keeps up with the collection (0042).
  { name: 'share_link_target_fixed', table: 'share_link', fn: 'share_link_target_fixed' },
  // And a link's lines in the activity log: on its head, one at a time,
  // hashed as every line is (0042, the 5.19 review).
  { name: 'audit_event_link_line', table: 'audit_event', fn: 'audit_event_link_line' },
  // And what protects it: its secret and "this device only" fixed, a device
  // bound once, its code's address cleared only once it has ended (0043).
  { name: 'share_link_factors_fixed', table: 'share_link', fn: 'share_link_factors_fixed' },
  // A code sent keeps what it was: its tries only go up, it is used once (0043).
  { name: 'share_code_writes', table: 'share_code', fn: 'share_code_writes' },
  // An upload link counts its visits, tries and files on its own request,
  // and finishes and sends its own files, and changes nothing else (0044).
  {
    name: 'upload_request_upload_writes',
    table: 'upload_request',
    fn: 'upload_request_upload_writes',
  },
  {
    name: 'incoming_file_upload_writes',
    table: 'incoming_file',
    fn: 'incoming_file_upload_writes',
  },
  // An upload link's lines in the activity log: on its head, hashed as
  // every line is (0044, A74).
  { name: 'audit_event_upload_line', table: 'audit_event', fn: 'audit_event_upload_line' },
  // A request's address is cleared by whatever ends it (0044).
  {
    name: 'upload_request_ended_forgets',
    table: 'upload_request',
    fn: 'upload_request_forgets_address',
  },
  // A person's version moves on with every change to their details, and an
  // owner alone says somebody has passed away (0046).
  { name: 'member_versioned', table: 'member', fn: 'member_versioned' },
  // And nobody recorded as passed away is given a sign-in (0046).
  {
    name: 'account_household_not_deceased',
    table: 'account_household',
    fn: 'account_household_not_deceased',
  },
  // A reviewer files or refuses a waiting file, as themselves, once, and
  // changes nothing else of it: whose key, who reviews it, its bytes (0047).
  {
    name: 'incoming_file_account_writes',
    table: 'incoming_file',
    fn: 'incoming_file_account_writes',
  },
  // A decided file's row going before its bytes leaves them to be removed
  // with the rest of a removal's leftovers (0047, with 0045).
  {
    name: 'incoming_file_leaves_bytes',
    table: 'incoming_file',
    fn: 'incoming_file_leaves_bytes',
  },
  // A notice says what it said, asked now, and ends once (0050).
  { name: 'notice_request_fixed', table: 'notice_request', fn: 'notice_request_fixed' },
  // Nobody widens who sees identity details before its notice runs out (0050).
  {
    name: 'household_identity_audience_guard',
    table: 'household',
    fn: 'household_identity_audience_guard',
  },
  // An identity part's version, and the key of its part: an Only me part
  // under its person's own key (0050).
  {
    name: 'member_identity_versioned',
    table: 'member_identity',
    fn: 'member_identity_versioned',
  },
];

/**
 * What was moved to the owners from a requester who can no longer review
 * it (0047): a request and its files, each kept from every other caller
 * signed in by a rule of its own that names the column saying so.
 */
const OWNERS_ONLY = [
  {
    table: 'upload_request',
    column: 'moved_to_owners_at',
    where: 'moved_to_owners_at is not null',
  },
  { table: 'incoming_file', column: 'owners_only', where: 'owners_only' },
];

/**
 * Callers who are given nothing in the tables below, and how the check
 * names them: nobody said, a signed-out page, an upload link, and a share
 * link that is not one of the household's.
 */
const GIVEN_NOTHING: [actor: string, who: string][] = [
  ['', 'a caller who says nothing'],
  ['anonymous', 'a signed-out page'],
  ['upload', 'an upload link'],
  ['link', 'a share link it never made'],
];

/** The tables 0030 and 0031 give a rule for each kind of caller. */
const ACTOR_GUARDED = [
  'document',
  'document_version',
  'document_text',
  'document_text_sealed',
  'reminder',
  'reminder_delivery',
  'share_link',
  'document_link',
  'offline_fill',
  'private_notice',
  'upload_idempotency',
  'export',
  // A household's own types, its changes to the built-ins, and its own
  // fields (0031).
  'document_type',
  'document_type_setting',
  'document_attribute',
  // Collections of documents, and what is in them (0036).
  'doc_collection',
  'doc_collection_item',
  // What a share link's Open gives a browser (0037).
  'share_session',
  // People's photos: the family's, and a viewer's own (0040).
  'member_photo',
  // What a session has had of each document, and a view-only link's own
  // pages (0041).
  'share_session_use',
  'share_page',
  // What a collection's link was made with: the documents ticked; and a
  // view-only link's pages that could not be drawn, a version at a time (0042).
  'share_link_item',
  'share_page_failure',
  // A link's emailed codes: its own, and the vault's; nobody else's (0043).
  'share_code',
  // Requests to send documents, what they ask for, their senders' sessions
  // and codes, and the files that came in (0044).
  'upload_request',
  'upload_request_item',
  'upload_session',
  'upload_code',
  'incoming_file',
  // What a document removed for good leaves behind: who could see it, and
  // the files still to be deleted (0045).
  'document_tombstone',
  'purge_leftover',
  // People's identity details, and the notices that come before a wider
  // audience for them (0050).
  'member_identity',
  'notice_request',
];

/**
 * The household's other tables, and the sign-ins that belong to no
 * household, each with a rule that takes rows away from a share link (0042,
 * from the 5.6 review): a link reads its household, its sharer and what
 * opens its files, and nothing here but that. Other callers keep what
 * they had, so the check asks only that a link the household never made is
 * given none of them.
 */
const LINK_NARROWED = [
  'account_household',
  'member',
  'scope_key',
  'vault',
  'audit_event',
  'session',
  'household_profile',
  'invitation',
  'owner_change_request',
  'known_device',
  'notification_digest',
  'device',
  'smtp_settings',
  'notification_preference',
  'suggestion_dismissal',
  'client_event_receipt',
  'account',
  'credential',
  'password_reset',
  'webauthn_challenge',
  // People's identity details and the notices (0050): no link, of either
  // kind, is given a row of them.
  'member_identity',
  'notice_request',
];

/**
 * The same tables, each with a rule of its own that takes rows away from an
 * upload link (0044, A74): it reads its household, its requester's member
 * row, its one key and its vaults, and nothing here but that. A rule that
 * names the upload link must be there, beside the share link's; and an
 * upload link that asks for no request is given none of them.
 */
const UPLOAD_NARROWED = LINK_NARROWED;

/**
 * The tables where a member's own is theirs alone, by a rule that asks who
 * the member is: an Only me collection is its maker's (0036); a photo is
 * the family's and, to anybody else, only their own (0040); a request to
 * send documents that its requester reviews, and its files, are theirs
 * (0044). Each must have
 * such a rule, and somebody signed in as no member, with no role of the
 * family's, is given none.
 */
const MAKER_ONLY = [
  { table: 'doc_collection', where: "audience = 'only_me'", what: 'an Only me collection' },
  { table: 'member_photo', where: 'true', what: "a person's photo" },
  // A request its requester alone reviews, and what came in through it (0044).
  {
    table: 'upload_request',
    where: "review_by = 'me'",
    what: 'a request for one person to review',
  },
  {
    table: 'incoming_file',
    where: "review_by = 'me'",
    what: 'a file sent for one person to review',
  },
  // A person's Only me identity details: theirs alone, whoever else asks (0050, A33).
  {
    table: 'member_identity',
    where: "part = 'only_me'",
    what: "a person's Only me identity details",
  },
];

/**
 * The tables whose rows only some of the family may change, by a rule that
 * asks the caller's role: a person's details are changed by an owner, an
 * adult (their own, and those of anybody with no sign-in) or a teen (their
 * own), and by nobody else (A66, 0046).
 */
const CHANGED_BY_ROLE = [
  { table: 'member', what: "a person's details" },
  // The person both parts of their own; an owner anybody's shared part (0050).
  { table: 'member_identity', what: "a person's identity details" },
];

/**
 * Rules the vault relies on by name: each on its own table, for its own
 * command, restrictive. Asking for "a rule that names the role" let these
 * go unnoticed (the 5.26 review): member_identity's rule for each kind of
 * caller names the role too, so with the writers' rules gone a teen wrote
 * other people's details. Each is also tried below, where trying is cheap.
 */
const REQUIRED_RULES = [
  // A person's Only me identity details are theirs alone, whoever asks (0050, A33).
  {
    table: 'member_identity',
    name: 'member_identity_only_me',
    cmd: '*',
    what: "a person's Only me identity details are theirs alone",
  },
  // Who writes which part: the person, both of their own; an owner, the shared part (0050).
  {
    table: 'member_identity',
    name: 'member_identity_writer_insert',
    cmd: 'a',
    what: 'who writes identity details',
  },
  {
    table: 'member_identity',
    name: 'member_identity_writer_update',
    cmd: 'w',
    what: 'who changes identity details',
  },
  // An owner asks for a notice, in their own name, and an owner ends it (0050).
  {
    table: 'notice_request',
    name: 'notice_request_actor_insert',
    cmd: 'a',
    what: 'who asks for a notice',
  },
  {
    table: 'notice_request',
    name: 'notice_request_actor_update',
    cmd: 'w',
    what: 'who ends a notice',
  },
];

/** The rows of a guarded table that are a household's: the built-ins are everybody's. */
const HOUSEHOLD_ROWS: Record<string, string> = {
  document_type: 'household_id is not null',
  document_attribute: 'household_id is not null',
};

/**
 * The rules of 0050 that say who writes, tried as the vault's callers would
 * be, each in a transaction rolled back (the 5.26 review):
 *
 *  - a viewer changes no identity details, not even their own;
 *  - a teen, with the whole family the audience, changes nobody else's;
 *  - nobody but the person writes a part of their own;
 *  - nobody signed in but an owner asks for a notice.
 *
 * Where the household has nothing to try one on — no identity details yet
 * — there is nothing that rule could let through, and it is not tried. The
 * teen's is tried as the application role with the audience widened in the
 * same transaction, which the owning role must be able to SET ROLE to; a
 * database where it cannot (not the vault's own compose) skips that one.
 */
async function probeIdentityWriters(
  admin: ReturnType<typeof createPool>,
  app: ReturnType<typeof createPool>,
  appUrl: string,
  household: string,
): Promise<void> {
  const exists = await admin.query<{ ok: boolean }>(
    "select to_regclass('public.member_identity') is not null as ok",
  );
  if (!exists.rows[0]?.ok) return;
  const settings = `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                           set_config('app.role', $2, true), set_config('app.member_id', $3, true)`;
  /** One statement as somebody signed in: what it changed, or the error's code. */
  const asCaller = async (
    role: string,
    member: string,
    text: string,
    args: unknown[] = [],
  ): Promise<number | string> => {
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query(settings, [household, role, member]);
      return (await client.query(text, args)).rowCount ?? 0;
    } catch (err) {
      return (err as { code?: string }).code ?? 'error';
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  };
  const fail = (what: string) => {
    throw new Error(`household ${household}: ${what}`);
  };

  // A person with identity details of their own, and their member key.
  const { rows: people } = await admin.query<{ member_id: string; key: string | null }>(
    `select i.member_id,
            (select k.id::text from scope_key k
              where k.household_id = i.household_id and k.kind = 'member'
                and k.member_id = i.member_id) as key
       from member_identity i where i.household_id = $1 order by i.member_id limit 1`,
    [household],
  );
  const person = people[0];
  if (person) {
    // A viewer, of their own: read, never written.
    const viewer = await asCaller(
      'viewer',
      person.member_id,
      'update member_identity set filled = filled where member_id = app_member()',
    );
    if (viewer !== 0) fail('a viewer may change their own identity details');
    // Nor added to, as the person's own Only me part (its key is theirs).
    if (person.key) {
      const added = await asCaller(
        'viewer',
        person.member_id,
        `insert into member_identity (household_id, member_id, part, sealed, dek_wrapped, wrapped_by_scope)
         values ($1, app_member(), 'only_me', $2, $3, $4)`,
        [household, Buffer.alloc(28), Buffer.alloc(60), person.key],
      );
      if (added !== '42501') fail('a viewer may write identity details');
    }
  }

  // An adult asks for no notice; only an owner does. An insert the rule
  // refuses is refused before anything else could be (42501).
  const asked = await asCaller(
    'adult',
    '00000000-0000-4000-8000-000000000000',
    `insert into notice_request (household_id, kind, subject, notice_until)
     values ($1, 'identity_audience', 'family', now() + interval '72 hours')`,
    [household],
  );
  if (asked !== '42501') fail('somebody signed in who is no owner may ask for a notice');

  // A teen, the whole family the audience, changes nobody else's details.
  const shared = await admin.query<{ n: number }>(
    "select count(*)::int as n from member_identity where household_id = $1 and part = 'shared'",
    [household],
  );
  if ((shared.rows[0]?.n ?? 0) === 0) return;
  const role = decodeURIComponent(new URL(appUrl).username);
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query("update household set identity_audience = 'family' where id = $1", [
      household,
    ]);
    try {
      await client.query(`set local role "${role.replace(/"/g, '""')}"`);
    } catch {
      return; // the owning role may not be the application role here
    }
    await client.query(settings, [household, 'teen', '00000000-0000-4000-8000-000000000000']);
    const changed = await client.query(
      "update member_identity set filled = filled where part = 'shared'",
    );
    if ((changed.rowCount ?? 0) !== 0) fail("a teen may change somebody else's identity details");
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

/**
 * The restored vault, seen the way the vault will see it: as the
 * application role, one household at a time.
 */
export async function checkRestored(
  target: RestoreTarget,
): Promise<
  Omit<
    RestoreReport,
    keyof Undone | keyof StillOpen | keyof RemovedFiles | 'rekeyed' | 'incomingDropped'
  >
> {
  const admin = createPool(target.adminUrl, 1);
  const app = createPool(target.appUrl, 1);
  try {
    const { rows: counts } = await admin.query<{ id: string; members: number; documents: number }>(
      `select h.id,
              (select count(*)::int from member m where m.household_id = h.id) as members,
              (select count(*)::int from document d where d.household_id = h.id) as documents
         from household h`,
    );
    const { rows: totals } = await admin.query<{
      schema: number;
      versions: number;
      unprotected: string[];
      definer_views: string[];
    }>(
      `select (select max(version)::int from schema_migration) as schema,
              (select count(*)::int from document_version) as versions,
              array(select c.oid::regclass::text from pg_class c
                     where exists (select 1 from pg_policy p where p.polrelid = c.oid)
                       and not c.relrowsecurity) as unprotected,
              array(select c.oid::regclass::text from pg_class c
                      join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'public' and c.relkind = 'v'
                       and not coalesce((select o.option_value in ('true', 'on', '1')
                                           from pg_options_to_table(c.reloptions) o
                                          where o.option_name = 'security_invoker'), false))
                as definer_views`,
    );
    const t = totals[0];
    if (!t) throw new Error('the restored database has no schema_migration');
    if (t.unprotected.length) {
      throw new Error(`row-level security is off on ${t.unprotected.join(', ')}`);
    }
    // A view reads with its owner's rights unless it says otherwise, and
    // the owner is past every household's wall (0031's types).
    if (t.definer_views.length) {
      throw new Error(
        `${t.definer_views.join(', ')} would read with its owner's rights, past the households' walls`,
      );
    }
    // The database's own guards: the audit log refuses changes, a
    // household always keeps an owner, and a link only counts on its share.
    // Each on its own table, calling its own function, and firing for the
    // vault's sessions ('O' or 'A': not only on a replica, not disabled).
    const { rows: guards } = await admin.query<{ tgname: string }>(
      `select t.tgname
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_proc f on f.oid = t.tgfoid
         join unnest($1::text[], $2::text[], $3::text[]) as g(name, tbl, fn)
           on g.name = t.tgname and g.tbl = c.relname and g.fn = f.proname
        where not t.tgisinternal and t.tgenabled in ('O', 'A')`,
      [GUARDS.map((g) => g.name), GUARDS.map((g) => g.table), GUARDS.map((g) => g.fn)],
    );
    if (guards.length !== GUARDS.length) {
      throw new Error(
        `a guard the vault relies on is missing (found: ${guards.map((g) => g.tgname).join(', ') || 'none'})`,
      );
    }
    // And the second wall (0030): a rule for each kind of caller on the
    // document, all that hangs off it, and exports — one that governs what
    // is read, and asks who is asking. (What each rule then gives is tried
    // below, household by household.)
    const { rows: unguarded } = await admin.query<{ name: string }>(
      `select t as name from unnest($1::text[]) as t
        where not exists (select 1 from pg_policy p
                           where p.polrelid = to_regclass('public.' || t)
                             and not p.polpermissive
                             and p.polcmd in ('*', 'r')
                             and pg_get_expr(p.polqual, p.polrelid) like '%app_actor()%')`,
      [ACTOR_GUARDED],
    );
    if (unguarded.length) {
      throw new Error(
        `no rule for each kind of caller on ${unguarded.map((u) => u.name).join(', ')}`,
      );
    }
    // And the rule that keeps a share link to what its page needs (0042),
    // on the household's other tables and the sign-ins: one that governs
    // what is read, and asks who is asking.
    // (It must name the share link: since 0044 the same tables carry an
    // upload link's rule too, which asks who is asking as well.)
    const { rows: unnarrowed } = await admin.query<{ name: string }>(
      `select t as name from unnest($1::text[]) as t
        where not exists (select 1 from pg_policy p
                           where p.polrelid = to_regclass('public.' || t)
                             and p.polcmd in ('*', 'r')
                             and pg_get_expr(p.polqual, p.polrelid) like '%app_actor()%'
                             and pg_get_expr(p.polqual, p.polrelid) like '%''link''%')`,
      [LINK_NARROWED],
    );
    if (unnarrowed.length) {
      throw new Error(
        `no rule keeps a share link out of ${unnarrowed.map((u) => u.name).join(', ')}`,
      );
    }
    // And the rule that keeps an upload link to what its page needs (0044,
    // A74): its own, beside the share link's, naming it.
    const { rows: unnarrowedUploads } = await admin.query<{ name: string }>(
      `select t as name from unnest($1::text[]) as t
        where not exists (select 1 from pg_policy p
                           where p.polrelid = to_regclass('public.' || t)
                             and not p.polpermissive
                             and p.polcmd in ('*', 'r')
                             and pg_get_expr(p.polqual, p.polrelid) like '%app_actor()%'
                             and pg_get_expr(p.polqual, p.polrelid) like '%''upload''%')`,
      [UPLOAD_NARROWED],
    );
    if (unnarrowedUploads.length) {
      throw new Error(
        `no rule keeps an upload link out of ${unnarrowedUploads.map((u) => u.name).join(', ')}`,
      );
    }
    // And the rule that keeps a member's own theirs (0036): one that
    // governs what is read, and asks which member is asking.
    const { rows: unkept } = await admin.query<{ name: string }>(
      `select t as name from unnest($1::text[]) as t
        where not exists (select 1 from pg_policy p
                           where p.polrelid = to_regclass('public.' || t)
                             and not p.polpermissive
                             and p.polcmd in ('*', 'r')
                             and pg_get_expr(p.polqual, p.polrelid) like '%app_member()%')`,
      [MAKER_ONLY.map((m) => m.table)],
    );
    if (unkept.length) {
      throw new Error(
        `no rule keeps a member's own to them on ${unkept.map((u) => u.name).join(', ')}`,
      );
    }
    // And who may change a person (0046): a rule that governs what is
    // changed, and asks the caller's role.
    const { rows: unruled } = await admin.query<{ name: string }>(
      `select t as name from unnest($1::text[]) as t
        where not exists (select 1 from pg_policy p
                           where p.polrelid = to_regclass('public.' || t)
                             and not p.polpermissive
                             and p.polcmd in ('*', 'w')
                             and pg_get_expr(p.polqual, p.polrelid) like '%app_role()%')`,
      [CHANGED_BY_ROLE.map((c) => c.table)],
    );
    if (unruled.length) {
      const what = CHANGED_BY_ROLE.filter((c) => unruled.some((u) => u.name === c.table));
      throw new Error(`no rule says who may change ${what.map((c) => c.what).join(', ')}`);
    }
    // And the rule that keeps what was moved to the owners theirs (0047):
    // one that governs what is read, asks who is asking, and names the
    // column that says so.
    const { rows: unowned } = await admin.query<{ name: string }>(
      `select t as name from unnest($1::text[], $2::text[]) as o(t, col)
        where not exists (select 1 from pg_policy p
                           where p.polrelid = to_regclass('public.' || o.t)
                             and not p.polpermissive
                             and p.polcmd in ('*', 'r')
                             and pg_get_expr(p.polqual, p.polrelid) like '%app_actor()%'
                             and pg_get_expr(p.polqual, p.polrelid) like '%' || o.col || '%')`,
      [OWNERS_ONLY.map((o) => o.table), OWNERS_ONLY.map((o) => o.column)],
    );
    if (unowned.length) {
      throw new Error(
        `no rule keeps what was moved to the owners theirs on ${unowned.map((u) => u.name).join(', ')}`,
      );
    }
    // And the rules the vault relies on by name (0050, the 5.26 review).
    const { rows: unnamed } = await admin.query<{ name: string }>(
      `select r.name from unnest($1::text[], $2::text[], $3::text[]) as r(tbl, name, cmd)
        where not exists (select 1 from pg_policy p
                           where p.polrelid = to_regclass('public.' || r.tbl)
                             and p.polname = r.name
                             and p.polcmd = r.cmd::"char"
                             and not p.polpermissive)`,
      [
        REQUIRED_RULES.map((r) => r.table),
        REQUIRED_RULES.map((r) => r.name),
        REQUIRED_RULES.map((r) => r.cmd),
      ],
    );
    if (unnamed.length) {
      const what = REQUIRED_RULES.filter((r) => unnamed.some((u) => u.name === r.name));
      throw new Error(
        `no rule says ${what.map((r) => `${r.what} (${r.name} on ${r.table})`).join(', ')}`,
      );
    }

    const { rows: rights } = await app.query<{
      unreadable: string[];
      owned: string[];
      privileged: boolean;
      queue: boolean;
      audit_mutable: boolean;
      tombstones_mutable: boolean;
      tenant_tables: string[];
    }>(
      `with ours as (
         select c.oid, c.relowner from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname in ('public', 'pgboss') and c.relkind in ('r', 'p'))
       select array(select oid::regclass::text from ours
                     where not has_table_privilege(oid, 'select')) as unreadable,
              array(select oid::regclass::text from ours
                     where pg_has_role(current_user, relowner, 'USAGE')) as owned,
              (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as privileged,
              has_schema_privilege('pgboss', 'usage') as queue,
              has_table_privilege('public.audit_event', 'update')
                or has_table_privilege('public.audit_event', 'delete') as audit_mutable,
              -- What a document removed for good leaves behind (0045).
              has_table_privilege('public.document_tombstone', 'update')
                or has_table_privilege('public.document_tombstone', 'delete')
                as tombstones_mutable,
              array(select c.oid::regclass::text from pg_class c
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind in ('r', 'p')
                      and exists (select 1 from pg_attribute a where a.attrelid = c.oid
                                   and a.attname = 'household_id' and not a.attisdropped)) as tenant_tables`,
    );
    const r = rights[0];
    if (!r || r.unreadable.length) {
      throw new Error(`the application role cannot read ${r?.unreadable.join(', ') ?? 'anything'}`);
    }
    // Row-level security does not apply to a table's owner, or to a role
    // that may bypass it: the application role must be neither.
    if (r.owned.length) {
      throw new Error(
        `the application role owns ${r.owned.join(', ')}, so no policy applies to it`,
      );
    }
    if (r.privileged) throw new Error('the application role can bypass row-level security');
    if (!r.queue) throw new Error('the application role cannot use the job queue');
    if (r.audit_mutable) throw new Error('the audit log is no longer append-only');
    if (r.tombstones_mutable) {
      throw new Error("a removed document's tombstone can be changed or removed");
    }

    // Outside withScope, so it says for itself what withSystem would: this
    // household, asked by the vault itself. Since 0030 a transaction that
    // does not say who is asking is given no documents.
    const asHousehold = async <T>(
      household: string,
      sql: string,
      actor = 'system',
    ): Promise<T[]> => {
      const client = await app.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', $2, true)`,
          [household, actor],
        );
        const { rows } = await client.query<T & object>(sql);
        await client.query('commit');
        return rows;
      } finally {
        client.release();
      }
    };
    const seen = async (household: string) =>
      (
        await asHousehold<{ members: number; documents: number }>(
          household,
          `select (select count(*)::int from member) as members,
                  (select count(*)::int from document) as documents`,
        )
      )[0] ?? { members: -1, documents: -1 };

    // Somebody else's household sees nothing, in any table that belongs to
    // a household: the policies came back. A row that belongs to no
    // household is everybody's to read — the built-in document types and
    // attributes (0031) — and is not a leak.
    const stranger = randomUUID();
    const leaks = await asHousehold<{ t: string; n: number }>(
      stranger,
      r.tenant_tables
        .map(
          (t) =>
            `select '${t.replace(/'/g, "''")}' as t, count(*)::int as n from ${t} where household_id is not null`,
        )
        .join(' union all '),
    );
    const leaking = leaks.filter((l) => l.n > 0).map((l) => l.t);
    if (leaking.length) {
      throw new Error(`a household can see rows that are not its own in ${leaking.join(', ')}`);
    }
    for (const h of counts) {
      const got = await seen(h.id);
      if (got.members !== h.members || got.documents !== h.documents) {
        throw new Error(
          `household ${h.id}: the vault would see ${got.members} people and ${got.documents} ` +
            `documents, but the backup has ${h.members} and ${h.documents}`,
        );
      }
      // And the rules for each kind of caller (0030) came back doing what
      // they did: nobody who is not signed in or the vault itself is given
      // a row of these tables. (A link here names no share, so it is one
      // the household never made.)
      for (const [actor, who] of GIVEN_NOTHING) {
        const given = await asHousehold<{ t: string; n: number }>(
          h.id,
          ACTOR_GUARDED.map(
            (t) =>
              `select '${t}' as t, count(*)::int as n from ${t}` +
              (HOUSEHOLD_ROWS[t] ? ` where ${HOUSEHOLD_ROWS[t]}` : ''),
          ).join(' union all '),
          actor,
        );
        const where = given.filter((g) => g.n > 0).map((g) => g.t);
        if (where.length) {
          throw new Error(`household ${h.id}: ${who} is given its documents (${where.join(', ')})`);
        }
      }
      // A share link reaches nothing of the household's other tables but
      // what its own page names (0042): one it never made, nothing at all.
      const linked = await asHousehold<{ t: string; n: number }>(
        h.id,
        LINK_NARROWED.map((t) => `select '${t}' as t, count(*)::int as n from ${t}`).join(
          ' union all ',
        ),
        'link',
      );
      const reached = linked.filter((g) => g.n > 0).map((g) => g.t);
      if (reached.length) {
        throw new Error(
          `household ${h.id}: a share link it never made is given ${reached.join(', ')}`,
        );
      }
      // Nor an upload link (0044, A74): one that asks for no request of the
      // household's is given none of them.
      const uploaded = await asHousehold<{ t: string; n: number }>(
        h.id,
        UPLOAD_NARROWED.map((t) => `select '${t}' as t, count(*)::int as n from ${t}`).join(
          ' union all ',
        ),
        'upload',
      );
      const reachedByUpload = uploaded.filter((g) => g.n > 0).map((g) => g.t);
      if (reachedByUpload.length) {
        throw new Error(
          `household ${h.id}: an upload link it never made is given ${reachedByUpload.join(', ')}`,
        );
      }
      // Who writes identity details, and asks for a notice, tried (0050):
      // each in a transaction rolled back, so nothing is kept.
      await probeIdentityWriters(admin, app, target.appUrl, h.id);
      // Somebody signed in who is no member of it — so the maker of none,
      // with no role of the family's — is given no Only me collection (0036)
      // and nobody's photo (0040).
      for (const m of MAKER_ONLY) {
        const [open] = await asHousehold<{ n: number }>(
          h.id,
          `select count(*)::int as n from ${m.table} where ${m.where}`,
          'account',
        );
        if ((open?.n ?? 0) > 0) {
          throw new Error(
            `household ${h.id}: ${m.what} is open to somebody signed in who is not given it`,
          );
        }
      }
      // An adult — no owner — is given nothing moved to the owners (0047).
      for (const o of OWNERS_ONLY) {
        const client = await app.connect();
        try {
          await client.query('begin');
          await client.query(
            `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                    set_config('app.role', 'adult', true)`,
            [h.id],
          );
          const { rows: shown } = await client.query<{ n: number }>(
            `select count(*)::int as n from ${o.table} where ${o.where}`,
          );
          await client.query('commit');
          if ((shown[0]?.n ?? 0) > 0) {
            throw new Error(
              `household ${h.id}: what was moved to the owners (${o.table}) is open to an adult`,
            );
          }
        } finally {
          client.release();
        }
      }
    }
    return {
      schema: t.schema,
      households: counts.length,
      members: counts.reduce((n, h) => n + h.members, 0),
      documents: counts.reduce((n, h) => n + h.documents, 0),
      versions: t.versions,
    };
  } finally {
    await admin.end();
    await app.end();
  }
}
