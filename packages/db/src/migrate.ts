import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { applyPrivileges } from './privileges.js';

/**
 * A deliberately small migration runner.
 *
 * Migrations are numbered SQL files in `packages/db/migrations`, named
 * `NNNN_description.sql`. Each is applied once, in order, inside its own
 * transaction, and recorded in `schema_migration`. There is no "down": the
 * upgrade story (NFR-12) is a database backup taken before the image is
 * updated, which is simpler, safer and actually tested.
 */

export interface Migration {
  version: number;
  name: string;
  file: string;
}

export interface MigrationStatus {
  applied: Migration[];
  pending: Migration[];
}

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const LOCK_KEY = 7401;

export const MIGRATIONS_DIR =
  process.env.FDV_MIGRATIONS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function listMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir);
  const found: Migration[] = [];
  for (const f of entries) {
    const m = FILE.exec(f);
    if (m) found.push({ version: Number(m[1]), name: m[2] as string, file: path.join(dir, f) });
  }
  found.sort((a, b) => a.version - b.version);

  for (let i = 1; i < found.length; i++) {
    const prev = found[i - 1] as Migration;
    const cur = found[i] as Migration;
    if (cur.version === prev.version) {
      throw new Error(`duplicate migration version ${cur.version}: ${prev.file}, ${cur.file}`);
    }
  }
  return found;
}

async function ensureTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    create table if not exists schema_migration (
      version    int primary key,
      name       text not null,
      applied_at timestamptz not null default now()
    )`);
}

async function status(client: pg.PoolClient, dir: string): Promise<MigrationStatus> {
  const all = await listMigrations(dir);
  await ensureTable(client);
  const { rows } = await client.query<{ version: number }>(
    'select version from schema_migration order by version',
  );
  const done = new Set(rows.map((r) => r.version));
  return {
    applied: all.filter((m) => done.has(m.version)),
    pending: all.filter((m) => !done.has(m.version)),
  };
}

export async function migrationStatus(
  pool: pg.Pool,
  dir = MIGRATIONS_DIR,
): Promise<MigrationStatus> {
  const client = await pool.connect();
  try {
    return await status(client, dir);
  } finally {
    client.release();
  }
}

/**
 * Applies every pending migration, then the application role's privileges
 * (privileges.ts) — every time, so a database restored from a backup, which
 * carries none, is put right on the vault's first start. Takes an advisory
 * lock so that two API replicas starting at once cannot both run the same
 * file.
 */
export async function migrateUp(
  pool: pg.Pool,
  dir = MIGRATIONS_DIR,
  log: (msg: string) => void = () => {},
  /** Tests only: what the migrations alone produce, to hold privileges.ts to. */
  opts: { privileges?: boolean } = {},
): Promise<Migration[]> {
  const client = await pool.connect();
  const applied: Migration[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    const { pending } = await status(client, dir);
    for (const m of pending) {
      const body = await readFile(m.file, 'utf8');
      await client.query('begin');
      try {
        await client.query(body);
        await client.query('insert into schema_migration (version, name) values ($1, $2)', [
          m.version,
          m.name,
        ]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${m.version}_${m.name} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
      log(`applied ${m.version}_${m.name}`);
      applied.push(m);
    }
    if (opts.privileges !== false) await applyPrivileges(client);
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
