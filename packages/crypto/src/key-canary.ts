import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { deriveKey } from './master.js';

/**
 * Which master key the vault was last opened with, for a process that
 * cannot check the key itself.
 *
 * The full check (`checkMasterKey`) opens every household's keys, which only
 * the owning role can see; the API in the compose setup runs on the
 * application role alone. So whatever does the full check and passes — the
 * migrate service, or a worker or API given DATABASE_ADMIN_URL — records an
 * HMAC of the key here (master_key_canary, migration 0121: one row, readable
 * by the application role, written by the owning role alone). The API then
 * compares its own key's HMAC at start, and refuses a different one. The
 * HMAC is under a key derived for this purpose alone, so the row says
 * nothing about the master key or any key derived for anything else; it is
 * never logged.
 */
export const KEY_CANARY_PURPOSE = 'key-canary';

const MESSAGE = 'family-document-vault master key canary v1';

/** The canary for `secret`: 32 bytes. */
export function keyCanary(secret: string): Buffer {
  return createHmac('sha256', deriveKey(secret, KEY_CANARY_PURPOSE)).update(MESSAGE).digest();
}

/**
 * Records `secret`'s canary, by a process whose full check of it has just
 * passed. False, writing nothing, where there is no table yet (a database
 * from before 0121) or the role may not write it (not the owning role).
 */
export async function writeKeyCanary(admin: pg.Pool, secret: string): Promise<boolean> {
  const { rows } = await admin.query<{ writable: boolean | null }>(
    `select case when to_regclass('public.master_key_canary') is null then null
                 else has_table_privilege(current_user, 'public.master_key_canary', 'INSERT')
                      and has_table_privilege(current_user, 'public.master_key_canary', 'UPDATE')
            end as writable`,
  );
  if (!rows[0]?.writable) return false;
  await admin.query(
    `insert into public.master_key_canary (singleton, mac, written_at) values (true, $1, now())
     on conflict (singleton) do update set mac = excluded.mac, written_at = excluded.written_at`,
    [keyCanary(secret)],
  );
  return true;
}

/**
 * How `secret` compares with the key the vault was last opened with:
 * `match`; `mismatch`; or `absent`, where nothing has been recorded yet (a
 * database from before 0121, or one this release's migrate service has not
 * run on) and the caller does as it did before.
 */
export async function compareKeyCanary(
  pool: pg.Pool,
  secret: string,
): Promise<'match' | 'mismatch' | 'absent'> {
  const { rows: table } = await pool.query<{ present: boolean }>(
    "select to_regclass('public.master_key_canary') is not null as present",
  );
  if (!table[0]?.present) return 'absent';
  const { rows } = await pool.query<{ mac: Buffer }>(
    'select mac from public.master_key_canary where singleton',
  );
  const recorded = rows[0]?.mac;
  if (!recorded) return 'absent';
  const mine = keyCanary(secret);
  return recorded.length === mine.length && timingSafeEqual(recorded, mine) ? 'match' : 'mismatch';
}

/** What an operator is told when the key is not the one the vault was last opened with. */
export const KEY_CANARY_MISMATCH = [
  'FDV_MASTER_KEY is not the key this vault was last opened with (the migrate service records',
  'it each time the stack starts), so nothing is started on it. Put the right key in .env (or in',
  'your FDV_MASTER_KEY_FILE). If you have just rotated the master key, start the vault with',
  '`docker compose up -d`, which runs the migrate service first; with --no-deps, run',
  '`docker compose run --rm --no-deps migrate` before anything else.',
].join('\n');
