import path from 'node:path';
import { openBackupOffsiteSecret } from '@fdv/crypto';
import { householdZone, withSystem, type Db } from '@fdv/db';
import {
  OFFSITE_LATE_DAYS,
  offsiteProblemWords,
  shareEndWords,
  type OffsiteProblem,
} from '@fdv/shared';
import {
  OFFSITE_COPY_NAME,
  OffsiteError,
  pruneOffsite,
  uploadOffsite,
  type OffsiteBucket,
} from '@fdv/storage';
import { sql } from 'kysely';
import type pg from 'pg';
import { queueDbOf, type OwnersAlert, type QueueDb } from '../ai-send.js';
import { JOBS } from '../queue.js';

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

/**
 * The off-site copy of the nightly backups (0.9.0-dev.76), as an owner set it
 * in Settings → Backups. After each backup the worker copies the file it
 * just wrote — encrypted under the master key, as every backup is — to the
 * bucket, and keeps the newest `retain_count` of its own copies there (none
 * removed when the key may not delete). It reads nothing back and decrypts
 * nothing. What it did, and why not, is kept on the setting for Settings to
 * show, in a word, never the provider's own words or a secret.
 *
 * A dump is the whole database: it is copied only while the database holds
 * one household, the self-hosted vault's.
 */
export interface OffsiteDeps {
  /** The owning role: which households have the copy on, and how many there are. */
  admin: pg.Pool;
  /** The application role: each household's setting, read and written as the vault. */
  db: Db;
  /** deriveKey(master, BACKUP_OFFSITE_KEY_PURPOSE). */
  key: Buffer;
  log: Log;
  /** Tests: the copy and the prune, unless they stand in. */
  upload?: typeof uploadOffsite;
  prune?: typeof pruneOffsite;
}

export interface OffsiteReport {
  copied: number;
  failed: number;
}

/**
 * The copy's own queue: a large upload may take longer than the backup's
 * job is given, and a backup job past its time would be made again, dump
 * and all, while the first upload still ran. One queued and one running
 * (stately, one key), three hours, never tried again (the next backup's
 * copy is the next try).
 */
export const OFFSITE_COPY_QUEUE = JOBS.backupOffsiteCopy;
export const OFFSITE_COPY_SECONDS = 3 * 3600;
export const OFFSITE_COPY_QUEUE_OPTIONS = {
  policy: 'stately' as const,
  retryLimit: 0,
  expireInSeconds: OFFSITE_COPY_SECONDS,
};
export const OFFSITE_COPY_SINGLETON = 'backup-offsite-copy';

/** What the backup job sends: the backup's own name, never a path. */
export interface OffsiteCopyJob {
  file: string;
}

/** The job's file, in the backups directory, or null for anything not a backup's name. */
export function offsiteCopyFile(dir: string, data: unknown): string | null {
  const name = (data as Partial<OffsiteCopyJob> | null)?.file;
  if (typeof name !== 'string' || !OFFSITE_COPY_NAME.test(name)) return null;
  return path.join(dir, name);
}

/**
 * Copies one backup file to every bucket that is on. Never throws for a
 * bucket's failure. `stop` ends an upload as its job's time runs out.
 */
export async function copyOffsite(
  deps: OffsiteDeps,
  file: string,
  stop?: AbortSignal,
): Promise<OffsiteReport> {
  const report: OffsiteReport = { copied: 0, failed: 0 };
  const { rows } = await deps.admin.query<{ household_id: string }>(
    `select household_id from public.backup_offsite where enabled order by 1`,
  );
  if (rows.length === 0) return report;
  const { rows: count } = await deps.admin.query<{ n: number }>(
    'select count(*)::int as n from public.household',
  );
  const several = (count[0]?.n ?? 0) > 1;
  const upload = deps.upload ?? uploadOffsite;
  const prune = deps.prune ?? pruneOffsite;

  for (const { household_id: hh } of rows) {
    const row = await withSystem(deps.db, hh, (trx) =>
      trx.selectFrom('backup_offsite').selectAll().where('enabled', '=', true).executeTakeFirst(),
    );
    if (!row) continue;
    let problem: OffsiteProblem | null = null;
    let copied: { key: string; bytes: number } | null = null;
    if (several || !row.secret_encrypted) {
      problem = several ? 'several_households' : 'secret_unopened';
      deps.log('warn', 'backup not copied off-site', { problem });
    } else {
      let bucket: OffsiteBucket | null = null;
      try {
        bucket = {
          endpoint: row.endpoint,
          region: row.region,
          bucket: row.bucket,
          prefix: row.prefix,
          pathStyle: row.path_style,
          accessKeyId: row.access_key_id,
          secretAccessKey: openBackupOffsiteSecret(deps.key, row.secret_encrypted, hh, {
            endpoint: row.endpoint,
            bucket: row.bucket,
            accessKeyId: row.access_key_id,
          }),
        };
      } catch {
        problem = 'secret_unopened';
        deps.log('warn', 'backup not copied off-site', { problem });
      }
      if (bucket) {
        try {
          copied = await upload(bucket, file, stop);
          // A key that may not delete (a write-only key): nothing is
          // removed, and the bucket's own lifecycle rule keeps the count.
          const gone = row.can_delete === false ? [] : await prune(bucket, row.retain_count);
          deps.log('info', 'backup copied off-site', {
            bytes: copied.bytes,
            removed: gone.length,
            ...(row.can_delete === false ? { pruning: 'off: the key may not delete' } : {}),
          });
        } catch (err) {
          // A copy that went whole is a copy, whatever became of the prune:
          // the next night prunes again.
          if (!copied) {
            problem = err instanceof OffsiteError ? err.problem : 'unknown';
          }
          deps.log('warn', copied ? 'off-site copies not pruned' : 'backup not copied off-site', {
            problem: err instanceof OffsiteError ? err.problem : 'unknown',
            // The provider's words, for whoever runs the server: never a secret.
            detail: err instanceof OffsiteError ? err.detail : (err as Error).message,
          });
        }
      }
    }
    await withSystem(deps.db, hh, async (trx) => {
      // Said of the bucket that was copied to, and no other: one saved
      // while the copy ran (a new bucket, key or secret) waits for its own.
      await trx
        .updateTable('backup_offsite')
        .set(
          copied
            ? {
                last_attempt_at: sql<Date>`now()`,
                last_copy_at: sql<Date>`now()`,
                last_copy_object: copied.key.slice(0, 300),
                last_copy_bytes: copied.bytes,
                last_result: 'ok',
                last_problem: null,
                // The incident, if there was one, is over.
                alerted_at: null,
              }
            : {
                last_attempt_at: sql<Date>`now()`,
                last_result: 'failed',
                last_problem: problem ?? 'unknown',
              },
        )
        .where('endpoint', 'is not distinct from', row.endpoint)
        .where('region', 'is not distinct from', row.region)
        .where('bucket', '=', row.bucket)
        .where('prefix', 'is not distinct from', row.prefix)
        .where('path_style', '=', row.path_style)
        .where('access_key_id', '=', row.access_key_id)
        .where('secret_encrypted', 'is not distinct from', row.secret_encrypted)
        .execute();
    });
    if (copied) report.copied += 1;
    else report.failed += 1;
  }
  return report;
}

/**
 * Tells the owners, once an incident, when a copy that is on failed since it
 * was last turned on, or has not gone for `lateDays` (OFFSITE_LATE_DAYS:
 * nightly backups) — the backup itself failing, a worker stopped. Cleared by
 * the next copy that goes, or by turning it on again; a failure from before
 * it was turned on again is not this incident's.
 */
export async function noticeOffsite(deps: {
  admin: pg.Pool;
  db: Db;
  tell: (a: OwnersAlert, db: QueueDb) => Promise<void>;
  lateDays?: number;
}): Promise<number> {
  const lateDays = Math.max(1, Math.round(deps.lateDays ?? OFFSITE_LATE_DAYS));
  const since = `coalesce(enabled_at, '-infinity'::timestamptz)`;
  const failedNow = `(last_result = 'failed' and last_attempt_at >= ${since})`;
  const due = `enabled
      and (alerted_at is null or alerted_at < ${since})
      and (${failedNow}
           or greatest(coalesce(last_copy_at, '-infinity'::timestamptz), ${since})
              < now() - make_interval(days => ${lateDays}))`;
  const { rows } = await deps.admin.query<{ household_id: string }>(
    `select household_id from public.backup_offsite where ${due} order by 1`,
  );
  let told = 0;
  for (const { household_id: hh } of rows) {
    const sent = await withSystem(deps.db, hh, async (trx) => {
      const marked = await sql<{
        failed: boolean;
        last_problem: string | null;
        last_copy_at: Date | null;
      }>`update backup_offsite set alerted_at = now()
          where ${sql.raw(due)}
        returning ${sql.raw(failedNow)} as failed, last_problem, last_copy_at`.execute(trx);
      const r = marked.rows[0];
      if (!r) return false;
      const owners = (
        await trx
          .selectFrom('account_household')
          .select('account_id')
          .where('role', '=', 'owner')
          .execute()
      ).map((o) => o.account_id);
      if (owners.length === 0) return false;
      const hhRow = await trx.selectFrom('household').select('timezone').executeTakeFirstOrThrow();
      const zone = householdZone(hhRow.timezone);
      const last = r.last_copy_at
        ? `The last copy that went was on ${shareEndWords(r.last_copy_at, zone, { weekday: false, year: true })}.`
        : 'No copy has gone since it was turned on.';
      await deps.tell(
        {
          household_id: hh,
          account_ids: owners,
          subject: r.failed
            ? 'Your backups could not be copied off-site'
            : 'Your backups have not been copied off-site lately',
          body: [
            r.failed
              ? `The vault could not copy its latest backup to the bucket set in Settings → Backups. ${offsiteProblemWords(r.last_problem)}`
              : `The vault has not copied a backup to the bucket set in Settings → Backups for more than ${lateDays} ${lateDays === 1 ? 'day' : 'days'}. Check that the worker is running and the backups are made.`,
            last,
            'Your backups are still made on the server; only the copy elsewhere is missing. Open Settings → Backups, send a test, and fix what it says. You will not be told again until a copy goes.',
          ].join(' '),
        },
        queueDbOf(trx),
      );
      return true;
    });
    if (sent) told += 1;
  }
  return told;
}
