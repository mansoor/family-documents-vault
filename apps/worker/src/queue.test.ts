import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueue, JOBS } from './queue.js';

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
});
