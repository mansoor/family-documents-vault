import { PgBoss } from 'pg-boss';

/**
 * Job names are the contract between the API (which enqueues) and the worker
 * (which runs). Add a name here and a handler in `jobs/`; never send a job
 * the worker has no handler for.
 */
export const JOBS = {
  /** Proves the worker is alive; runs every minute and logs one line. */
  heartbeat: 'heartbeat',
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
