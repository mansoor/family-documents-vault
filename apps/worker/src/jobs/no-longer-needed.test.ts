import { randomUUID } from 'node:crypto';
import { EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createDb, createPool, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliver, refreshStatus, tick, weekly, type Digest } from './reminders.js';
import { regenerateTypeReminders } from './types.js';

const MASTER = 'no-longer-needed-test-master-secret-32-bytes';

/**
 * No longer needed (0.9.0, 0082) in the worker: a document marked so is
 * passed by — never made due by the tick, in no daily digest (email or
 * push) and no Sunday summary, reminded of nothing when its kind's
 * reminders are made again, and its status said so by the nightly refresh.
 * The API resolves its reminders as it marks it; these are the ones it
 * would have missed, left open as an older vault left them.
 */
describe.skipIf(!testAdminUrl())('a document no longer needed, to the worker (0082)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  const hh = randomUUID();
  const sent: Digest[] = [];
  const notifier = { digest: async (d: Digest) => (sent.push(d), ['email', 'push']) };
  let clock = new Date('2026-09-22T09:10:00Z');
  const deps = () => ({ admin, app: db, notifier, log: () => undefined, now: () => clock });
  const ids = { needed: '', ead: '', visa: '' };
  const statuses = async (doc: string) =>
    (
      await admin.query<{ kind: string; status: string; fire_at: Date }>(
        `select kind, status, fire_at from reminder where document_id = $1
          order by fire_at, status`,
        [doc],
      )
    ).rows.map((r) => `${r.kind}:${r.status}`);

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    await admin.query("insert into household (id, name, timezone) values ($1, 'Kept', 'UTC')", [
      hh,
    ]);
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'M') returning id",
      [hh],
    );
    const a = await admin.query<{ id: string }>(
      "insert into account (email) values ('kept-0082@example.test') returning id",
    );
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [a.rows[0]?.id, hh, m.rows[0]?.id],
    );
    const doc = async (title: string, type: string | null, expires: string | null) =>
      (
        await admin.query<{ id: string }>(
          `insert into document (household_id, title, type_key, owner_member_id,
                                 expires_on, expires_precision)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [hh, title, type, m.rows[0]?.id, expires, expires ? 'day' : null],
        )
      ).rows[0]?.id as string;
    ids.needed = await doc('Water bill', null, null);
    ids.ead = await doc('EAD card', 'visa', '2026-12-01');
    ids.visa = await doc('Work visa', 'visa', '2026-12-01');
    const remind = (d: string, status: string, fire: string, snoozed: string | null = null) =>
      admin.query(
        `insert into reminder (household_id, document_id, kind, fire_at, status, snoozed_until, note)
         values ($1, $2, 'manual', $3, $4, $5, 'Look at it')`,
        [hh, d, fire, status, snoozed],
      );
    await remind(ids.needed, 'due', '2026-09-20');
    await remind(ids.ead, 'due', '2026-09-20');
    await remind(ids.ead, 'scheduled', '2026-09-21');
    await remind(ids.ead, 'snoozed', '2026-09-19', '2026-09-21');
    // Marked by the owning role, as a restore leaves a vault: its reminders
    // still open, which the API's marking never leaves.
    await admin.query('update document set no_longer_needed_at = now() where id = $1', [ids.ead]);
  });
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  it('the tick never makes one due: scheduled and snoozed stay as they are', async () => {
    await tick(deps());
    expect(await statuses(ids.ead)).toEqual(['manual:snoozed', 'manual:due', 'manual:scheduled']);
  });

  it('in no digest, by email or push, and in no Sunday summary', async () => {
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 1 });
    expect(sent.at(-1)?.items.map((i) => i.title)).toEqual(['Water bill']);
    // Sunday 27 September, 18:30.
    clock = new Date('2026-09-27T18:30:00Z');
    expect(await weekly({ ...deps(), weeklyHour: 18 })).toEqual({ digests: 1 });
    expect(sent.at(-1)?.kind).toBe('weekly');
    expect(sent.at(-1)?.items.map((i) => i.title)).toEqual(['Water bill']);
    expect(sent.flatMap((d) => d.items).some((i) => i.document_id === ids.ead)).toBe(false);
  });

  it('its kind’s reminders made again pass it by; its status says what it is', async () => {
    const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
    const done = await regenerateTypeReminders(
      { app: db, keys },
      { household_id: hh, type_key: 'visa' },
    );
    // Both looked at, neither failed; the one no longer needed made nothing.
    expect(done).toMatchObject({ documents: 2, failed: 0 });
    expect(await statuses(ids.visa)).toEqual(['derived:scheduled']);
    expect((await statuses(ids.ead)).filter((s) => s.startsWith('derived'))).toEqual([]);
    await refreshStatus(deps());
    const cache = await admin.query<{ id: string; status_cache: string }>(
      'select id, status_cache from document where id = any($1::uuid[])',
      [[ids.ead, ids.visa]],
    );
    expect(Object.fromEntries(cache.rows.map((r) => [r.id, r.status_cache]))).toEqual({
      [ids.ead]: 'no_longer_needed',
      [ids.visa]: 'expiring_soon',
    });
  });
});
