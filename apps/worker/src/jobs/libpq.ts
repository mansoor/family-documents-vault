/**
 * libpq's environment for a connection string, for pg_dump and psql: the
 * password goes in the child's environment, not on a command line that
 * every process on the host can read.
 */
export function libpqEnv(url: string): Record<string, string> {
  const u = new URL(url);
  const env: Record<string, string> = {};
  const host = decodeURIComponent(u.hostname.replace(/^\[(.*)\]$/, '$1'));
  if (host) env.PGHOST = host;
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (db) env.PGDATABASE = db;
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/** The same server and credentials, another database. */
export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
