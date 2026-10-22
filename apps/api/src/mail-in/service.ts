import { createHash, createHmac, randomInt } from 'node:crypto';
import { sealMailboxPassword } from '@fdv/crypto';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import { isIP } from 'node:net';
import { sql } from 'kysely';
import {
  can,
  isLoopbackName,
  isPrivateAddress,
  MAIL_IN_AUTHSERV_HINT,
  MAIL_IN_CODE_ALPHABET,
  MAIL_IN_EMAILED_CODE_PATTERN,
  MAIL_IN_NO_CONFIRM,
  MAIL_IN_STALE_GRACE_MS,
  MAIL_IN_STALE_POLLS,
  mailFilingWords,
  mailInCountWords,
  mailInAddressRefused,
  mailInErrorWords,
  mailInSenderWarning,
  mailServerWords,
  maskEmail,
  mayFillFromScanner,
  refusalFor,
  type MailInCode,
  type MailInConfirmWays,
  type MailInEmailed,
  type MailInFiling,
  type MailInInput,
  type MailInMailboxInput,
  type MailInMine,
  type MailInSource,
  type MailInView,
  type SettingsCheckView,
} from '@fdv/shared';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import type { MailRequest } from '../mail-job.js';
import type { SettingsCheckService } from '../settings-checks.js';

/**
 * Email documents to the vault (0.8.0, S4, CAP-09): the owners' setting,
 * and what each person who may add documents is told.
 *
 * The worker checks the household mailbox (apps/worker/src/jobs/mail-in.ts)
 * and says how it has it (mail_in_server): set up or not, its address,
 * whether senders are checked, how mail is filed — never its password,
 * which the API never has. Email in is offered — in /capabilities and here
 * — only when it is set up and the worker said so in its last two polls;
 * otherwise Settings says why.
 *
 * An owner turns it on or off. The database keeps the setting, and what the
 * worker says of it, to the owners (mail_in_actor, 0069).
 *
 * Whoever may add documents — an owner, an adult, a teen; never a viewer,
 * never a guest — is told where to send from where, and confirms that
 * address once, in one of two ways that prove it (the review, F1):
 *
 *  - while the mailbox checks senders (FDV_MAIL_IN_AUTHSERV_ID), a code
 *    made here, shown once, that they send FROM the address in a subject
 *    (a mailto link has it): the worker confirms it only on the provider's
 *    word that the mail came from there. Its SHA-256 is kept, for a day.
 *  - with the operator's mail server (FDV_SMTP_URL), a code emailed TO the
 *    address, which they type in: an HMAC of it kept, for a day, used once,
 *    five tries; a code a minute and five a day.
 *
 * With neither, nobody can confirm, and both pages say why. The codes are
 * made and checked by the database's own functions (mail_in_issue_code,
 * mail_in_check_code, 0069): nobody signed in writes an address's row.
 */

const ownersOnly = () => new ApiError(403, 'forbidden', 'Only an owner can set up email in.');
const notAvailable = (words: string) =>
  new ApiError(409, 'mail_in_unavailable', `Email in can’t be turned on. ${words}`);
const elsewhere = () =>
  new ApiError(
    409,
    'mail_in_in_use',
    'Another household on this server already fills its Inboxes from the household mailbox.',
  );
const mayNot = () => new ApiError(403, 'forbidden', refusalFor('document.add'));
const off = () =>
  new ApiError(409, 'mail_in_unavailable', 'Email in isn’t turned on for this household.');
const tooOften = (code: string) =>
  new ApiError(
    429,
    'rate_limited',
    code === 'too_soon'
      ? 'A code was made less than a minute ago. Wait a moment, then ask again.'
      : 'Five codes have been made today. Try again tomorrow.',
    { retriable: true, retryAfter: code === 'too_soon' ? 60 : 3600 },
  );

/** What the API's key for emailed codes is derived for. */
export const MAIL_IN_CODE_KEY_PURPOSE = 'mail-in-code-hmac';

/** The mailbox as the worker last said. */
interface ServerRow {
  configured: boolean;
  address: string | null;
  folder: string | null;
  after: 'move' | 'delete';
  sender_check: boolean;
  filing: MailInFiling | null;
  poll_seconds: number;
  checked_at: Date;
  /** Households' own mailboxes with a password set, as the worker counted them (0076, O1). */
  mailboxes: number;
  /** FDV_MAIL_IN_ALLOWED_PORTS and FDV_MAIL_IN_ALLOW_PRIVATE, as the worker said (the O1 review, M3). */
  allowed_ports: number[];
  allow_private: boolean;
}

/** A control character: never in a sign-in or a folder name (the O1 review, L4). */
const CONTROL = /\p{Cc}/u;

const letters = (n: number) =>
  Array.from({ length: n }, () => MAIL_IN_CODE_ALPHABET[randomInt(32)] as string).join('');

/** A code to send FROM an address: FDV- and three groups of four, from an alphabet of 32 (60 bits). */
export function newMailInCode(): string {
  return `FDV-${letters(4)}-${letters(4)}-${letters(4)}`;
}

/** A code emailed TO an address, to type in: two groups of four (40 bits; five tries). */
export function newEmailedCode(): string {
  return `${letters(4)}-${letters(4)}`;
}

export interface MailInOptions {
  /** The operator's mail server (FDV_SMTP_URL): a code emailed to an address. Null without one. */
  mail?: ((m: MailRequest) => Promise<void>) | null;
  /** The key an emailed code is HMACed under (deriveKey(master, MAIL_IN_CODE_KEY_PURPOSE)). */
  codeKey?: Buffer;
  /**
   * The key a mailbox's app password set in Settings is sealed under
   * (deriveKey(master, MAILBOX_PASSWORD_PURPOSE), 0.9.0, O1). Without it
   * none can be set.
   */
  mailboxKey?: Buffer;
  /** The worker's queue, for Test the mailbox (O1). */
  checks?: SettingsCheckService;
  /** The clock, for the tests. */
  now?: () => number;
}

/** The household's own mailbox, as the API reads it: never its password, only whether one is set. */
interface BoxRow {
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  folder: string;
  after: 'move' | 'delete';
  authserv_id: string | null;
  poll_seconds: number;
  updated_at: Date;
}

/** The mailbox checked for a household: its own (O1), else the server's. */
interface Effective {
  source: MailInSource;
  state: MailInView['server']['state'];
  address: string | null;
  folder: string | null;
  after: 'move' | 'delete';
  sender_check: boolean;
  poll_seconds: number | null;
}

/** A mail server's name: letters, digits, dots and dashes (as 0076 checks). */
const HOST = /^[A-Za-z0-9.-]{1,253}$/;

export class MailInService {
  private readonly now: () => number;
  private readonly mail: ((m: MailRequest) => Promise<void>) | null;
  private readonly codeKey: Buffer;
  private readonly mailboxKey: Buffer | null;
  private readonly checks: SettingsCheckService | null;

  constructor(
    private readonly db: Db,
    opts: MailInOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.mail = opts.mail ?? null;
    this.codeKey = opts.codeKey ?? Buffer.alloc(32);
    this.mailboxKey = opts.mailboxKey ?? null;
    this.checks = opts.checks ?? null;
  }

  private async serverRow(): Promise<ServerRow | null> {
    // Not tenant data (0069): the installation's, as watch_dir is.
    const row = await this.db
      .selectFrom('mail_in_server')
      .select([
        'configured',
        'address',
        'folder',
        'after',
        'sender_check',
        'filing',
        'poll_seconds',
        'checked_at',
        'mailboxes',
        'allowed_ports',
        'allow_private',
      ])
      .executeTakeFirst();
    return row ?? null;
  }

  /** The worker has said so within two polls and a minute: it is running and checking. */
  private workerFresh(row: ServerRow | null, pollSeconds?: number): boolean {
    if (!row) return false;
    const poll = Math.max(row.poll_seconds, pollSeconds ?? 0);
    const stale = poll * 1000 * MAIL_IN_STALE_POLLS + MAIL_IN_STALE_GRACE_MS;
    return this.now() - row.checked_at.getTime() <= stale;
  }

  /** The mailbox's state, as of the worker's word: stale after two polls, and a minute. */
  private state(row: ServerRow | null): MailInView['server']['state'] {
    if (!row || !this.workerFresh(row)) return 'unknown';
    return row.configured ? 'ready' : 'not_configured';
  }

  /** The household's own mailbox (O1), as an owner reads it: never its password. */
  private async boxRow(trx: Db): Promise<BoxRow | null> {
    const row = await trx
      .selectFrom('mail_in_mailbox')
      .select([
        'host',
        'port',
        'username',
        'folder',
        'after',
        'authserv_id',
        'poll_seconds',
        'updated_at',
        sql<boolean>`password_encrypted is not null`.as('has_password'),
      ])
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Which mailbox is checked for the household, and how it is (O1): its
   * own, set up in Settings, overriding FDV_MAIL_IN_* — ready once it has a
   * password and the worker is running — else the server's.
   */
  private effective(server: ServerRow | null, own: BoxRow | null): Effective {
    if (own) {
      const fresh = this.workerFresh(server, own.poll_seconds);
      return {
        source: 'settings',
        state: !fresh ? 'unknown' : own.has_password ? 'ready' : 'not_configured',
        address: /^[^\s@]+@[^\s@]+$/.test(own.username) ? own.username : null,
        folder: own.folder,
        after: own.after,
        sender_check: own.authserv_id !== null,
        poll_seconds: own.poll_seconds,
      };
    }
    const state = this.state(server);
    return {
      source: state === 'ready' ? 'server' : 'none',
      state,
      address: server?.address ?? null,
      folder: server?.folder ?? null,
      after: server?.after ?? 'move',
      sender_check: server?.sender_check ?? false,
      poll_seconds: server?.poll_seconds ?? null,
    };
  }

  /** How an address may be confirmed now (F1). */
  private ways(senderCheck: boolean, ready: boolean): MailInConfirmWays {
    return { send_from: ready && senderCheck, emailed: this.mail !== null };
  }

  /**
   * `/capabilities`' email_ingest: a mailbox set up — the server's, or one
   * a household set up in Settings (O1, counted by the worker) — and
   * checked in the last two polls.
   */
  async available(): Promise<boolean> {
    const row = await this.serverRow();
    return this.workerFresh(row) && row !== null && (row.configured || row.mailboxes > 0);
  }

  /** GET /mail-in: the setting, the mailbox, what the worker last said. An owner's. */
  async get(p: Principal): Promise<MailInView> {
    if (p.role !== 'owner') throw ownersOnly();
    const row = await this.serverRow();
    return withPrincipal(this.db, p, async (trx) => {
      const own = await this.boxRow(trx);
      const e = this.effective(row, own);
      const ready = e.state === 'ready';
      const confirm = this.ways(e.sender_check, ready);
      const s = await trx
        .selectFrom('mail_in')
        .selectAll()
        .where('household_id', '=', p.householdId)
        .executeTakeFirst();
      const counts = {
        unknown_senders: s?.unknown_senders ?? 0,
        unverified: s?.unverified ?? 0,
        waiting: s?.waiting ?? 0,
      };
      // How mail is filed, as the server of the mailbox in use allows.
      const filing = ready ? (own ? (s?.filing ?? null) : (row?.filing ?? null)) : null;
      return {
        available: ready,
        server: {
          state: e.state,
          address: ready ? e.address : null,
          folder: ready ? e.folder : null,
          after: e.after,
          sender_check: ready ? e.sender_check : false,
          filing,
          filing_words: ready ? mailFilingWords(filing, e.after, e.source) : null,
          poll_seconds: e.poll_seconds,
          checked_at: row ? row.checked_at.toISOString() : null,
          words: mailServerWords(e.state, e.address, e.folder, e.source),
        },
        enabled: s?.enabled ?? false,
        last_checked_at: s?.last_checked_at ? s.last_checked_at.toISOString() : null,
        last_error:
          s?.last_error && s.enabled
            ? {
                code: s.last_error,
                words: mailInErrorWords(
                  s.last_error,
                  e.folder,
                  own ? 'settings' : 'server',
                  row?.allowed_ports,
                ),
                at: (s.last_error_at ?? s.updated_at).toISOString(),
              }
            : null,
        last_added_at: s?.last_added_at ? s.last_added_at.toISOString() : null,
        ...counts,
        counts: s?.enabled ? mailInCountWords(counts) : [],
        sender_warning:
          ready && !e.sender_check ? mailInSenderWarning(own ? 'settings' : 'server') : null,
        confirm,
        confirm_warning:
          ready && !confirm.send_from && !confirm.emailed ? MAIL_IN_NO_CONFIRM : null,
        source: own ? 'settings' : e.source,
        mailbox: own
          ? {
              host: own.host,
              port: own.port,
              username: own.username,
              password: own.has_password ? 'set' : 'not_set',
              folder: own.folder,
              after: own.after,
              authserv_id: own.authserv_id,
              poll_seconds: own.poll_seconds,
              updated_at: own.updated_at.toISOString(),
            }
          : null,
      };
    });
  }

  /**
   * PUT /mail-in/mailbox (O1): the household mailbox, set up in Settings —
   * it overrides FDV_MAIL_IN_*. The app password, when given, is sealed
   * under a key derived from the master key with the household bound in;
   * left out, the one set is kept. It is never returned, logged, or put in
   * anything but its sealed column.
   */
  async putMailbox(
    p: Principal,
    input: MailInMailboxInput,
    meta: RequestMeta,
  ): Promise<MailInView> {
    if (p.role !== 'owner') throw ownersOnly();
    const host = input.host.trim();
    const bad = (words: string) => new ApiError(422, 'validation_failed', words);
    if (!HOST.test(host)) throw bad('Type the mail server’s name, such as imap.gmail.com.');
    const authserv = input.authserv_id?.trim() || null;
    if (authserv !== null && !HOST.test(authserv)) {
      throw bad(`Type the authserv-id as your provider writes it (${MAIL_IN_AUTHSERV_HINT}).`);
    }
    const username = input.username.trim();
    if (!username) throw bad('Type the mailbox’s sign-in: usually its address.');
    if (CONTROL.test(username)) throw bad('The sign-in can’t have a line break or a tab in it.');
    const folder = input.folder.trim() || 'INBOX';
    if (CONTROL.test(folder)) throw bad('The folder can’t have a line break or a tab in it.');
    // Where the worker may connect for a mailbox set up here (the O1 review,
    // M3): said now where it can be, and checked again by the worker, by
    // every address the name resolves to, each time it connects.
    const server = await this.serverRow();
    const ports = server?.allowed_ports?.length ? server.allowed_ports : [993];
    const inside =
      !(server?.allow_private ?? false) &&
      (isLoopbackName(host) || (isIP(host) !== 0 && isPrivateAddress(host)));
    if (!ports.includes(input.port) || inside) {
      throw new ApiError(422, 'mailbox_address_refused', mailInAddressRefused(ports));
    }
    const key = this.mailboxKey;
    if (input.password !== undefined && !key) {
      throw new ApiError(503, 'unavailable', 'The vault can’t keep a password just now.');
    }
    await withPrincipal(this.db, p, async (trx) => {
      const before = await trx
        .selectFrom('mail_in_mailbox')
        .select([
          'household_id',
          'host',
          'port',
          'username',
          sql<boolean>`password_encrypted is not null`.as('has_password'),
        ])
        .forUpdate()
        .executeTakeFirst();
      // The password was kept for one server, port and sign-in alone (H1):
      // any of them changed, it is typed again, for the new one.
      const hostChanged =
        before !== undefined &&
        (before.host.toLowerCase() !== host.toLowerCase() || before.port !== input.port);
      const userChanged = before !== undefined && before.username !== username;
      if (before?.has_password && (hostChanged || userChanged) && input.password === undefined) {
        throw new ApiError(
          422,
          'mailbox_password_needed',
          'Type the app password again for the new server.',
        );
      }
      const values = {
        host,
        port: input.port,
        username,
        folder,
        after: input.after,
        authserv_id: authserv,
        poll_seconds: input.poll_seconds,
        updated_by: p.accountId,
        updated_at: new Date(),
        ...(input.password !== undefined && key
          ? {
              password_encrypted: sealMailboxPassword(key, input.password, p.householdId, {
                host,
                port: input.port,
                username,
              }),
            }
          : {}),
      };
      if (before) {
        await trx.updateTable('mail_in_mailbox').set(values).execute();
      } else {
        await trx
          .insertInto('mail_in_mailbox')
          .values({ household_id: p.householdId, ...values })
          .execute();
      }
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'mail_in.mailbox_saved',
        objectType: 'household',
        objectId: p.householdId,
        // Whether the password, the server or the sign-in changed: never
        // the password, the server or the sign-in themselves.
        detail: {
          password_changed: input.password !== undefined,
          host_changed: hostChanged,
          user_changed: userChanged,
        },
        ip: meta.ip,
      });
    });
    return this.get(p);
  }

  /** DELETE /mail-in/mailbox (O1): the household's own mailbox gone, password and all; FDV_MAIL_IN_* again. */
  async removeMailbox(p: Principal, meta: RequestMeta): Promise<MailInView> {
    if (p.role !== 'owner') throw ownersOnly();
    await withPrincipal(this.db, p, async (trx) => {
      const gone = await trx.deleteFrom('mail_in_mailbox').returning('household_id').execute();
      if (gone.length > 0) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'mail_in.mailbox_removed',
          objectType: 'household',
          objectId: p.householdId,
          detail: {},
          ip: meta.ip,
        });
      }
    });
    return this.get(p);
  }

  /**
   * POST /mail-in/mailbox/test (O1): Test the mailbox, in the worker —
   * the one set up here, else the server's. Read-only: it signs in, opens
   * the folder with EXAMINE and reads the newest three messages'
   * Authentication-Results with BODY.PEEK. The answer is the check's.
   */
  async test(p: Principal): Promise<SettingsCheckView> {
    if (p.role !== 'owner') throw ownersOnly();
    if (!this.checks) {
      throw new ApiError(503, 'unavailable', 'The worker can’t be asked just now.', {
        retriable: true,
      });
    }
    return this.checks.ask(p, 'mailbox', null);
  }

  /**
   * PUT /mail-in: on or off. Only while it is offered may it be turned on
   * (409 mail_in_unavailable); it may always be turned off.
   */
  async put(p: Principal, input: MailInInput, meta: RequestMeta): Promise<MailInView> {
    if (p.role !== 'owner') throw ownersOnly();
    if (input.enabled) {
      const row = await this.serverRow();
      const e = await withPrincipal(this.db, p, async (trx) =>
        this.effective(row, await this.boxRow(trx)),
      );
      if (e.state !== 'ready') {
        throw notAvailable(mailServerWords(e.state, e.address, e.folder, e.source));
      }
    }
    await withPrincipal(this.db, p, async (trx) => {
      const before = await trx
        .selectFrom('mail_in')
        .select(['enabled'])
        .where('household_id', '=', p.householdId)
        .forUpdate()
        .executeTakeFirst();
      const values = { enabled: input.enabled, updated_by: p.accountId, updated_at: new Date() };
      try {
        if (before) {
          await trx
            .updateTable('mail_in')
            .set(values)
            .where('household_id', '=', p.householdId)
            .execute();
        } else {
          await trx
            .insertInto('mail_in')
            .values({ household_id: p.householdId, ...values })
            .execute();
        }
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw elsewhere();
        throw err;
      }
      if ((before?.enabled ?? false) !== input.enabled) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'mail_in.changed',
          objectType: 'household',
          objectId: p.householdId,
          detail: { enabled: input.enabled },
          ip: meta.ip,
        });
      }
    });
    return this.get(p);
  }

  /** Whoever may add documents: of the family, a role that adds; nobody else. */
  private async mustAdd(p: Principal): Promise<void> {
    if (!can(p.role, 'document.add')) throw mayNot();
    const kind = await withPrincipal(this.db, p, (trx) =>
      trx.selectFrom('member').select('kind').where('id', '=', p.memberId).executeTakeFirst(),
    );
    if (!kind || !mayFillFromScanner(p.role, kind.kind)) throw mayNot();
  }

  /**
   * GET /mail-in/me: where the caller sends documents, from which address,
   * whether it is confirmed and how it may be, and what of theirs was left
   * in the mailbox. Off — not set up, or not turned on — says so (`on:
   * false`) and names no mailbox.
   */
  /**
   * Where the caller's household's mail goes, for whoever may add (O1): its
   * own mailbox, of which only that much (mail_in_box, 0076) — else the
   * server's.
   */
  private async publicBox(
    p: Principal,
    row: ServerRow | null,
  ): Promise<{
    ready: boolean;
    address: string | null;
    after: 'move' | 'delete';
    sender_check: boolean;
  }> {
    const own = await withPrincipal(this.db, p, async (trx) => {
      const { rows } = await sql<{
        configured: boolean;
        address: string | null;
        after: 'move' | 'delete';
        sender_check: boolean;
      }>`select * from mail_in_box()`.execute(trx);
      return rows[0] ?? null;
    });
    if (own) {
      return {
        ready: own.configured && this.workerFresh(row),
        address: own.address,
        after: own.after,
        sender_check: own.sender_check,
      };
    }
    return {
      ready: this.state(row) === 'ready',
      address: row?.address ?? null,
      after: row?.after ?? 'move',
      sender_check: row?.sender_check ?? false,
    };
  }

  /** What is done with an email once it is dealt with, for the household (O1): its mailbox's word. */
  async afterFor(p: Principal): Promise<'move' | 'delete'> {
    return (await this.publicBox(p, await this.serverRow())).after;
  }

  async mine(p: Principal): Promise<MailInMine> {
    await this.mustAdd(p);
    const box = await this.publicBox(p, await this.serverRow());
    const ready = box.ready;
    // Whether the household has it on: of the owners' row, that one word
    // and nothing else (mail_in_on, 0069), asked as the caller.
    const on = ready
      ? await withPrincipal(this.db, p, async (trx) => {
          const { rows } = await sql<{ on: boolean }>`select mail_in_on() as on`.execute(trx);
          return rows[0]?.on === true;
        })
      : false;
    const confirm = this.ways(box.sender_check, ready);
    return withPrincipal(this.db, p, async (trx) => {
      const account = await trx
        .selectFrom('account')
        .select('email')
        .where('id', '=', p.accountId)
        .executeTakeFirstOrThrow();
      const mine = await trx
        .selectFrom('mail_in_address')
        .select([
          'email',
          'confirmed_at',
          'code_kind',
          'code_expires_at',
          'held_unverified',
          'held_unconfirmed',
          'held_last_at',
        ])
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      const confirmed =
        mine?.confirmed_at != null &&
        typeof mine.email === 'string' &&
        mine.email.toLowerCase() === account.email.toLowerCase();
      const live =
        !confirmed && mine?.code_expires_at && mine.code_expires_at.getTime() > this.now()
          ? mine.code_expires_at.toISOString()
          : null;
      const held =
        on && mine && (mine.held_unverified > 0 || mine.held_unconfirmed > 0)
          ? {
              unverified: mine.held_unverified,
              unconfirmed: mine.held_unconfirmed,
              last_at: mine.held_last_at ? mine.held_last_at.toISOString() : null,
            }
          : null;
      return {
        on,
        address: on ? box.address : null,
        email: account.email,
        confirmed,
        code_expires_at: on ? live : null,
        code_kind: on && live ? (mine?.code_kind ?? null) : null,
        sender_check: on ? box.sender_check : false,
        confirm: on ? confirm : { send_from: false, emailed: false },
        confirm_words:
          on && !confirmed && !confirm.send_from && !confirm.emailed ? MAIL_IN_NO_CONFIRM : null,
        held,
      };
    });
  }

  /** A code issued by the database's own function, or why not: too soon, too many. */
  private async issue(p: Principal, hash: Buffer, kind: 'send' | 'enter'): Promise<void> {
    const r = await withPrincipal(this.db, p, async (trx) => {
      const { rows } = await sql<{
        r: string;
      }>`select mail_in_issue_code(${hash}, ${kind}) as r`.execute(trx);
      return rows[0]?.r ?? 'none';
    });
    if (r !== 'ok') throw tooOften(r);
  }

  /**
   * POST /mail-in/me/code: a new code to send FROM the caller's address,
   * shown once, lasting a day, and a mailto link with it in the subject;
   * any earlier code stops working. Only while email in is on and the
   * mailbox checks senders (F1).
   */
  async code(p: Principal): Promise<MailInCode> {
    const mine = await this.mine(p);
    if (!mine.on || !mine.address) throw off();
    if (!mine.confirm.send_from) {
      throw new ApiError(
        409,
        'mail_in_no_sender_check',
        'An address is confirmed by sending a code from it only while the mailbox checks senders (FDV_MAIL_IN_AUTHSERV_ID).',
      );
    }
    const code = newMailInCode();
    await this.issue(p, createHash('sha256').update(code).digest(), 'send');
    return {
      code,
      expires_at: new Date(this.now() + 24 * 60 * 60_000).toISOString(),
      mailto: `mailto:${encodeURIComponent(mine.address)}?subject=${encodeURIComponent(code)}`,
    };
  }

  /** An emailed code, as kept: an HMAC under the API's own key. */
  private emailedHash(code: string): Buffer {
    const plain = code.trim().toUpperCase().replace(/-/g, '');
    return createHmac('sha256', this.codeKey).update(plain).digest();
  }

  /**
   * POST /mail-in/me/email-code: a code emailed TO the caller's sign-in
   * address through the operator's mail server, to type in (F1). A code a
   * minute, five a day (429).
   */
  async emailCode(p: Principal): Promise<MailInEmailed> {
    const mine = await this.mine(p);
    if (!mine.on) throw off();
    if (!this.mail) {
      throw new ApiError(
        409,
        'mail_in_no_operator_mail',
        'The vault can’t email a code: the server has no mail server of its own (FDV_SMTP_URL).',
      );
    }
    const code = newEmailedCode();
    await this.issue(p, this.emailedHash(code), 'enter');
    await this.mail({
      householdId: p.householdId,
      to: mine.email,
      subject: 'Your code to email documents to the vault',
      text: `Your code is ${code}. Type it into the vault, where it asked for it, within a day. If you didn’t ask for it, ignore this email.`,
    });
    return {
      sent_to: maskEmail(mine.email),
      expires_at: new Date(this.now() + 24 * 60 * 60_000).toISOString(),
    };
  }

  /**
   * POST /mail-in/me/confirm: the emailed code, typed in. Right: the
   * address is confirmed and the code used up (`204`). Wrong: `422`, one of
   * five tries spent; expired, used up, or tried five times: `410`.
   */
  async confirm(p: Principal, code: string): Promise<void> {
    await this.mustAdd(p);
    if (!MAIL_IN_EMAILED_CODE_PATTERN.test(code.trim())) {
      throw new ApiError(422, 'code_wrong', 'That isn’t the code. Check it, and try again.');
    }
    const r = await withPrincipal(this.db, p, async (trx) => {
      const { rows } = await sql<{
        r: string;
      }>`select mail_in_check_code(${this.emailedHash(code)}) as r`.execute(trx);
      return rows[0]?.r ?? 'none';
    });
    if (r === 'confirmed') return;
    if (r === 'wrong') {
      throw new ApiError(422, 'code_wrong', 'That isn’t the code. Check it, and try again.');
    }
    throw new ApiError(
      410,
      'code_gone',
      r === 'locked'
        ? 'That code was tried too many times. Ask for a new one.'
        : 'That code has expired, or was used already. Ask for a new one.',
    );
  }
}
