import { createHash } from 'node:crypto';
import { type ScopeKeys } from '@fdv/crypto';
import { withSystem, type Db } from '@fdv/db';
import {
  dropFileName,
  MAIL_IN_FILED_FOLDER,
  MAIL_IN_INLINE_SKIP_BYTES,
  MAIL_IN_MAX_MESSAGE_BYTES,
  mayFillFromScanner,
  suspensionInEffect,
  WATCH_NOTICE_DAYS,
  type MailInAfter,
  type MailInError,
  type MailInFiling,
  type MailNoticeReason,
  type MailSkippedCounts,
  type Role,
} from '@fdv/shared';
import type pg from 'pg';
import {
  AdvisoryLock,
  arriveItem,
  clearStaleItem,
  dayIsFull,
  discardItem,
  keyedUuid,
  placeItem,
  storeItem,
  whoseInbox,
  whyOf,
  type Target,
} from './intake-ingest.js';
import {
  ImapMailbox,
  MailboxError,
  type MailboxConnector,
  type MailboxSession,
} from './mailbox.js';
import type { MailHead, MailReader } from './mail-thread.js';
import { watchKindOf } from './watch-folder.js';

/**
 * Email documents to the vault: a household mailbox checked over IMAP
 * (0.8.0, S4, CAP-09).
 *
 * Every FDV_MAIL_IN_POLL_SECONDS one worker — whichever holds a Postgres
 * advisory lock (MAIL_IN_LOCK_KEY), on a connection of its own, checked in
 * pg_locks before every mail — signs in to the household mailbox and looks
 * at its folder.
 *
 *  - It says how it has the mailbox (mail_in_server): the API offers email
 *    in only when it is set up and the worker said so in its last two
 *    polls. The password is never said, anywhere: only that one is set.
 *  - It finds the household that has it on. Mail is read on the mail
 *    thread (mail-thread.ts), never here: first each new mail's header (its
 *    first 64 KB) — who it is From, its Message-ID, the codes in its
 *    subject, the provider's word on the sender — kept for the UID while
 *    the folder's UIDVALIDITY stands.
 *  - Mail From the sign-in address of somebody of the family who may add
 *    documents (an owner, an adult, a teen; never a viewer, never a guest),
 *    confirmed (mail_in_address) by a code sent from it while the provider
 *    vouches for senders, or one the vault emailed to it, is theirs.
 *    With FDV_MAIL_IN_AUTHSERV_ID set, only once the provider vouched for
 *    the sender (mail-auth.ts); without it, on the From alone, each item
 *    "sender not verified". Anything else is left as it is — unread, not
 *    moved, not flagged — and counted for the owners: from strangers (or an
 *    address not confirmed yet), failing the check, or waiting for somebody
 *    who cannot have files added just now (locked, after a restore, a full
 *    day).
 *  - A mail of theirs is fetched whole only when the server says it is at
 *    most 50 MB (RFC822.SIZE), and read on the thread: each attachment whose
 *    bytes are a kind the vault keeps (UPLOAD_KINDS: watchKindOf, as the
 *    scanner folder sniffs) becomes an item of their batch of the day
 *    ("Email, 12 Oct"), as Add → Many documents adds one — but a picture in
 *    the body under 20 KB (a signature, a logo). The body is never kept;
 *    the subject neither (no sealed field of an item fits it).
 *  - Each item's Idempotency-Key is a keyed hash of the mailbox's
 *    UIDVALIDITY, the mail's UID, the attachment's place and its SHA-256;
 *    its mail_key, of the Message-ID, place and SHA-256. Either finds it
 *    again: a worker that stops between storing and filing adds nothing
 *    twice, whatever became of the UIDs. Only once every attachment is in
 *    is the mail moved to Filed (made if it is not there), or deleted.
 *  - A mail larger than 50 MB, or with an attachment larger than the
 *    vault takes, or with nothing to add, or that cannot be read, is filed
 *    too, and its person told (watch_notice, source email: theirs alone).
 *  - The mailbox's sign-in refused, its server out of reach, its
 *    certificate not verified, the folder not there: said to the owners as
 *    a word (never the server's message), and tried again less and less
 *    often, up to an hour apart, so a provider does not lock the mailbox.
 */

/** The advisory lock one worker holds while it checks the mailbox: beside the scanner folder's 7403. */
export const MAIL_IN_LOCK_KEY = 7404;

/** What the itemKey is derived for. */
export const MAIL_KEY_PURPOSE = 'mail-in-items';

/** A mail's first bytes fetched to read its header. */
export const MAIL_HEAD_BYTES = 64 * 1024;

/** At most this many headers are fetched a round, and this many mails filed: the rest wait. */
export const MAIL_HEADS_PER_ROUND = 200;
export const MAIL_ROUND_MAX = 25;

/** Tried again at most this far apart while the mailbox cannot be had. */
const BACKOFF_MAX_MS = 60 * 60_000;

/** The first bytes a kind is told from. */
const SNIFF_BYTES = 4100;

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

export interface MailInDeps {
  /** The owning role: the mailbox's state, and which household has it on. */
  admin: pg.Pool;
  /** The application role, as the vault itself in one household (withSystem). */
  db: Db;
  keys: ScopeKeys;
  credentialsKey: Buffer;
  localRoot: string;
  log: Log;
  /** The key an item's Idempotency-Key is made with (deriveKey(master, MAIL_KEY_PURPOSE)). */
  itemKey: Buffer;
  /** FDV_MAX_UPLOAD_BYTES: the most one attachment may be, as for an upload. */
  maxBytes: number;
  /** A household's batch.previews job: the items' pages drawn and read. */
  sendBatchPreviews: (householdId: string) => Promise<void>;
  /** The mail thread: where a mail's MIME is read. */
  reader: MailReader;
}

export interface MailInOptions {
  /** The mailbox, signed in to; null when FDV_MAIL_IN_* is not set. */
  connector: MailboxConnector | null;
  /** Where the family sends mail: shown to them. */
  address: string | null;
  folder: string;
  after: MailInAfter;
  /** FDV_MAIL_IN_AUTHSERV_ID: the provider whose word on a sender counts; null for none. */
  authservId: string | null;
  pollMs: number;
  /** Where the lock's own connection goes (DATABASE_URL: a direct connection). */
  lockUrl: string;
  roundMax?: number;
  /** The clock, for the tests. */
  now?: () => number;
  /** Tests: just before a mail is filed, for a stop in between. */
  beforeFile?: (uid: number) => Promise<void>;
}

/** What became of one mail. */
export type MailOutcome =
  | { kind: 'added'; items: string[] }
  /** Every attachment in already: only filed. */
  | { kind: 'already' }
  | { kind: 'told'; reasons: MailNoticeReason[] }
  /** Left as it is, and counted. */
  | { kind: 'unknown' }
  | { kind: 'unverified' }
  | { kind: 'waiting'; why: string }
  /** Dealt with before, and left in place (a server that cannot move or delete one mail). */
  | { kind: 'done' }
  /** Not now: tried next round. */
  | { kind: 'later'; why: string };

/** What a round did. */
export interface MailRound {
  ran: boolean;
  error?: MailInError | null;
  /** Backing off: the mailbox was not tried. */
  waited?: boolean;
  /** How mail is filed this round, as the server allows (F10). */
  filing?: MailInFiling;
  outcomes: Array<{ uid: number } & MailOutcome>;
}

/** Somebody of the household, as email in sees them: by their sign-in address. */
interface Sender {
  memberId: string;
  role: Role;
  kind: 'family' | 'guest';
  email: string;
  suspended: boolean;
  confirmed: boolean;
  codeHash: Buffer | null;
  codeKind: 'send' | 'enter' | null;
  codeExpires: Date | null;
}

/**
 * A header read, kept for its UID while the folder's UIDVALIDITY stands:
 * what it says; or not readable; or a whole mail that did not say what its
 * header said (F3) — nobody's, never fetched again.
 */
type Known = { head: MailHead } | { unreadable: true } | { mismatch: true };

/** What a mail left in the mailbox from somebody of the family is, for them (F1). */
interface Held {
  unverified: number;
  unconfirmed: number;
  last: number | null;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

/** An address the vault compares: printable ASCII alone (F6), lower case. */
const asciiAddress = (s: string): string | null => {
  // ASCII before anything is folded: a Kelvin sign lower-cased is a k.
  const a = s.trim();
  return /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+$/.test(a) ? a.toLowerCase() : null;
};

/** FDV_MAIL_IN_* as the worker has them. */
export interface MailInConfig {
  FDV_MAIL_IN_HOST?: string | undefined;
  FDV_MAIL_IN_PORT: number;
  FDV_MAIL_IN_USER?: string | undefined;
  FDV_MAIL_IN_PASSWORD?: string | undefined;
  FDV_MAIL_IN_PASSWORD_FILE?: string | undefined;
  FDV_MAIL_IN_ADDRESS?: string | undefined;
}

/**
 * The mailbox's password taken out of the environment once the settings
 * are read (F7): what the worker starts — a tool, a thread — is never
 * handed it. FDV_MAIL_IN_PASSWORD_FILE (a Docker secret) is better still:
 * the password is never in the environment at all.
 */
export function takeMailInPassword(env: NodeJS.ProcessEnv): void {
  delete env.FDV_MAIL_IN_PASSWORD;
}

/**
 * The household mailbox from the worker's settings: null unless its host,
 * its sign-in and a password (or a file holding one) are all set. The
 * password goes to the connector and nowhere else; a file that cannot be
 * read is no password, said without its path.
 */
export async function mailboxFromConfig(
  c: MailInConfig,
  log: Log,
  readFile: (p: string) => Promise<string>,
): Promise<{ connector: MailboxConnector; address: string | null } | null> {
  if (!c.FDV_MAIL_IN_HOST || !c.FDV_MAIL_IN_USER) return null;
  let password = c.FDV_MAIL_IN_PASSWORD ?? null;
  if (!password && c.FDV_MAIL_IN_PASSWORD_FILE) {
    password = await readFile(c.FDV_MAIL_IN_PASSWORD_FILE).then(
      (s) => s.replace(/\r?\n$/, ''),
      () => {
        log('warn', 'FDV_MAIL_IN_PASSWORD_FILE could not be read: email in is off');
        return null;
      },
    );
  }
  if (!password) return null;
  return {
    connector: new ImapMailbox({
      host: c.FDV_MAIL_IN_HOST,
      port: c.FDV_MAIL_IN_PORT,
      user: c.FDV_MAIL_IN_USER,
      password,
    }),
    address:
      c.FDV_MAIL_IN_ADDRESS ?? (c.FDV_MAIL_IN_USER.includes('@') ? c.FDV_MAIL_IN_USER : null),
  };
}

/** Per round: the members whose mail waits (a full day, F4), and what was held of whose. */
interface RoundState {
  fullDay: Set<string>;
  held: Map<string, Held>;
}

export class MailInRunner {
  private readonly now: () => number;
  private readonly lock: AdvisoryLock;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<MailRound> | null = null;
  private stopped = false;
  private readonly abort = new AbortController();
  /** Headers read, by UID, of this UIDVALIDITY in this household. */
  private known = new Map<number, Known>();
  private knownOf = '';
  /** While the mailbox cannot be had: how many times in a row, and not before when. */
  private failures = 0;
  private notBefore = 0;
  /** How mail is filed in this session, as the server allows (F10). */
  private filing: MailInFiling = 'move';
  /** The Filed folder is there, this session: made the first time a mail is moved. */
  private filedReady = false;

  constructor(
    private readonly deps: MailInDeps,
    private readonly opts: MailInOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.lock = new AdvisoryLock(MAIL_IN_LOCK_KEY, opts.lockUrl, deps.log, 'email in');
  }

  get holding(): boolean {
    return this.lock.holding;
  }

  /** Looks every pollMs from now on, a round at a time. */
  start(): void {
    const next = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        void this.tick()
          .catch((err: unknown) =>
            this.deps.log('warn', 'the household mailbox could not be checked', {
              err: whyOf(err),
            }),
          )
          .finally(next);
      }, this.opts.pollMs);
      this.timer.unref?.();
    };
    void this.tick()
      .catch(() => undefined)
      .finally(next);
  }

  /** Stops: between mails, and an item on its way aborted; then lets go of the lock. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
    await this.lock.letGo();
  }

  /** One round: never two at once. */
  async tick(): Promise<MailRound> {
    if (this.running) return this.running;
    this.running = this.round().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async round(): Promise<MailRound> {
    const out: MailRound = { ran: false, outcomes: [] };
    if (this.stopped) return out;
    const o = this.opts;
    if (!o.connector) {
      // Not set up here: said — but never over a worker that has it set up
      // and said so within its last two polls (F9).
      await this.deps.admin.query(
        `insert into mail_in_server (singleton, configured, address, folder, after, sender_check, filing, poll_seconds, checked_at)
         values (true, false, null, null, 'move', false, null, $1, now())
         on conflict (singleton) do update
           set configured = false, address = null, folder = null, after = 'move',
               sender_check = false, filing = null, poll_seconds = $1, checked_at = now()
         where not mail_in_server.configured
            or mail_in_server.checked_at < now() - make_interval(secs => mail_in_server.poll_seconds * 2)`,
        [Math.round(o.pollMs / 1000)],
      );
      return out;
    }
    if (!(await this.lock.hold(this.stopped))) return out;
    out.ran = true;
    await this.deps.admin.query(
      `insert into mail_in_server (singleton, configured, address, folder, after, sender_check, poll_seconds, checked_at)
       values (true, true, $1, $2, $3, $4, $5, now())
       on conflict (singleton) do update
         set configured = true, address = $1, folder = $2, after = $3, sender_check = $4,
             poll_seconds = $5, checked_at = now()`,
      [o.address, o.folder, o.after, o.authservId !== null, Math.round(o.pollMs / 1000)],
    );
    // What nobody dismissed in WATCH_NOTICE_DAYS goes, as the scanner's does.
    await this.deps.admin.query(
      `delete from watch_notice where source = 'email' and created_at < now() - make_interval(days => $1)`,
      [WATCH_NOTICE_DAYS],
    );
    const { rows } = await this.deps.admin.query<{ household_id: string }>(
      'select household_id from mail_in where enabled order by household_id limit 1',
    );
    const hh = rows[0]?.household_id;
    if (!hh) {
      this.known.clear();
      return out;
    }
    if (this.now() < this.notBefore) {
      out.waited = true;
      return out;
    }

    let session: MailboxSession;
    try {
      session = await o.connector.open(o.folder);
    } catch (err) {
      const problem: MailInError = err instanceof MailboxError ? err.problem : 'unreachable';
      this.failures += 1;
      this.notBefore = this.now() + Math.min(BACKOFF_MAX_MS, o.pollMs * 2 ** (this.failures - 1));
      this.deps.log('warn', 'the household mailbox could not be opened', { why: problem });
      out.error = problem;
      await this.said(hh, { error: problem });
      return out;
    }
    this.failures = 0;
    this.notBefore = 0;
    // How mail is filed, as the server allows (F10): a delete only where one
    // mail is expunged alone (UIDPLUS); a move only by MOVE (never COPY and
    // EXPUNGE); otherwise left in place, marked read. Said to the owners.
    this.filing =
      o.after === 'delete' && session.canDelete ? 'delete' : session.canMove ? 'move' : 'leave';
    out.filing = this.filing;
    await this.deps.admin.query('update mail_in_server set filing = $1', [this.filing]);
    try {
      return await this.look(hh, session, out);
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /** The folder, open: every mail looked at, theirs added and filed, the rest counted. */
  private async look(hh: string, session: MailboxSession, out: MailRound): Promise<MailRound> {
    const o = this.opts;
    const of = `${hh}\0${session.uidValidity}`;
    if (of !== this.knownOf) {
      this.known.clear();
      this.knownOf = of;
    }
    let entries;
    try {
      entries = await session.list();
    } catch (err) {
      this.deps.log('warn', 'the household mailbox could not be listed', { err: whyOf(err) });
      out.error = 'unreachable';
      await this.said(hh, { error: 'unreachable' });
      return out;
    }
    const here = new Set(entries.map((e) => e.uid));
    for (const uid of [...this.known.keys()]) if (!here.has(uid)) this.known.delete(uid);

    const senders = await this.senders(hh);
    const counts = { unknown: 0, unverified: 0, waiting: 0 };
    const state: RoundState = { fullDay: new Set(), held: new Map() };
    const hold = (memberId: string, kind: 'unverified' | 'unconfirmed', head: MailHead) => {
      const h = state.held.get(memberId) ?? { unverified: 0, unconfirmed: 0, last: null };
      h[kind] += 1;
      const at = head.date ? Date.parse(head.date) : this.now();
      if (Number.isFinite(at) && (h.last === null || at > h.last)) h.last = at;
      state.held.set(memberId, h);
    };
    let heads = 0;
    let handled = 0;
    let added = 0;
    let error: MailInError | null = null;
    this.filedReady = false;
    for (const e of entries) {
      if (this.stopped) break;
      let known = this.known.get(e.uid);
      if (!known) {
        if (heads >= MAIL_HEADS_PER_ROUND) continue;
        heads += 1;
        const bytes = await session.head(e.uid, MAIL_HEAD_BYTES);
        if (!bytes) continue;
        const a = await this.deps.reader.head(bytes, o.authservId);
        if (a.state === 'unavailable') continue;
        known = a.state === 'done' ? { head: a.head } : { unreadable: true };
        this.known.set(e.uid, known);
      }
      const who = this.whose(known, senders);
      if (who.kind === 'unknown' || who.kind === 'unverified') {
        counts[who.kind] += 1;
        if (who.kind === 'unverified' && 'head' in known)
          hold(who.memberId, 'unverified', known.head);
        out.outcomes.push({ uid: e.uid, kind: who.kind });
        continue;
      }
      if (who.kind === 'unconfirmed') {
        counts.unknown += 1;
        hold(who.sender.memberId, 'unconfirmed', who.head);
        out.outcomes.push({ uid: e.uid, kind: 'unknown' });
        continue;
      }
      const head = who.head;
      // Dealt with before, and left in place (F10): never fetched again.
      if (this.filing === 'leave' && (await this.isDone(hh, this.mailOf(session, e.uid, head)))) {
        out.outcomes.push({ uid: e.uid, kind: 'done' });
        continue;
      }
      if (who.kind === 'confirm') {
        // Their address, confirmed by the code they sent from it — which the
        // provider vouched was them (only while senders are checked, F1).
        await withSystem(this.deps.db, hh, (trx) =>
          trx
            .updateTable('mail_in_address')
            .set({
              email: who.sender.email,
              confirmed_at: new Date(),
              code_hash: null,
              code_kind: null,
              code_expires_at: null,
              code_attempts: 0,
              updated_at: new Date(),
            })
            .where('member_id', '=', who.sender.memberId)
            .where('code_hash', '=', who.code)
            .where('code_kind', '=', 'send')
            .execute(),
        );
        who.sender.confirmed = true;
        this.deps.log('info', 'an address was confirmed for email in', { household: hh });
      }
      // Waiting, before anything is fetched (F4): their sign-in paused, or
      // their day full — and then the rest of theirs this round too. None of
      // it counts towards the mails handled a round.
      const waits = await this.waits(hh, who.sender, state);
      if (waits) {
        counts.waiting += 1;
        out.outcomes.push({ uid: e.uid, kind: 'waiting', why: waits });
        continue;
      }
      if (handled >= (o.roundMax ?? MAIL_ROUND_MAX)) continue;
      // Still the one runner, before anything is fetched, added or filed:
      // one that is not says nothing more either.
      if (!(await this.lock.still())) return out;
      handled += 1;
      const r = await this.take(
        hh,
        session,
        e,
        head,
        who.sender,
        who.kind === 'confirm',
        state,
      ).catch((err: unknown): MailOutcome & { error?: MailInError } => ({
        kind: 'later',
        why: whyOf(err),
      }));
      const { error: problem, ...outcome } = r;
      if (problem) error = problem;
      out.outcomes.push({ uid: e.uid, ...outcome });
      if (outcome.kind === 'added') added += outcome.items.length;
      if (outcome.kind === 'waiting') counts.waiting += 1;
      if (outcome.kind === 'unknown') counts.unknown += 1;
      if (outcome.kind === 'later') {
        this.deps.log('warn', 'an email is to be tried again', { why: outcome.why.slice(0, 200) });
      }
      if (problem === 'no_storage') break;
    }
    out.error = error;
    await this.said(hh, {
      error,
      checked: true,
      added: added > 0,
      counts,
    });
    await this.tellHeld(hh, state.held);
    if (added > 0) {
      await this.deps
        .sendBatchPreviews(hh)
        .catch((err: unknown) =>
          this.deps.log('warn', 'could not ask for emailed files’ pages', { err: whyOf(err) }),
        );
      this.deps.log('info', 'emailed files added', { household: hh, added });
    }
    return out;
  }

  /**
   * Why a member's mail waits now, before anything of it is fetched (F4):
   * their sign-in paused, or their day full — or null. A full day is
   * remembered for the rest of the round.
   */
  private async waits(hh: string, sender: Sender, state: RoundState): Promise<string | null> {
    if (sender.suspended) return 'their sign-in is paused';
    if (state.fullDay.has(sender.memberId)) return 'day_full';
    const target = await whoseInbox(this.deps.db, hh, sender.memberId, this.now());
    if ('pause' in target) return target.pause;
    if (await dayIsFull(this.deps.db, target, 'email', this.now())) {
      state.fullDay.add(sender.memberId);
      return 'day_full';
    }
    return null;
  }

  /** What the worker says of a household's email in: read by Settings. */
  private async said(
    hh: string,
    s: {
      error: MailInError | null;
      checked?: boolean;
      added?: boolean;
      counts?: { unknown: number; unverified: number; waiting: number };
    },
  ): Promise<void> {
    const at = new Date();
    await withSystem(this.deps.db, hh, async (trx) => {
      const was = await trx
        .selectFrom('mail_in')
        .select(['last_error'])
        .where('household_id', '=', hh)
        .executeTakeFirst();
      await trx
        .updateTable('mail_in')
        .set({
          last_checked_at: at,
          last_error: s.error,
          ...(s.error && s.error !== was?.last_error ? { last_error_at: at } : {}),
          ...(!s.error ? { last_error_at: null } : {}),
          ...(s.added ? { last_added_at: at } : {}),
          ...(s.counts
            ? {
                unknown_senders: s.counts.unknown,
                unverified: s.counts.unverified,
                waiting: s.counts.waiting,
              }
            : {}),
        })
        .where('household_id', '=', hh)
        .execute();
    });
  }

  /**
   * What was left in the mailbox from each member's address, told to them
   * alone (F1): failing the check, or waiting for the address to be
   * confirmed — counts, and the newest one's date. Everybody else's, none.
   */
  private async tellHeld(hh: string, held: Map<string, Held>): Promise<void> {
    await withSystem(this.deps.db, hh, async (trx) => {
      const quiet = trx
        .updateTable('mail_in_address')
        .set({ held_unverified: 0, held_unconfirmed: 0, held_last_at: null })
        .where((eb) => eb.or([eb('held_unverified', '>', 0), eb('held_unconfirmed', '>', 0)]));
      await (
        held.size > 0 ? quiet.where('member_id', 'not in', [...held.keys()]) : quiet
      ).execute();
      for (const [memberId, h] of held) {
        const values = {
          held_unverified: h.unverified,
          held_unconfirmed: h.unconfirmed,
          held_last_at: h.last === null ? null : new Date(h.last),
        };
        await trx
          .insertInto('mail_in_address')
          .values({ household_id: hh, member_id: memberId, ...values })
          .onConflict((oc) => oc.columns(['household_id', 'member_id']).doUpdateSet(values))
          .execute();
      }
    });
  }

  /**
   * Everybody of the household with a sign-in, by its address: printable
   * ASCII alone, lower case (F6). An address two people share (a look-alike
   * after folding) is neither's: both are left out.
   */
  private async senders(hh: string): Promise<Map<string, Sender>> {
    const rows = await withSystem(this.deps.db, hh, (trx) =>
      trx
        .selectFrom('account_household as a')
        .innerJoin('account as acc', 'acc.id', 'a.account_id')
        .innerJoin('member as m', (j) =>
          j.onRef('m.id', '=', 'a.member_id').onRef('m.household_id', '=', 'a.household_id'),
        )
        .leftJoin('mail_in_address as ad', (j) =>
          j
            .onRef('ad.member_id', '=', 'a.member_id')
            .onRef('ad.household_id', '=', 'a.household_id'),
        )
        .select([
          'a.member_id',
          'a.role',
          'a.suspended_at',
          'a.suspended_until',
          'acc.email',
          'acc.disabled_at',
          'm.kind',
          'ad.email as confirmed_email',
          'ad.confirmed_at',
          'ad.code_hash',
          'ad.code_kind',
          'ad.code_expires_at',
        ])
        .where('a.household_id', '=', hh)
        .execute(),
    );
    const now = this.now();
    const out = new Map<string, Sender>();
    const twice = new Set<string>();
    for (const r of rows) {
      const email = asciiAddress(r.email);
      if (!email) continue;
      if (out.has(email)) twice.add(email);
      const confirmedAs =
        typeof r.confirmed_email === 'string' ? asciiAddress(r.confirmed_email) : null;
      out.set(email, {
        memberId: r.member_id,
        role: r.role,
        kind: r.kind,
        email,
        suspended: r.disabled_at !== null || suspensionInEffect(r, now),
        confirmed: r.confirmed_at !== null && confirmedAs === email,
        codeHash: r.code_hash,
        codeKind: r.code_kind,
        codeExpires: r.code_expires_at,
      });
    }
    for (const email of twice) out.delete(email);
    return out;
  }

  /**
   * Whose a mail is, from its header: theirs (confirmed), theirs by the
   * code it carries (`confirm`: only while the provider vouches for
   * senders), or left alone — from nobody of the family who may add
   * documents (`unknown`), from a family address not confirmed
   * (`unconfirmed`), or not vouched for while senders are checked
   * (`unverified`).
   */
  private whose(
    known: Known,
    senders: Map<string, Sender>,
  ):
    | { kind: 'unknown' }
    | { kind: 'unverified'; memberId: string }
    | { kind: 'unconfirmed'; sender: Sender; head: MailHead }
    | { kind: 'theirs'; sender: Sender; head: MailHead }
    | { kind: 'confirm'; sender: Sender; head: MailHead; code: Buffer } {
    if (!('head' in known) || !known.head.from) return { kind: 'unknown' };
    const head = known.head;
    const from = asciiAddress(head.from as string);
    const sender = from ? senders.get(from) : undefined;
    if (!sender || !mayFillFromScanner(sender.role, sender.kind)) return { kind: 'unknown' };
    if (this.opts.authservId && head.auth !== 'pass') {
      return { kind: 'unverified', memberId: sender.memberId };
    }
    if (sender.confirmed) return { kind: 'theirs', sender, head };
    // A code sent FROM the address proves it only on the provider's word (F1).
    if (
      this.opts.authservId &&
      sender.codeKind === 'send' &&
      sender.codeHash &&
      sender.codeExpires &&
      sender.codeExpires.getTime() > this.now()
    ) {
      for (const c of head.codes) {
        const h = sha256(Buffer.from(c, 'utf8'));
        if (h.equals(sender.codeHash)) {
          return { kind: 'confirm', sender, head, code: sender.codeHash };
        }
      }
    }
    return { kind: 'unconfirmed', sender, head };
  }

  /** The notes' and items' keys for a mail: by its Message-ID where it has one, by its UID otherwise. */
  private mailOf(session: MailboxSession, uid: number, head: MailHead): string {
    return head.messageId ? `mid\0${head.messageId}` : `uid\0${session.uidValidity}\0${uid}`;
  }

  /** A mail left in place has been dealt with (F10). */
  private async isDone(hh: string, mail: string): Promise<boolean> {
    const key = keyedUuid(this.deps.itemKey, ['done', hh, mail]);
    const row = await withSystem(this.deps.db, hh, (trx) =>
      trx
        .selectFrom('mail_in_done')
        .select('mail_key')
        .where('mail_key', '=', key)
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  /** A note to its person, once a mail and reason. */
  private async tell(
    t: { householdId: string; memberId: string },
    mail: string,
    reason: MailNoticeReason,
    skipped: MailSkippedCounts | null = null,
  ): Promise<void> {
    await withSystem(this.deps.db, t.householdId, (trx) =>
      trx
        .insertInto('watch_notice')
        .values({
          household_id: t.householdId,
          member_id: t.memberId,
          source: 'email',
          file_name: null,
          reason,
          ...(skipped ? { skipped: skipped as Record<string, number> } : {}),
          file_key: keyedUuid(this.deps.itemKey, [
            'notice',
            t.householdId,
            t.memberId,
            mail,
            reason,
          ]),
        })
        .onConflict((oc) => oc.columns(['household_id', 'member_id', 'file_key']).doNothing())
        .execute(),
    );
  }

  /**
   * The mail filed, once all of it is in: moved to Filed, or deleted — but a
   * mail with anything not added (`keep`) is never deleted (F5): moved even
   * in delete mode. Where the server can do neither safely (F10), it is
   * left in place, marked read, and remembered as dealt with.
   */
  private async file(
    hh: string,
    session: MailboxSession,
    uid: number,
    mail: string,
    keep: boolean,
  ): Promise<boolean> {
    await this.opts.beforeFile?.(uid);
    let done: boolean;
    if (this.filing === 'leave') {
      await withSystem(this.deps.db, hh, (trx) =>
        trx
          .insertInto('mail_in_done')
          .values({ household_id: hh, mail_key: keyedUuid(this.deps.itemKey, ['done', hh, mail]) })
          .onConflict((oc) => oc.columns(['household_id', 'mail_key']).doNothing())
          .execute(),
      );
      await session.markSeen(uid).catch(() => false);
      done = true;
    } else if (this.filing === 'delete' && !keep) {
      done = await session.remove(uid);
    } else {
      if (!this.filedReady) {
        await session.ensureFolder(MAIL_IN_FILED_FOLDER).catch((err: unknown) => {
          this.deps.log('warn', 'the Filed folder could not be made', { err: whyOf(err) });
          throw err;
        });
        this.filedReady = true;
      }
      done = await session.move(uid, MAIL_IN_FILED_FOLDER);
    }
    if (done) this.known.delete(uid);
    return done;
  }

  /** One mail of theirs: its attachments added, notes left, and it filed — or why not now. */
  private async take(
    hh: string,
    session: MailboxSession,
    e: { uid: number; size: number },
    head: MailHead,
    sender: Sender,
    confirming: boolean,
    state: RoundState,
  ): Promise<MailOutcome & { error?: MailInError }> {
    const o = this.opts;
    const target = await whoseInbox(this.deps.db, hh, sender.memberId, this.now());
    if ('pause' in target) return { kind: 'waiting', why: target.pause };
    const mail = this.mailOf(session, e.uid, head);
    const filed = async (
      outcome: MailOutcome,
      keep: boolean,
    ): Promise<MailOutcome & { error?: MailInError }> => {
      if (await this.file(hh, session, e.uid, mail, keep).catch(() => false)) return outcome;
      return { kind: 'later', why: 'not filed', error: 'not_filed' };
    };

    // Too large to fetch: told, and kept.
    if (e.size > MAIL_IN_MAX_MESSAGE_BYTES) {
      await this.tell(target, mail, 'message_too_large');
      return filed({ kind: 'told', reasons: ['message_too_large'] }, true);
    }
    const source = await session.source(e.uid, MAIL_IN_MAX_MESSAGE_BYTES + 1);
    if (!source) return { kind: 'later', why: 'gone' };
    if (source.length > MAIL_IN_MAX_MESSAGE_BYTES) {
      await this.tell(target, mail, 'message_too_large');
      return filed({ kind: 'told', reasons: ['message_too_large'] }, true);
    }
    const a = await this.deps.reader.message(source, o.authservId, this.deps.maxBytes);
    if (a.state === 'unavailable') return { kind: 'later', why: 'the mail thread is not there' };
    if (a.state !== 'done') {
      // Broken, too slow or fatal to read: told, and kept — never deleted (F5).
      await this.tell(target, mail, 'unreadable');
      return filed({ kind: 'told', reasons: ['unreadable'] }, true);
    }
    // The whole mail must say what its header said: the same sender,
    // vouched for as before. One that does not is nobody's, for good (F3).
    if (a.head.from !== head.from || (o.authservId && a.head.auth !== 'pass')) {
      this.known.set(e.uid, { mismatch: true });
      return { kind: 'unknown' };
    }

    const skipped: MailSkippedCounts = {};
    const skip = (k: keyof MailSkippedCounts, n = 1) => {
      if (n > 0) skipped[k] = (skipped[k] ?? 0) + n;
    };
    skip('too_many', a.skipped.tooMany);
    skip('too_deep', a.skipped.tooDeep);
    const usable: Array<{ index: number; name: string; mime: string; content: Buffer }> = [];
    for (const [index, p] of a.parts.entries()) {
      if (p.tooLarge) {
        skip('too_large');
        continue;
      }
      if (!p.content || p.content.length === 0) continue;
      const content = p.content;
      const raw = p.name ? dropFileName(p.name).slice(0, 255) : '';
      const kind = watchKindOf(content.subarray(0, SNIFF_BYTES), raw);
      if (!kind) {
        skip('unsupported');
        continue;
      }
      // A picture in the body, small: a signature, a logo — left out on purpose.
      if (
        p.inline &&
        kind.mime.startsWith('image/') &&
        content.length < MAIL_IN_INLINE_SKIP_BYTES
      ) {
        continue;
      }
      const name = raw || `Email attachment ${index + 1}.${kind.ext}`;
      usable.push({ index, name, mime: kind.mime, content });
    }
    const keep = Object.keys(skipped).length > 0;
    const reasons: MailNoticeReason[] = [];
    if (keep) {
      await this.tell(target, mail, 'skipped', skipped);
      reasons.push('skipped');
    }
    if (usable.length === 0) {
      if (!keep && !confirming) {
        await this.tell(target, mail, 'nothing_to_add');
        reasons.push('nothing_to_add');
      }
      return filed(reasons.length ? { kind: 'told', reasons } : { kind: 'already' }, keep);
    }

    const items: string[] = [];
    for (const u of usable) {
      if (this.stopped) return { kind: 'later', why: 'the worker is stopping' };
      if (!(await this.lock.still())) return { kind: 'later', why: 'the lock was lost' };
      const r = await this.add(target, session, e.uid, head, u);
      if (r === 'already') continue;
      if ('id' in r) items.push(r.id);
      else if ('waiting' in r) {
        if (r.waiting === 'day_full') state.fullDay.add(sender.memberId);
        return { kind: 'waiting', why: r.waiting };
      } else if ('error' in r) return { kind: 'later', why: r.error, error: r.error };
      else return { kind: 'later', why: r.later };
    }
    return filed(items.length > 0 ? { kind: 'added', items } : { kind: 'already' }, keep);
  }

  /** One attachment: added, found added already, or why not now. */
  private async add(
    t: Target,
    session: MailboxSession,
    uid: number,
    head: MailHead,
    u: { index: number; name: string; mime: string; content: Buffer },
  ): Promise<
    'already' | { id: string } | { waiting: string } | { error: MailInError } | { later: string }
  > {
    const hh = t.householdId;
    const sha = sha256(u.content);
    const key = keyedUuid(this.deps.itemKey, [
      'uid',
      hh,
      session.uidValidity,
      String(uid),
      String(u.index),
      sha.toString('hex'),
    ]);
    const mailKey = head.messageId
      ? keyedUuid(this.deps.itemKey, [
          'mid',
          hh,
          head.messageId,
          String(u.index),
          sha.toString('hex'),
        ])
      : null;
    // Taken before — waiting, accepted, or removed by its person since (F8:
    // never added again while its mail waits to be filed) — by its UID's
    // key, or, the mailbox's UIDs having changed since, its Message-ID's.
    const prior = await withSystem(this.deps.db, hh, (trx) =>
      trx
        .selectFrom('incoming_file')
        .select('id')
        .where('requester_member_id', '=', t.memberId)
        .where('state', 'in', ['received', 'accepted', 'rejected'])
        .where((eb) =>
          mailKey
            ? eb.or([eb('idempotency_key', '=', key), eb('mail_key', '=', mailKey)])
            : eb('idempotency_key', '=', key),
        )
        .executeTakeFirst(),
    );
    if (prior) return 'already';
    // On its way when a worker stopped: removed, and added again.
    await clearStaleItem(this.deps, hh, key, mailKey, { keepRemoved: true });

    const placed = await withSystem(this.deps.db, hh, async (trx) => {
      // Still on, held as it is placed: an owner who turns it off mid-round stops it here.
      const on = await trx
        .selectFrom('mail_in')
        .select('enabled')
        .where('household_id', '=', hh)
        .forShare()
        .executeTakeFirst();
      if (!on?.enabled) return { later: 'email in was turned off' };
      return placeItem(trx, this.deps, t, 'email', this.now(), {
        name: u.name,
        key,
        mailKey,
        senderUnverified: this.opts.authservId === null,
      });
    });
    if ('later' in placed) return { later: placed.later };
    if ('pause' in placed) {
      if (placed.pause === 'sealed' || placed.pause === 'no_storage')
        return { error: placed.pause };
      return { waiting: placed.pause };
    }
    let stored;
    try {
      stored = await storeItem(placed, [u.content], this.deps.maxBytes, this.abort.signal);
    } catch (err) {
      await discardItem(this.deps.db, placed);
      return { later: `not stored: ${whyOf(err)}` };
    }
    if (!stored.sha256.equals(sha)) {
      await discardItem(this.deps.db, placed);
      return { later: 'changed as it was stored' };
    }
    if (!(await arriveItem(this.deps.db, placed, { mime: u.mime, ...stored }))) {
      await discardItem(this.deps.db, placed);
      return { later: 'its batch went as it arrived' };
    }
    return { id: placed.id };
  }
}
