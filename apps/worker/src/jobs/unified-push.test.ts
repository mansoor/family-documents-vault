import { createECDH, randomBytes, randomUUID, type ECDH } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { deriveKey } from '@fdv/crypto';
import { createDb, createPool, withHousehold, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import ece from 'http_ece';
import pg from 'pg';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNotifier } from './notify.js';
import {
  createPushAgent,
  deliver,
  FAILURES_BEFORE_FAILED,
  PUSH_RETRIES,
  sendPushJob,
  type PushDeps,
  type PushJob,
} from './push.js';
import type { Digest } from './reminders.js';

/**
 * UnifiedPush from the worker (4.13), against a local HTTPS fake of a push
 * distributor, decrypting what it receives with the subscription's own
 * keys — as the phone would.
 */
const cert = readFileSync(new URL('./testdata/push-tls.crt', import.meta.url));
const key = readFileSync(new URL('./testdata/push-tls.key', import.meta.url));

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

describe.skipIf(!testAdminUrl())('UnifiedPush from the worker', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let server: https.Server;
  let port = 0;
  const hh = randomUUID();
  let account = '';
  let sessionId = '';
  const received: Received[] = [];
  const answers: number[] = [];
  const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:test@example.test' };
  const smtpKey = deriveKey('unified-push-test-master-secret-32-bytes', 'smtp-credentials');
  const log = () => undefined;
  // The phone's keys, as the app makes them for its subscription.
  const phone: { ecdh: ECDH; p256dh: string; auth: string } = (() => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return {
      ecdh,
      p256dh: ecdh.getPublicKey('base64url'),
      auth: randomBytes(16).toString('base64url'),
    };
  })();
  const open = (body: Buffer) =>
    JSON.parse(
      ece
        .decrypt(body, { version: 'aes128gcm', privateKey: phone.ecdh, authSecret: phone.auth })
        .toString('utf8'),
    ) as unknown;

  /** A phone registered through the distributor on this machine. */
  const device = async (name: string, over: { kind?: string; session?: string | null } = {}) => {
    const r = await admin.query<{ id: string }>(
      `insert into device (household_id, account_id, kind, endpoint, p256dh, auth, session_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        hh,
        account,
        over.kind ?? 'unified_push',
        `https://localhost:${port}/up/${name}`,
        phone.p256dh,
        phone.auth,
        over.session === undefined ? sessionId : over.session,
      ],
    );
    return r.rows[0]?.id as string;
  };
  const row = async (id: string) =>
    (
      await admin.query<{ failed_at: Date | null; consecutive_failures: number }>(
        'select failed_at, consecutive_failures from device where id = $1',
        [id],
      )
    ).rows[0] ?? null;

  const pushDeps = (over: Partial<PushDeps> = {}): PushDeps => ({
    app: db,
    vapid,
    agent: createPushAgent({ allowPrivate: true, ca: cert }),
    allowPrivate: true,
    log,
    ...over,
  });

  beforeAll(async () => {
    server = https.createServer({ cert, key }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
        const status = answers.shift() ?? 201;
        if (status === 0) return; // a push service that never answers
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;

    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    await admin.query("insert into household (id, name, timezone) values ($1, 'Push', 'UTC')", [
      hh,
    ]);
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'M') returning id",
      [hh],
    );
    const a = await admin.query<{ id: string }>(
      "insert into account (email) values ('up@example.test') returning id",
    );
    account = a.rows[0]?.id as string;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [account, hh, m.rows[0]?.id],
    );
    const s = await admin.query<{ id: string }>(
      `insert into session (account_id, household_id, refresh_hash, expires_at)
       values ($1, $2, $3, now() + interval '30 days') returning id`,
      [account, hh, randomBytes(32)],
    );
    sessionId = s.rows[0]?.id as string;
  }, 60_000);

  beforeEach(async () => {
    received.length = 0;
    answers.length = 0;
    await admin.query('delete from device where household_id = $1', [hh]);
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  const digestOf = (kind: Digest['kind']): Digest => ({
    household_id: hh,
    household_name: 'Push',
    timezone: 'UTC',
    local_date: '2026-10-03',
    kind,
    recipient: { account_id: account, email: 'up@example.test' },
    items: [1, 2, 3].map((n) => ({
      reminder_id: randomUUID(),
      document_id: randomUUID(),
      title: `Anna Example passport ${n}`,
      label: 'Due today',
      note: null,
      overdue: false,
      private: false,
    })),
  });
  const notifier = () =>
    createNotifier({
      app: db,
      vapid,
      smtpKey,
      baseUrl: 'https://vault.example.test',
      log,
      agent: createPushAgent({ allowPrivate: true, ca: cert }),
      allowPrivate: true,
    });

  it('a digest to a phone carries a count and no title bytes', async () => {
    await device('phone');
    expect(await notifier().digest(digestOf('daily'))).toContain('push');
    expect(received).toHaveLength(1);
    const got = received[0] as Received;
    expect(open(got.body)).toEqual({ v: 1, type: 'digest', count: 3, date: '2026-10-03' });
    // Nothing of a title, even encrypted-looking.
    expect(got.body.includes(Buffer.from('Anna'))).toBe(false);
    expect(got.headers.topic).toBe('fdv-digest');
    expect(got.headers.ttl).toBe(String(24 * 3600));
    expect(got.headers['content-encoding']).toBe('aes128gcm');
  });

  it('the Sunday summary is not pushed to a phone: it is an email', async () => {
    await device('weekly-phone');
    expect(await notifier().digest(digestOf('weekly'))).not.toContain('push');
    expect(received).toHaveLength(0);
  });

  it('a session that ended is told so, for a week, even with its row already gone', async () => {
    const { counts, next } = await sendPushJob(pushDeps(), {
      household_id: hh,
      message: { v: 1, type: 'session_ended' },
      targets: [
        {
          id: null,
          kind: 'unified_push',
          endpoint: `https://localhost:${port}/up/gone-phone`,
          p256dh: phone.p256dh,
          auth: phone.auth,
        },
      ],
    });
    expect(counts.sent).toBe(1);
    expect(next).toBeNull();
    const got = received[0] as Received;
    expect(open(got.body)).toEqual({ v: 1, type: 'session_ended' });
    expect(got.headers.ttl).toBe(String(7 * 24 * 3600));
  });

  it('a session_ended the push service did not take is tried again, later each time, then no more', async () => {
    const target = (name: string) => ({
      id: null,
      kind: 'unified_push' as const,
      endpoint: `https://localhost:${port}/up/${name}`,
      p256dh: phone.p256dh,
      auth: phone.auth,
    });
    const job: PushJob = {
      household_id: hh,
      message: { v: 1, type: 'session_ended' },
      targets: [target('ended-busy'), target('ended-fine')],
    };
    answers.push(503);
    const first = await sendPushJob(pushDeps(), job);
    expect(first.counts).toMatchObject({ counted: 1, sent: 1 });
    // Only the one that did not go, a minute later.
    expect(first.next).toEqual({
      job: { ...job, targets: [target('ended-busy')], attempt: 1 },
      delaySeconds: 60,
    });
    answers.push(503);
    const third = await sendPushJob(pushDeps(), {
      ...job,
      targets: [target('ended-busy')],
      attempt: 2,
    });
    expect(third.next?.delaySeconds).toBe(240);
    answers.push(503);
    const last = await sendPushJob(pushDeps(), {
      ...job,
      targets: [target('ended-busy')],
      attempt: PUSH_RETRIES,
    });
    expect(last.counts.counted).toBe(1);
    expect(last.next).toBeNull();
    // Refused for good (a 403): not tried again either.
    answers.push(403);
    expect(
      (await sendPushJob(pushDeps(), { ...job, targets: [target('ended-no')] })).next,
    ).toBeNull();
  });

  it('a push service that never answers is given up on, and counted', async () => {
    const id = await device('silent');
    answers.push(0);
    const started = Date.now();
    const outcome = await deliver(
      pushDeps({ timeoutMs: 300 }),
      {
        id,
        household_id: hh,
        endpoint: `https://localhost:${port}/up/silent`,
        p256dh: phone.p256dh,
        auth: phone.auth,
      },
      '{"v":1,"type":"test"}',
      'test',
    );
    expect(outcome).toBe('counted');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await row(id)).toEqual({ failed_at: null, consecutive_failures: 1 });
  });

  it('an endpoint that resolves to 127.0.0.1, 169.254.169.254 or 10.0.0.5 is refused unless allowed', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.5']) {
      const id = await device(`dns-${address}`);
      // The name resolves inside the vault's own network when the push is sent.
      const lookup = ((
        _h: string,
        _o: unknown,
        cb: (e: null, a: { address: string; family: number }[]) => void,
      ) => cb(null, [{ address, family: 4 }])) as never;
      const refused = await deliver(
        pushDeps({
          agent: createPushAgent({ allowPrivate: false, lookup, ca: cert }),
          allowPrivate: false,
        }),
        {
          id,
          household_id: hh,
          endpoint: `https://localhost:${port}/up/dns`,
          p256dh: phone.p256dh,
          auth: phone.auth,
        },
        '{"v":1,"type":"test"}',
        'test',
      );
      expect(refused).toBe('refused');
      expect((await row(id))?.failed_at).not.toBeNull();
    }
    // Written out as an address, too (no DNS is asked for one).
    const literal = await device('literal');
    await admin.query('update device set endpoint = $1 where id = $2', [
      `https://127.0.0.1:${port}/up/literal`,
      literal,
    ]);
    const refused = await deliver(
      pushDeps({ allowPrivate: false, agent: createPushAgent({ allowPrivate: false, ca: cert }) }),
      {
        id: literal,
        household_id: hh,
        endpoint: `https://127.0.0.1:${port}/up/literal`,
        p256dh: phone.p256dh,
        auth: phone.auth,
      },
      '{"v":1,"type":"test"}',
      'test',
    );
    expect(refused).toBe('refused');
    expect(received).toHaveLength(0);
    // Allowed by the operator (a distributor on the LAN): it goes.
    const allowed = await device('allowed');
    const lookup = ((
      _h: string,
      _o: unknown,
      cb: (e: null, a: { address: string; family: number }[]) => void,
    ) => cb(null, [{ address: '127.0.0.1', family: 4 }])) as never;
    expect(
      await deliver(
        pushDeps({ agent: createPushAgent({ allowPrivate: true, lookup, ca: cert }) }),
        {
          id: allowed,
          household_id: hh,
          endpoint: `https://localhost:${port}/up/allowed`,
          p256dh: phone.p256dh,
          auth: phone.auth,
        },
        '{"v":1,"type":"test"}',
        'test',
      ),
    ).toBe('sent');
  });

  it('a 410 removes the device, and says so in the activity log', async () => {
    const id = await device('gone');
    answers.push(410);
    const outcome = await sendPushJob(pushDeps(), {
      household_id: hh,
      message: { v: 1, type: 'test' },
      targets: [
        {
          id,
          kind: 'unified_push',
          endpoint: `https://localhost:${port}/up/gone`,
          p256dh: phone.p256dh,
          auth: phone.auth,
        },
      ],
    });
    expect(outcome.counts.gone).toBe(1);
    expect(await row(id)).toBeNull();
    const audit = await withHousehold(db, hh, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action', 'object_id'])
        .where('action', '=', 'notifications.device_gone')
        .execute(),
    );
    expect(audit.map((a) => a.object_id)).toContain(id);
  });

  it('a 503 keeps it and counts', async () => {
    const id = await device('busy');
    answers.push(503);
    const target = {
      id,
      kind: 'unified_push' as const,
      endpoint: `https://localhost:${port}/up/busy`,
      p256dh: phone.p256dh,
      auth: phone.auth,
    };
    const outcome = await sendPushJob(pushDeps(), {
      household_id: hh,
      message: { v: 1, type: 'test' },
      targets: [target],
    });
    expect(outcome.counts.counted).toBe(1);
    // It has a row: it counts, and hears the next push rather than this one again.
    expect(outcome.next).toBeNull();
    expect(await row(id)).toEqual({ failed_at: null, consecutive_failures: 1 });
  });

  it('ten failures in a row mark it failed and one success resets it', async () => {
    const id = await device('flaky');
    const target = {
      id,
      kind: 'unified_push' as const,
      endpoint: `https://localhost:${port}/up/flaky`,
      p256dh: phone.p256dh,
      auth: phone.auth,
    };
    const once = () =>
      sendPushJob(pushDeps(), {
        household_id: hh,
        message: { v: 1, type: 'test' },
        targets: [target],
      });
    for (let i = 0; i < FAILURES_BEFORE_FAILED - 1; i += 1) {
      answers.push(503);
      await once();
    }
    expect(await row(id)).toEqual({
      failed_at: null,
      consecutive_failures: FAILURES_BEFORE_FAILED - 1,
    });
    await once(); // 201
    expect(await row(id)).toEqual({ failed_at: null, consecutive_failures: 0 });
    for (let i = 0; i < FAILURES_BEFORE_FAILED; i += 1) {
      answers.push(503);
      await once();
    }
    const failed = await row(id);
    expect(failed?.consecutive_failures).toBe(FAILURES_BEFORE_FAILED);
    expect(failed?.failed_at).not.toBeNull();
  });

  it('a 403 marks it failed at once', async () => {
    const id = await device('refused');
    answers.push(403);
    await sendPushJob(pushDeps(), {
      household_id: hh,
      message: { v: 1, type: 'test' },
      targets: [
        {
          id,
          kind: 'unified_push',
          endpoint: `https://localhost:${port}/up/refused`,
          p256dh: phone.p256dh,
          auth: phone.auth,
        },
      ],
    });
    expect((await row(id))?.failed_at).not.toBeNull();
  });
});
