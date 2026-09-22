import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrateUp } from './migrate.js';

/**
 * Test support: a fresh, fully migrated database per test file.
 *
 * Integration tests run against a real PostgreSQL because row-level security,
 * triggers and generated columns are the things under test. Set
 * `DATABASE_ADMIN_URL` (a superuser or database-creating role) and each call
 * creates `fdv_test_<random>`, migrates it, and hands back both connection
 * strings. `drop()` removes it again.
 */

export interface TestDatabase {
  name: string;
  /** Owning role — migrations, fixtures that bypass RLS. */
  adminUrl: string;
  /** Application role `fdv_app` — what the API actually uses. RLS applies. */
  appUrl: string;
  drop(): Promise<void>;
}

export const TEST_APP_PASSWORD = 'fdv_app_test';

export function testAdminUrl(): string | undefined {
  return process.env.DATABASE_ADMIN_URL;
}

function withDatabase(url: string, name: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  if (user !== undefined) {
    u.username = user;
    u.password = password ?? '';
  }
  return u.toString();
}

export async function createTestDatabase(adminUrl = testAdminUrl()): Promise<TestDatabase> {
  if (!adminUrl)
    throw new Error('DATABASE_ADMIN_URL is not set; integration tests need PostgreSQL');
  const name = `fdv_test_${randomBytes(4).toString('hex')}`;

  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  try {
    // Postgres refuses to clone template1 while another clone is in flight;
    // serialise creation so parallel test files cannot collide.
    await root.query('select pg_advisory_lock(7402)');
    try {
      await root.query(`create database ${name}`);
    } finally {
      await root.query('select pg_advisory_unlock(7402)');
    }
  } finally {
    await root.end();
  }

  const dbAdminUrl = withDatabase(adminUrl, name);
  const pool = new pg.Pool({ connectionString: dbAdminUrl, max: 2 });
  try {
    await migrateUp(pool);
    await pool.query(`alter role fdv_app password '${TEST_APP_PASSWORD}'`);
  } finally {
    await pool.end();
  }

  return {
    name,
    adminUrl: dbAdminUrl,
    appUrl: withDatabase(adminUrl, name, 'fdv_app', TEST_APP_PASSWORD),
    async drop() {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query(`drop database if exists ${name} with (force)`);
      } finally {
        await c.end();
      }
    },
  };
}
