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
  /**
   * A person's photo made from its upload (5.17c): queued by the API's PUT
   * /members/{id}/photo, whose PHOTO_JOB is this name. Its own queue, so a
   * vault reading a hundred pages never keeps somebody's photo waiting.
   */
  memberPhoto: 'member.photo',
  /**
   * A view-only link's pages (5.18): the previews drawn again with whom the
   * link is for across each. Sent by the API when the link is made, when a
   * page is asked for and there are none, and when an owner turns the link
   * back on after a restore; one per link queued or running. The name
   * matches the API's SHARE_PAGES_JOB.
   */
  sharePages: 'share.pages',
  /**
   * Ended links' pages removed (5.18): one link's when it is taken back
   * (the API's SHARE_PAGES_PRUNE_JOB), and every household's each night.
   */
  sharePagesPrune: 'share.pages.prune',
  /**
   * The files of documents removed for good that could not be deleted then
   * (5.24): one household's when the API's removal asks (its
   * PURGE_LEFTOVERS_JOB), and every household's each night.
   */
  purgeLeftovers: 'purge.leftovers',
  /** Builds a full export ZIP with indexes. */
  exportBuild: 'export.build',
  /**
   * Seals the notes and details of documents that are Only me already
   * (0.5.8), one document per transaction; on every start of the worker.
   */
  sealPrivate: 'private.seal',
  /**
   * Every document of one type reminded anew (0.5.10), after a household
   * changed the type's lead times or switched its Expires on or off. The
   * API sends it, one queued and one running per type (`stately`); the
   * name matches the API's REGENERATE_JOB.
   */
  regenerateTypes: 'types.regenerate',
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
   * One email to one address (5.20): a share link's code, to the address its
   * sharer typed. Only through the operator's mail server (FDV_SMTP_URL),
   * never the household's (A21); sealed on the queue. The name matches the
   * API's MAIL_JOB.
   */
  mailToAddress: 'mail.to_address',
  /**
   * A push the API asks for (4.13): a device's test, and "you were signed
   * out" to the phones of a session that just ended (their rows already
   * gone, so the job carries what sending needs).
   */
  pushSend: 'push.send',
  /**
   * Files a sender has just sent through a request (5.23), got ready to be
   * looked at: scanned (by nothing, A42: `unscanned`), their review pages
   * drawn, and their reviewers told how many are waiting. Sent by the API
   * when the sender presses Finish; the name matches its INCOMING_SCAN_JOB.
   */
  incomingScan: 'incoming.scan',
  /**
   * What was sent for somebody alone to review, moved to the owners once
   * they can no longer review it (5.23). Sent by the API after a role is
   * changed or a sign-in taken away; the name matches its INCOMING_MOVE_JOB.
   */
  incomingMove: 'incoming.move',
  /**
   * Daily (5.23): files not filed within 30 days removed, requests past
   * their end with nothing waiting removed, and what a lost job missed.
   */
  incomingSweep: 'incoming.sweep',
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
