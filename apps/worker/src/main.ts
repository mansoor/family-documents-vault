import { readFile } from 'node:fs/promises';
import { deriveKey, EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { loadConfig } from './config.js';
import { backupDatabase } from './jobs/backup.js';
import { buildExport, type ExportJob } from './jobs/export.js';
import { processVersion, type ProcessVersionJob } from './jobs/process-version.js';
import { deliver, logNotifier, refreshStatus, tick } from './jobs/reminders.js';
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

  await boss.createQueue(JOBS.exportBuild, { retryLimit: 2, retryDelay: 60 });
  await boss.work<ExportJob>(JOBS.exportBuild, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await buildExport(processDeps, job.data);
  });

  const backupDeps = {
    adminUrl: config.DATABASE_ADMIN_URL ?? config.DATABASE_URL,
    backupKey: deriveKey(masterSecret, 'database-backup'),
    dir: config.FDV_BACKUP_DIR,
    retainDays: config.FDV_BACKUP_RETAIN_DAYS,
    log,
  };
  await boss.createQueue(JOBS.backupDatabase, { retryLimit: 3, retryDelay: 300 });
  await boss.work(JOBS.backupDatabase, async () => {
    await backupDatabase(backupDeps);
  });
  await boss.schedule(JOBS.backupDatabase, config.FDV_BACKUP_CRON);

  const reminderDeps = {
    admin: dbs.admin,
    app: dbs.app,
    notifier: logNotifier(log),
    log,
    digestHour: config.FDV_DIGEST_HOUR,
  };
  await boss.createQueue(JOBS.remindersTick);
  await boss.work(JOBS.remindersTick, async () => {
    const r = await tick(reminderDeps);
    if (r.became_due) log('info', 'reminders due', r);
  });
  await boss.schedule(JOBS.remindersTick, '*/15 * * * *');
  await boss.createQueue(JOBS.remindersDeliver);
  await boss.work(JOBS.remindersDeliver, async () => {
    const r = await deliver(reminderDeps);
    if (r.digests) log('info', 'reminder digests sent', r);
  });
  await boss.schedule(JOBS.remindersDeliver, '5 * * * *');
  await boss.createQueue(JOBS.statusRefresh);
  await boss.work(JOBS.statusRefresh, async () => {
    log('info', 'status cache refreshed', await refreshStatus(reminderDeps));
  });
  await boss.schedule(JOBS.statusRefresh, '45 3 * * *');
  // On start: catch up immediately rather than waiting for the next slot.
  await boss.send(JOBS.remindersTick, {});
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
