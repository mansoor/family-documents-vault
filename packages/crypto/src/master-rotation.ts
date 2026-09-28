import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { deriveKey, KEK_PURPOSE } from './master.js';
import { binding, type ScopeKind } from './scope-keys.js';
import { unwrapKey, wrapKey } from './wrap.js';

/**
 * Moving the database onto another master key (SEC-02): a rotation, the
 * repair of a vault left partly under an older key, and a restore of a
 * backup made before a rotation.
 *
 * What the master key protects in the database is of two kinds. Scope keys
 * are wrapped by the key-encryption key. And a few secrets the vault keeps
 * for the household are sealed under keys derived from the master secret
 * with `deriveKey`, one purpose each: MASTER_SEALED. Moving opens each of
 * them with whichever of the keys given opens it and puts it back under
 * the target key, in one transaction; if anything opens with none of them,
 * nothing is changed. Either way the database ends wholly under one key.
 * AES-GCM with the row bound in makes "which key opens this" unambiguous.
 * File content is never read or rewritten: it is under file keys, under
 * scope keys, which keep their value.
 *
 * Everything else derived from the master secret signs something that
 * lasts minutes — an access token, the "now the code" token of two-step
 * sign-in, a sealed-search handle — and is simply no longer accepted. The
 * nightly backups are files under 'database-backup': they are not
 * rewritten, and a restore opens an older one with the key it was made with
 * and moves what it holds across (ensureMasterKey).
 */

/**
 * The secrets sealed under a master-derived key, sealed as their writers
 * seal them: AES-256-GCM, `iv (12) || tag (16) || ciphertext`, with the row
 * bound in as additional data. A new purpose whose values are kept in the
 * database belongs here; the API's rotation test opens each one through its
 * writer's own code.
 */
export const MASTER_SEALED = [
  // apps/api/src/auth/totp.ts
  {
    name: 'totpSecrets',
    purpose: 'totp-secrets',
    table: 'account',
    key: 'id',
    column: 'totp_secret',
    aad: (id: string) => `totp:${id}`,
  },
  // packages/storage/src/vault-row.ts
  {
    name: 'vaultCredentials',
    purpose: 'vault-credentials',
    table: 'vault',
    key: 'id',
    column: 'credentials_encrypted',
    aad: (id: string) => `vault:${id}`,
  },
  // apps/api/src/notifications/service.ts (sealPassword)
  {
    name: 'smtpPasswords',
    purpose: 'smtp-credentials',
    table: 'smtp_settings',
    key: 'household_id',
    column: 'password_encrypted',
    aad: (id: string) => `smtp:${id}`,
  },
] as const;

export type SealedName = (typeof MASTER_SEALED)[number]['name'];

/** What was moved onto the target key: counts, never contents. */
export interface RekeyReport {
  /** Scope keys that were under another key, rewrapped under the target. */
  rewrapped: number;
  /** Secrets that were under another key, sealed again under the target, by kind. */
  resealed: Record<SealedName, number>;
  /** Scope keys and secrets under the target key already, left as they were. */
  unchanged: number;
}

/** A rotation's report: what moved, and who was signed out. */
export interface RotationReport extends RekeyReport {
  sessionsEnded: number;
  /**
   * Everything was under the new key already, and nothing was done: an
   * earlier run of the same rotation finished.
   */
  alreadyDone: boolean;
}

/**
 * Something opens with none of the keys given. Nothing was changed.
 */
export class MasterKeyMismatch extends Error {
  constructor(
    /** What opens with none of them, by table and row: never contents. */
    readonly unopened: readonly string[],
    /** How many values did open with one of them. */
    readonly opened: number,
  ) {
    super(`${listed(unopened)} ${unopened.length === 1 ? 'does' : 'do'} not open`);
  }

  /** The first few, and how many more: for a sentence. */
  get what(): string {
    return listed(this.unopened);
  }
}

/**
 * The connection is one row-level security applies to: it would see only
 * some households' rows, and move only those.
 */
export class CannotSeeVault extends Error {}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Seals a value as MASTER_SEALED's writers do. */
export function sealBound(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

/** Opens a value sealed by `sealBound`, or by one of MASTER_SEALED's writers. */
export function openBound(key: Buffer, sealed: Buffer, aad: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([d.update(sealed.subarray(IV_BYTES + TAG_BYTES)), d.final()]);
}

/** Scope keys and secrets moved (not counting those already in place). */
export function movedCount(r: RekeyReport): number {
  return r.rewrapped + Object.values(r.resealed).reduce((n, c) => n + c, 0);
}

/**
 * Rotation: everything under `current` is moved onto `next`, and every
 * session is ended — in one transaction, as the owning role, across
 * households. Access tokens are signed with a master-derived key and stop
 * working by themselves; the refresh tokens that renew them are not, so
 * their sessions are ended here and everybody signs in again.
 *
 * Throws MasterKeyMismatch, changing nothing, if anything opens with
 * neither key. If everything is under `next` already, an earlier run
 * finished: nothing is done, and the report says so.
 */
export async function rotateMasterKey(
  admin: pg.Pool,
  current: string,
  next: string,
): Promise<RotationReport> {
  if (current === next) throw new Error('the new master key is the one in use');
  return inTransaction(admin, async (client) => {
    const moved = await rekey(client, { to: next, from: [current], write: true });
    if (movedCount(moved) === 0 && moved.unchanged > 0) {
      return { ...moved, sessionsEnded: 0, alreadyDone: true };
    }
    const sessionsEnded = await endSessions(client, 'master key rotated');
    return { ...moved, sessionsEnded, alreadyDone: false };
  });
}

/**
 * Repair: a vault left partly under `previous` — rotated by a release
 * before 0.5.0, which moved only the scope keys, or written to by a vault
 * still running on the old key — is moved wholly onto `current`, and, as a
 * rotation would have, every session is ended. Throws MasterKeyMismatch,
 * changing nothing, if anything opens with neither key.
 */
export async function repairMasterKey(
  admin: pg.Pool,
  current: string,
  previous: string,
): Promise<RekeyReport & { sessionsEnded: number }> {
  if (current === previous) throw new Error('the previous master key is the one in use');
  return inTransaction(admin, async (client) => {
    const moved = await rekey(client, { to: current, from: [previous], write: true });
    const sessionsEnded =
      movedCount(moved) > 0 ? await endSessions(client, 'master key repaired') : 0;
    return { ...moved, sessionsEnded };
  });
}

/**
 * After a restore: makes everything the master key protects open with
 * `current`. A backup made before a rotation holds it under the key it was
 * made with, and one of a vault rotated by a release before 0.5.0 holds
 * some of it under each; given that key as `previous`, whatever is under it
 * is moved across, value by value, in one transaction. Null when all of it
 * opens with `current` already.
 *
 * Throws MasterKeyMismatch, changing nothing, when something opens with
 * neither key: a database left partly under a key nobody has would lock
 * part of the household out for good.
 */
export async function ensureMasterKey(
  admin: pg.Pool,
  current: string,
  previous?: string,
): Promise<RekeyReport | null> {
  return inTransaction(admin, async (client) => {
    const from = previous === undefined || previous === current ? [] : [previous];
    const moved = await rekey(client, { to: current, from, write: true });
    return movedCount(moved) > 0 ? moved : null;
  });
}

/**
 * Whether `secret` opens everything the master key protects, read only:
 * what the vault's start and the nightly backup ask. Throws
 * MasterKeyMismatch naming what does not open, or CannotSeeVault.
 */
export async function checkMasterKey(admin: pg.Pool, secret: string): Promise<{ checked: number }> {
  return inTransaction(
    admin,
    async (client) => ({
      checked: (await rekey(client, { to: secret, from: [], write: false })).unchanged,
    }),
    'begin read only',
  );
}

/**
 * For the vault's start, and before a backup: why it must not go ahead on
 * `secret`, or null. A connection that cannot see every household (no
 * DATABASE_ADMIN_URL) cannot check, and says so through `warn`.
 */
export async function masterKeyRefusal(
  admin: pg.Pool,
  secret: string,
  warn: (message: string) => void,
): Promise<string | null> {
  try {
    await checkMasterKey(admin, secret);
    return null;
  } catch (err) {
    if (err instanceof CannotSeeVault) {
      warn(`the master key was not checked: ${err.message}`);
      return null;
    }
    if (err instanceof MasterKeyMismatch) return wrongMasterKeyMessage(err);
    throw err;
  }
}

/** What an operator is told when FDV_MASTER_KEY does not open the vault. */
export function wrongMasterKeyMessage(err: MasterKeyMismatch): string {
  const lines = [
    `FDV_MASTER_KEY does not open this vault (${err.what}).`,
    'If you have just rotated the master key, put the new key in .env as FDV_MASTER_KEY (or in',
    'your FDV_MASTER_KEY_FILE) and run: docker compose up -d',
    'Not "docker compose start" or "restart": they keep the key the containers were made with.',
  ];
  if (err.opened > 0) {
    lines.push(
      'Part of the vault opens with this key and part does not. If the master key was rotated',
      'by a release before 0.5.0, repair it: see "Rotating the master key" in the README.',
    );
  }
  return lines.join('\n');
}

interface Rekey {
  /** The key everything ends under. */
  to: string;
  /** Other keys a value may be under now. */
  from: readonly string[];
  /** False: only open, as a check does. */
  write: boolean;
}

/**
 * Opens each scope key and each MASTER_SEALED value with `to` or, failing
 * that, one of `from`, and — writing — puts what `to` did not open back
 * under `to`. Throws MasterKeyMismatch, having written nothing that will
 * be kept, if anything opens with none of them.
 */
async function rekey(client: pg.ClientBase, { to, from, write }: Rekey): Promise<RekeyReport> {
  await assertSeesEverything(client);
  if (write) await lockProtected(client);
  const secrets = [to, ...from.filter((k) => k !== to)];
  const lock = write ? ' for update' : '';
  const unopened: string[] = [];
  let opened = 0;
  let unchanged = 0;

  let rewrapped = 0;
  if (await hasColumn(client, 'scope_key', 'key_wrapped')) {
    const keks = secrets.map((s) => deriveKey(s, KEK_PURPOSE));
    const { rows } = await client.query<{
      id: string;
      household_id: string;
      kind: ScopeKind;
      member_id: string | null;
      key_wrapped: Buffer;
    }>(`select id, household_id, kind, member_id, key_wrapped from scope_key order by id${lock}`);
    for (const r of rows) {
      const b = binding({ householdId: r.household_id, kind: r.kind, memberId: r.member_id });
      const found = firstOpening(keks, (kek) => unwrapKey(r.key_wrapped, kek, b));
      if (!found) {
        unopened.push(`the ${r.kind} scope key ${r.id}`);
        continue;
      }
      opened += 1;
      if (found.index === 0) {
        unchanged += 1;
        continue;
      }
      if (write) {
        await client.query(
          'update scope_key set key_wrapped = $1, rotated_at = now() where id = $2',
          [wrapKey(found.value, keks[0] as Buffer, b), r.id],
        );
      }
      rewrapped += 1;
    }
  }

  const resealed: Record<SealedName, number> = {
    totpSecrets: 0,
    vaultCredentials: 0,
    smtpPasswords: 0,
  };
  for (const s of MASTER_SEALED) {
    // A backup can be older than the column; a restore brings it up to date
    // afterwards, with nothing in it to move.
    if (!(await hasColumn(client, s.table, s.column))) continue;
    const keys = secrets.map((secret) => deriveKey(secret, s.purpose));
    const { rows } = await client.query<{ id: string; value: Buffer }>(
      `select ${s.key}::text as id, ${s.column} as value from ${s.table}
        where ${s.column} is not null order by 1${lock}`,
    );
    for (const r of rows) {
      const aad = s.aad(r.id);
      const found = firstOpening(keys, (key) => openBound(key, r.value, aad));
      if (!found) {
        unopened.push(`${s.table}.${s.column} of ${r.id}`);
        continue;
      }
      opened += 1;
      if (found.index === 0) {
        unchanged += 1;
        continue;
      }
      if (write) {
        await client.query(`update ${s.table} set ${s.column} = $1 where ${s.key} = $2`, [
          sealBound(keys[0] as Buffer, found.value, aad),
          r.id,
        ]);
      }
      resealed[s.name] += 1;
    }
  }
  if (unopened.length) throw new MasterKeyMismatch(unopened, opened);
  return { rewrapped, resealed, unchanged };
}

function firstOpening<T>(
  keys: readonly Buffer[],
  open: (key: Buffer) => T,
): { index: number; value: T } | null {
  for (const [index, key] of keys.entries()) {
    try {
      return { index, value: open(key) };
    } catch {
      // not this one
    }
  }
  return null;
}

/** The tables that hold what the master key protects, and the sessions a rotation ends. */
const PROTECTED = ['scope_key', 'account', 'vault', 'smtp_settings', 'session'];

/**
 * Row-level security would hide other households' rows and leave them
 * behind. The owning role sees everything; the application role does not.
 */
async function assertSeesEverything(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ hidden: string[]; role: string; tables: boolean }>(
    `select array(
              select c.relname::text from pg_class c
               where c.oid = any (array(select to_regclass('public.' || t)
                                          from unnest($1::text[]) t))
                 and c.relrowsecurity
                 and not (select rolsuper or rolbypassrls from pg_roles
                           where rolname = current_user)
                 and (c.relforcerowsecurity
                      or not pg_has_role(current_user, c.relowner, 'USAGE'))) as hidden,
            current_user::text as role,
            to_regclass('public.household') is not null
              and to_regclass('public.scope_key') is not null as tables`,
    [[...PROTECTED, 'household']],
  );
  const r = rows[0];
  const cannot = (why: string) =>
    new CannotSeeVault(
      `${why}, so it cannot see every household's rows: connect with DATABASE_ADMIN_URL, ` +
        'the owning role',
    );
  if (r?.hidden.length) {
    throw cannot(`row-level security applies to ${r.role} on ${r.hidden.join(', ')}`);
  }
  if (r?.tables) {
    // And a belt to that: every household has its scope keys from the
    // transaction that made it.
    const { rows: seen } = await client.query<{ stranded: boolean }>(
      `select exists (select 1 from household)
              and not exists (select 1 from scope_key) as stranded`,
    );
    if (seen[0]?.stranded) throw cannot(`${r.role} sees households but no scope keys`);
  }
}

/**
 * Nothing is written to what is being moved, or a session opened, until
 * the move commits: a vault still running on the old key waits, and sees
 * the new rows after.
 */
async function lockProtected(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query<{ t: string }>(
    `select t from unnest($1::text[]) t where to_regclass('public.' || t) is not null`,
    [PROTECTED],
  );
  if (!rows.length) return;
  await client.query("set local lock_timeout = '30s'");
  await client.query(`lock table ${rows.map((r) => r.t).join(', ')} in share row exclusive mode`);
}

async function endSessions(client: pg.ClientBase, reason: string): Promise<number> {
  const ended = await client.query(
    `update session set revoked_at = now(), revoked_reason = $1 where revoked_at is null`,
    [reason],
  );
  return ended.rowCount ?? 0;
}

async function hasColumn(client: pg.ClientBase, table: string, column: string): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    `select exists (select 1 from pg_attribute
                     where attrelid = to_regclass($1) and attname = $2 and not attisdropped) as ok`,
    [`public.${table}`, column],
  );
  return rows[0]?.ok === true;
}

function listed(items: readonly string[]): string {
  const shown = items.slice(0, 3).join(', ');
  return items.length > 3 ? `${shown} and ${items.length - 3} more` : shown;
}

async function inTransaction<T>(
  admin: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  begin = 'begin',
): Promise<T> {
  const client = await admin.connect();
  try {
    await client.query(begin);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
