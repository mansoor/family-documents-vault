import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deriveKey, EncryptStream, EnvKeyProvider, newKey, ScopeKeys, wrapKey } from '@fdv/crypto';
import { appendAudit, createDb, createPool, withSystem, type Db, type Schema } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { LocalAdapter } from '@fdv/storage';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendAlert } from './jobs/alerts.js';
import { buildExport } from './jobs/export.js';
import { createNotifier } from './jobs/notify.js';
import { backfillPreviews, renderVersionPreviews } from './jobs/previews.js';
import { processVersion } from './jobs/process-version.js';
import { pushDepsOf, sendPushJob } from './jobs/push.js';
import { deliver, refreshStatus, tick, weekly } from './jobs/reminders.js';
import { pruneUploads } from './jobs/uploads.js';
import { verifyAllAuditChains } from './jobs/verify-audit.js';

/**
 * The worker is the vault itself (5.5): every job it runs says so to the
 * database, and still does its work. Nothing reads the actor yet; once the
 * policies do (5.6), a job that forgot to say it would quietly process
 * nothing, and this is where that shows.
 *
 * Every job main.ts registers that opens a scope is run here once, against
 * one seeded household. The heartbeat and the backup open none: the backup
 * is pg_dump as the owning role. The restore check sets its settings by
 * hand, and restore.test.ts covers it.
 */

const MASTER = 'worker-test-master-key-with-32-bytes-or-more';

/** A one-page PDF, built by hand: enough for every tool, or for none. */
function onePagePdf(): Buffer {
  const stream = 'BT /F1 24 Tf 40 700 Td (ACTOR) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Just enough SMTP to take every message. */
async function fakeSmtp() {
  const received: string[] = [];
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    let inData = false;
    const say = (line: string) => sock.write(`${line}\r\n`);
    say('220 fake ESMTP');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            say('250 queued');
          } else if (line.startsWith('Subject: ')) received.push(line.slice(9));
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'DATA') {
          inData = true;
          say('354 go ahead');
        } else if (verb === 'QUIT') {
          say('221 bye');
          sock.end();
        } else say('250 ok');
      }
    });
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as net.AddressInfo).port;
  return { port, received, close: () => new Promise((res) => server.close(res)) };
}

describe.skipIf(!testAdminUrl())('the worker asks as the vault itself', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let seed: Db;
  let app: Db;
  let vaultDir: string;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  const hh = randomUUID();
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const credentialsKey = deriveKey(MASTER, 'vault-credentials');
  const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:test@example.test' };
  // A Sunday evening in the household's own zone: every reminder job has work.
  const now = new Date('2026-09-27T19:00:00Z');
  const log = () => undefined;
  const ids = { account: '', member: '', document: '', version: '', export: '' };
  const devices: string[] = [];

  /** Every scope the jobs open, as the database is told it. */
  const opened: Array<{ household: unknown; actor: unknown }> = [];

  beforeAll(async () => {
    smtp = await fakeSmtp();
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    seed = createDb(createPool(tdb.appUrl, 2));
    // The jobs' own connection, listening for what each transaction says first.
    app = new Kysely<Schema>({
      dialect: new PostgresDialect({ pool: createPool(tdb.appUrl, 3) }),
      log(event) {
        if (event.level !== 'query' || !event.query.sql.includes("set_config('app.actor'")) return;
        const [household, actor] = event.query.parameters;
        opened.push({ household, actor });
      },
    });
    vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-actor-vault-'));

    await admin.query("insert into household (id, name, timezone) values ($1, 'Actors', 'UTC')", [
      hh,
    ]);
    ids.member = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Owner') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    ids.account = (
      await admin.query<{ id: string }>(
        "insert into account (email) values ('owner@actors.test') returning id",
      )
    ).rows[0]?.id as string;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [ids.account, hh, ids.member],
    );

    await withSystem(seed, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      await keys.mintMemberKey(trx, hh, ids.member, null);
      const vault = await trx
        .insertInto('vault')
        .values({ household_id: hh, kind: 'local', label: 'test', status: 'ok' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('household')
        .set({ active_vault_id: vault.id })
        .where('id', '=', hh)
        .execute();

      // An Essential with a file, and a reminder that has come round.
      const doc = await trx
        .insertInto('document')
        .values({
          household_id: hh,
          title: 'Passport',
          type_key: 'passport',
          owner_member_id: ids.member,
          is_essential: true,
          expires_on: '2027-03-20',
          expires_precision: 'day',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids.document = doc.id;
      await trx
        .insertInto('reminder')
        .values({
          household_id: hh,
          document_id: doc.id,
          kind: 'derived',
          fire_at: '2026-09-20',
          lead_days: 180,
        })
        .execute();
      const scope = await keys.unwrap(trx, { householdId: hh, kind: 'household' });
      const fileKey = newKey();
      const key = `${hh}/${doc.id}/1/passport.pdf.enc`;
      const plain = onePagePdf();
      const enc = new EncryptStream(fileKey);
      const [put] = await Promise.all([
        new LocalAdapter(vaultDir).put(key, enc),
        pipeline(Readable.from([plain]), enc),
      ]);
      ids.version = (
        await trx
          .insertInto('document_version')
          .values({
            household_id: hh,
            document_id: doc.id,
            version_no: 1,
            filename: 'passport.pdf',
            mime: 'application/pdf',
            byte_size: plain.length,
            sha256: Buffer.alloc(32),
            cipher_bytes: put.bytes,
            cipher_sha256: Buffer.from(put.sha256, 'hex'),
            storage_key: key,
            vault_id: vault.id,
            file_key_wrapped: wrapKey(fileKey, scope.key, `version:${doc.id}`),
            wrapped_by_scope: scope.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;

      // Signed in, with two browsers whose push addresses the vault will
      // refuse without going anywhere: one for the push job, one for alerts.
      const session = await trx
        .insertInto('session')
        .values({
          account_id: ids.account,
          household_id: hh,
          refresh_hash: randomBytes(32),
          expires_at: new Date(Date.now() + 30 * 864e5),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const n of [1, 2]) {
        const d = await trx
          .insertInto('device')
          .values({
            household_id: hh,
            account_id: ids.account,
            endpoint: `http://push.example.test/${n}`,
            p256dh: 'test-key',
            auth: 'test-auth',
            session_id: session.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        devices.push(d.id);
      }
      await trx
        .insertInto('smtp_settings')
        .values({
          household_id: hh,
          host: '127.0.0.1',
          port: smtp.port,
          secure: false,
          from_email: 'vault@actors.test',
          status: 'ok',
        })
        .execute();

      ids.export = (
        await trx
          .insertInto('export')
          .values({ household_id: hh, requested_by: ids.account })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      // An upload whose try died two days ago.
      await trx
        .insertInto('upload_idempotency')
        .values({
          idempotency_key: randomUUID(),
          household_id: hh,
          account_id: ids.account,
          state: 'pending',
          request_kind: 'capture',
          claim_nonce: randomUUID(),
          claimed_at: new Date(now.getTime() - 2 * 864e5),
        })
        .execute();
      await appendAudit(trx, { householdId: hh, action: 'household.created' });
    });
  }, 60_000);

  afterAll(async () => {
    await app?.destroy();
    await seed?.destroy();
    await admin?.end();
    await tdb?.drop();
    await smtp?.close();
    if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
  });

  const version = () =>
    withSystem(seed, hh, (trx) =>
      trx
        .selectFrom('document_version')
        .select(['processed_at', 'preview_state'])
        .where('id', '=', ids.version)
        .executeTakeFirstOrThrow(),
    );
  const failedDevices = async () =>
    (
      await admin.query<{ id: string }>(
        'select id from device where failed_at is not null order by id',
      )
    ).rows.map((r) => r.id);

  it('every worker job, run against a seeded household, still does its work as system', async () => {
    const queued: string[] = [];
    const send = async (job: { version_id: string }) => void queued.push(job.version_id);
    const processDeps = {
      db: app,
      keys,
      credentialsKey,
      localRoot: vaultDir,
      maxOcrPages: 1,
      log,
      sendPreviews: send,
    };
    const notifier = createNotifier({
      app,
      vapid,
      smtpKey: deriveKey(MASTER, 'smtp-credentials'),
      baseUrl: 'https://vault.example.test',
      log,
    });
    const reminderDeps = { admin, app, notifier, log, now: () => now };
    const alertDeps = {
      app,
      vapid,
      smtpKey: deriveKey(MASTER, 'smtp-credentials'),
      baseUrl: 'https://vault.example.test',
      operatorMail: { url: `smtp://127.0.0.1:${smtp.port}`, from: 'operator@actors.test' },
      log,
    };

    const jobs: Array<[string, () => Promise<void>]> = [
      [
        'audit.verify',
        async () => {
          expect(await verifyAllAuditChains(admin, app)).toEqual({ households: 1, broken: [] });
        },
      ],
      [
        'previews backfill',
        async () => {
          expect(await backfillPreviews({ admin, app, send })).toBe(1);
          expect(queued).toEqual([ids.version]);
          expect((await version()).preview_state).toBe('queued');
        },
      ],
      [
        'version.process',
        async () => {
          await processVersion(processDeps, { household_id: hh, version_id: ids.version });
          expect((await version()).processed_at).not.toBeNull();
        },
      ],
      [
        'previews.render',
        async () => {
          // Drawn where the tools are installed, recorded as failed where not:
          // either way the job reached its outcome.
          await renderVersionPreviews(processDeps, { household_id: hh, version_id: ids.version })
            .then(() => 'ready')
            .catch(() => 'failed');
          expect(['ready', 'failed']).toContain((await version()).preview_state);
        },
      ],
      [
        'export.build',
        async () => {
          await buildExport(processDeps, { household_id: hh, export_id: ids.export });
          const e = await admin.query<{ state: string; document_count: number }>(
            'select state, document_count from export where id = $1',
            [ids.export],
          );
          expect(e.rows[0]).toEqual({ state: 'done', document_count: 1 });
        },
      ],
      [
        'push.send',
        async () => {
          const r = await sendPushJob(pushDepsOf({ app, vapid, log }), {
            household_id: hh,
            message: { v: 1, type: 'test' },
            targets: [
              {
                id: devices[0] as string,
                kind: 'web_push',
                endpoint: 'http://push.example.test/1',
                p256dh: 'test-key',
                auth: 'test-auth',
              },
            ],
          });
          expect(r.counts.refused).toBe(1);
          expect(await failedDevices()).toEqual([devices[0]]);
        },
      ],
      [
        'alert.send',
        async () => {
          const alert = {
            household_id: hh,
            account_ids: [ids.account],
            subject: 'A new device signed in',
            body: 'If that was you, nothing to do.',
          };
          expect(await sendAlert(alertDeps, alert)).toEqual(['email']);
          // The other browser was tried, and refused.
          expect(await failedDevices()).toEqual([...devices].sort());
          expect(
            await sendAlert(alertDeps, { ...alert, subject: 'A reset', via: 'operator' }),
          ).toEqual(['email']);
          expect(smtp.received).toEqual(['A new device signed in', 'A reset']);
        },
      ],
      [
        'reminders.tick',
        async () => {
          expect(await tick(reminderDeps)).toEqual({ became_due: 1 });
        },
      ],
      [
        'reminders.deliver',
        async () => {
          expect(await deliver(reminderDeps)).toEqual({ digests: 1 });
        },
      ],
      [
        'reminders.weekly',
        async () => {
          expect(await weekly(reminderDeps)).toEqual({ digests: 1 });
          expect(smtp.received).toHaveLength(3);
        },
      ],
      [
        'status.refresh',
        async () => {
          expect(await refreshStatus(reminderDeps)).toEqual({ documents: 1 });
        },
      ],
      [
        'uploads.prune',
        async () => {
          expect(
            await pruneUploads({ admin, app, credentialsKey, localRoot: vaultDir, now: () => now }),
          ).toEqual({ done: 0, abandoned: 1 });
        },
      ],
    ];

    for (const [name, job] of jobs) {
      opened.length = 0;
      await job();
      expect(opened.length, `${name} opened no scope`).toBeGreaterThan(0);
      expect(
        opened.filter((s) => s.actor !== 'system' || s.household !== hh),
        `${name} asked as somebody else`,
      ).toEqual([]);
    }
  }, 120_000);
});
