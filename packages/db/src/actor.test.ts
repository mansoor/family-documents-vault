import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANONYMOUS,
  createDb,
  createPool,
  withPrincipal,
  withScope,
  withSystem,
  type Actor,
  type Db,
  type Scope,
} from './client.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * The database is told who is asking (5.5). Nothing reads these settings
 * yet — the policies that answer each kind of caller come next — so what
 * is tested here is that they are said, and that they end with the
 * transaction that said them.
 */

const SETTINGS = [
  'app.household_id',
  'app.actor',
  'app.account_id',
  'app.member_id',
  'app.role',
  'app.share_id',
  'app.upload_request_id',
] as const;
type Settings = Record<(typeof SETTINGS)[number], string | null>;

async function settings(executor: Db): Promise<Settings> {
  const r = await sql<Settings>`select
    current_setting('app.household_id', true) as "app.household_id",
    current_setting('app.actor', true) as "app.actor",
    current_setting('app.account_id', true) as "app.account_id",
    current_setting('app.member_id', true) as "app.member_id",
    current_setting('app.role', true) as "app.role",
    current_setting('app.share_id', true) as "app.share_id",
    current_setting('app.upload_request_id', true) as "app.upload_request_id"`.execute(executor);
  return r.rows[0] as Settings;
}

/** Unset reads as null on a fresh connection and as '' once a transaction has set it. */
const none = (s: Settings) =>
  Object.fromEntries(SETTINGS.map((k) => [k, s[k] === '' ? null : s[k]])) as Settings;

const blank: Settings = Object.fromEntries(SETTINGS.map((k) => [k, null])) as Settings;

describe('a scope says who it is for', () => {
  it('a scope with no actor does not compile', () => {
    // @ts-expect-error the actor is required
    const scope: Scope = { householdId: randomUUID() };
    expect(scope.actor).toBeUndefined();
  });
});

describe.skipIf(!testAdminUrl())('the actor', () => {
  let tdb: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    // One connection: whoever asks next is certainly given the same one.
    db = createDb(createPool(tdb.appUrl, 1));
  });
  afterAll(async () => {
    await db.destroy();
    await tdb.drop();
  });

  const hh = randomUUID();
  const accountId = randomUUID();
  const memberId = randomUUID();
  const shareId = randomUUID();
  const requestId = randomUUID();
  const cases: Array<[Actor, Partial<Settings>]> = [
    [
      { kind: 'account', accountId, memberId, role: 'teen' },
      {
        'app.actor': 'account',
        'app.account_id': accountId,
        'app.member_id': memberId,
        'app.role': 'teen',
      },
    ],
    [{ kind: 'system' }, { 'app.actor': 'system' }],
    [
      { kind: 'link', shareId },
      { 'app.actor': 'link', 'app.share_id': shareId },
    ],
    [
      { kind: 'upload', requestId },
      { 'app.actor': 'upload', 'app.upload_request_id': requestId },
    ],
    [ANONYMOUS, { 'app.actor': 'anonymous' }],
  ];

  it("the settings end with the transaction; the pooled connection's next user sees none", async () => {
    for (const [actor, said] of cases) {
      const inside = await withScope(db, { householdId: hh, actor }, (trx) => settings(trx));
      expect(none(inside), actor.kind).toEqual({ ...blank, 'app.household_id': hh, ...said });

      // Same pool, one connection, next borrower: nothing is left.
      expect(none(await settings(db)), actor.kind).toEqual(blank);
    }
  });

  it('withPrincipal is the account, and withSystem the vault itself', async () => {
    const p = { householdId: hh, accountId, memberId, role: 'viewer' as const };
    expect(none(await withPrincipal(db, p, (trx) => settings(trx)))).toEqual({
      ...blank,
      'app.household_id': hh,
      'app.actor': 'account',
      'app.account_id': accountId,
      'app.member_id': memberId,
      'app.role': 'viewer',
    });
    expect(none(await withSystem(db, hh, (trx) => settings(trx)))).toEqual({
      ...blank,
      'app.household_id': hh,
      'app.actor': 'system',
    });
    expect(none(await settings(db))).toEqual(blank);
  });

  it('a sign-in not yet in a household is anonymous, and sees its own memberships', async () => {
    const inside = await withScope(db, { accountId, actor: ANONYMOUS }, (trx) => settings(trx));
    expect(none(inside)).toEqual({
      ...blank,
      'app.actor': 'anonymous',
      'app.account_id': accountId,
    });
  });

  it('a value left on the connection itself does not show through', async () => {
    // Nothing in the vault sets one; if something ever did, a scope still
    // says everything for itself.
    await sql`select set_config('app.role', 'owner', false), set_config('app.member_id', ${memberId}, false)`.execute(
      db,
    );
    try {
      const inside = await withSystem(db, hh, (trx) => settings(trx));
      expect(none(inside)).toEqual({ ...blank, 'app.household_id': hh, 'app.actor': 'system' });
    } finally {
      await sql`select set_config('app.role', '', false), set_config('app.member_id', '', false)`.execute(
        db,
      );
    }
  });

  it('a failed transaction takes its settings with it', async () => {
    await expect(
      withSystem(db, hh, async () => {
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(none(await settings(db))).toEqual(blank);
  });
});
