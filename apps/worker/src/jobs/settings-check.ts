import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { openMailboxPassword } from '@fdv/crypto';
import { withSystem, type Db } from '@fdv/db';
import { sql } from 'kysely';
import {
  SETTINGS_CHECK_KEEP_MS,
  WATCH_BROWSE_MAX,
  WATCH_LOW_SPACE_BYTES,
  WATCH_PROCESSED_DIR,
  WATCH_REJECTED_DIR,
  WATCH_VERIFY_CHECKS,
  watchPathRefusal,
  watchPathWords,
  MAIL_IN_AUTHSERV_AGREE,
  type LocalAiTestFound,
  type MailInTestFound,
  type WatchBrowseResult,
  type WatchVerifyCheck,
  type WatchVerifyFound,
} from '@fdv/shared';
import { localAiHost, type LocalAiClient } from '../local-ai.js';
import { whyOf } from './intake-ingest.js';
import { mailHostAddress, type MailHostRules } from './mail-address.js';
import {
  ImapMailbox,
  MailboxError,
  type ImapSettings,
  type MailboxConnector,
  type MailboxInspection,
} from './mailbox.js';
import type { MailReader } from './mail-thread.js';
import {
  acceptedRoots,
  nodeFs,
  ownIdsOf,
  placeOf,
  type OwnIds,
  type WatchFs,
  type WatchPlaceRules,
} from './watch-folder.js';

/**
 * What an owner asks the worker from Settings (0.9.0, O1), answered here:
 * the worker alone has the scanner folders mounted into it and the
 * mailbox's password. The API writes the question (settings_check) and
 * sends this job; the answer is written to the same row, which the page
 * asks for until it is there.
 *
 *  - `folder`, Verify: whether a path is a folder the scanner folder may
 *    be — there, a folder, inside the roots by its real path (no link out
 *    of them), none of the vault's own folders nor above one — and whether
 *    the vault can list it, make a file in it, move that file and delete it
 *    (a hidden one, removed afterwards), and how much room there is.
 *    Nothing is written in a folder that fails any of the first four.
 *  - `browse`: the folders inside a folder the scanner folder may be in,
 *    by name, for the path picker. Never a file's name.
 *  - `mailbox`, Test the mailbox: signed in, the folder opened read-only,
 *    and the newest messages' Authentication-Results alone asked for with
 *    BODY.PEEK (MailboxConnector.inspect) — nothing marked, moved or
 *    fetched besides; that header read on the mail thread, never here.
 *
 * Every path is refused again here as the API refused it, and by its real
 * path besides: what the API let through is not trusted.
 */

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

/** The job's data: which household, which question. */
export interface SettingsCheckJob {
  household_id: string;
  check_id: string;
}

export function isSettingsCheckJob(d: unknown): d is SettingsCheckJob {
  const j = d as Partial<SettingsCheckJob> | null;
  return typeof j?.household_id === 'string' && typeof j.check_id === 'string';
}

export interface SettingsCheckDeps {
  db: Db;
  log: Log;
  watch: {
    /** FDV_WATCH_ROOTS, and FDV_WATCH_DIR: what a folder may be chosen inside. */
    roots: readonly string[];
    /** The vault's own folders (WATCH_SYSTEM_DIRS and the worker's). */
    ownDirs: readonly string[];
    fs?: WatchFs;
  };
  mail: {
    /** FDV_MAIL_IN_*: the server's own mailbox, when it has one. */
    env: { connector: MailboxConnector; folder: string; authservId: string | null } | null;
    /** The key a mailbox set up in Settings has its password opened with. */
    mailKey: Buffer;
    /** A mailbox set up in Settings, signed in to: over IMAP, or the tests' own. */
    connect?: (s: ImapSettings) => MailboxConnector;
    reader: MailReader;
    /** FDV_MAIL_IN_ALLOWED_PORTS, FDV_MAIL_IN_ALLOW_PRIVATE: where one set up in Settings may be (M3). */
    hosts?: MailHostRules;
    /** How long Test the mailbox may take: MAILBOX_TEST_MS, unless a test says less. */
    testMs?: number;
  };
  /** The local AI's client (R4), where the operator set one up; none, and Test says so. */
  localAi?: Pick<LocalAiClient, 'test' | 'settings'> | null;
}

/**
 * Test the local AI (R4): a tiny fixed prompt — no paper's words — to the
 * operator's endpoint, through the same client and turn as a paper's, and
 * whatever its breaker says (the client says what it found, for
 * local_ai_state). What it found: the model, the host, how long. The reply
 * is not read, beyond its status: 200 is an answer.
 */
export async function testLocalAi(
  client: Pick<LocalAiClient, 'test' | 'settings'> | null,
): Promise<LocalAiTestFound> {
  if (!client) return { problem: 'not_set_up', model: null, host: null, latency_ms: null };
  const at = { model: client.settings.model, host: localAiHost(client.settings.url) };
  const got = await client.test();
  if (got.state === 'replied') return { problem: null, ...at, latency_ms: got.ms };
  const problem: LocalAiTestFound['problem'] =
    got.why === 'http_error'
      ? got.status === 404
        ? 'no_model'
        : 'http_error'
      : got.why === 'too_big'
        ? 'too_big'
        : got.why === 'timeout'
          ? 'timeout'
          : 'unreachable';
  return { problem, ...at, latency_ms: null };
}

/** The question answered, once: a row answered already, or gone, is left as it is. */
export async function runSettingsCheck(
  deps: SettingsCheckDeps,
  job: SettingsCheckJob,
): Promise<void> {
  const hh = job.household_id;
  const row = await withSystem(deps.db, hh, (trx) =>
    trx
      .selectFrom('settings_check')
      .select(['id', 'kind', 'path', 'done_at'])
      .where('id', '=', job.check_id)
      .executeTakeFirst(),
  );
  if (!row || row.done_at) return;
  const fsx = deps.watch.fs ?? nodeFs;
  // The roots but `/` and any holding one of the vault's own (the O1 review, M4).
  const { accepted } =
    row.kind === 'mailbox' || row.kind === 'local_ai'
      ? { accepted: [] }
      : await acceptedRoots(deps.watch.roots, deps.watch.ownDirs, fsx);
  const rules = { roots: accepted, ownDirs: deps.watch.ownDirs };
  let result: object;
  try {
    if (row.kind === 'folder') {
      result = await verifyWatchFolder(row.path ?? '', rules, fsx);
    } else if (row.kind === 'browse') {
      result = await browseWatchFolder(row.path ?? '', rules, fsx);
    } else if (row.kind === 'local_ai') {
      result = await testLocalAi(deps.localAi ?? null);
    } else {
      result = await testMailbox(deps, hh);
    }
  } catch (err) {
    // Said as nothing could be told, never as the error's own words.
    deps.log('warn', 'a check asked for in Settings could not be finished', { err: whyOf(err) });
    result =
      row.kind === 'local_ai'
        ? ({
            problem: 'unreachable',
            model: null,
            host: null,
            latency_ms: null,
          } satisfies LocalAiTestFound)
        : row.kind === 'mailbox'
          ? ({ ...emptyTest('none'), problem: 'unreachable' } satisfies MailInTestFound)
          : row.kind === 'browse'
            ? ({
                path: row.path ?? '',
                folders: [],
                truncated: false,
                problem: 'That folder couldn’t be looked in just now. Try again.',
              } satisfies WatchBrowseResult)
            : ({
                path: row.path ?? '',
                steps: WATCH_VERIFY_CHECKS.map((check) => ({ check, ok: null })),
                free_bytes: null,
              } satisfies WatchVerifyFound);
  }
  await withSystem(deps.db, hh, async (trx) => {
    await trx
      .updateTable('settings_check')
      .set({ result: result as Record<string, unknown>, done_at: new Date() })
      .where('id', '=', job.check_id)
      .where('done_at', 'is', null)
      .execute();
    // Answers older than a day are cleared away.
    await trx
      .deleteFrom('settings_check')
      .where('requested_at', '<', new Date(Date.now() - SETTINGS_CHECK_KEEP_MS))
      .execute();
  });
}

/**
 * The folder asked about, pinned (the O1 review, M1): its real path, inside
 * the real roots and none of the vault's own nor above one — checked on
 * that real path, by name and by device and inode — and the device and
 * inode it had. Everything after works on the real path alone, and asks
 * `held` before it writes: a folder swapped for a link since is not.
 */
async function pinFolder(
  p: string,
  rules: WatchPlaceRules & { roots: readonly string[] },
  fsx: WatchFs,
  ids: OwnIds,
): Promise<{ real: string; id: string; inside: boolean; own: boolean; withinOwn: boolean } | null> {
  const real = await fsx.realpath(p).catch(() => null);
  if (!real) return null;
  const st = await fsx.lstat(real, { bigint: true }).catch(() => null);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return null;
  // As named (no `..`, under a root by its name too), and by its real path.
  const named = await placeOf(p, rules, fsx, { ids });
  const byReal = await placeOf(real, rules, fsx, { real: true, ids });
  if (!named || !byReal) return null;
  return {
    real,
    id: `${st.dev}:${st.ino}`,
    inside: named.inside && byReal.inside,
    own: named.own || byReal.own,
    withinOwn: named.withinOwn || byReal.withinOwn,
  };
}

/** Whether the real path is still the folder pinned: no link, the same device and inode. */
async function held(fsx: WatchFs, real: string, id: string): Promise<boolean> {
  const st = await fsx.lstat(real, { bigint: true }).catch(() => null);
  return st !== null && st.isDirectory() && !st.isSymbolicLink() && `${st.dev}:${st.ino}` === id;
}

/**
 * Verify (O1): each check in order, a failed one leaving those after it
 * untried (null). Nothing is written in a folder that is not there, not a
 * folder, outside the roots or the vault's own; the probe is a hidden file
 * (which the scanner folder never takes), made new and never through a
 * link, in the folder's real path as checked (M1), and removed whatever
 * happened.
 */
export async function verifyWatchFolder(
  p: string,
  rules: WatchPlaceRules & { roots: readonly string[] },
  fsx: WatchFs = nodeFs,
  ids?: OwnIds,
  /** Tests: held once the folder is checked, before anything is written, for the races. */
  beforeWrite?: () => Promise<void>,
): Promise<WatchVerifyFound> {
  const ok = new Map<WatchVerifyCheck, boolean>();
  let free: number | null = null;
  const found = (): WatchVerifyFound => ({
    path: p,
    steps: WATCH_VERIFY_CHECKS.map((check) => ({ check, ok: ok.get(check) ?? null })),
    free_bytes: free,
  });
  if (!path.isAbsolute(p)) {
    ok.set('exists', false);
    return found();
  }
  const st = await fsx.stat(p).catch(() => null);
  ok.set('exists', st !== null);
  if (!st) return found();
  ok.set('folder', st.isDirectory());
  if (!st.isDirectory()) return found();
  const own = ids ?? (await ownIdsOf(rules.ownDirs, fsx));
  const pin = await pinFolder(p, rules, fsx, own);
  ok.set('inside', pin?.inside === true);
  if (!pin?.inside) return found();
  ok.set('not_vault', !pin.own);
  if (pin.own) return found();
  const at = pin.real;

  const space = await fsx.statfs(at).catch(() => null);
  free = space ? Number(space.bavail) * Number(space.bsize) : null;
  ok.set('space', free !== null && free >= WATCH_LOW_SPACE_BYTES);

  ok.set(
    'read',
    await fsx.readdir(at).then(
      () => true,
      () => false,
    ),
  );
  if (!ok.get('read')) return found();
  await beforeWrite?.();
  // Still the folder checked: else nothing is written (M1).
  if (!(await held(fsx, at, pin.id))) {
    ok.set('create', false);
    return found();
  }
  const probe = path.join(at, `.fdv-verify-${randomBytes(6).toString('hex')}`);
  const moved = `${probe}-moved`;
  try {
    ok.set(
      'create',
      await fsx.writeFile(probe, '', { flag: 'wx', mode: 0o600 }).then(
        () => true,
        () => false,
      ),
    );
    if (!ok.get('create')) return found();
    const made = await fsx.lstat(probe, { bigint: true }).catch(() => null);
    // Moved onto a name nothing has, and still the file made.
    const free2 = await fsx.lstat(moved).then(
      () => false,
      () => true,
    );
    const didMove =
      free2 &&
      made !== null &&
      (await held(fsx, at, pin.id)) &&
      (await fsx.rename(probe, moved).then(
        () => true,
        () => false,
      ));
    const after = didMove ? await fsx.lstat(moved, { bigint: true }).catch(() => null) : null;
    ok.set(
      'move',
      didMove &&
        after !== null &&
        made !== null &&
        after.ino === made.ino &&
        after.dev === made.dev,
    );
    if (!ok.get('move')) return found();
    ok.set(
      'delete',
      await fsx.unlink(moved).then(
        () => true,
        () => false,
      ),
    );
    return found();
  } finally {
    // Whatever happened, the probe goes: only a plain file of the vault's own making.
    for (const n of [probe, moved]) {
      const s = await fsx.lstat(n).catch(() => null);
      if (s?.isFile() && !s.isSymbolicLink()) await fsx.unlink(n).catch(() => undefined);
    }
  }
}

/**
 * The folders inside a folder the scanner folder may be in (O1), by name:
 * never through a link, never a hidden one or the vault's own rejected/
 * and processed/, at most WATCH_BROWSE_MAX. Looked in at its real path,
 * as checked there (M1).
 */
export async function browseWatchFolder(
  p: string,
  rules: WatchPlaceRules & { roots: readonly string[] },
  fsx: WatchFs = nodeFs,
  ids?: OwnIds,
): Promise<WatchBrowseResult> {
  const refuse = (problem: string): WatchBrowseResult => ({
    path: p,
    folders: [],
    truncated: false,
    problem,
  });
  if (!path.isAbsolute(p)) return refuse(watchPathWords('not_absolute', rules.roots));
  if (path.sep === '/') {
    // A folder above one of the vault's own may be browsed through, though never chosen.
    const r = watchPathRefusal(p, rules.roots, []);
    if (r) return refuse(watchPathWords(r, rules.roots));
  }
  const exists = await fsx.stat(p).catch(() => null);
  if (!exists) return refuse('There is nothing at that path in the worker.');
  if (!exists.isDirectory()) return refuse('That is not a folder.');
  const own = ids ?? (await ownIdsOf(rules.ownDirs, fsx));
  const pin = await pinFolder(p, rules, fsx, own);
  if (!pin) return refuse('That is not a folder.');
  if (!pin.inside) return refuse(watchPathWords('outside_roots', rules.roots));
  if (pin.withinOwn) return refuse(watchPathWords('vault_folder', rules.roots));
  let entries;
  try {
    entries = await fsx.readdir(pin.real, { withFileTypes: true });
  } catch {
    return refuse(
      'The vault can’t see what is in that folder. Give it to the containers’ user (uid 1000).',
    );
  }
  if (!(await held(fsx, pin.real, pin.id))) return refuse('That is not a folder.');
  const names: string[] = [];
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (e.name === WATCH_REJECTED_DIR || e.name === WATCH_PROCESSED_DIR) continue;
    // One of the vault's own, or inside one: not offered.
    const inner = await placeOf(
      path.join(pin.real, e.name),
      { roots: null, ownDirs: rules.ownDirs },
      fsx,
      { real: true, ids: own },
    );
    if (!inner || inner.withinOwn) continue;
    names.push(e.name);
    if (names.length > WATCH_BROWSE_MAX) break;
  }
  return {
    path: p,
    folders: names.slice(0, WATCH_BROWSE_MAX),
    truncated: names.length > WATCH_BROWSE_MAX,
    problem: null,
  };
}

const emptyTest = (source: MailInTestFound['source']): MailInTestFound => ({
  source,
  problem: null,
  messages: null,
  move: null,
  uidplus: null,
  authserv_id_seen: null,
  headers_read: 0,
  authserv_id_set: null,
});

/** How long Test the mailbox may take, all told (the O1 review, L6). */
export const MAILBOX_TEST_MS = 15_000;

/** The advisory lock's first key for Test the mailbox, one a household (the O1 re-check, 4). */
export const MAILBOX_TEST_LOCK = 7406;

/**
 * Test the mailbox (O1): the one set up in Settings, else the server's.
 * Read-only: the connector's inspect, and the headers it hands back read on
 * the mail thread. The password goes to the connector alone, and opens only
 * for the server, port and sign-in it was typed for (H1); a server set up
 * in Settings is connected to only on an allowed port and at an address
 * outside the server's own network, the one checked (M3). Fifteen seconds
 * at most (L6).
 */
export async function testMailbox(deps: SettingsCheckDeps, hh: string): Promise<MailInTestFound> {
  const row = await withSystem(deps.db, hh, (trx) =>
    trx.selectFrom('mail_in_mailbox').selectAll().where('household_id', '=', hh).executeTakeFirst(),
  );
  let box: { connector: MailboxConnector; folder: string; authservId: string | null };
  let source: MailInTestFound['source'];
  if (row) {
    source = 'settings';
    if (!row.password_encrypted) return { ...emptyTest(source), problem: 'not_set_up' };
    let password: string;
    try {
      password = openMailboxPassword(deps.mail.mailKey, row.password_encrypted, hh, {
        host: row.host,
        port: row.port,
        username: row.username,
      });
    } catch {
      return { ...emptyTest(source), problem: 'password_sealed' };
    }
    const at = await mailHostAddress(
      row.host,
      row.port,
      deps.mail.hosts ?? { allowedPorts: [993], allowPrivate: false },
    );
    if ('refused' in at) {
      return {
        ...emptyTest(source),
        problem: 'address_refused',
        allowed_ports: [...(deps.mail.hosts?.allowedPorts ?? [993])],
      };
    }
    if ('unresolved' in at) return { ...emptyTest(source), problem: 'unreachable' };
    const connect = deps.mail.connect ?? ((s: ImapSettings) => new ImapMailbox(s));
    box = {
      connector: connect({
        host: row.host,
        port: row.port,
        user: row.username,
        password,
        address: at.address,
        quick: true,
      }),
      folder: row.folder,
      authservId: row.authserv_id,
    };
  } else if (deps.mail.env) {
    source = 'server';
    box = deps.mail.env;
  } else {
    return { ...emptyTest('none'), problem: 'not_set_up' };
  }
  const found = { ...emptyTest(source), authserv_id_set: box.authservId };
  // One test of a household's mailbox at a time, whichever worker answers
  // (the O1 re-check, 4): its advisory lock, held while it runs.
  return withSystem(deps.db, hh, async (trx) => {
    const { rows } = await sql<{ got: boolean }>`
      select pg_try_advisory_xact_lock(${MAILBOX_TEST_LOCK}, hashtext(${hh})) as got`.execute(trx);
    if (!rows[0]?.got) return { ...found, problem: 'busy' as const };
    return inspected(deps, box, found);
  });
}

/** The look itself: given up on, and its connection closed, after its time (L6, the re-check 4). */
async function inspected(
  deps: SettingsCheckDeps,
  box: { connector: MailboxConnector; folder: string; authservId: string | null },
  found: MailInTestFound,
): Promise<MailInTestFound> {
  let seen: MailboxInspection;
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new AbortController();
  try {
    seen = await Promise.race([
      box.connector.inspect(box.folder, giveUp.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          giveUp.abort();
          reject(new MailboxError('unreachable'));
        }, deps.mail.testMs ?? MAILBOX_TEST_MS);
      }),
    ]);
  } catch (err) {
    return { ...found, problem: err instanceof MailboxError ? err.problem : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
  // An authserv-id suggested only when the newest three all name the same
  // one at their top (L3): one email, which anybody can send, is not enough.
  const tops: Array<string | null> = [];
  for (const h of seen.newestHeaders.slice(0, MAIL_IN_AUTHSERV_AGREE)) {
    const a = await deps.mail.reader.head(h, null);
    tops.push(a.state === 'done' ? a.head.authservTop : null);
  }
  const first = tops[0] ?? null;
  const agreed =
    tops.length >= MAIL_IN_AUTHSERV_AGREE && first !== null && tops.every((t) => t === first);
  return {
    ...found,
    messages: seen.exists,
    move: seen.move,
    uidplus: seen.uidplus,
    authserv_id_seen: agreed ? first : null,
    headers_read: tops.length,
  };
}
