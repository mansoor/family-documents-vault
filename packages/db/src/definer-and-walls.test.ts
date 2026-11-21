import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TABLES_WITHOUT_ROW_SECURITY, tablesMissingRowSecurity } from './row-security.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Two rules over the whole schema, so that a new migration that forgets
 * either fails the build rather than reaching a family's vault:
 *
 * - every function that runs with the owner's rights (SECURITY DEFINER) has
 *   pg_temp last on its search_path and is nobody's to call by default;
 * - every table in public has row-level security, but for the few on the
 *   allow-list, which hold no household's data.
 */
describe.skipIf(!testAdminUrl())('the schema as the migrations leave it', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
  });
  afterAll(async () => {
    await admin?.end();
    await tdb?.drop();
  });

  it('every definer function has pg_temp last on its search_path, and PUBLIC cannot call it', async () => {
    const { rows } = await admin.query<{
      fn: string;
      config: string[] | null;
      public_may: boolean;
    }>(
      `select p.oid::regprocedure::text as fn, p.proconfig as config,
              exists (select 1
                        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_may
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
        order by 1`,
    );
    // The vault has many; an empty list would mean the query went wrong.
    expect(rows.length).toBeGreaterThan(50);
    const searchPath = (config: string[] | null) =>
      config?.find((c) => c.startsWith('search_path='))?.slice('search_path='.length) ?? '';
    expect(
      rows.filter((r) => !/(^|,\s*)pg_temp$/.test(searchPath(r.config))).map((r) => r.fn),
    ).toEqual([]);
    expect(rows.filter((r) => r.public_may).map((r) => r.fn)).toEqual([]);
  });

  it('the first-run and link lookups are still the application role’s to call', async () => {
    const { rows } = await admin.query<{ fn: string; app: boolean; public_may: boolean }>(
      `select f as fn, has_function_privilege('fdv_app', f, 'execute') as app,
              has_function_privilege('public', f, 'execute') as public_may
         from unnest(array['setup_complete()', 'vault_display_name()',
                           'invitation_household(bytea)', 'share_link_household(bytea)',
                           'app_is_installation_household()']) f`,
    );
    expect(rows).toEqual(rows.map((r) => ({ fn: r.fn, app: true, public_may: false })));
    // And a member of the application role can ask, as the API does.
    const app = new pg.Pool({ connectionString: tdb.appUrl, max: 1 });
    try {
      const r = await app.query<{ done: boolean; name: string | null }>(
        'select setup_complete() as done, vault_display_name() as name',
      );
      expect(r.rows[0]).toEqual({ done: false, name: null });
    } finally {
      await app.end();
    }
  });

  it('every table in public has row-level security, but for the allow-list', async () => {
    expect(await tablesMissingRowSecurity(admin)).toEqual([]);
    // Every name on the list is a table that exists and has no RLS: a stale
    // entry would quietly let a later table of that name through.
    const { rows } = await admin.query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(TABLES_WITHOUT_ROW_SECURITY).sort());
  });

  it('notices a new table with neither row-level security nor policies', async () => {
    await admin.query('create table public.stray_without_walls (id int)');
    try {
      expect(await tablesMissingRowSecurity(admin)).toEqual(['stray_without_walls']);
    } finally {
      await admin.query('drop table public.stray_without_walls');
    }
  });
});
