import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DecryptStream } from '@fdv/crypto';
import { createPool, listMigrations, migrateUp } from '@fdv/db';
import { libpqEnv, withDatabase } from './libpq.js';

/**
 * Putting a backup back (NFR-07).
 *
 * A backup is a plain `pg_dump`, encrypted (backup.ts). Restoring loads it
 * into an empty database, then does what the vault's own start would: runs
 * any migrations the backup predates and gives the application role its
 * privileges, which the dump does not carry. Then it checks the result the
 * way the vault will use it — as the application role, through row-level
 * security — rather than counting rows as the owner, which is all the drill
 * did until 0.4.5, and why it never noticed that a restored vault could not
 * read itself.
 *
 * The load is one transaction, and it is committed only after the whole
 * file has decrypted and authenticated: the last chunk carries the flag
 * that proves nothing was cut off, so until it has been read there is
 * nothing to commit. A truncated, altered or foreign file leaves the
 * database as empty as it was. (pg_dump writes row-level security, the
 * policies and the audit log's trigger last, so a partial load would have
 * been a vault without its privacy wall.)
 *
 * A backup is the past: whatever was revoked or changed since it was made
 * is undone. So every session is ended — everybody signs in again — and
 * password-reset links still outstanding are expired; what cannot be
 * decided for the family (share links and invitations that are open again)
 * is reported.
 */

export interface RestoreTarget {
  /** The owning role, on the database to restore into. */
  adminUrl: string;
  /** The application role, on the same database. */
  appUrl: string;
}

export interface RestoreReport {
  schema: number;
  households: number;
  members: number;
  documents: number;
  versions: number;
  /** Sessions ended, so that everybody signs in again. */
  sessionsEnded: number;
  /** Share links that work again: any revoked since the backup is among them. */
  liveShareLinks: number;
  openInvitations: number;
}

export type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

/** Refused because the target is not empty: nothing was changed. */
export class RestoreRefused extends Error {}

/** The backup was loaded, but what follows the load failed. */
export class RestoreIncomplete extends Error {}

export async function restoreBackup(
  file: string,
  backupKey: Buffer,
  target: RestoreTarget,
  log: Log,
): Promise<RestoreReport> {
  await assertEmpty(target.adminUrl);
  const known = (await listMigrations()).reduce((max, m) => Math.max(max, m.version), 0);
  await load(file, backupKey, target.adminUrl, known);
  log('info', 'backup loaded', { file });

  try {
    const admin = createPool(target.adminUrl, 1);
    let after: AfterRestore;
    try {
      // What the vault's own start does: bring an older backup up to date,
      // then give the application role its privileges.
      const applied = await migrateUp(admin, undefined, (m) => log('info', `migrate: ${m}`));
      if (applied.length) log('info', 'backup brought up to date', { migrations: applied.length });
      after = await undoThePast(admin);
    } finally {
      await admin.end();
    }
    return { ...(await checkRestored(target)), ...after };
  } catch (err) {
    throw new RestoreIncomplete((err as Error).message, { cause: err });
  }
}

interface AfterRestore {
  sessionsEnded: number;
  liveShareLinks: number;
  openInvitations: number;
}

/**
 * A session revoked, a password changed, a phone signed out since the
 * backup: all of it came back with it. Ending every session makes the
 * restored vault ask everybody for the password it now has.
 */
async function undoThePast(admin: ReturnType<typeof createPool>): Promise<AfterRestore> {
  const ended = await admin.query(
    `update session set revoked_at = now(), revoked_reason = 'restored from a backup'
      where revoked_at is null`,
  );
  await admin.query(
    `update password_reset set expires_at = now() where used_at is null and expires_at > now()`,
  );
  const { rows } = await admin.query<{ links: number; invitations: number }>(
    `select (select count(*)::int from share_link
              where revoked_at is null and (expires_at is null or expires_at > now())) as links,
            (select count(*)::int from invitation
              where accepted_at is null and revoked_at is null and expires_at > now()) as invitations`,
  );
  return {
    sessionsEnded: ended.rowCount ?? 0,
    liveShareLinks: rows[0]?.links ?? 0,
    openInvitations: rows[0]?.invitations ?? 0,
  };
}

/**
 * The newest backup in a folder, by name: the names are timestamps, and a
 * copied file's modification time may not be.
 */
export async function newestBackup(dir: string): Promise<string | null> {
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => /^fdv-.*\.sql\.enc$/.test(f))
    .sort();
  const last = names.at(-1);
  return last ? path.join(dir, last) : null;
}

const DRILL_PREFIX = 'fdv_restore_drill_';

/**
 * Restores a backup into a scratch database on the same server, checks it
 * as the application role, and drops it again — also if the drill fails or
 * is interrupted, because the scratch copy holds the whole household.
 */
export async function restoreDrill(opts: {
  file: string;
  backupKey: Buffer;
  adminUrl: string;
  appUrl: string;
  log: Log;
}): Promise<RestoreReport> {
  const name = `${DRILL_PREFIX}${Math.floor(Date.now() / 1000)}_${randomUUID().slice(0, 8)}`;
  const root = createPool(withDatabase(opts.adminUrl, 'postgres'), 1);
  const drop = () => root.query(`drop database if exists ${name} with (force)`);
  const onSignal = (signal: NodeJS.Signals) => {
    void drop()
      .catch(() => undefined)
      .finally(() => process.kill(process.pid, signal));
  };
  try {
    await dropStaleDrills(root, opts.log);
    await root.query(`create database ${name}`);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    return await restoreBackup(
      opts.file,
      opts.backupKey,
      { adminUrl: withDatabase(opts.adminUrl, name), appUrl: withDatabase(opts.appUrl, name) },
      opts.log,
    );
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await drop().catch((err: unknown) =>
      opts.log('error', 'could not drop the drill database; drop it by hand', {
        database: name,
        err: String(err),
      }),
    );
    await root.end();
  }
}

/** A drill that was killed outright leaves its copy behind; the next one removes it. */
async function dropStaleDrills(root: ReturnType<typeof createPool>, log: Log): Promise<void> {
  const { rows } = await root.query<{ datname: string }>(
    `select datname from pg_database where datname like $1`,
    [`${DRILL_PREFIX}%`],
  );
  const hourAgo = Date.now() / 1000 - 3600;
  for (const { datname } of rows) {
    const started = Number(datname.slice(DRILL_PREFIX.length).split('_')[0]);
    if (!/^[a-z0-9_]+$/.test(datname) || !(started < hourAgo)) continue;
    await root.query(`drop database if exists ${datname} with (force)`);
    log('info', 'removed a copy left behind by an earlier drill', { database: datname });
  }
}

/** Nothing in it yet: no tables, no schemas of ours. */
async function assertEmpty(adminUrl: string): Promise<void> {
  const pool = createPool(adminUrl, 1);
  try {
    const { rows } = await pool.query<{ relations: number; schemas: number }>(`
      select
        (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname not in ('pg_catalog', 'information_schema')
            and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%') as relations,
        (select count(*)::int from pg_namespace
          where nspname not in ('public', 'pg_catalog', 'information_schema')
            and nspname not like 'pg\\_toast%' and nspname not like 'pg\\_temp%') as schemas`);
    const r = rows[0];
    if (r && (r.relations > 0 || r.schemas > 0)) {
      throw new RestoreRefused(
        'The database is not empty, so nothing was restored into it. A backup goes into an ' +
          'empty database only — see "Restoring" in the README for how to get one without ' +
          'touching your files.',
      );
    }
  } finally {
    await pool.end();
  }
}

/**
 * Decrypts the file into psql, in one transaction that is committed only
 * when the whole file has been read and authenticated, and only if the
 * backup is not from a newer release than this one.
 */
async function load(file: string, key: Buffer, adminUrl: string, known: number): Promise<void> {
  const psql = spawn('psql', ['--no-psqlrc', '--quiet', '--set', 'ON_ERROR_STOP=1'], {
    // The connection goes in the environment, not on a command line other
    // processes can read.
    env: { ...process.env, ...libpqEnv(adminUrl), PGAPPNAME: 'fdv-restore' },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  psql.stderr.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    psql.on('error', reject);
    psql.on('close', (code) => resolve(code));
  });

  psql.stdin.write('begin;\n');
  try {
    await pipeline(createReadStream(file), new DecryptStream(key), psql.stdin, { end: false });
  } catch (err) {
    // The file did not decrypt to the end, or psql stopped on an error.
    // Nothing has been committed: stop psql before it could see the end of
    // its input, and the open transaction dies with the connection.
    psql.kill('SIGKILL');
    await exited.catch(() => undefined);
    throw new Error(
      stderr.trim()
        ? `the backup could not be loaded: ${stderr.trim()}`
        : `the backup could not be read: ${(err as Error).message}`,
      { cause: err },
    );
  }
  psql.stdin.end(`\n${versionGuard(known)}\ncommit;\n`);
  const code = await exited;
  if (code !== 0) {
    throw new Error(`the backup could not be loaded (psql exited ${code}): ${stderr.trim()}`);
  }
}

/** Refuses, inside the load's transaction, a backup this release cannot run. */
function versionGuard(known: number): string {
  return `do $guard$
declare made int;
begin
  if to_regclass('public.schema_migration') is null then
    raise exception 'this file is not a backup of a Family Document Vault database';
  end if;
  select max(version) into made from public.schema_migration;
  if made > ${known} then
    raise exception 'this backup was made by a newer release of the vault (database schema %), and this one only knows schema %: restore it with that release or a later one', made, ${known};
  end if;
end $guard$;`;
}

/**
 * The restored vault, seen the way the vault will see it: as the
 * application role, one household at a time.
 */
export async function checkRestored(
  target: RestoreTarget,
): Promise<Omit<RestoreReport, keyof AfterRestore>> {
  const admin = createPool(target.adminUrl, 1);
  const app = createPool(target.appUrl, 1);
  try {
    const { rows: counts } = await admin.query<{ id: string; members: number; documents: number }>(
      `select h.id,
              (select count(*)::int from member m where m.household_id = h.id) as members,
              (select count(*)::int from document d where d.household_id = h.id) as documents
         from household h`,
    );
    const { rows: totals } = await admin.query<{
      schema: number;
      versions: number;
      unprotected: string[];
    }>(
      `select (select max(version)::int from schema_migration) as schema,
              (select count(*)::int from document_version) as versions,
              array(select c.oid::regclass::text from pg_class c
                     where exists (select 1 from pg_policy p where p.polrelid = c.oid)
                       and not c.relrowsecurity) as unprotected`,
    );
    const t = totals[0];
    if (!t) throw new Error('the restored database has no schema_migration');
    if (t.unprotected.length) {
      throw new Error(`row-level security is off on ${t.unprotected.join(', ')}`);
    }
    // The database's own guards: the audit log refuses changes, and a
    // household always keeps an owner.
    const { rows: guards } = await admin.query<{ tgname: string }>(
      `select tgname from pg_trigger
        where not tgisinternal and tgenabled <> 'D'
          and tgname in ('audit_event_no_update', 'owner_floor')`,
    );
    if (guards.length !== 2) {
      throw new Error(
        `a guard the vault relies on is missing (found: ${guards.map((g) => g.tgname).join(', ') || 'none'})`,
      );
    }

    const { rows: rights } = await app.query<{
      unreadable: string[];
      owned: string[];
      privileged: boolean;
      queue: boolean;
      audit_mutable: boolean;
      tenant_tables: string[];
    }>(
      `with ours as (
         select c.oid, c.relowner from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname in ('public', 'pgboss') and c.relkind in ('r', 'p'))
       select array(select oid::regclass::text from ours
                     where not has_table_privilege(oid, 'select')) as unreadable,
              array(select oid::regclass::text from ours
                     where pg_has_role(current_user, relowner, 'USAGE')) as owned,
              (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as privileged,
              has_schema_privilege('pgboss', 'usage') as queue,
              has_table_privilege('public.audit_event', 'update')
                or has_table_privilege('public.audit_event', 'delete') as audit_mutable,
              array(select c.oid::regclass::text from pg_class c
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind in ('r', 'p')
                      and exists (select 1 from pg_attribute a where a.attrelid = c.oid
                                   and a.attname = 'household_id' and not a.attisdropped)) as tenant_tables`,
    );
    const r = rights[0];
    if (!r || r.unreadable.length) {
      throw new Error(`the application role cannot read ${r?.unreadable.join(', ') ?? 'anything'}`);
    }
    // Row-level security does not apply to a table's owner, or to a role
    // that may bypass it: the application role must be neither.
    if (r.owned.length) {
      throw new Error(
        `the application role owns ${r.owned.join(', ')}, so no policy applies to it`,
      );
    }
    if (r.privileged) throw new Error('the application role can bypass row-level security');
    if (!r.queue) throw new Error('the application role cannot use the job queue');
    if (r.audit_mutable) throw new Error('the audit log is no longer append-only');

    const asHousehold = async <T>(household: string, sql: string): Promise<T[]> => {
      const client = await app.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.household_id', $1, true)`, [household]);
        const { rows } = await client.query<T & object>(sql);
        await client.query('commit');
        return rows;
      } finally {
        client.release();
      }
    };
    const seen = async (household: string) =>
      (
        await asHousehold<{ members: number; documents: number }>(
          household,
          `select (select count(*)::int from member) as members,
                  (select count(*)::int from document) as documents`,
        )
      )[0] ?? { members: -1, documents: -1 };

    // Somebody else's household sees nothing, in any table that belongs to
    // a household: the policies came back.
    const stranger = randomUUID();
    const leaks = await asHousehold<{ t: string; n: number }>(
      stranger,
      r.tenant_tables
        .map((t) => `select '${t.replace(/'/g, "''")}' as t, count(*)::int as n from ${t}`)
        .join(' union all '),
    );
    const leaking = leaks.filter((l) => l.n > 0).map((l) => l.t);
    if (leaking.length) {
      throw new Error(`a household can see rows that are not its own in ${leaking.join(', ')}`);
    }
    for (const h of counts) {
      const got = await seen(h.id);
      if (got.members !== h.members || got.documents !== h.documents) {
        throw new Error(
          `household ${h.id}: the vault would see ${got.members} people and ${got.documents} ` +
            `documents, but the backup has ${h.members} and ${h.documents}`,
        );
      }
    }
    return {
      schema: t.schema,
      households: counts.length,
      members: counts.reduce((n, h) => n + h.members, 0),
      documents: counts.reduce((n, h) => n + h.documents, 0),
      versions: t.versions,
    };
  } finally {
    await admin.end();
    await app.end();
  }
}
