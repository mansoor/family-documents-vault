import { PgBoss } from 'pg-boss';

/**
 * Job names are the contract between the API (which enqueues) and the worker
 * (which runs). Add a name here and a handler in `jobs/`; never send a job
 * the worker has no handler for.
 */
export const JOBS = {
  /** Proves the worker is alive; runs every minute and logs one line. */
  heartbeat: 'heartbeat',
  /** Recomputes every household's audit hash chain; nightly. */
  verifyAudit: 'audit.verify',
  /** Page count, thumbnail and OCR for one uploaded version. */
  processVersion: 'version.process',
  /**
   * One version's page previews (4.7): queued by the API on the first
   * request for a page, when a document becomes Essential, and by the
   * worker's backfill at startup. The name matches the API's enqueue.
   */
  renderPreviews: 'version.previews',
  /** Builds a full export ZIP with indexes. */
  exportBuild: 'export.build',
  /**
   * Seals the notes and details of documents that are Only me already
   * (0.5.8), one document per transaction; on every start of the worker.
   */
  sealPrivate: 'private.seal',
  /** Nightly encrypted pg_dump with 30-day retention. */
  backupDatabase: 'backup.database',
  /** Every 15 minutes: scheduled/snoozed reminders become due on the local date. */
  remindersTick: 'reminders.tick',
  /** Hourly: one digest per household at its local 9am, with catch-up. */
  remindersDeliver: 'reminders.deliver',
  /** Nightly: materialise status_cache. */
  statusRefresh: 'status.refresh',
  /** Nightly: upload keys past their time, and claims whose try died. */
  uploadsPrune: 'uploads.prune',
  /** Sunday evening: the week's summary by email. */
  remindersWeekly: 'reminders.weekly',
  /**
   * One thing, to named people, now: a new device signed in, somebody was
   * made an owner, somebody asked for an owner to be demoted. Unlike a
   * digest these are never batched and never wait for nine in the morning.
   */
  alertSend: 'alert.send',
  /**
   * A push the API asks for (4.13): a device's test, and "you were signed
   * out" to the phones of a session that just ended (their rows already
   * gone, so the job carries what sending needs).
   */
  pushSend: 'push.send',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

export const QUEUE_SCHEMA = 'pgboss';

export interface QueueOptions {
  connectionString: string;
  /** Install or upgrade the queue schema on start. Only the owning role may. */
  migrate: boolean;
}

export function createQueue(opts: QueueOptions): PgBoss {
  return new PgBoss({
    connectionString: opts.connectionString,
    schema: QUEUE_SCHEMA,
    migrate: opts.migrate,
    // Only the worker supervises and runs schedules; the API merely enqueues.
    supervise: opts.migrate,
    schedule: opts.migrate,
  });
}
