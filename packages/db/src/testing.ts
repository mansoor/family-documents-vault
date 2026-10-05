import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
 * The template is named after the migrations it holds (a hash of their
 * names and contents), so checkouts at different migrations — another
 * branch, a worktree — share the cluster without testing against each
 * other's schema or rebuilding each other's template. Templates of sets no
 * checkout has any more stay until dropped by hand
 * (`drop database fdv_test_template_…`); each is an empty schema.
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
const TEMPLATE_PREFIX = 'fdv_test_template';
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

/** The template for the migrations on disk: named after their names and contents. */
async function templateName(): Promise<{ name: string; migrations: number }> {
  const migrations = await listMigrations();
  const hash = createHash('sha256');
  for (const m of migrations) {
    hash.update(`${m.version}_${m.name}\0`);
    hash.update(await readFile(m.file));
    hash.update('\0');
  }
  return {
    name: `${TEMPLATE_PREFIX}_${hash.digest('hex').slice(0, 16)}`,
    migrations: migrations.length,
  };
}

/**
 * Builds the template if it is missing, or if a build of it stopped part
 * way (a killed test run). The caller holds the setup lock.
 *
 * Its name changes with any migration added or edited, so a template that
 * exists holds exactly the migrations on disk: without that, the template
 * surviving between runs would leave every test on yesterday's schema (CI
 * never sees it — a fresh cluster has no template — which is exactly what
 * makes it worth getting right here).
 */
async function ensureTemplate(
  root: pg.Client,
  adminUrl: string,
  template: { name: string; migrations: number },
): Promise<void> {
  const { rows } = await root.query<{ ok: boolean }>(
    'select exists (select 1 from pg_database where datname = $1) as ok',
    [template.name],
  );
  if (rows[0]?.ok) {
    if (await templateIsComplete(adminUrl, template)) return;
    await root.query(`drop database if exists ${template.name} with (force)`);
  }
  // The single template of before (0.5.4) is never current again.
  await root.query(`drop database if exists ${TEMPLATE_PREFIX} with (force)`);
  await root.query(`create database ${template.name}`);
  const pool = new pg.Pool({ connectionString: withDatabase(adminUrl, template.name), max: 2 });
  try {
    await migrateUp(pool);
  } catch (err) {
    await pool.end();
    await root.query(`drop database if exists ${template.name} with (force)`);
    throw err;
  }
  await pool.end();
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

/** Did the build of this template finish? */
async function templateIsComplete(
  adminUrl: string,
  template: { name: string; migrations: number },
): Promise<boolean> {
  const client = new pg.Client({ connectionString: withDatabase(adminUrl, template.name) });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      'select count(*)::int as n from schema_migration',
    );
    return rows[0]?.n === template.migrations;
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
  const template = await templateName();

  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  try {
    await root.query('select pg_advisory_lock($1)', [SETUP_LOCK]);
    await ensureTemplate(root, adminUrl, template);
    await ensureRole(root); // after the template: migration 0001 creates fdv_app
    await root.query(
      fromTemplate
        ? `create database ${name} template ${template.name}`
        : `create database ${name}`,
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
        await settle(c, name);
        await c.query(`drop database if exists ${name} with (force)`);
      } finally {
        await c.end();
      }
    },
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The w-th (5: the last) weekday d (0: Sunday) of month m (1–12) of year y, at midnight UTC. */
function weekdayOfMonth(y: number, m: number, w: number, d: number): number {
  if (w === 5) {
    const last = Date.UTC(y, m, 0);
    return last - ((new Date(last).getUTCDay() - d + 7) % 7) * DAY_MS;
  }
  const first = Date.UTC(y, m - 1, 1);
  return first + (((d - new Date(first).getUTCDay() + 7) % 7) + (w - 1) * 7) * DAY_MS;
}

/**
 * Made-up time zones (POSIX rules, standard time UTC) in which, from `now`,
 * the clocks go forward twice within 366 days and back once, so that 366
 * days on their calendar are 8783 hours, not 366 × 24 — the likeliest
 * first. The way that always exists (the 5.34 review, N534A-02): a weekday
 * of a month (Mm.w.d) whose next year's falls 364 days on, the change made
 * up to a week after it (a rule's time runs to 167 hours) so that it comes
 * an hour from now, and next year's 364 days after that, inside the 366.
 * Of the seven days before now, one always has such a rule. The plainer
 * spellings follow, and the database decides (zoneShortOfAYear).
 */
export function zonesShortOfAYear(now: Date = new Date()): string[] {
  // The first going forward, to the minute, an hour or so from now.
  const at = Math.ceil((now.getTime() + HOUR_MS) / 60_000) * 60_000;
  const when = new Date(at);
  const y = when.getUTCFullYear();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const counted = Math.floor(
    (Date.UTC(y, when.getUTCMonth(), when.getUTCDate()) - Date.UTC(y, 0, 1)) / DAY_MS,
  );
  const julian = counted + 1 - (leap && when.getUTCMonth() > 1 ? 1 : 0);
  // Back half a year on, once.
  const back = `J${((julian + 181) % 365) + 1}/2`;
  const zones: string[] = [];
  for (const monthsBack of [0, 1]) {
    const first = new Date(Date.UTC(y, when.getUTCMonth() - monthsBack, 1));
    const ry = first.getUTCFullYear();
    const m = first.getUTCMonth() + 1;
    for (let w = 1; w <= 5; w += 1) {
      for (let d = 0; d <= 6; d += 1) {
        const day = weekdayOfMonth(ry, m, w, d);
        const after = at - day;
        if (after < 0 || after > 167 * HOUR_MS) continue;
        if (weekdayOfMonth(ry + 1, m, w, d) - day !== 364 * DAY_MS) continue;
        const minutes = after / 60_000;
        const time = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
        zones.push(`XST0XDT,M${m}.${w}.${d}/${time},${back}`);
      }
    }
  }
  const time = `${when.getUTCHours()}:${String(when.getUTCMinutes()).padStart(2, '0')}`;
  const day = when.getUTCDate();
  zones.push(
    `XST0XDT,M${when.getUTCMonth() + 1}.${Math.min(5, Math.ceil(day / 7))}.${when.getUTCDay()}/${time},${back}`,
    `XST0XDT,${counted}/${time},${back}`,
  );
  if (!(when.getUTCMonth() === 1 && day === 29)) zones.push(`XST0XDT,J${julian}/${time},${back}`);
  return [...new Set(zones)];
}

/**
 * A made-up time zone (POSIX rules) in which, from now, the clocks go
 * forward twice within 366 days and back once, so that 366 days on its
 * calendar are 8783 hours, not 366 × 24 (the 5.34 review, L534-06). For a
 * test that a bound is counted as the vault counts it, in hours, and not in
 * days of whatever zone a database runs in. The database at `url` confirms
 * it, counting from `now` in that zone as a trigger counts from its now();
 * none would be a test that proves nothing, so it throws.
 */
export async function zoneShortOfAYear(url: string, now = new Date()): Promise<string> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    for (const zone of zonesShortOfAYear(now)) {
      await c.query('begin');
      try {
        await c.query(`select set_config('timezone', $1, true)`, [zone]);
        const { rows } = await c.query<{ short: boolean }>(
          `select $1::timestamptz + interval '366 days' = $1::timestamptz + interval '8783 hours' as short`,
          [now.toISOString()],
        );
        if (rows[0]?.short) return zone;
      } finally {
        await c.query('rollback');
      }
    }
  } finally {
    await c.end();
  }
  throw new Error(
    `No made-up zone puts two clock changes forward within 366 days of ${now.toISOString()}`,
  );
}

/** How long a dropped test database's own connections are given to close. */
export const DROP_SETTLE_MS = 5_000;

/**
 * Waits for the connections to a database to close before it is dropped
 * with force. A pool's `end()` resolves once it has asked each connection
 * to close, not once each has: one the server ends first, by `with
 * (force)`, answers with 57P01 ("terminating connection due to
 * administrator command") — an 'error' on a pool nobody listens to any
 * more, and an unhandled error that fails a test file that passed (the
 * 5.23 review, CI's image tests). Any still open after DROP_SETTLE_MS are
 * a test's own leak, and are ended with the database.
 */
async function settle(c: pg.Client, name: string): Promise<void> {
  const until = Date.now() + DROP_SETTLE_MS;
  while (Date.now() < until) {
    const { rows } = await c.query<{ n: number }>(
      'select count(*)::int as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
      [name],
    );
    if (!rows[0]?.n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
