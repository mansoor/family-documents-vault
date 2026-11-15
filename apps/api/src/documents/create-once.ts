import type { Db } from '@fdv/db';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { ApiError } from '../errors.js';

/**
 * A create made twice is made once (0.9.0-dev.45, `features.idempotent_create`):
 * POST /api/v1/documents takes an optional Idempotency-Key, as Stripe's API
 * does. The key is the caller's own — its household, its account as the
 * person it is there, and the key — and lasts 24 hours.
 *
 *  - The first request claims the key (a row of create_idempotency, with the
 *    request's fingerprint), makes the document and writes its id on the
 *    key, all in one transaction: no create without its key, no key without
 *    its create. A refusal (a 4xx) rolls the claim back with everything
 *    else, so the request can be put right and sent again under the same key.
 *  - The same key and the same request again: the first answer, replayed —
 *    its status, and the document as it is now, read with the caller's
 *    rules now (`Idempotent-Replayed: true`).
 *  - The same key with a different request: 422 idempotency_key_reused.
 *  - The same key while the first is still being made: the second waits
 *    for the first on the key's own lock (up to `createKeyWait.ms`), then
 *    answers as above; still running then, 409 idempotency_in_progress.
 *  - What the first made, no longer the caller's to see: the route answers
 *    404 created_not_visible, with nothing of it.
 */

/** How long a key answers. */
export const CREATE_KEY_HOURS = 24;

/** How long a second try waits for a first still being made; tests shorten it. */
export const createKeyWait = { ms: 5_000 };

/** 1 to 255 printable ASCII characters (a space included); a UUID is usual. */
const KEY = /^[\x20-\x7e]{1,255}$/;

/**
 * The Idempotency-Key header, from the request's raw headers (`rawHeaders`:
 * name, value, name, value…), when one was sent: undefined when none was;
 * 400 invalid_idempotency_key for anything else — sent more than once (Node
 * would join two into "k1, k2", so they are counted as they came), empty or
 * only spaces, longer than 255, or a character outside printable ASCII.
 */
export function createKeyOf(rawHeaders: readonly string[]): string | undefined {
  const sent: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === 'idempotency-key') sent.push(rawHeaders[i + 1] ?? '');
  }
  if (sent.length === 0) return undefined;
  const [key] = sent;
  if (sent.length > 1 || key === undefined || !KEY.test(key) || key.trim() === '') {
    throw new ApiError(
      400,
      'invalid_idempotency_key',
      'An Idempotency-Key is 1 to 255 printable ASCII characters, sent once; a UUID is usual.',
      { detail: 'idempotency-key' },
    );
  }
  return key;
}

/** JSON with every object's keys in order: one body, one text, however it was written. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** What a request was, for telling the same one from another: a SHA-256, hex. */
export function requestFingerprint(method: string, route: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${route}\n${canonicalJson(body)}`)
    .digest('hex');
}

export interface CreateKey {
  key: string;
  fingerprint: string;
}

interface Caller {
  householdId: string;
  accountId: string;
  memberId: string;
}

export type CreateClaim =
  { kind: 'claimed' } | { kind: 'replay'; documentId: string | null; status: number };

const keyReused = () =>
  new ApiError(
    422,
    'idempotency_key_reused',
    'That Idempotency-Key was already used for a different request. Send a new key with a new request.',
  );

const inProgress = () =>
  new ApiError(
    409,
    'idempotency_in_progress',
    'A request with this Idempotency-Key is still being made. Try again in a moment.',
    { retriable: true, retryAfter: 2 },
  );

/** A lock wait that was not a first try of the same key: nothing is wrong, try again. */
const busy = () =>
  new ApiError(503, 'busy_try_again', 'The vault is busy. Try again in a moment.', {
    retriable: true,
    retryAfter: 1,
  });

const mine = (c: Caller, key: string) =>
  ({
    household_id: c.householdId,
    account_id: c.accountId,
    member_id: c.memberId,
    key,
  }) as const;

/** The one lock each key is made under: held only by a try of that key, by that caller. */
export const createKeyLockName = (c: Caller, key: string) =>
  `create-key:${c.householdId}:${c.accountId}:${c.memberId}:${key}`;

/**
 * Claims a key in the caller's transaction, before the create: `claimed`
 * when this request makes it, or what the first request made.
 *
 * Tries of one key take turns on a lock of their own (an advisory lock on
 * the household, account, member and key), so a second try waits for a
 * first still being made — for `createKeyWait.ms`, then 409
 * idempotency_in_progress — and nothing else waits under that limit. Only a
 * try of the same key holds that lock, so the 409 never answers a key no
 * earlier request sent. Any other wait (the household, the person or the
 * account held a moment by a change to them, as every create waits for it)
 * is the create's own, as long as it takes. A key older than 24 hours is no
 * key: it is deleted first. 422 when the key was used for another request.
 */
export async function claimCreateKey(trx: Db, c: Caller, k: CreateKey): Promise<CreateClaim> {
  const at = mine(c, k.key);
  const { rows } = await sql<{ was: string }>`
    select current_setting('lock_timeout') as was`.execute(trx);
  const wait = `${Math.max(1, Math.round(createKeyWait.ms))}ms`;
  await sql`select set_config('lock_timeout', ${wait}, true)`.execute(trx);
  try {
    await sql`select pg_advisory_xact_lock(hashtextextended(${createKeyLockName(c, k.key)}, 0))`.execute(
      trx,
    );
  } catch (err) {
    // lock_not_available: only a first try of this very key holds it.
    if ((err as { code?: string }).code === '55P03') throw inProgress();
    throw err;
  }
  await sql`select set_config('lock_timeout', ${rows[0]?.was ?? '0'}, true)`.execute(trx);
  await trx
    .deleteFrom('create_idempotency')
    .where('household_id', '=', at.household_id)
    .where('account_id', '=', at.account_id)
    .where('member_id', '=', at.member_id)
    .where('idempotency_key', '=', at.key)
    .where('created_at', '<=', sql<Date>`now() - make_interval(hours => ${CREATE_KEY_HOURS})`)
    .execute();
  // Twice at most: a key whose document was removed for good between the
  // insert and the read below has gone with it, and is claimed afresh.
  for (let attempt = 0; attempt < 2; attempt++) {
    const claimed = await trx
      .insertInto('create_idempotency')
      .values({
        household_id: at.household_id,
        account_id: at.account_id,
        member_id: at.member_id,
        idempotency_key: at.key,
        request_fingerprint: k.fingerprint,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('idempotency_key')
      .executeTakeFirst();
    if (claimed) return { kind: 'claimed' };
    const first = await trx
      .selectFrom('create_idempotency')
      .select(['request_fingerprint', 'document_id', 'status'])
      .where('household_id', '=', at.household_id)
      .where('account_id', '=', at.account_id)
      .where('member_id', '=', at.member_id)
      .where('idempotency_key', '=', at.key)
      .executeTakeFirst();
    if (!first) continue;
    if (first.request_fingerprint !== k.fingerprint) throw keyReused();
    return { kind: 'replay', documentId: first.document_id, status: first.status };
  }
  // A key there and not there, twice: nothing an earlier request of it is
  // doing (its lock is ours). Try again.
  throw busy();
}

/** The document a claimed key made, written on it in the same transaction. */
export async function keepCreateKey(
  trx: Db,
  c: Caller,
  key: string,
  documentId: string,
  status = 201,
): Promise<void> {
  const at = mine(c, key);
  await trx
    .updateTable('create_idempotency')
    .set({ document_id: documentId, status })
    .where('household_id', '=', at.household_id)
    .where('account_id', '=', at.account_id)
    .where('member_id', '=', at.member_id)
    .where('idempotency_key', '=', at.key)
    .execute();
}
