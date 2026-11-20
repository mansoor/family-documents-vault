import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueue, JOBS } from './queue.js';
import {
  OFFSITE_COPY_QUEUE,
  OFFSITE_COPY_QUEUE_OPTIONS,
  OFFSITE_COPY_SECONDS,
  OFFSITE_COPY_SINGLETON,
} from './jobs/backup-offsite.js';

describe.skipIf(!testAdminUrl())('queue', () => {
  let tdb: TestDatabase;
  let boss: PgBoss;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    boss = createQueue({ connectionString: tdb.adminUrl, migrate: true });
    await boss.start();
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await tdb.drop();
  });

  it('installs its schema and round-trips a job', async () => {
    await boss.createQueue(JOBS.heartbeat);
    const seen: string[] = [];
    await boss.work<{ n: number }>(JOBS.heartbeat, async (jobs) => {
      for (const j of jobs) seen.push(`${j.data.n}`);
    });
    const id = await boss.send(JOBS.heartbeat, { n: 42 });
    expect(id).toBeTruthy();

    for (let i = 0; i < 50 && seen.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(seen).toEqual(['42']);
  });

  it('copies a backup off-site in a job of its own: one waiting, three hours, never retried', async () => {
    expect(OFFSITE_COPY_QUEUE).toBe('backup.offsite_copy');
    await boss.createQueue(OFFSITE_COPY_QUEUE, OFFSITE_COPY_QUEUE_OPTIONS);
    const q = await boss.getQueue(OFFSITE_COPY_QUEUE);
    expect(q).toMatchObject({
      policy: 'stately',
      retryLimit: 0,
      expireInSeconds: OFFSITE_COPY_SECONDS,
    });
    expect(OFFSITE_COPY_SECONDS).toBeGreaterThan(15 * 60);
    const send = () =>
      boss.send(
        OFFSITE_COPY_QUEUE,
        { file: 'fdv-2026-11-20T02-30-00-000Z.sql.enc' },
        { singletonKey: OFFSITE_COPY_SINGLETON },
      );
    expect(await send()).toBeTruthy();
    // A second backup's copy while one waits: not queued twice.
    expect(await send()).toBeNull();
  });
});
