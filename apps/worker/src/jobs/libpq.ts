/**
 * Handing a connection string to pg_dump or psql.
 *
 * The password should not be on a command line, which every process on
 * the host can read, so everything libpq has an environment variable for
 * goes in the child's environment instead. A connection parameter with no
 * such variable (keepalives, say) cannot: then the whole string goes on the
 * command line, as it did before 0.4.5, rather than be quietly dropped —
 * a backup that stopped verifying its server's certificate would be worse.
 */
export interface LibpqConnection {
  env: Record<string, string>;
  args: string[];
}

/** libpq's connection parameters and the environment variables that set them. */
const ENV: Record<string, string> = {
  host: 'PGHOST',
  hostaddr: 'PGHOSTADDR',
  port: 'PGPORT',
  dbname: 'PGDATABASE',
  user: 'PGUSER',
  password: 'PGPASSWORD',
  passfile: 'PGPASSFILE',
  channel_binding: 'PGCHANNELBINDING',
  service: 'PGSERVICE',
  options: 'PGOPTIONS',
  application_name: 'PGAPPNAME',
  sslmode: 'PGSSLMODE',
  requiressl: 'PGREQUIRESSL',
  sslcompression: 'PGSSLCOMPRESSION',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  sslrootcert: 'PGSSLROOTCERT',
  sslcrl: 'PGSSLCRL',
  sslcrldir: 'PGSSLCRLDIR',
  sslsni: 'PGSSLSNI',
  requirepeer: 'PGREQUIREPEER',
  ssl_min_protocol_version: 'PGSSLMINPROTOCOLVERSION',
  ssl_max_protocol_version: 'PGSSLMAXPROTOCOLVERSION',
  gssencmode: 'PGGSSENCMODE',
  krbsrvname: 'PGKRBSRVNAME',
  gsslib: 'PGGSSLIB',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  client_encoding: 'PGCLIENTENCODING',
  target_session_attrs: 'PGTARGETSESSIONATTRS',
  load_balance_hosts: 'PGLOADBALANCEHOSTS',
};

export function libpqConnection(url: string): LibpqConnection {
  const asArgument = { env: {}, args: ['--dbname', url] };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return asArgument; // several hosts, say: libpq reads it, URL cannot
  }
  const env: Record<string, string> = {};
  const host = decodeURIComponent(u.hostname.replace(/^\[(.*)\]$/, '$1'));
  if (host) env.PGHOST = host;
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (db) env.PGDATABASE = db;
  for (const [key, value] of u.searchParams) {
    const name = ENV[key];
    if (!name) return asArgument;
    env[name] = value;
  }
  return { env, args: [] };
}

/** The same server and credentials, another database. */
export function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
