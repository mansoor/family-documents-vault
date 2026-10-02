import { readFile } from 'node:fs/promises';
import { deriveKey, EnvKeyProvider, OPERATOR_MAIL_KEY_PURPOSE, ScopeKeys } from '@fdv/crypto';
import { assertSchemaKnown, createPool } from '@fdv/db';
import { loadConfig } from './config.js';
import { backupDatabase } from './jobs/backup.js';
import { buildExport, type ExportJob } from './jobs/export.js';
import { processVersion, type ProcessVersionJob } from './jobs/process-version.js';
import {
  backfillPreviews,
  previewJobKey,
  renderVersionPreviews,
  type RenderPreviewsJob,
  type SendPreviews,
} from './jobs/previews.js';
import { createNotifier } from './jobs/notify.js';
import { makeMemberPhoto, type MemberPhotoJob } from './jobs/member-photo.js';
import { drawSharePages, pruneSharePages, type SharePagesJob } from './jobs/share-pages.js';
import { removeLeftovers, type PurgeLeftoversJob } from './jobs/purge-leftovers.js';
import { isAlert, sendAlert } from './jobs/alerts.js';
import { isMailJob, pruneShareCodes, sendToAddress } from './jobs/mail.js';
import { createPushAgent, isPushJob, sendPushJob } from './jobs/push.js';
import { deliver, logNotifier, refreshStatus, tick, weekly } from './jobs/reminders.js';
import { sealPrivateValues } from './jobs/seal.js';
import { regenerateTypeReminders, type RegenerateTypeJob } from './jobs/types.js';
import { pruneUploads } from './jobs/uploads.js';
import {
  moveIncoming,
  scanIncoming,
  sweepIncoming,
  type IncomingDeps,
  type IncomingMoveJob,
  type IncomingScanJob,
} from './jobs/incoming.js';
import { connections, verifyAllAuditChains } from './jobs/verify-audit.js';
import type { JobWithMetadata } from 'pg-boss';
import { createQueue, JOBS } from './queue.js';
import { masterKeyOpensVault, resolveMasterSecret } from './master-key-check.js';

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), ...extra }));

async function main(): Promise<void> {
  const config = loadConfig();
  const adminUrl = config.DATABASE_ADMIN_URL ?? config.DATABASE_URL;
  if (!(await masterKeyOpensVault(adminUrl, await resolveMasterSecret(config), log))) {
    process.exitCode = 1;
    return;
  }

  // A database a newer release has upgraded is refused before any job
  // touches it: this release's jobs would see no documents on it.
  const probe = createPool(config.DATABASE_ADMIN_URL ?? config.DATABASE_URL, 1);
  try {
    await assertSchemaKnown(probe);
  } finally {
    await probe.end();
  }

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
  await boss.createQueue(JOBS.renderPreviews, {
    policy: 'exclusive',
    retryLimit: 2,
    retryDelay: 60,
  });
  const sendPreviews: SendPreviews = (job, opts = {}) =>
    boss.send(
      JOBS.renderPreviews,
      { ...job },
      { singletonKey: previewJobKey(job.version_id), ...opts },
    );
  const processDeps = {
    db: dbs.app,
    keys: new ScopeKeys(new EnvKeyProvider(masterSecret)),
    credentialsKey: deriveKey(masterSecret, 'vault-credentials'),
    localRoot: config.FDV_LOCAL_VAULT_DIR,
    maxOcrPages: config.FDV_OCR_MAX_PAGES,
    log,
    sendPreviews,
  };
  await boss.createQueue(JOBS.processVersion, {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
  });
  await boss.work<ProcessVersionJob>(JOBS.processVersion, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await processVersion(processDeps, job.data);
  });

  // Page previews: one job per version queued or running (exclusive on its
  // key), drawn one at a time so a vault full of Essentials is drawn in the
  // background without crowding out anything else. Somebody waiting for a
  // page is served first (priority 10), then new Essentials (5), then the
  // backfill.
  await boss.work(
    JOBS.renderPreviews,
    { batchSize: 1, includeMetadata: true },
    async (jobs: JobWithMetadata<RenderPreviewsJob>[]) => {
      for (const job of jobs) {
        await renderVersionPreviews(processDeps, job.data, {
          final: job.retryCount >= job.retryLimit,
        });
      }
    },
  );
  void backfillPreviews({ admin: dbs.admin, app: dbs.app, send: sendPreviews })
    .then((queued) => {
      if (queued) log('info', 'page previews queued for Essentials', { queued });
    })
    .catch((err: unknown) => log('warn', 'page preview backfill failed', { err: String(err) }));

  // People's photos (5.17c), one at a time: the upload opened into a folder
  // of the worker's own, made into the square, and deleted. Tried twice; on
  // the second failure it is refused and its upload goes at once.
  await boss.createQueue(JOBS.memberPhoto, { retryLimit: 1, retryDelay: 30 });
  await boss.work(
    JOBS.memberPhoto,
    { batchSize: 1, includeMetadata: true },
    async (jobs: JobWithMetadata<MemberPhotoJob>[]) => {
      for (const job of jobs) {
        await makeMemberPhoto(processDeps, job.data, {
          final: job.retryCount >= job.retryLimit,
        });
      }
    },
  );

  // A view-only link's pages (5.18): one job per link queued or running,
  // drawn one at a time like the previews they are drawn from.
  await boss.createQueue(JOBS.sharePages, { policy: 'exclusive', retryLimit: 2, retryDelay: 30 });
  await boss.work(
    JOBS.sharePages,
    { batchSize: 1, includeMetadata: true },
    async (jobs: JobWithMetadata<SharePagesJob>[]) => {
      for (const job of jobs) {
        await drawSharePages(processDeps, job.data, {
          final: job.retryCount >= job.retryLimit,
        });
      }
    },
  );
  // And removed when their link ends: one link's at once when it is taken
  // back, and whatever else has ended each night.
  const pruneDeps = {
    admin: dbs.admin,
    app: dbs.app,
    credentialsKey: processDeps.credentialsKey,
    localRoot: processDeps.localRoot,
    log,
  };
  await boss.createQueue(JOBS.sharePagesPrune, { retryLimit: 3, retryDelay: 300 });
  await boss.work<Partial<SharePagesJob>>(JOBS.sharePagesPrune, async (jobs) => {
    for (const job of jobs) {
      const one =
        job.data?.household_id && job.data.share_id
          ? { household_id: job.data.household_id, share_id: job.data.share_id }
          : undefined;
      await pruneSharePages(pruneDeps, one);
      // Each night, too: the address an ended link's code went to, and
      // codes past their day (5.20).
      if (!one) await pruneShareCodes(pruneDeps);
    }
  });
  await boss.schedule(JOBS.sharePagesPrune, '35 4 * * *');
  // One queued and one running a household (the API's singletonKey): each
  // run finishes all the household has, so more would only repeat it.
  await boss.createQueue(JOBS.purgeLeftovers, {
    policy: 'stately',
    retryLimit: 3,
    retryDelay: 300,
  });
  await boss.work<PurgeLeftoversJob>(JOBS.purgeLeftovers, async (jobs) => {
    for (const job of jobs) {
      const hh = job.data?.household_id;
      await removeLeftovers(pruneDeps, hh ? { household_id: hh } : undefined);
    }
  });
  await boss.schedule(JOBS.purgeLeftovers, '40 4 * * *');

  await boss.createQueue(JOBS.exportBuild, { retryLimit: 2, retryDelay: 60 });
  await boss.work<ExportJob>(JOBS.exportBuild, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await buildExport(processDeps, job.data);
  });

  // Only me notes and details written before 0.5.8, sealed: on every
  // start, which after the upgrade is the one that seals them. A document
  // that could not be is tried again, and the rest stay done.
  await boss.createQueue(JOBS.sealPrivate, { retryLimit: 3, retryDelay: 60 });
  await boss.work(JOBS.sealPrivate, async () => {
    const r = await sealPrivateValues({
      admin: dbs.admin,
      app: dbs.app,
      keys: processDeps.keys,
      log,
    });
    if (r.sealed) log('info', 'Only me notes and details sealed', r);
    if (r.failed) throw new Error(`${r.failed} Only me documents could not be sealed`);
  });
  await boss.send(JOBS.sealPrivate, {});

  // A type's reminding date or lead times changed, or its reminders switched
  // on or off: each of its documents reminded anew, as the vault, one per
  // transaction (0.5.10). An Only me document's reminding date is opened
  // with its owner's key for that alone (0.5.15, A62), as private.seal
  // opens with it: the log says counts and ids, never a value.
  await boss.createQueue(JOBS.regenerateTypes, {
    policy: 'stately',
    retryLimit: 3,
    retryDelay: 60,
  });
  await boss.work<RegenerateTypeJob>(JOBS.regenerateTypes, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const r = await regenerateTypeReminders({ app: dbs.app, keys: processDeps.keys }, job.data);
      log('info', "a type's reminders made again", { type_key: job.data.type_key, ...r });
      if (r.failed) throw new Error(`${r.failed} documents' reminders could not be made again`);
    }
  });

  const backupDeps = {
    adminUrl: config.DATABASE_ADMIN_URL ?? config.DATABASE_URL,
    backupKey: deriveKey(masterSecret, 'database-backup'),
    dir: config.FDV_BACKUP_DIR,
    retainDays: config.FDV_BACKUP_RETAIN_DAYS,
    log,
    masterSecret,
  };
  await boss.createQueue(JOBS.backupDatabase, { retryLimit: 3, retryDelay: 300 });
  await boss.work(JOBS.backupDatabase, async () => {
    await backupDatabase(backupDeps);
  });
  await boss.schedule(JOBS.backupDatabase, config.FDV_BACKUP_CRON);

  const vapid =
    config.FDV_VAPID_PUBLIC_KEY && config.FDV_VAPID_PRIVATE_KEY
      ? {
          publicKey: config.FDV_VAPID_PUBLIC_KEY,
          privateKey: config.FDV_VAPID_PRIVATE_KEY,
          subject: config.FDV_VAPID_SUBJECT,
        }
      : null;
  if (!vapid) log('warn', 'no VAPID keys: push notifications are off (run scripts/gen-env.mjs)');
  // Every push leaves through one agent that will not connect inside the
  // vault's own network, unless the operator says so (4.13).
  const allowPrivate = config.FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS === 'true';
  if (allowPrivate)
    log('warn', 'pushes may go to private addresses (FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS)');
  const pushAgent = createPushAgent({ allowPrivate });
  const notifier = createNotifier({
    app: dbs.app,
    vapid,
    smtpKey: deriveKey(masterSecret, 'smtp-credentials'),
    baseUrl: config.FDV_BASE_URL,
    log,
    agent: pushAgent,
    allowPrivate,
  });
  void logNotifier;

  const alertDeps = {
    operatorMail: config.FDV_SMTP_URL
      ? { url: config.FDV_SMTP_URL, from: config.FDV_SMTP_FROM }
      : null,
    app: dbs.app,
    vapid,
    smtpKey: deriveKey(masterSecret, 'smtp-credentials'),
    baseUrl: config.FDV_BASE_URL,
    log,
    agent: pushAgent,
    allowPrivate,
  };
  await boss.createQueue(JOBS.pushSend);
  await boss.work(JOBS.pushSend, async (jobs) => {
    for (const job of jobs) {
      if (!isPushJob(job.data)) {
        log('warn', 'push job had the wrong shape', { id: job.id });
        continue;
      }
      const { counts, next } = await sendPushJob(
        { app: dbs.app, vapid, agent: pushAgent, allowPrivate, log },
        job.data,
      );
      log('info', 'push sent', { type: job.data.message.type, ...counts });
      if (next) {
        await boss.send(JOBS.pushSend, { ...next.job }, { startAfter: next.delaySeconds });
        log('info', 'push to be tried again', {
          type: next.job.message.type,
          attempt: next.job.attempt,
          targets: next.job.targets.length,
          in_seconds: next.delaySeconds,
        });
      }
    }
  });
  await boss.createQueue(JOBS.alertSend);
  await boss.work(JOBS.alertSend, async (jobs) => {
    for (const job of jobs) {
      if (!isAlert(job.data)) {
        log('warn', 'alert job had the wrong shape', { id: job.id });
        continue;
      }
      const channels = await sendAlert(alertDeps, job.data);
      log('info', 'alert sent', { subject: job.data.subject, channels });
    }
  });
  // One email to one address (5.20): a share link's code, through the
  // operator's mail server alone. The log says one went, never to whom.
  const mailDeps = {
    mailKey: deriveKey(masterSecret, OPERATOR_MAIL_KEY_PURPOSE),
    operatorMail: alertDeps.operatorMail,
    log,
  };
  await boss.createQueue(JOBS.mailToAddress);
  await boss.work(JOBS.mailToAddress, async (jobs) => {
    for (const job of jobs) {
      if (!isMailJob(job.data)) {
        log('warn', 'mail job had the wrong shape', { id: job.id });
        continue;
      }
      const sent = await sendToAddress(mailDeps, job.data);
      log('info', 'email to one address', { household: job.data.household_id, sent });
    }
  });

  const reminderDeps = {
    admin: dbs.admin,
    app: dbs.app,
    notifier,
    log,
    digestHour: config.FDV_DIGEST_HOUR,
    weeklyHour: config.FDV_WEEKLY_HOUR,
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
  await boss.createQueue(JOBS.uploadsPrune);
  await boss.work(JOBS.uploadsPrune, async () => {
    log(
      'info',
      'upload keys pruned',
      await pruneUploads({
        admin: dbs.admin,
        app: dbs.app,
        credentialsKey: processDeps.credentialsKey,
        localRoot: processDeps.localRoot,
      }),
    );
  });
  await boss.schedule(JOBS.uploadsPrune, '25 4 * * *');

  // What came in through a request (5.23): got ready to be looked at, moved
  // to the owners when its reviewer can no longer review it, and swept.
  const incomingDeps: IncomingDeps = {
    admin: dbs.admin,
    db: dbs.app,
    keys: processDeps.keys,
    credentialsKey: processDeps.credentialsKey,
    localRoot: processDeps.localRoot,
    log,
    tell: {
      vapid,
      smtpKey: deriveKey(masterSecret, 'smtp-credentials'),
      baseUrl: config.FDV_BASE_URL,
      agent: pushAgent,
      allowPrivate,
    },
  };
  await boss.createQueue(JOBS.incomingScan, { retryLimit: 2, retryDelay: 60 });
  await boss.work<IncomingScanJob>(JOBS.incomingScan, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await scanIncoming(incomingDeps, job.data);
  });
  await boss.createQueue(JOBS.incomingMove, { retryLimit: 3, retryDelay: 60 });
  await boss.work<IncomingMoveJob>(JOBS.incomingMove, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await moveIncoming(incomingDeps, job.data);
  });
  await boss.createQueue(JOBS.incomingSweep, { retryLimit: 3, retryDelay: 300 });
  await boss.work(JOBS.incomingSweep, async () => {
    log('info', 'files sent in swept', { ...(await sweepIncoming(incomingDeps)) });
  });
  await boss.schedule(JOBS.incomingSweep, '50 4 * * *');
  await boss.createQueue(JOBS.remindersWeekly);
  await boss.work(JOBS.remindersWeekly, async () => {
    const r = await weekly(reminderDeps);
    if (r.digests) log('info', 'weekly summaries sent', r);
  });
  await boss.schedule(JOBS.remindersWeekly, '10 * * * *');
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
