import { readFile } from 'node:fs/promises';
import { deriveKey, EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { loadConfig } from './config.js';
import { processVersion, type ProcessVersionJob } from './jobs/process-version.js';
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

  const masterSecret = config.FDV_MASTER_KEY_FILE
    ? (await readFile(config.FDV_MASTER_KEY_FILE, 'utf8')).trim()
    : (config.FDV_MASTER_KEY as string);
  const processDeps = {
    db: dbs.app,
    keys: new ScopeKeys(new EnvKeyProvider(masterSecret)),
    credentialsKey: deriveKey(masterSecret, 'vault-credentials'),
    localRoot: config.FDV_LOCAL_VAULT_DIR,
    maxOcrPages: config.FDV_OCR_MAX_PAGES,
    log,
  };
  await boss.createQueue(JOBS.processVersion, {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
  });
  await boss.work<ProcessVersionJob>(JOBS.processVersion, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await processVersion(processDeps, job.data);
  });
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
