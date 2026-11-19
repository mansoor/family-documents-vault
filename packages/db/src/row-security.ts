import type pg from 'pg';

/**
 * Why the application's database role would not be held by row-level
 * security, in words for the operator; null when it is.
 *
 * Every household boundary in the vault is a policy on a table, and a
 * policy binds nobody who owns the table (the tables enable row-level
 * security without forcing it, so that migrations and the owning role's
 * own work go as they do), a superuser, or a role with BYPASSRLS. One
 * misconfiguration — DATABASE_URL set to the owning role, or the admin URL
 * left out and the defaults collapsing — would turn every policy off
 * without a word. So the API and the worker ask this as they start, of the
 * connection they serve the family with, and refuse to start otherwise.
 */
export async function rowSecurityProblem(pool: pg.Pool): Promise<string | null> {
  const { rows } = await pool.query<{
    role: string;
    super: boolean;
    bypass: boolean;
    owns: string | null;
  }>(
    `select current_user as role, r.rolsuper as super, r.rolbypassrls as bypass,
            (select c.relname
               from pg_catalog.pg_class c
               join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public'
                and c.relkind in ('r', 'p')
                and c.relrowsecurity
                and pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER')
              order by c.relname
              limit 1) as owns
       from pg_catalog.pg_roles r
      where r.rolname = current_user`,
  );
  const me = rows[0];
  if (!me) return 'DATABASE_URL connects as a role the database does not list.';
  const fix =
    'DATABASE_URL must be the application role (fdv_app in the compose setup), and ' +
    'DATABASE_ADMIN_URL the owning role; see the README, "Configuration".';
  if (me.super) {
    return `DATABASE_URL connects as ${me.role}, a superuser, which row-level security does not hold: every household's documents would be open to every other. ${fix}`;
  }
  if (me.bypass) {
    return `DATABASE_URL connects as ${me.role}, which has BYPASSRLS: row-level security would not hold it. ${fix}`;
  }
  if (me.owns) {
    return `DATABASE_URL connects as ${me.role}, which owns the vault's tables (${me.owns}, among others): row-level security does not hold a table's owner. ${fix}`;
  }
  return null;
}
