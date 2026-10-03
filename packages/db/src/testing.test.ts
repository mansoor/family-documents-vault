import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDatabase, testAdminUrl } from './testing.js';

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
