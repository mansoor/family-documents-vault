import { loadConfig } from './config.js';
import { connections, verifyAllAuditChains } from './jobs/verify-audit.js';
import { createQueue, JOBS } from './queue.js';

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), ...extra }));

async function main(): Promise<void> {
  const config = loadConfig();

  // The queue schema is installed with the owning role; job data itself is
  // not tenant data, so row-level security is not a concern here.
  const boss = createQueue({
    connectionString: config.DATABASE_ADMIN_URL ?? config.DATABASE_URL,
    migrate: true,
  });
  boss.on('error', (err) => log('error', 'queue error', { err: String(err) }));

  await boss.start();
  log('info', 'queue started');

  await boss.createQueue(JOBS.heartbeat);
  await boss.work(JOBS.heartbeat, async (jobs) => {
    for (const job of jobs) log('info', 'heartbeat', { job_id: job.id });
  });
  await boss.schedule(JOBS.heartbeat, '* * * * *');

  const dbs = connections(config.DATABASE_URL, config.DATABASE_ADMIN_URL ?? config.DATABASE_URL);
  await boss.createQueue(JOBS.verifyAudit);
  await boss.work(JOBS.verifyAudit, async () => {
    const report = await verifyAllAuditChains(dbs.admin, dbs.app);
    if (report.broken.length) {
      log('error', 'audit chain broken', { ...report });
    } else {
      log('info', 'audit chains verified', { households: report.households });
    }
  });
  await boss.schedule(JOBS.verifyAudit, '15 3 * * *');
  log('info', 'worker ready', { jobs: Object.values(JOBS) });

  const shutdown = async (signal: string) => {
    log('info', 'shutting down', { signal });
    await boss.stop({ graceful: true, timeout: 10_000 });
    await dbs.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
