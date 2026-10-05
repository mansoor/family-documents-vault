import { randomBytes, randomUUID } from 'node:crypto';
import { deriveKey } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import webpush from 'web-push';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sendAlert } from './alerts.js';
import { createNotifier } from './notify.js';
import type { Digest } from './reminders.js';

/**
 * Notifications end when the sign-in does.
 *
 * Before 0.4.2 a browser that had once turned notifications on kept
 * receiving that person's digest after they signed out of it — on a
 * shared laptop, the next person to sit down saw the last one's private
 * titles — and a browser used with a stolen session kept receiving it
 * after the password was changed.
 */
describe.skipIf(!testAdminUrl())('push reaches only live sign-ins', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  const hh = randomUUID();
  let account = '';
  const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:test@example.test' };
  const smtpKey = deriveKey('push-sessions-test-master-secret-32-bytes', 'smtp-credentials');

  const session = async (live: boolean) => {
    const r = await admin.query<{ id: string }>(
      `insert into session (account_id, household_id, refresh_hash, expires_at, revoked_at)
       values ($1, $2, $3, now() + interval '30 days', $4) returning id`,
      [account, hh, randomBytes(32), live ? null : new Date()],
    );
    return r.rows[0]?.id as string;
  };
  const device = (name: string, sessionId: string | null) =>
    admin.query(
      `insert into device (household_id, account_id, endpoint, p256dh, auth, session_id)
       values ($1, $2, $3, 'k', 'a', $4)`,
      [hh, account, `https://push.example.test/${hh}/${name}`, sessionId],
    );

  const digest = (): Digest => ({
    household_id: hh,
    household_name: 'Sessions',
    timezone: 'UTC',
    local_date: '2026-09-22',
    kind: 'daily',
    recipient: { account_id: account, email: 'sessions@example.test' },
    items: [
      {
        reminder_id: randomUUID(),
        document_id: randomUUID(),
        title: 'My own private title',
        label: 'Due today',
        about: null,
        note: null,
        overdue: false,
        private: false,
      },
    ],
  });

  const pushedTo = () => {
    const endpoints: string[] = [];
    vi.spyOn(webpush, 'sendNotification').mockImplementation(async (sub) => {
      endpoints.push(sub.endpoint.split('/').pop() as string);
      return { statusCode: 201, body: '', headers: {} };
    });
    return endpoints;
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    await admin.query("insert into household (id, name, timezone) values ($1, 'Sessions', 'UTC')", [
      hh,
    ]);
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'M') returning id",
      [hh],
    );
    const a = await admin.query<{ id: string }>(
      "insert into account (email) values ('sessions@example.test') returning id",
    );
    account = a.rows[0]?.id as string;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [account, hh, m.rows[0]?.id],
    );
    // The phone in their pocket, still signed in; the shared laptop they
    // signed out of; a browser registered before sessions were recorded.
    await device('phone', await session(true));
    await device('shared-laptop', await session(false));
    await device('old-browser', null);
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  const notifier = () =>
    createNotifier({ app: db, vapid, smtpKey, baseUrl: 'x', log: () => undefined });

  it('a digest goes to the live sign-ins, never to the one they signed out of', async () => {
    const endpoints = pushedTo();
    await notifier().digest(digest());
    expect(endpoints.sort()).toEqual(['old-browser', 'phone']);
  });

  it('an alert follows the same rule', async () => {
    const endpoints = pushedTo();
    await sendAlert(
      { app: db, vapid, smtpKey, baseUrl: 'x', log: () => undefined },
      { household_id: hh, account_ids: [account], subject: 'A new device', body: 'b' },
    );
    expect(endpoints.sort()).toEqual(['old-browser', 'phone']);
  });

  it('a sign-in locked, or paused after a restore, is pushed nothing but of its own sign-in (5.28)', async () => {
    const alert = { household_id: hh, account_ids: [account], subject: 'A new device', body: 'b' };
    const deps = { app: db, vapid, smtpKey, baseUrl: 'x', log: () => undefined };
    // Another owner who can sign in, as every household keeps (0051's floor):
    // this one is locked as no owner could be through the API, to see the rule.
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'Other') returning id",
      [hh],
    );
    const o = await admin.query<{ id: string }>(
      "insert into account (email) values ('other-sessions-528@example.test') returning id",
    );
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [o.rows[0]?.id, hh, m.rows[0]?.id],
    );
    await admin.query(
      `update account_household set suspended_at = now(), suspend_reason = 'locked' where account_id = $1`,
      [account],
    );
    try {
      let endpoints = pushedTo();
      await sendAlert(deps, alert);
      expect(endpoints).toEqual([]);
      vi.restoreAllMocks();
      endpoints = pushedTo();
      await sendAlert(deps, { ...alert, own_sign_in: true });
      expect(endpoints.sort()).toEqual(['old-browser', 'phone']);
    } finally {
      await admin.query(
        `update account_household set suspended_at = null, suspend_reason = null where account_id = $1`,
        [account],
      );
    }
  });

  it("a guest's sign-in past its end is pushed nothing but of its own sign-in (5.34)", async () => {
    const deps = { app: db, vapid, smtpKey, baseUrl: 'x', log: () => undefined };
    // Somebody outside the family, limited, whose sign-in ended a minute ago
    // (written as the owning role: nobody signed in may set it so).
    const g = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name, kind) values ($1, 'Gwen', 'guest') returning id",
      [hh],
    );
    const guest = g.rows[0]?.id as string;
    const a = await admin.query<{ id: string }>(
      "insert into account (email) values ('gwen-sessions-534@example.test') returning id",
    );
    const gwen = a.rows[0]?.id as string;
    await admin.query('insert into access_restriction (member_id, household_id) values ($1, $2)', [
      guest,
      hh,
    ]);
    await admin.query(
      `insert into account_household (account_id, household_id, member_id, role, access_expires_at)
       values ($1, $2, $3, 'viewer', now() + interval '10 days')`,
      [gwen, hh, guest],
    );
    const s = await admin.query<{ id: string }>(
      `insert into session (account_id, household_id, refresh_hash, expires_at)
       values ($1, $2, $3, now() + interval '30 days') returning id`,
      [gwen, hh, randomBytes(32)],
    );
    await admin.query(
      `insert into device (household_id, account_id, endpoint, p256dh, auth, session_id)
       values ($1, $2, $3, 'k', 'a', $4)`,
      [hh, gwen, `https://push.example.test/${hh}/gwen-phone`, s.rows[0]?.id],
    );
    const alert = { household_id: hh, account_ids: [gwen], subject: 'A new device', body: 'b' };
    // Still running: told.
    let endpoints = pushedTo();
    await sendAlert(deps, alert);
    expect(endpoints).toEqual(['gwen-phone']);
    vi.restoreAllMocks();
    // Ended: nothing, but of her own sign-in.
    await admin.query(
      `update account_household set access_expires_at = now() - interval '1 minute'
        where account_id = $1`,
      [gwen],
    );
    endpoints = pushedTo();
    await sendAlert(deps, alert);
    expect(endpoints).toEqual([]);
    vi.restoreAllMocks();
    endpoints = pushedTo();
    await sendAlert(deps, { ...alert, own_sign_in: true });
    expect(endpoints).toEqual(['gwen-phone']);
  });

  it('once every sign-in has ended, nothing is sent anywhere', async () => {
    await withSystem(db, hh, (trx) =>
      trx.updateTable('session').set({ revoked_at: new Date() }).execute(),
    );
    const endpoints = pushedTo();
    await notifier().digest(digest());
    expect(endpoints).toEqual([]);
  });
});
