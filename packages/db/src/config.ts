/**
 * Two connection strings, two roles.
 *
 * PostgreSQL bypasses row-level security for the role that owns a table.
 * Migrations therefore run as the owning role (`DATABASE_ADMIN_URL`) while
 * the application queries as a separate, non-owning role (`DATABASE_URL`)
 * that row-level security actually applies to. Collapsing them into one is
 * the single easiest way to silently lose the tenant guarantee.
 */
export interface DbConfig {
  /** Application role: RLS enforced. */
  url: string;
  /** Owning role: used only to run migrations. */
  adminUrl: string;
}

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return { url, adminUrl: env.DATABASE_ADMIN_URL ?? url };
}
