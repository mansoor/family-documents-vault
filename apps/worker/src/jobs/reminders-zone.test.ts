import { randomUUID } from 'node:crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { deliver, tick, weekly, type Digest } from './reminders.js';

/**
 * The family's clock in the worker (0.9.0, TZ): reminders fall due, and the
 * digest goes out at its hour, on the household's own zone when an owner
 * chose one, else the server's FDV_TIMEZONE. Read every round: a zone
 * changed in Settings moves the next one to the household hour on the new
 * clock, and a reminder's day is never shifted by it.
 */
describe.skipIf(!testAdminUrl())("reminders and digests on the family's clock (TZ)", () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  const hh = randomUUID();
  const sent: Digest[] = [];
  const notifier = { digest: async (d: Digest) => (sent.push(d), ['test']) };
  let clock = new Date();
  const deps = () => ({ admin, app: db, notifier, log: () => undefined, now: () => clock });
  const at = (iso: string) => {
    clock = new Date(iso);
  };
  const statuses = () =>
    withSystem(db, hh, (trx) =>
      trx.selectFrom('reminder').select(['fire_at', 'status']).orderBy('fire_at').execute(),
    ).then((rows) => rows.map((r) => `${String(r.fire_at).slice(0, 10)}:${r.status}`));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    // Nobody has chosen a zone: the server's default is the family's clock.
    await admin.query("insert into household (id, name) values ($1, 'Clocks')", [hh]);
    const m = await admin.query<{ id: string }>(
      "insert into member (household_id, display_name) values ($1, 'M') returning id",
      [hh],
    );
    const a = await admin.query<{ id: string }>(
      "insert into account (email) values ('clocks@example.test') returning id",
    );
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [a.rows[0]?.id, hh, m.rows[0]?.id],
    );
    await withSystem(db, hh, async (trx) => {
      for (const [title, fire] of [
        ['Car insurance', '2026-09-22'],
        ['Boiler service', '2026-09-23'],
      ] as const) {
        const d = await trx
          .insertInto('document')
          .values({ household_id: hh, title, owner_member_id: m.rows[0]?.id as string })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('reminder')
          .values({
            household_id: hh,
            document_id: d.id,
            kind: 'manual',
            fire_at: fire,
          })
          .execute();
      }
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  it("the server's default: due on its day, and the digest at 9 there, never before", async () => {
    vi.stubEnv('FDV_TIMEZONE', 'America/New_York');
    // 08:30 in New York on the 22nd (12:30 UTC): due, but not 9 yet.
    at('2026-09-22T12:30:00Z');
    await tick(deps());
    expect(await statuses()).toEqual(['2026-09-22:due', '2026-09-23:scheduled']);
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 0 });
    // 09:05 there: sent, on the family's day, its zone the server's.
    at('2026-09-22T13:05:00Z');
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 1 });
    expect(sent.at(-1)).toMatchObject({
      timezone: 'America/New_York',
      local_date: '2026-09-22',
      items: [{ title: 'Car insurance' }],
    });
  });

  it('an owner choosing another zone moves the next digest to 9 on the new clock, and the days with it', async () => {
    vi.stubEnv('FDV_TIMEZONE', 'America/New_York');
    await admin.query("update household set timezone = 'Asia/Tokyo' where id = $1", [hh]);
    // 00:05 UTC on the 23rd: 20:05 on the 22nd in New York, but 09:05 on
    // the 23rd in Tokyo — the Boiler service is due there today.
    at('2026-09-23T00:05:00Z');
    await tick(deps());
    expect(await statuses()).toEqual(['2026-09-22:due', '2026-09-23:due']);
    expect(await deliver({ ...deps(), digestHour: 9 })).toEqual({ digests: 1 });
    expect(sent.at(-1)).toMatchObject({
      timezone: 'Asia/Tokyo',
      local_date: '2026-09-23',
      items: [{ title: 'Boiler service' }],
    });
  });

  it("cleared back to the server's default, the server's clock again", async () => {
    vi.stubEnv('FDV_TIMEZONE', 'Pacific/Kiritimati');
    await admin.query('update household set timezone = null where id = $1', [hh]);
    // Sunday 27 September, 18:30 in Kiritimati (04:30 UTC): the weekly summary.
    at('2026-09-27T04:30:00Z');
    expect(await weekly({ ...deps(), weeklyHour: 18 })).toEqual({ digests: 1 });
    expect(sent.at(-1)).toMatchObject({
      kind: 'weekly',
      timezone: 'Pacific/Kiritimati',
      local_date: '2026-09-27',
    });
  });
});

describe('FDV_TIMEZONE at the worker’s start', () => {
  const base = { DATABASE_URL: 'postgres://x', FDV_MASTER_KEY: 'k'.repeat(40) };
  it('is UTC unless set, and refuses a name that is not a zone, saying what to give', () => {
    expect(loadConfig(base).FDV_TIMEZONE).toBe('UTC');
    expect(loadConfig({ ...base, FDV_TIMEZONE: 'Asia/Kolkata' }).FDV_TIMEZONE).toBe('Asia/Kolkata');
    expect(() => loadConfig({ ...base, FDV_TIMEZONE: 'Asia/Calcutta_' })).toThrow(
      /FDV_TIMEZONE: not a time zone this server knows: give an IANA name such as Europe\/London/,
    );
  });
});
