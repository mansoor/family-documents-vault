import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  testAdminUrl,
  zoneShortOfAYear,
  zonesShortOfAYear,
} from './testing.js';

/**
 * A test database dropped with its connections still closing: a pool's
 * `end()` resolves once it has asked them to close, not once they have,
 * and a connection the server ends first — `drop … with (force)` — tells
 * its client so, an unhandled 'error' that failed CI's image tests after
 * every test had passed (the 5.23 review). The drop waits for them.
 */
describe.skipIf(!testAdminUrl())('dropping a test database', () => {
  it('waits for its connections to close rather than ending them', async () => {
    const tdb = await createTestDatabase();
    const client = new pg.Client({ connectionString: tdb.adminUrl });
    const errors: string[] = [];
    client.on('error', (err: Error & { code?: string }) => errors.push(err.code ?? err.message));
    await client.connect();
    await client.query('select 1');
    // Still open when the drop begins, closed a moment after.
    const closing = new Promise<void>((resolve) => {
      setTimeout(() => {
        void client.end().then(resolve, resolve);
      }, 300);
    });
    await tdb.drop();
    await closing;
    expect(errors).toEqual([]);
    const root = new pg.Client({ connectionString: testAdminUrl() });
    await root.connect();
    try {
      const { rows } = await root.query('select 1 from pg_database where datname = $1', [tdb.name]);
      expect(rows).toEqual([]);
    } finally {
      await root.end();
    }
  });
});

/**
 * The made-up zone the year-bound tests count in (the 5.34 review,
 * N534A-02): one is found on every day, at any time — in January and
 * February of a leap year too, when the plainer spellings put next year's
 * change a day too late. Replayed against the database for every day of
 * 2026–2029, five times a day, each instant counted in its own zone, in one
 * query.
 */
describe.skipIf(!testAdminUrl())('a zone whose 366 days are an hour short', () => {
  it('is found for every day of 2026 to 2029, at any time of day', async () => {
    const instants: string[] = [];
    const zones: string[] = [];
    const times = [0, 5 * 3600e3 + 37 * 60e3, 11 * 3600e3 + 7 * 60e3, 17.5 * 3600e3, 23.5 * 3600e3];
    for (let day = Date.UTC(2026, 0, 1); day < Date.UTC(2030, 0, 1); day += 864e5) {
      for (const at of times) {
        // The first offered: the one the helper finds, at its first try.
        const now = new Date(day + at);
        instants.push(now.toISOString());
        zones.push(zonesShortOfAYear(now)[0] ?? 'none');
      }
    }
    const client = new pg.Client({ connectionString: testAdminUrl() });
    await client.connect();
    try {
      await client.query('begin');
      // Counted in each zone as a trigger counts from its now(), in it.
      await client.query(
        `create function pg_temp.short_of_a_year(t timestamptz, z text) returns boolean
           language plpgsql as $$
         begin
           perform set_config('timezone', z, true);
           return t + interval '366 days' = t + interval '8783 hours';
         end $$`,
      );
      const { rows } = await client.query<{ t: string; ok: boolean }>(
        `select x.t, pg_temp.short_of_a_year(x.t::timestamptz, x.z) as ok
           from unnest($1::text[], $2::text[]) as x(t, z)`,
        [instants, zones],
      );
      await client.query('rollback');
      const found = new Set(rows.filter((r) => r.ok).map((r) => r.t));
      const missing = [...new Set(instants)].filter((t) => !found.has(t));
      expect(missing).toEqual([]);
      expect(found.size).toBe(1461 * times.length);
    } finally {
      await client.end();
    }
    // The helper itself, on days the review found it wanting.
    for (const at of ['2028-01-08T11:07:00Z', '2028-02-15T09:00:00Z', '2032-01-08T10:00:00Z']) {
      await expect(zoneShortOfAYear(testAdminUrl() as string, new Date(at))).resolves.toMatch(
        /^XST0XDT,/,
      );
    }
  }, 60_000);
});
