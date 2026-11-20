import { lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * What the sweep may remove: every temporary folder the worker makes
 * (mkdtemp, `fdv-…`), and ImageMagick's pixel cache files (`magick-…`),
 * which land in /tmp too (MAGICK_TEMPORARY_PATH, docker-compose.yml).
 */
export const WORKER_TEMP_PREFIXES = ['fdv-', 'magick-'] as const;

/**
 * How old a leftover must be before it is removed: 6 hours. Far longer than
 * any job may run — pg-boss expires a job after 15 minutes unless its queue
 * says otherwise, and none says more (processing, a batch's reading and a
 * reading check: 14 minutes) — and than an operator's command run in a
 * worker container of its own is expected to take. Whatever is younger may
 * belong to a job still running: another worker, or a `docker compose run
 * worker …` container, shares the volume.
 */
export const WORKER_TEMP_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * On the worker's start, in its image: what a worker that stopped mid-job
 * left in its temporary folder — a document's plain bytes, pages drawn from
 * it, an export being built, ImageMagick's pixels — removed once it is older
 * than WORKER_TEMP_MIN_AGE_MS. There /tmp is the worker-tmp volume
 * (docker-compose.yml: the root filesystem is read-only, and an export of
 * the whole vault is too large for memory), kept across restarts and
 * upgrades. Anywhere else — a development machine's shared temporary
 * folder, where the tests make folders of the same names — nothing is
 * touched. Answers how many.
 */
export async function sweepWorkerTemp(
  dir: string = tmpdir(),
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<number> {
  if (env.NODE_ENV !== 'production') return 0;
  const names = await readdir(dir).catch(() => [] as string[]);
  let n = 0;
  for (const name of names) {
    if (!WORKER_TEMP_PREFIXES.some((p) => name.startsWith(p))) continue;
    const at = path.join(dir, name);
    // Its last change, no earlier than when it was made: a job's folder is
    // made as the job starts, so one older than the age above outlived it.
    const changed = await lstat(at).then(
      (s) => s.mtimeMs,
      () => null,
    );
    if (changed === null || now - changed < WORKER_TEMP_MIN_AGE_MS) continue;
    await rm(at, { recursive: true, force: true }).then(
      () => (n += 1),
      () => undefined,
    );
  }
  return n;
}
