import { actAs, withSystem, type Db } from '@fdv/db';
import {
  APP_FILE_READY_JOB,
  lockInEffect,
  seesAdults,
  suspensionInEffect,
  type Role,
} from '@fdv/shared';
import type { Principal } from '../auth/service.js';
import type { BatchService } from '../uploads/batches.js';

/**
 * Connected apps file automatically (0.9.0, APP4).
 *
 * An owner may switch on, per app, "File when everything is sure and
 * complete" — or switch it on for a backfill's window alone. The worker,
 * having read an item such an app sent, sends `apps.file_ready` with the
 * household and the item; the API consumes that one queue (filing is the
 * API's code: keys rewrapped, versions, titles, the activity log's line),
 * and files the item as the app's person with BatchService.fileFromApp —
 * which asks everything again in the person's own transaction: the item
 * still waiting in that app's batch and never taken back by an Undo, the
 * app still on, turned on by its person, not paused or removed, still
 * allowed to send and still filing automatically (`appOn`, holding the
 * app's row before the batch and the item, as a send does), and the item still Ready and sure by `appFilesItself`.
 *
 * An item the app sent to the Inbox of the person it is about (APP5) is
 * filed as that person — whose Inbox it is in — with the same checks, and
 * that person still an owner or an adult who may act; the app's own rows
 * are read as the app's person, in the same transaction.
 *
 * Safe to run twice, and on several API instances at once: an item filed
 * or removed meanwhile is nothing to do, and the item's own lock decides
 * which of two runs files it. Anything that is not so waits for review, as
 * it always did; a failure the vault may get over (storage, the database a
 * moment away) is thrown, for the queue to try again.
 */

export interface FileReadyJob {
  household_id: string;
  item_id: string;
}

/** What one job came to: filed, or why the item still waits (or is nothing to do). */
export type FileReadyOutcome =
  'filed' | 'gone' | 'held' | 'off' | 'not_sure' | 'refused' | 'malformed';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An app's switches, as its row has them. */
interface AutoFileSwitches {
  auto_file: boolean;
  backfill_auto_file: boolean;
  backfill_until: Date | null;
}

/** Whether an app files automatically now: its own switch, or a backfill's while it lasts. */
export function autoFileOn(a: AutoFileSwitches, now: number): boolean {
  return (
    a.auto_file ||
    (a.backfill_auto_file && a.backfill_until !== null && a.backfill_until.getTime() > now)
  );
}

export class AppAutoFile {
  constructor(
    private readonly db: Db,
    private readonly batches: BatchService,
    private readonly opts: { now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** One `apps.file_ready` job. */
  async fileReady(data: unknown): Promise<FileReadyOutcome> {
    const job = data as Partial<FileReadyJob> | null;
    const hh = typeof job?.household_id === 'string' ? job.household_id : '';
    const item = typeof job?.item_id === 'string' ? job.item_id : '';
    if (!UUID.test(hh) || !UUID.test(item)) return 'malformed';
    // Which app sent it, and whom it acts as: the job names only the item.
    const found = await withSystem(this.db, hh, (trx) =>
      trx
        .selectFrom('incoming_file as f')
        .innerJoin('intake_batch as ib', 'ib.id', 'f.batch_id')
        .innerJoin('connected_app as a', (j) =>
          j.onRef('a.id', '=', 'ib.app_id').onRef('a.household_id', '=', 'ib.household_id'),
        )
        .leftJoin('connected_app_intake as i', (j) =>
          j.onRef('i.incoming_file_id', '=', 'f.id').onRef('i.app_id', '=', 'a.id'),
        )
        .leftJoin('account_household as ah', (j) =>
          j
            .onRef('ah.account_id', '=', 'a.account_id')
            .onRef('ah.household_id', '=', 'a.household_id'),
        )
        // Whose Inbox it is in (APP5): the person it was sent to, as they are now.
        .leftJoin('account_household as rh', (j) =>
          j
            .onRef('rh.account_id', '=', 'ib.created_by')
            .onRef('rh.household_id', '=', 'ib.household_id')
            .onRef('rh.member_id', '=', 'ib.member_id'),
        )
        .select([
          'f.state',
          'i.auto_file_held',
          'a.id as app_id',
          'a.name',
          'a.account_id',
          'a.member_id',
          'a.approval',
          'a.paused_reason',
          'a.revoked_at',
          'a.scopes',
          'a.auto_file',
          'a.backfill_auto_file',
          'a.backfill_until',
          'ah.role',
          'ah.member_id as ah_member_id',
          'ah.suspended_at',
          'ah.suspended_until',
          'ah.suspend_reason',
          'rh.account_id as inbox_account_id',
          'rh.member_id as inbox_member_id',
          'rh.role as inbox_role',
          'rh.suspended_at as inbox_suspended_at',
          'rh.suspended_until as inbox_suspended_until',
          'rh.suspend_reason as inbox_suspend_reason',
        ])
        .where('f.id', '=', item)
        .executeTakeFirst(),
    );
    if (!found || found.state !== 'received') return 'gone';
    if (found.auto_file_held) return 'held';
    if (!live(found, this.now()) || !found.role || found.ah_member_id !== found.member_id) {
      return 'off';
    }
    // Filed as whoever's Inbox it is in: the app's person, or the person
    // it was sent to (APP5) — still an owner or an adult who may act.
    const inboxRole = found.inbox_role;
    if (
      !found.inbox_account_id ||
      !found.inbox_member_id ||
      (inboxRole !== 'owner' && inboxRole !== 'adult') ||
      !mayAct({
        suspended_at: found.inbox_suspended_at,
        suspended_until: found.inbox_suspended_until,
        suspend_reason: found.inbox_suspend_reason,
      })
    ) {
      return 'off';
    }
    const role: Role = found.role;
    const acting = { accountId: found.account_id, memberId: found.member_id, role };
    const p: Principal = {
      accountId: found.inbox_account_id,
      sessionId: '',
      householdId: hh,
      memberId: found.inbox_member_id,
      role: inboxRole,
      seesAdults: seesAdults(inboxRole, null),
    };
    const app = { id: found.app_id, name: found.name };
    const out = await this.batches.fileFromApp(
      p,
      item,
      app,
      // The app's row, and its person, read as its person (APP5): the person
      // it sent to need not see the app's row.
      (trx) => actAs(trx, acting, (t) => this.appOn(t, app.id, hh)),
      { ip: null, userAgent: null },
    );
    return out.filed ? 'filed' : out.why;
  }

  /**
   * In the filing's own transaction, as the app's person, before its batch
   * and the item are held (a send holds them in this order): the app still
   * files automatically, its row held for share so a pause, a removal or the
   * switch turned off waits for this filing (and this one for them); and its
   * person, in this household as this member, still able to act.
   */
  private async appOn(trx: Db, appId: string, householdId: string): Promise<boolean> {
    const a = await trx
      .selectFrom('connected_app')
      .select([
        'approval',
        'paused_reason',
        'revoked_at',
        'scopes',
        'auto_file',
        'backfill_auto_file',
        'backfill_until',
        'account_id',
        'member_id',
      ])
      .where('id', '=', appId)
      .where('household_id', '=', householdId)
      .forShare()
      .executeTakeFirst();
    if (!a) return false;
    // This household's row alone: an account may belong to others too.
    const person = await trx
      .selectFrom('account_household')
      .select(['role', 'suspended_at', 'suspended_until', 'suspend_reason'])
      .where('account_id', '=', a.account_id)
      .where('household_id', '=', householdId)
      .where('member_id', '=', a.member_id)
      .executeTakeFirst();
    return person !== undefined && live({ ...a, ...person }, this.now());
  }
}

/** The app on, turned on, allowed to send, filing automatically; its person an owner or adult who may act. */
function live(
  a: AutoFileSwitches & {
    approval: string;
    paused_reason: string | null;
    revoked_at: Date | null;
    scopes: string[];
    role: string | null;
    suspended_at: Date | null;
    suspended_until: Date | null;
    suspend_reason: string | null;
  },
  now: number,
): boolean {
  if (a.revoked_at !== null || a.paused_reason !== null || a.approval !== 'approved') return false;
  if (!a.scopes.includes('documents.send') || !autoFileOn(a, now)) return false;
  if (a.role !== 'owner' && a.role !== 'adult') return false;
  return mayAct(a);
}

/** Whether a person's sign-in is neither locked nor paused now. */
function mayAct(a: {
  suspended_at: Date | null;
  suspended_until: Date | null;
  suspend_reason: string | null;
}): boolean {
  const person = {
    suspended_at: a.suspended_at,
    suspended_until: a.suspended_until,
    suspend_reason: a.suspend_reason,
  };
  return !lockInEffect(person) && !suspensionInEffect(person);
}

/** The queue the API consumes, as far as it needs it. */
export interface FileReadyQueue {
  getQueue: (name: string) => Promise<unknown>;
  work: (
    name: string,
    options: { batchSize: number; pollingIntervalSeconds: number },
    handler: (jobs: Array<{ data: unknown }>) => Promise<void>,
  ) => Promise<string>;
  offWork: (name: string) => Promise<void>;
}

/**
 * The API's one consumer (APP4): `apps.file_ready`, one job at a time on
 * each instance. The worker makes the queue (only the owning role may); an
 * API that starts first looks for it again every `retryMs` until it is
 * there, and one whose start fails tries again as often. Started once the
 * server listens, stopped before it closes.
 */
export function consumeFileReady(
  queue: FileReadyQueue,
  autoFile: Pick<AppAutoFile, 'fileReady'>,
  log: (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>) => void,
  opts: { retryMs?: number; pollingIntervalSeconds?: number } = {},
): { started: Promise<void>; stop: () => Promise<void> } {
  let stopped = false;
  let working = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  let told = false;
  let warned = false;
  /** A while, or until stopped. */
  const later = async () => {
    await new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, opts.retryMs ?? 30_000);
    });
    timer = null;
    wake = null;
  };
  const start = async (): Promise<void> => {
    while (!stopped) {
      const there = await queue.getQueue(APP_FILE_READY_JOB).catch(() => null);
      if (stopped) return;
      if (!there) {
        if (!told) log('info', 'waiting for the worker to make the queue apps.file_ready');
        told = true;
        await later();
        continue;
      }
      try {
        await queue.work(
          APP_FILE_READY_JOB,
          { batchSize: 1, pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 },
          async (jobs) => {
            for (const job of jobs) {
              const outcome = await autoFile.fileReady(job.data);
              // Never what it was, nor whose: the outcome alone.
              if (outcome !== 'filed' && outcome !== 'gone') {
                log('info', 'an app’s item was left for review', { outcome });
              }
            }
          },
        );
      } catch (err) {
        // The database a moment away as it starts: tried again, as the queue is looked for.
        if (!warned) {
          log('warn', 'could not start filing apps’ items automatically; trying again', {
            err: (err as Error).message.slice(0, 200),
          });
        }
        warned = true;
        await later();
        continue;
      }
      working = true;
      if (stopped) await queue.offWork(APP_FILE_READY_JOB).catch(() => undefined);
      return;
    }
  };
  const started = start();
  return {
    started,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
      await started;
      if (working) await queue.offWork(APP_FILE_READY_JOB).catch(() => undefined);
    },
  };
}
