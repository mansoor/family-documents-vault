import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import { sql } from 'kysely';
import {
  can,
  mailNoticeTitle,
  mailNoticeWords,
  mayFillFromScanner,
  refusalFor,
  WATCH_KEEP_DAYS_DEFAULT,
  WATCH_KEEP_DAYS_MAX,
  WATCH_KEPT_WARNING,
  WATCH_LEFT_IN_PLACE,
  WATCH_PROCESSED_FOREIGN,
  WATCH_PROCESSED_UNTOUCHED,
  WATCH_REJECTED_TITLE,
  WATCH_STALE_MS,
  WATCH_SYSTEM_DIRS,
  watchDirWords,
  watchKeptChangedWords,
  watchKeptLeftWords,
  watchKeptUntrackedWords,
  watchPathRefusal,
  watchPathTidy,
  watchPathWithin,
  watchPathWords,
  watchPauseOf,
  watchPauseWords,
  watchRefusedRootsWords,
  watchStuckWords,
  watchRejectWords,
  watchVerifyResult,
  type SettingsCheckView,
  type WatchCandidate,
  type WatchDirState,
  type WatchFolderInput,
  type WatchFolderView,
  type WatchNoticeView,
  type MailNoticeReason,
  type WatchPause,
  type WatchRejectReason,
  type WatchVerifyFound,
} from '@fdv/shared';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import type { SettingsCheckService } from '../settings-checks.js';

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
  roots: string[];
  own_dirs: string[];
  /** FDV_WATCH_ROOTS the worker refused (the O1 review, M4). */
  refused_roots: string[];
}

/** A household's folder chosen, as the worker last found it (0.9.0, O1). */
interface ChosenRow {
  dir: string | null;
  dir_state: WatchDirState | null;
  dir_seen: string | null;
  dir_checked_at: Date | null;
}

/** A Verify of the very path, passed this recently, lets it be turned on before the worker's next look. */
const VERIFIED_FOR_MS = 10 * 60_000;

const refused = (words: string) => new ApiError(422, 'watch_folder_path_refused', words);

export interface WatchFolderOptions {
  /** The worker's queue, and the questions an owner asks it (Verify, browse; O1). */
  checks?: SettingsCheckService;
  /** The clock, for the tests. */
  now?: () => number;
}

export class WatchFolderService {
  private readonly now: () => number;
  private readonly checks: SettingsCheckService | null;

  constructor(
    private readonly db: Db,
    opts: WatchFolderOptions | (() => number) = {},
  ) {
    const o = typeof opts === 'function' ? { now: opts } : opts;
    this.now = o.now ?? Date.now;
    this.checks = o.checks ?? null;
  }

  private async dirRow(): Promise<DirRow | null> {
    // Not tenant data (0068): the installation's, as instance is.
    const row = await this.db
      .selectFrom('watch_dir')
      .select(['dir', 'state', 'checked_at', 'roots', 'own_dirs', 'refused_roots'])
      .executeTakeFirst();
    return row ?? null;
  }

  private fresh(row: DirRow | null): WatchDirState | 'unknown' {
    if (!row) return 'unknown';
    return this.now() - row.checked_at.getTime() <= WATCH_STALE_MS ? row.state : 'unknown';
  }

  /** A folder chosen, as the worker found it: of that very path, and lately; else unknown. */
  private chosenState(row: ChosenRow, dir: string): WatchDirState | 'unknown' {
    if (row.dir_seen !== dir || !row.dir_state || !row.dir_checked_at) return 'unknown';
    return this.now() - row.dir_checked_at.getTime() <= WATCH_STALE_MS ? row.dir_state : 'unknown';
  }

  /** The folders a folder may be chosen inside, as the worker said them lately: none when it has not. */
  private roots(row: DirRow | null): string[] {
    if (!row || this.fresh(row) === 'unknown') return [];
    return row.roots;
  }

  /**
   * Whether a path may be chosen (O1): inside the roots, and none of the
   * vault's own folders nor above one — WATCH_SYSTEM_DIRS, and those the
   * worker said are its own. Refused in plain words (422); the worker asks
   * again, by the folder's real path, every round.
   */
  private checkPath(dir: string, row: DirRow | null, browsing = false): string {
    if (!row || this.fresh(row) === 'unknown') {
      throw new ApiError(
        409,
        'watch_folder_unavailable',
        'The worker hasn’t looked at the scanner folders in the last few minutes, so a folder can’t be chosen now. Check that it is running.',
      );
    }
    const tidy = watchPathTidy(dir.trim());
    const own = [...WATCH_SYSTEM_DIRS, ...row.own_dirs];
    // Browsing goes through a folder above one of the vault's own, never into one.
    const r = browsing
      ? (watchPathRefusal(tidy, row.roots, []) ??
        (own.some((o) => o.startsWith('/') && watchPathWithin(o, tidy)) ? 'vault_folder' : null))
      : watchPathRefusal(tidy, row.roots, own);
    if (r) throw refused(watchPathWords(r, row.roots));
    return tidy;
  }

  /**
   * Whether another household on this server uses the folder (the O1
   * review, L2): it, a folder inside it, or (unless only browsing through
   * it) one above it. Refused, saying nothing of the other household.
   */
  private async notElsewhere(p: Principal, dir: string, browsing: boolean): Promise<void> {
    const used = await withPrincipal(this.db, p, (trx) =>
      sql<{ used: boolean }>`select watch_dir_used_elsewhere(${dir}, ${browsing}) as used`.execute(
        trx,
      ),
    );
    if (used.rows[0]?.used) throw refused(watchPathWords('used_elsewhere'));
  }

  /** `/capabilities`' watch_folder: set, there, writable, and said so lately. */
  async available(): Promise<boolean> {
    return this.fresh(await this.dirRow()) === 'ready';
  }

  /** GET /watch-folder: the setting, the folder, whether it is paused and why. An owner's. */
  async get(p: Principal): Promise<WatchFolderView> {
    if (p.role !== 'owner') throw ownersOnly();
    const dir = await this.dirRow();
    const envState = this.fresh(dir);
    return withPrincipal(this.db, p, async (trx) => {
      const setting = await trx
        .selectFrom('watch_folder')
        .select([
          'enabled',
          'member_id',
          'paused_reason',
          'last_added_at',
          'stuck_files',
          'dir',
          'keep_days',
          'dir_state',
          'dir_seen',
          'dir_checked_at',
          'processed_foreign',
          'kept_left',
          'kept_changed',
          'kept_untracked',
        ])
        .where('household_id', '=', p.householdId)
        .executeTakeFirst();
      // The folder in use: the one chosen, as the worker found it; else FDV_WATCH_DIR.
      const inUse = setting?.dir ?? dir?.dir ?? null;
      const state = setting?.dir ? this.chosenState(setting, setting.dir) : envState;
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
          // As they are now; and what only the worker can tell, as it last
          // said — only while its word on the folder is fresh and ready: a
          // pause the worker said before it stopped, or before the folder
          // went, is not today's.
          paused =
            watchPauseOf(m ?? null, signIn ?? null, this.now()) ??
            (state === 'ready' ? setting.paused_reason : null);
        }
      } else if (setting?.enabled) {
        paused = 'removed';
      }
      const checkedAt = setting?.dir ? setting.dir_checked_at : (dir?.checked_at ?? null);
      return {
        available: state === 'ready',
        folder: {
          state,
          dir: inUse,
          checked_at: checkedAt ? checkedAt.toISOString() : null,
          words: watchDirWords(state, inUse),
        },
        choice: {
          dir: setting?.dir ?? null,
          default_dir: dir?.dir ?? null,
          roots: this.roots(dir),
          refused_roots: dir && this.fresh(dir) !== 'unknown' ? dir.refused_roots : [],
          refused_words:
            dir && this.fresh(dir) !== 'unknown' ? watchRefusedRootsWords(dir.refused_roots) : null,
        },
        processed_words: setting?.processed_foreign ? WATCH_PROCESSED_FOREIGN : null,
        kept_left: setting?.kept_left ?? 0,
        kept_left_words: watchKeptLeftWords(setting?.kept_left ?? 0),
        kept_changed: setting?.kept_changed ?? 0,
        kept_changed_words: watchKeptChangedWords(setting?.kept_changed ?? 0),
        kept_untracked: setting?.kept_untracked ?? 0,
        kept_untracked_words: watchKeptUntrackedWords(setting?.kept_untracked ?? 0),
        keep_days: setting?.keep_days ?? WATCH_KEEP_DAYS_DEFAULT,
        kept_warning: `${WATCH_KEPT_WARNING} ${WATCH_PROCESSED_UNTOUCHED}`,
        enabled: setting?.enabled ?? false,
        member_id: setting?.member_id ?? null,
        member_name: name,
        paused: paused ? { reason: paused, words: watchPauseWords(paused, name) } : null,
        last_added_at: setting?.last_added_at ? setting.last_added_at.toISOString() : null,
        stuck_files: setting?.stuck_files ?? 0,
        stuck_words: watchStuckWords(setting?.stuck_files ?? 0),
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
    if (
      input.keep_days !== undefined &&
      (!Number.isInteger(input.keep_days) ||
        input.keep_days < 0 ||
        input.keep_days > WATCH_KEEP_DAYS_MAX)
    ) {
      throw new ApiError(
        422,
        'validation_failed',
        `Scans are kept from 0 to ${WATCH_KEEP_DAYS_MAX} days.`,
      );
    }
    const dirRow = await this.dirRow();
    // A folder chosen (O1): refused here, before anything, outside the
    // roots or the vault's own — and again by the worker every round.
    const chosen =
      input.dir === undefined || input.dir === null ? input.dir : this.checkPath(input.dir, dirRow);
    if (typeof chosen === 'string') await this.notElsewhere(p, chosen, false);
    await withPrincipal(this.db, p, async (trx) => {
      const before = await trx
        .selectFrom('watch_folder')
        .select([
          'enabled',
          'member_id',
          'dir',
          'keep_days',
          'dir_state',
          'dir_seen',
          'dir_checked_at',
        ])
        .where('household_id', '=', p.householdId)
        .forUpdate()
        .executeTakeFirst();
      const dir = chosen === undefined ? (before?.dir ?? null) : chosen;
      if (input.enabled) {
        // Turned on only while the folder in use is ready: as the worker
        // found that very folder lately, or as a Verify of it just said.
        const state = dir
          ? before
            ? this.chosenState(before, dir)
            : 'unknown'
          : this.fresh(dirRow);
        if (state !== 'ready' && !(dir && (await this.verified(trx, dir)))) {
          throw notAvailable(watchDirWords(state, dir ?? dirRow?.dir ?? null));
        }
      }
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
        dir,
        keep_days: input.keep_days ?? before?.keep_days ?? WATCH_KEEP_DAYS_DEFAULT,
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
      // Which folder, and how long scans are kept (O1): the owners' to know.
      if (
        (before?.dir ?? null) !== dir ||
        (before?.keep_days ?? WATCH_KEEP_DAYS_DEFAULT) !== values.keep_days
      ) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'watch_folder.folder_changed',
          objectType: 'household',
          objectId: p.householdId,
          detail: { dir_chosen: dir !== null, keep_days: values.keep_days },
          ip: meta.ip,
        });
      }
    });
    return this.get(p);
  }

  /** A Verify of the very path passed, lately (O1): it may be turned on before the worker's next look. */
  private async verified(trx: Db, dir: string): Promise<boolean> {
    const rows = await trx
      .selectFrom('settings_check')
      .select(['result'])
      .where('kind', '=', 'folder')
      .where('path', '=', dir)
      .where('done_at', '>', new Date(this.now() - VERIFIED_FOR_MS))
      .orderBy('done_at', 'desc')
      .limit(1)
      .execute();
    const r = rows[0]?.result as unknown as WatchVerifyFound | undefined;
    return r !== undefined && watchVerifyResult(r).ok;
  }

  /**
   * POST /watch-folder/verify (O1): Verify a path, in the worker — refused
   * here first, as a Save would refuse it. The answer is the check's
   * (GET /settings-checks/{id}).
   */
  async verify(p: Principal, dir: string): Promise<SettingsCheckView> {
    if (p.role !== 'owner') throw ownersOnly();
    const path = this.checkPath(dir, await this.dirRow());
    await this.notElsewhere(p, path, false);
    return this.mustCheck().ask(p, 'folder', path);
  }

  /** POST /watch-folder/browse (O1): the folders inside a folder that may be chosen, from the worker. */
  async browse(p: Principal, dir: string): Promise<SettingsCheckView> {
    if (p.role !== 'owner') throw ownersOnly();
    const path = this.checkPath(dir, await this.dirRow(), true);
    await this.notElsewhere(p, path, true);
    return this.mustCheck().ask(p, 'browse', path);
  }

  private mustCheck(): SettingsCheckService {
    if (!this.checks) {
      throw new ApiError(503, 'unavailable', 'The worker can’t be asked just now.', {
        retriable: true,
      });
    }
    return this.checks;
  }

  /**
   * GET /watch-folder/notices: "A scanned file couldn't be added" — and,
   * since S4, "An email couldn't be added" (`source`) — the caller's own,
   * newest first. Whoever may add documents; nobody is given anybody else's,
   * an owner included (0068, 0069).
   */
  async notices(p: Principal): Promise<WatchNoticeView[]> {
    if (!can(p.role, 'document.add'))
      throw new ApiError(403, 'forbidden', refusalFor('document.add'));
    // What is done with an email once it is dealt with: as the household's
    // own mailbox is set up (O1), else as the worker says of the server's.
    const server = await this.db.selectFrom('mail_in_server').select('after').executeTakeFirst();
    return withPrincipal(this.db, p, async (trx) => {
      const { rows: own } = await sql<{ after: 'move' | 'delete' }>`
        select after from mail_in_box()`.execute(trx);
      const mailbox = own[0] ?? server;
      const rows = await trx
        .selectFrom('watch_notice')
        .select(['id', 'source', 'file_name', 'reason', 'left_in_place', 'skipped', 'created_at'])
        .where('member_id', '=', p.memberId)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(50)
        .execute();
      return rows.map((r) => {
        if (r.source === 'email') {
          const reason = r.reason as MailNoticeReason;
          return {
            id: r.id,
            source: 'email' as const,
            file_name: r.file_name,
            reason,
            left_in_place: false,
            title: mailNoticeTitle(reason),
            words: mailNoticeWords(
              reason,
              r.file_name,
              mailbox?.after ?? 'move',
              undefined,
              r.skipped,
            ),
            at: r.created_at.toISOString(),
          };
        }
        const reason = r.reason as WatchRejectReason;
        const name = r.file_name ?? 'A scanned file';
        return {
          id: r.id,
          source: 'scanner' as const,
          file_name: r.file_name,
          reason,
          left_in_place: r.left_in_place,
          title: WATCH_REJECTED_TITLE,
          words: r.left_in_place
            ? `${name}: ${watchRejectWords(reason)} ${WATCH_LEFT_IN_PLACE}`
            : `${name} was moved to the scanner folder’s rejected folder. ${watchRejectWords(reason)}`,
          at: r.created_at.toISOString(),
        };
      });
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
