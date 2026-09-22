import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrateUp } from './migrate.js';

/**
 * Test support: a fresh, fully migrated database per test file.
 *
 * Integration tests run against a real PostgreSQL because row-level
 * security, triggers and generated columns are the things under test. Set
 * `DATABASE_ADMIN_URL` (a superuser or database-creating role).
 *
 * The migrations run **once**, into a template database; each test file
 * then copies that template, which takes a fraction of a second. Copying
 * and the one-time build are serialised by an advisory lock: `CREATE
 * DATABASE`, `CREATE ROLE` and `ALTER ROLE` all touch cluster-wide
 * catalogues, and doing them at once yields "tuple concurrently updated".
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
const TEMPLATE = 'fdv_test_template';
const SETUP_LOCK = 7402;

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

/** Builds the template if it is missing. The caller holds the setup lock. */
async function ensureTemplate(root: pg.Client, adminUrl: string): Promise<void> {
  const { rows } = await root.query<{ ok: boolean }>(
    'select exists (select 1 from pg_database where datname = $1) as ok',
    [TEMPLATE],
  );
  if (rows[0]?.ok) return;
  await root.query(`create database ${TEMPLATE}`);
  const pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEMPLATE), max: 2 });
  try {
    await migrateUp(pool);
    // The application role is cluster-wide; its password is set once here.
    await pool.query(`alter role fdv_app password '${TEST_APP_PASSWORD}'`);
  } finally {
    await pool.end();
  }
}

export async function createTestDatabase(adminUrl = testAdminUrl()): Promise<TestDatabase> {
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is not set; integration tests need PostgreSQL');
  const name = `fdv_test_${randomBytes(4).toString('hex')}`;

  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  try {
    await root.query('select pg_advisory_lock($1)', [SETUP_LOCK]);
    await ensureTemplate(root, adminUrl);
    await root.query(`create database ${name} template ${TEMPLATE}`);
  } finally {
    await root.query('select pg_advisory_unlock($1)', [SETUP_LOCK]).catch(() => undefined);
    await root.end();
  }

  return {
    name,
    adminUrl: withDatabase(adminUrl, name),
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
