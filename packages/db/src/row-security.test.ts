import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from './client.js';
import { rowSecurityProblem } from './row-security.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Row-level security cannot silently be off: the API and the worker refuse
 * to start when the role they serve the family with is a superuser, has
 * BYPASSRLS, or owns the tables.
 */
describe.skipIf(!testAdminUrl())('the role the vault serves the family with', () => {
  let tdb: TestDatabase;
  const pools: Array<ReturnType<typeof createPool>> = [];
  const pool = (url: string) => {
    const p = createPool(url, 1);
    pools.push(p);
    return p;
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(async () => {
    for (const p of pools) await p.end();
    await tdb?.drop();
  });

  it('the application role is held by row-level security', async () => {
    expect(await rowSecurityProblem(pool(tdb.appUrl))).toBeNull();
  });

  it('the owning role is refused, in words that say what to set', async () => {
    const said = await rowSecurityProblem(pool(tdb.adminUrl));
    expect(said).toMatch(/superuser|BYPASSRLS|owns the vault's tables/);
    expect(said).toContain('DATABASE_URL must be the application role');
  });

  it('a role that owns the tables is refused, though it is no superuser', async () => {
    const admin = pool(tdb.adminUrl);
    const role = `fdv_owner_test_${Math.random().toString(36).slice(2, 8)}`;
    await admin.query(`create role ${role} login password 'owner-test'`);
    try {
      // A member of whoever owns one table: as good as its owner.
      const { rows } = await admin.query<{ owner: string }>(
        `select pg_catalog.pg_get_userbyid(relowner) as owner from pg_catalog.pg_class
          where relname = 'document' and relkind = 'r'`,
      );
      await admin.query(`grant ${rows[0]?.owner as string} to ${role}`);
      const u = new URL(tdb.appUrl);
      u.username = role;
      u.password = 'owner-test';
      const owner = pool(u.toString());
      expect(await rowSecurityProblem(owner)).toMatch(/owns the vault's tables/);
      await owner.end();
      pools.splice(pools.indexOf(owner), 1);
    } finally {
      await admin.query(`drop role if exists ${role}`);
    }
  });

  it('a role with BYPASSRLS is refused', async () => {
    const admin = pool(tdb.adminUrl);
    const role = `fdv_bypass_test_${Math.random().toString(36).slice(2, 8)}`;
    await admin.query(`create role ${role} login bypassrls password 'bypass-test'`);
    try {
      const u = new URL(tdb.appUrl);
      u.username = role;
      u.password = 'bypass-test';
      const bypass = pool(u.toString());
      expect(await rowSecurityProblem(bypass)).toMatch(/BYPASSRLS/);
      await bypass.end();
      pools.splice(pools.indexOf(bypass), 1);
    } finally {
      await admin.query(`drop role if exists ${role}`);
    }
  });
});
