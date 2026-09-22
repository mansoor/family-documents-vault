import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from './client.js';

/**
 * Hash-chained audit log (SEC-16, design decision 9).
 *
 *   hash = sha256(prev_hash || household_id || actor || action || object || detail || at)
 *
 * `prev_hash` is the hash of the previous row for the same household. Any
 * edited or removed row breaks the chain from that point on, detectably by
 * anyone who can read the table — including a self-hoster auditing their own
 * installation. Rows are appended inside the caller's transaction, so the
 * audit entry commits with the change it describes, or not at all.
 */

export interface AuditInput {
  householdId: string;
  actorAccountId?: string | null | undefined;
  actorLabel?: string | null | undefined;
  action: string;
  objectType?: string | null | undefined;
  objectId?: string | null | undefined;
  detail?: Record<string, unknown> | undefined;
  ip?: string | null | undefined;
}

interface ChainRow {
  id: number;
  household_id: string;
  actor_account_id: string | null;
  actor_label: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  detail: unknown;
  at: Date;
  prev_hash: Buffer | null;
  hash: Buffer;
}

/** Deterministic JSON: sorted keys, so the hash does not depend on insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function computeHash(row: Omit<ChainRow, 'id' | 'hash'>): Buffer {
  const h = createHash('sha256');
  h.update(row.prev_hash ?? Buffer.alloc(0));
  h.update('|');
  h.update(row.household_id);
  h.update('|');
  h.update(row.actor_account_id ?? row.actor_label ?? '');
  h.update('|');
  h.update(row.action);
  h.update('|');
  h.update(row.object_type ?? '');
  h.update('|');
  h.update(row.object_id ?? '');
  h.update('|');
  h.update(canonicalJson(row.detail));
  h.update('|');
  h.update(row.at.toISOString());
  return h.digest();
}

/**
 * Appends one event. Must run inside a transaction scoped to the household
 * (see withScope). Serialises per household with a transaction-level
 * advisory lock so that concurrent writers cannot both read the same
 * `prev_hash`.
 */
export async function appendAudit(trx: Db, input: AuditInput): Promise<number> {
  await sql`select pg_advisory_xact_lock(hashtext('audit:' || ${input.householdId}))`.execute(trx);

  const last = await trx
    .selectFrom('audit_event')
    .select('hash')
    .where('household_id', '=', input.householdId)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();

  const at = new Date();
  const detail = input.detail ?? {};
  const row = {
    household_id: input.householdId,
    actor_account_id: input.actorAccountId ?? null,
    actor_label: input.actorLabel ?? null,
    action: input.action,
    object_type: input.objectType ?? null,
    object_id: input.objectId ?? null,
    detail,
    at,
    prev_hash: last?.hash ?? null,
  };
  const hash = computeHash(row);

  const inserted = await trx
    .insertInto('audit_event')
    .values({
      household_id: row.household_id,
      actor_account_id: row.actor_account_id,
      actor_label: row.actor_label,
      action: row.action,
      object_type: row.object_type,
      object_id: row.object_id,
      detail: JSON.stringify(detail),
      ip: input.ip ?? null,
      at,
      prev_hash: row.prev_hash,
      hash,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return inserted.id;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  /** The first row whose hash or link does not match, if any. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Walks a household's chain from the start and recomputes every hash.
 * Runs nightly in the worker and on demand from the settings screen.
 */
export async function verifyAuditChain(trx: Db, householdId: string): Promise<ChainVerification> {
  const rows = (await trx
    .selectFrom('audit_event')
    .selectAll()
    .where('household_id', '=', householdId)
    .orderBy('id', 'asc')
    .execute()) as unknown as ChainRow[];

  let prev: Buffer | null = null;
  for (const row of rows) {
    const linkOk =
      (prev === null && row.prev_hash === null) ||
      (prev !== null && row.prev_hash !== null && prev.equals(row.prev_hash));
    if (!linkOk) {
      return { ok: false, checked: rows.length, brokenAt: row.id, reason: 'link' };
    }
    const expected = computeHash({ ...row, prev_hash: prev });
    if (!expected.equals(row.hash)) {
      return { ok: false, checked: rows.length, brokenAt: row.id, reason: 'hash' };
    }
    prev = row.hash;
  }
  return { ok: true, checked: rows.length };
}
