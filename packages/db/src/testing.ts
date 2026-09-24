import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { listMigrations, migrateUp } from './migrate.js';

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
 *
 * Tests connect as `fdv_app_test`, a member of the application role rather
 * than the application role itself. Roles are cluster-wide: the README
 * tells you to point `DATABASE_ADMIN_URL` at the dev compose Postgres,
 * which is also the one your running vault uses, and giving `fdv_app` a
 * test password there would lock the live stack out of its own database.
 * Membership inherits every grant, owns nothing, and so is still subject
 * to row-level security — which is the whole point of not being `fdv`.
 */

export interface TestDatabase {
  name: string;
  /** Owning role — migrations, fixtures that bypass RLS. */
  adminUrl: string;
  /** A member of the application role: the same grants, and RLS applies. */
  appUrl: string;
  drop(): Promise<void>;
}

export const TEST_APP_ROLE = 'fdv_app_test';
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

/**
 * Builds the template if it is missing, or if a migration has been added
 * since it was built. The caller holds the setup lock.
 *
 * That second condition is not optional: the template survives between
 * runs, so without it a new migration is invisible locally and every test
 * runs against yesterday's schema. CI never sees it — a fresh cluster has
 * no template — which is exactly what makes it worth checking here.
 */
async function ensureTemplate(root: pg.Client, adminUrl: string): Promise<void> {
  const { rows } = await root.query<{ ok: boolean }>(
    'select exists (select 1 from pg_database where datname = $1) as ok',
    [TEMPLATE],
  );
  if (rows[0]?.ok) {
    if (await templateIsCurrent(adminUrl)) return;
    // Sessions on the template would block the drop; there should be none,
    // because copying only holds it briefly under the same lock.
    await root.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1`, [
      TEMPLATE,
    ]);
    await root.query(`drop database if exists ${TEMPLATE} with (force)`);
  }
  await root.query(`create database ${TEMPLATE}`);
  const pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEMPLATE), max: 2 });
  try {
    await migrateUp(pool);
  } finally {
    await pool.end();
  }
}

/** The test's own login, inheriting `fdv_app` rather than replacing it. */
async function ensureRole(root: pg.Client): Promise<void> {
  const { rows } = await root.query<{ n: number }>(
    'select count(*)::int as n from pg_roles where rolname = $1',
    [TEST_APP_ROLE],
  );
  if (rows[0]?.n) return;
  await root.query(
    `create role ${TEST_APP_ROLE} login password '${TEST_APP_PASSWORD}' in role fdv_app`,
  );
}

/** Has every migration on disk been applied to the template? */
async function templateIsCurrent(adminUrl: string): Promise<boolean> {
  const latest = (await listMigrations()).reduce((max, m) => Math.max(max, m.version), 0);
  const client = new pg.Client({ connectionString: withDatabase(adminUrl, TEMPLATE) });
  await client.connect();
  try {
    const { rows } = await client.query<{ version: number | null }>(
      'select max(version)::int as version from schema_migration',
    );
    return (rows[0]?.version ?? 0) >= latest;
  } catch {
    return false; // no schema_migration table: not a template we can trust
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(adminUrl = testAdminUrl()): Promise<TestDatabase> {
  const tdb = await newDatabase(adminUrl, true);
  // A copy of the template is a new vault, not the template's twin: give it
  // its own installation id, as running the migrations afresh would have.
  const own = new pg.Client({ connectionString: tdb.adminUrl });
  await own.connect();
  try {
    await own.query('update instance set instance_id = gen_random_uuid()');
  } finally {
    await own.end();
  }
  return tdb;
}

/**
 * An empty database, not migrated, with the same logins: for tests that
 * build their own schema, or restore a backup into it.
 */
export async function createEmptyDatabase(adminUrl = testAdminUrl()): Promise<TestDatabase> {
  return newDatabase(adminUrl, false);
}

async function newDatabase(
  adminUrl: string | undefined,
  fromTemplate: boolean,
): Promise<TestDatabase> {
  if (!adminUrl)
    throw new Error('DATABASE_ADMIN_URL is not set; integration tests need PostgreSQL');
  const name = `fdv_test_${randomBytes(4).toString('hex')}`;

  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  try {
    await root.query('select pg_advisory_lock($1)', [SETUP_LOCK]);
    await ensureTemplate(root, adminUrl);
    await ensureRole(root); // after the template: migration 0001 creates fdv_app
    await root.query(
      fromTemplate ? `create database ${name} template ${TEMPLATE}` : `create database ${name}`,
    );
  } finally {
    await root.query('select pg_advisory_unlock($1)', [SETUP_LOCK]).catch(() => undefined);
    await root.end();
  }

  return {
    name,
    adminUrl: withDatabase(adminUrl, name),
    appUrl: withDatabase(adminUrl, name, TEST_APP_ROLE, TEST_APP_PASSWORD),
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

/**
 * Every privilege in the schemas the vault uses, as sorted lines: who may do
 * what to each table, sequence, function and schema; the default
 * privileges; owners; and row-level security with its policies. Two
 * databases with equal snapshots give the application role exactly the same
 * rights. A NULL ACL is normalised to the built-in default, which is what
 * it means.
 */
export async function privilegeSnapshot(client: pg.ClientBase): Promise<string[]> {
  const { rows } = await client.query<{ line: string }>(SNAPSHOT_SQL);
  return rows.map((r) => r.line);
}

const SNAPSHOT_SQL = `
with
schemas as (
  select oid, nspname, nspowner, nspacl from pg_namespace where nspname in ('public', 'pgboss')
),
who(oid, name) as (
  select 0::oid, 'PUBLIC' union all select oid, rolname::text from pg_roles
),
lines as (
  select format('rel %s.%s %s %s', s.nspname, c.relname, w.name, a.privilege_type) as line
    from pg_class c join schemas s on s.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl,
      acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) a
    join who w on w.oid = a.grantee
   where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f') and a.grantee <> c.relowner
  union all
  select format('owner %s.%s %s', s.nspname, c.relname, pg_get_userbyid(c.relowner))
    from pg_class c join schemas s on s.oid = c.relnamespace
   where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  union all
  select format('rls %s.%s enabled=%s forced=%s', s.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity)
    from pg_class c join schemas s on s.oid = c.relnamespace
   where c.relkind in ('r', 'p')
  union all
  select format('policy %s.%s %s %s', s.nspname, c.relname, p.polname, p.polcmd)
    from pg_policy p join pg_class c on c.oid = p.polrelid join schemas s on s.oid = c.relnamespace
  union all
  select format('col %s.%s.%s %s %s', s.nspname, c.relname, t.attname, w.name, a.privilege_type)
    from pg_attribute t join pg_class c on c.oid = t.attrelid join schemas s on s.oid = c.relnamespace
    cross join lateral aclexplode(t.attacl) a join who w on w.oid = a.grantee
   where t.attacl is not null
  union all
  select format('fn %s.%s(%s) %s %s', s.nspname, p.proname,
                pg_get_function_identity_arguments(p.oid), w.name, a.privilege_type)
    from pg_proc p join schemas s on s.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    join who w on w.oid = a.grantee
   where a.grantee <> p.proowner
  union all
  select format('fnowner %s.%s(%s) %s definer=%s', s.nspname, p.proname,
                pg_get_function_identity_arguments(p.oid), pg_get_userbyid(p.proowner), p.prosecdef)
    from pg_proc p join schemas s on s.oid = p.pronamespace
  union all
  select format('schema %s %s %s', s.nspname, w.name, a.privilege_type)
    from schemas s
    cross join lateral aclexplode(coalesce(s.nspacl, acldefault('n', s.nspowner))) a
    join who w on w.oid = a.grantee
   where a.grantee <> s.nspowner
  union all
  select format('default %s %s %s %s %s', pg_get_userbyid(d.defaclrole),
                coalesce(d.defaclnamespace::regnamespace::text, '*'), d.defaclobjtype,
                w.name, a.privilege_type)
    from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a join who w on w.oid = a.grantee
)
select line from lines order by line collate "C"`;
