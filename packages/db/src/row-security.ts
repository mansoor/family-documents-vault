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

/**
 * The tables in `public` that have no row-level security, and why each may
 * go without. None holds a household's own data: each is the installation's,
 * read by the application role and (but for the reference rules and the
 * sign-in counts) written by the owning role alone (privileges.ts), or the
 * migration runner's own record.
 *
 * Every other table must have row-level security on. A table added without
 * it would be open to every household, since the application role is given
 * every table by default (privileges.ts); a check run in CI and on every
 * restore refuses one that is neither on this list nor protected.
 */
export const TABLES_WITHOUT_ROW_SECURITY: Readonly<Record<string, string>> = {
  schema_migration: "the migration runner's record of what has run",
  instance: "the installation's identifier, one row, read-only to the application",
  suggestion_rule:
    'reference rules for papers a family may be missing, the same for every household',
  watch_dir: 'the scanner folder as the worker last found it, one row',
  mail_in_server: 'the mailbox the worker reads, as it last had it, one row',
  reading_model_state: 'whether each worker has the reading model loaded',
  local_ai_state: 'the local AI as each worker last found it',
  master_key_canary: 'an HMAC of the master key the vault was last opened with',
  sign_in_failure: 'failed sign-in counts, kept under HMACs and tied to no household',
};

/**
 * The tables in `public` with row-level security off that are not on
 * {@link TABLES_WITHOUT_ROW_SECURITY}, whether or not they have policies;
 * empty when every table is as it should be.
 */
export async function tablesMissingRowSecurity(db: pg.Pool | pg.ClientBase): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `select c.relname as name
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and not c.relrowsecurity
        and not (c.relname = any($1::text[]))
      order by c.relname`,
    [Object.keys(TABLES_WITHOUT_ROW_SECURITY)],
  );
  return rows.map((r) => r.name);
}
