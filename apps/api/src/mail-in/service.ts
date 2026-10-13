import { createHash, randomInt } from 'node:crypto';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import { sql } from 'kysely';
import {
  can,
  MAIL_IN_CODE_ALPHABET,
  MAIL_IN_CODE_MS,
  MAIL_IN_SENDER_WARNING,
  MAIL_IN_STALE_GRACE_MS,
  MAIL_IN_STALE_POLLS,
  mailInCountWords,
  mailInErrorWords,
  mailServerWords,
  mayFillFromScanner,
  refusalFor,
  type MailInCode,
  type MailInInput,
  type MailInMine,
  type MailInView,
} from '@fdv/shared';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';

/**
 * Email documents to the vault (0.8.0, S4, CAP-09): the owners' setting,
 * and what each person who may add documents is told.
 *
 * The worker checks the household mailbox (apps/worker/src/jobs/mail-in.ts)
 * and says how it has it (mail_in_server): set up or not, its address,
 * whether senders are checked — never its password, which the API never has.
 * Email in is offered — in /capabilities and here — only when it is set up
 * and the worker said so in its last two polls; otherwise Settings says why.
 *
 * An owner turns it on or off. The database keeps the setting, and what the
 * worker says of it, to the owners (mail_in_actor, 0069).
 *
 * Whoever may add documents — an owner, an adult, a teen; never a viewer,
 * never a guest — is told where to send from where, and confirms that
 * address: a code, made here and shown once, that they send from it in a
 * subject. Only its SHA-256 is kept, for a day; the worker compares. Their
 * confirmation is theirs alone (mail_in_address_actor, 0069).
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

/** The mailbox as the worker last said. */
interface ServerRow {
  configured: boolean;
  address: string | null;
  folder: string | null;
  after: 'move' | 'delete';
  sender_check: boolean;
  poll_seconds: number;
  checked_at: Date;
}

/** A code: FDV- and three groups of four, from an alphabet of 32 (60 bits). */
export function newMailInCode(): string {
  const group = () =>
    Array.from({ length: 4 }, () => MAIL_IN_CODE_ALPHABET[randomInt(32)] as string).join('');
  return `FDV-${group()}-${group()}-${group()}`;
}

export class MailInService {
  constructor(
    private readonly db: Db,
    /** The clock, for the tests. */
    private readonly now: () => number = Date.now,
  ) {}

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
        'poll_seconds',
        'checked_at',
      ])
      .executeTakeFirst();
    return row ?? null;
  }

  /** The mailbox's state, as of the worker's word: stale after two polls, and a minute. */
  private state(row: ServerRow | null): MailInView['server']['state'] {
    if (!row) return 'unknown';
    const stale = row.poll_seconds * 1000 * MAIL_IN_STALE_POLLS + MAIL_IN_STALE_GRACE_MS;
    if (this.now() - row.checked_at.getTime() > stale) return 'unknown';
    return row.configured ? 'ready' : 'not_configured';
  }

  /** `/capabilities`' mail_in: set up, and checked in the last two polls. */
  async available(): Promise<boolean> {
    return this.state(await this.serverRow()) === 'ready';
  }

  /** GET /mail-in: the setting, the mailbox, what the worker last said. An owner's. */
  async get(p: Principal): Promise<MailInView> {
    if (p.role !== 'owner') throw ownersOnly();
    const row = await this.serverRow();
    const state = this.state(row);
    const ready = state === 'ready' && row !== null;
    return withPrincipal(this.db, p, async (trx) => {
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
      return {
        available: ready,
        server: {
          state,
          address: ready ? row.address : null,
          folder: ready ? row.folder : null,
          after: row?.after ?? 'move',
          sender_check: ready ? row.sender_check : false,
          poll_seconds: row?.poll_seconds ?? null,
          checked_at: row ? row.checked_at.toISOString() : null,
          words: mailServerWords(state, row?.address ?? null, row?.folder ?? null),
        },
        enabled: s?.enabled ?? false,
        last_checked_at: s?.last_checked_at ? s.last_checked_at.toISOString() : null,
        last_error:
          s?.last_error && s.enabled
            ? {
                code: s.last_error,
                words: mailInErrorWords(s.last_error, row?.folder ?? null),
                at: (s.last_error_at ?? s.updated_at).toISOString(),
              }
            : null,
        last_added_at: s?.last_added_at ? s.last_added_at.toISOString() : null,
        ...counts,
        counts: s?.enabled ? mailInCountWords(counts) : [],
        sender_warning: ready && !row.sender_check ? MAIL_IN_SENDER_WARNING : null,
      };
    });
  }

  /**
   * PUT /mail-in: on or off. Only while it is offered may it be turned on
   * (409 mail_in_unavailable); it may always be turned off.
   */
  async put(p: Principal, input: MailInInput, meta: RequestMeta): Promise<MailInView> {
    if (p.role !== 'owner') throw ownersOnly();
    if (input.enabled) {
      const row = await this.serverRow();
      const state = this.state(row);
      if (state !== 'ready') {
        throw notAvailable(mailServerWords(state, row?.address ?? null, row?.folder ?? null));
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
   * and whether it is confirmed. Off — not set up, or not turned on — says so
   * (`on: false`) and names no mailbox.
   */
  async mine(p: Principal): Promise<MailInMine> {
    await this.mustAdd(p);
    const row = await this.serverRow();
    const ready = this.state(row) === 'ready' && row !== null;
    // Whether the household has it on: of the owners' row, that one word
    // and nothing else (mail_in_on, 0069), asked as the caller.
    const on = ready
      ? await withPrincipal(this.db, p, async (trx) => {
          const { rows } = await sql<{ on: boolean }>`select mail_in_on() as on`.execute(trx);
          return rows[0]?.on === true;
        })
      : false;
    return withPrincipal(this.db, p, async (trx) => {
      const account = await trx
        .selectFrom('account')
        .select('email')
        .where('id', '=', p.accountId)
        .executeTakeFirstOrThrow();
      const mine = await trx
        .selectFrom('mail_in_address')
        .select(['email', 'confirmed_at', 'code_expires_at'])
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
      return {
        on,
        address: on && row ? row.address : null,
        email: account.email,
        confirmed,
        code_expires_at: on ? live : null,
        sender_check: on && row ? row.sender_check : false,
      };
    });
  }

  /**
   * POST /mail-in/me/code: a new code, shown once, lasting a day; any
   * earlier one stops working. Only while email in is on.
   */
  async code(p: Principal): Promise<MailInCode> {
    const mine = await this.mine(p);
    if (!mine.on) {
      throw new ApiError(
        409,
        'mail_in_unavailable',
        'Email in isn’t turned on for this household.',
      );
    }
    const code = newMailInCode();
    const hash = createHash('sha256').update(code).digest();
    const expires = new Date(this.now() + MAIL_IN_CODE_MS);
    await withPrincipal(this.db, p, async (trx) => {
      await trx
        .insertInto('mail_in_address')
        .values({
          household_id: p.householdId,
          member_id: p.memberId,
          code_hash: hash,
          code_expires_at: expires,
          updated_at: new Date(),
        })
        .onConflict((oc) =>
          oc.columns(['household_id', 'member_id']).doUpdateSet({
            code_hash: hash,
            code_expires_at: expires,
            updated_at: new Date(),
          }),
        )
        .execute();
    });
    return { code, expires_at: expires.toISOString() };
  }
}
