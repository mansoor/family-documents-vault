import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  can,
  mayFillFromScanner,
  refusalFor,
  WATCH_REJECTED_TITLE,
  WATCH_STALE_MS,
  watchDirWords,
  watchPauseOf,
  watchPauseWords,
  watchRejectWords,
  type WatchCandidate,
  type WatchDirState,
  type WatchFolderInput,
  type WatchFolderView,
  type WatchNoticeView,
  type WatchPause,
} from '@fdv/shared';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';

/**
 * A watched folder for network scanners (0.8.0, S3, CAP-10): the owners'
 * setting, and what the person it fills is told.
 *
 * The worker looks in the folder (apps/worker/src/jobs/watch-folder.ts)
 * and says how it found it (watch_dir). The folder is offered — in
 * /capabilities and here — only when it is set, there and writable, and
 * the worker said so lately (WATCH_STALE_MS); otherwise Settings says why.
 *
 * An owner turns it on and chooses whose Inbox it fills: by default
 * themselves; anybody else of the family with a sign-in who may add
 * documents; never a viewer or a guest. The database keeps the setting to
 * the owners (watch_folder_actor, 0068) and the person to one who may add
 * (watch_folder_account_writes).
 *
 * While it is on and that person cannot have files added — gone, no
 * sign-in, no longer one who may add, locked, waiting after a restore — it
 * is paused, worked out here as it is asked, as the worker works it out
 * (watchPauseOf); the worker adds what only it can tell: the vault cannot
 * open their key, has nowhere to keep files, or the day's batch is full.
 *
 * "A scanned file couldn't be added" (watch_notice) is that person's alone:
 * never an owner who is not them. They read and dismiss their own.
 */

const ownersOnly = () =>
  new ApiError(403, 'forbidden', 'Only an owner can set up the scanner folder.');

/** The setting is an owner's: anybody else is refused (403). */
export function ownerOnly(p: Principal): void {
  if (p.role !== 'owner') throw ownersOnly();
}
const noNotice = () => new ApiError(404, 'not_found', 'That note is not here.');
const notAvailable = (words: string) =>
  new ApiError(409, 'watch_folder_unavailable', `The scanner folder can’t be turned on. ${words}`);
const notThem = () =>
  new ApiError(
    422,
    'validation_failed',
    'The scanner folder can fill the Inbox of someone in the family who signs in and adds documents: not a viewer.',
  );
const elsewhere = () =>
  new ApiError(
    409,
    'watch_folder_in_use',
    'Another household on this server already fills its Inboxes from the scanner folder.',
  );

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The folder as the worker last said, and whether that is lately. */
interface DirRow {
  dir: string | null;
  state: WatchDirState;
  checked_at: Date;
}

export class WatchFolderService {
  constructor(
    private readonly db: Db,
    /** The clock, for the tests. */
    private readonly now: () => number = Date.now,
  ) {}

  private async dirRow(): Promise<DirRow | null> {
    // Not tenant data (0068): the installation's, as instance is.
    const row = await this.db
      .selectFrom('watch_dir')
      .select(['dir', 'state', 'checked_at'])
      .executeTakeFirst();
    return row ?? null;
  }

  private fresh(row: DirRow | null): WatchDirState | 'unknown' {
    if (!row) return 'unknown';
    return this.now() - row.checked_at.getTime() <= WATCH_STALE_MS ? row.state : 'unknown';
  }

  /** `/capabilities`' watch_folder: set, there, writable, and said so lately. */
  async available(): Promise<boolean> {
    return this.fresh(await this.dirRow()) === 'ready';
  }

  /** GET /watch-folder: the setting, the folder, whether it is paused and why. An owner's. */
  async get(p: Principal): Promise<WatchFolderView> {
    if (p.role !== 'owner') throw ownersOnly();
    const dir = await this.dirRow();
    const state = this.fresh(dir);
    return withPrincipal(this.db, p, async (trx) => {
      const setting = await trx
        .selectFrom('watch_folder')
        .select(['enabled', 'member_id', 'paused_reason', 'last_added_at'])
        .where('household_id', '=', p.householdId)
        .executeTakeFirst();
      const candidates = await this.candidates(trx);
      let name: string | null = null;
      let paused: WatchPause | null = null;
      if (setting?.member_id) {
        const m = await trx
          .selectFrom('member')
          .select(['display_name', 'kind'])
          .where('id', '=', setting.member_id)
          .executeTakeFirst();
        name = m?.display_name ?? null;
        if (setting.enabled) {
          const signIn = await trx
            .selectFrom('account_household')
            .select(['role', 'suspended_at', 'suspended_until', 'suspend_reason'])
            .where('member_id', '=', setting.member_id)
            .executeTakeFirst();
          // As they are now; and what only the worker can tell, as it last said.
          paused = watchPauseOf(m ?? null, signIn ?? null, this.now()) ?? setting.paused_reason;
        }
      } else if (setting?.enabled) {
        paused = 'removed';
      }
      return {
        available: state === 'ready',
        folder: {
          state,
          dir: dir?.dir ?? null,
          checked_at: dir ? dir.checked_at.toISOString() : null,
          words: watchDirWords(state, dir?.dir ?? null),
        },
        enabled: setting?.enabled ?? false,
        member_id: setting?.member_id ?? null,
        member_name: name,
        paused: paused ? { reason: paused, words: watchPauseWords(paused, name) } : null,
        last_added_at: setting?.last_added_at ? setting.last_added_at.toISOString() : null,
        candidates,
      };
    });
  }

  /** Whose Inbox the folder may fill: of the family, with a sign-in, who may add documents. */
  private async candidates(trx: Db): Promise<WatchCandidate[]> {
    const rows = await trx
      .selectFrom('account_household as a')
      .innerJoin('member as m', (j) =>
        j.onRef('m.id', '=', 'a.member_id').onRef('m.household_id', '=', 'a.household_id'),
      )
      .select(['a.member_id', 'a.role', 'm.display_name', 'm.kind'])
      .orderBy('m.display_name')
      .orderBy('a.member_id')
      .execute();
    return rows
      .filter((r) => mayFillFromScanner(r.role, r.kind))
      .map((r) => ({ member_id: r.member_id, display_name: r.display_name, role: r.role }));
  }

  /**
   * PUT /watch-folder: on or off, and whose Inbox it fills. Turned on with
   * nobody named, it fills the owner's turning it on. Only while the folder
   * is offered may it be turned on (409 watch_folder_unavailable); it may
   * always be turned off.
   */
  async put(p: Principal, input: WatchFolderInput, meta: RequestMeta): Promise<WatchFolderView> {
    if (p.role !== 'owner') throw ownersOnly();
    if (input.member_id != null && !UUID.test(input.member_id)) throw notThem();
    if (input.enabled) {
      const dir = await this.dirRow();
      const state = this.fresh(dir);
      if (state !== 'ready') throw notAvailable(watchDirWords(state, dir?.dir ?? null));
    }
    await withPrincipal(this.db, p, async (trx) => {
      const before = await trx
        .selectFrom('watch_folder')
        .select(['enabled', 'member_id'])
        .where('household_id', '=', p.householdId)
        .forUpdate()
        .executeTakeFirst();
      // Turned on: whoever is named, or the owner turning it on. Turned off:
      // whoever it filled stays named, for the next time.
      const member = input.enabled
        ? (input.member_id ?? p.memberId)
        : (input.member_id ?? before?.member_id ?? null);
      if (input.enabled || (member !== null && member !== before?.member_id)) {
        // Somebody who may add documents, as they are now, held until this commits.
        const them = await trx
          .selectFrom('account_household as a')
          .innerJoin('member as m', (j) =>
            j.onRef('m.id', '=', 'a.member_id').onRef('m.household_id', '=', 'a.household_id'),
          )
          .select(['a.role', 'm.kind'])
          .where('a.member_id', '=', member as string)
          .forShare()
          .executeTakeFirst();
        if (!them || !mayFillFromScanner(them.role, them.kind)) throw notThem();
      }
      const values = {
        enabled: input.enabled,
        member_id: member,
        updated_by: p.accountId,
        updated_at: new Date(),
      };
      try {
        if (before) {
          await trx
            .updateTable('watch_folder')
            .set(values)
            .where('household_id', '=', p.householdId)
            .execute();
        } else {
          await trx
            .insertInto('watch_folder')
            .values({ household_id: p.householdId, ...values })
            .execute();
        }
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw elsewhere();
        throw err;
      }
      if (before?.enabled !== input.enabled || before?.member_id !== member) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'watch_folder.changed',
          // About whose Inbox it fills, or filled: told to them too.
          objectType: 'member',
          objectId: member,
          detail: { enabled: input.enabled },
          ip: meta.ip,
        });
      }
    });
    return this.get(p);
  }

  /**
   * GET /watch-folder/notices: "A scanned file couldn't be added" — the
   * caller's own, newest first. Whoever may add documents; nobody is given
   * anybody else's, an owner included (0068).
   */
  async notices(p: Principal): Promise<WatchNoticeView[]> {
    if (!can(p.role, 'document.add'))
      throw new ApiError(403, 'forbidden', refusalFor('document.add'));
    return withPrincipal(this.db, p, async (trx) => {
      const rows = await trx
        .selectFrom('watch_notice')
        .select(['id', 'file_name', 'reason', 'created_at'])
        .where('member_id', '=', p.memberId)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(50)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        file_name: r.file_name,
        reason: r.reason,
        title: WATCH_REJECTED_TITLE,
        words: `${r.file_name} was moved to the scanner folder’s rejected folder. ${watchRejectWords(r.reason)}`,
        at: r.created_at.toISOString(),
      }));
    });
  }

  /** POST /watch-folder/notices/{id}/dismiss: one of the caller's own, gone (`204`; `404` otherwise). */
  async dismiss(p: Principal, id: string): Promise<void> {
    if (!can(p.role, 'document.add'))
      throw new ApiError(403, 'forbidden', refusalFor('document.add'));
    if (!UUID.test(id)) throw noNotice();
    await withPrincipal(this.db, p, async (trx) => {
      const gone = await trx
        .deleteFrom('watch_notice')
        .where('id', '=', id)
        .where('member_id', '=', p.memberId)
        .returning('id')
        .executeTakeFirst();
      if (!gone) throw noNotice();
    });
  }
}
