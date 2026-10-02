import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  createPool,
  withPrincipal,
  withScope,
  withSystem,
  type Db,
  type Role,
} from './client.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0045 (5.24): what a document removed for good leaves behind,
 * and who may ask for one to be removed — held by the database itself, not
 * only by the API.
 *
 *  - A tombstone is read by the family and the vault, by nobody else; it
 *    is written by an owner, of a document in the Trash, saying what the
 *    row says, and at least every collection's link its snapshot names;
 *    and never changed or removed.
 *  - A request to remove is an owner's, in their own name and now; only of
 *    a document in the Trash; and bringing it back must clear it.
 */
describe.skipIf(!testAdminUrl())('migration 0045: removing a document for good', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let db: Db;
  const hh = randomUUID();
  const member = { owner: randomUUID(), adult: randomUUID() };
  const account = { owner: randomUUID(), adult: randomUUID() };
  const doc = { trashed: randomUUID(), live: randomUUID(), linked: randomUUID() };
  /** A collection's link whose snapshot names doc.linked. */
  let shareId = '';

  const as = (who: 'owner' | 'adult', role: Role = who) => ({
    householdId: hh,
    accountId: account[who],
    memberId: member[who],
    role,
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    db = createDb(createPool(tdb.appUrl, 2));
    await admin.query("insert into household (id, name) values ($1, 'Tombstones')", [hh]);
    await admin.query(
      `insert into member (id, household_id, display_name) values ($1, $3, 'Owner'), ($2, $3, 'Adult')`,
      [member.owner, member.adult, hh],
    );
    await admin.query('insert into account (id, email) values ($1, $3), ($2, $4)', [
      account.owner,
      account.adult,
      `owner-${hh}@example.test`,
      `adult-${hh}@example.test`,
    ]);
    await admin.query(
      `insert into account_household (account_id, household_id, member_id, role)
       values ($1, $3, $4, 'owner'), ($2, $3, $5, 'adult')`,
      [account.owner, account.adult, hh, member.owner, member.adult],
    );
    await admin.query(
      `insert into document (id, household_id, title, visibility, owner_member_id, created_by, deleted_at)
       values ($1, $4, 'In the Trash', 'adults', $5, $6, now()),
              ($2, $4, 'Out of it', 'household', null, $6, null),
              ($3, $4, 'Shared, in the Trash', 'household', null, $6, now())`,
      [doc.trashed, doc.live, doc.linked, hh, member.adult, account.adult],
    );
    // A collection's link whose snapshot names the third.
    const c = await admin.query<{ id: string }>(
      `insert into doc_collection (household_id, name, audience, owner_member_id)
       values ($1, 'Linked', 'everyone', $2) returning id`,
      [hh, member.owner],
    );
    const collection = c.rows[0]?.id;
    await admin.query(
      'insert into doc_collection_item (collection_id, document_id, household_id, position) values ($1, $2, $3, 1)',
      [collection, doc.linked, hh],
    );
    const l = await admin.query<{ id: string }>(
      `insert into share_link (household_id, collection_id, token_hash, created_by, expires_at, flow)
       values ($1, $2, $3, $4, now() + interval '7 days', 'v2') returning id`,
      [hh, collection, randomBytes(32), account.owner],
    );
    await admin.query(
      `insert into share_link_item (share_id, household_id, collection_id, document_id, position)
       values ($1, $2, $3, $4, 1)`,
      [l.rows[0]?.id, hh, collection, doc.linked],
    );
    shareId = l.rows[0]?.id as string;
  });
  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  const tombstoneOf = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    household_id: hh,
    visibility: 'adults' as const,
    owner_member_id: member.adult,
    ...over,
  });

  it('an owner writes the tombstone of a document in the Trash, as its row says, and nobody changes or removes it', async () => {
    // Not as the row says, or of a document out of the Trash: refused.
    for (const [why, row] of [
      ['another visibility', tombstoneOf(doc.trashed, { visibility: 'household' })],
      ['another owner', tombstoneOf(doc.trashed, { owner_member_id: member.owner })],
      [
        'out of the Trash',
        tombstoneOf(doc.live, { visibility: 'household', owner_member_id: null }),
      ],
      ['nothing at all', tombstoneOf(randomUUID())],
    ] as const) {
      await expect(
        withPrincipal(db, as('owner'), (trx) =>
          trx.insertInto('document_tombstone').values(row).execute(),
        ),
        why,
      ).rejects.toThrow(/row-level security/);
    }
    // By an adult: refused, however true.
    await expect(
      withPrincipal(db, as('adult'), (trx) =>
        trx.insertInto('document_tombstone').values(tombstoneOf(doc.trashed)).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    // By an owner, true: written.
    await withPrincipal(db, as('owner'), (trx) =>
      trx.insertInto('document_tombstone').values(tombstoneOf(doc.trashed)).execute(),
    );
    // Never changed or removed, by anybody the vault speaks as.
    await expect(
      withPrincipal(db, as('owner'), (trx) =>
        trx
          .updateTable('document_tombstone')
          .set({ visibility: 'household' })
          .where('id', '=', doc.trashed)
          .execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withSystem(db, hh, (trx) =>
        trx.deleteFrom('document_tombstone').where('id', '=', doc.trashed).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("a tombstone names at least every collection's link its snapshot names", async () => {
    await expect(
      withPrincipal(db, as('owner'), (trx) =>
        trx
          .insertInto('document_tombstone')
          .values(tombstoneOf(doc.linked, { visibility: 'household', owner_member_id: null }))
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await withPrincipal(db, as('owner'), (trx) =>
      trx
        .insertInto('document_tombstone')
        .values({
          ...tombstoneOf(doc.linked, { visibility: 'household', owner_member_id: null }),
          link_ids: [shareId, randomUUID()],
        } as never)
        .execute(),
    );
  });

  it('the family and the vault read tombstones; a link, an upload link, a signed-out page and nobody read none', async () => {
    const read = (trx: Db) => trx.selectFrom('document_tombstone').select('id').execute();
    expect((await withPrincipal(db, as('adult'), read)).length).toBeGreaterThan(0);
    expect((await withSystem(db, hh, read)).length).toBeGreaterThan(0);
    for (const actor of [
      { kind: 'link' as const, shareId },
      { kind: 'upload' as const, requestId: randomUUID() },
      { kind: 'anonymous' as const },
    ]) {
      expect(await withScope(db, { householdId: hh, actor }, read), actor.kind).toEqual([]);
      await expect(
        withScope(db, { householdId: hh, actor }, (trx) =>
          trx.insertInto('document_tombstone').values(tombstoneOf(randomUUID())).execute(),
        ),
        actor.kind,
      ).rejects.toThrow(/row-level security/);
    }
    // Nor another household.
    expect(await withPrincipal(db, { ...as('owner'), householdId: randomUUID() }, read)).toEqual(
      [],
    );
  });

  it('only an owner asks to remove a document, in their own name and now, and only of one in the Trash', async () => {
    const ask = (who: 'owner' | 'adult', id: string, by: string, at = 'now()') =>
      withPrincipal(db, as(who), async (trx) => {
        await sql`update document set purge_requested_at = ${sql.raw(at)}, purge_requested_by = ${by}::uuid
                  where id = ${id}::uuid`.execute(trx);
      });
    const fresh = randomUUID();
    await admin.query(
      `insert into document (id, household_id, title, created_by, deleted_at)
       values ($1, $2, 'Asked about', $3, now())`,
      [fresh, hh, account.adult],
    );
    await expect(ask('adult', fresh, account.adult)).rejects.toThrow(/only an owner asks/);
    await expect(ask('owner', fresh, account.adult)).rejects.toThrow(/only an owner asks/);
    await expect(ask('owner', fresh, account.owner, "now() - interval '2 days'")).rejects.toThrow(
      /only an owner asks/,
    );
    await expect(ask('owner', doc.live, account.owner)).rejects.toThrow(
      /document_purge_request_in_trash/,
    );
    await ask('owner', fresh, account.owner);
    const { rows } = await admin.query('select purge_requested_by from document where id = $1', [
      fresh,
    ]);
    expect(rows).toEqual([{ purge_requested_by: account.owner }]);
    // Brought back by whoever may: only with the request cleared.
    await expect(
      admin.query('update document set deleted_at = null where id = $1', [fresh]),
    ).rejects.toThrow(/document_purge_request_in_trash/);
    await withPrincipal(db, as('adult'), (trx) =>
      trx
        .updateTable('document')
        .set({ deleted_at: null, purge_requested_at: null, purge_requested_by: null })
        .where('id', '=', fresh)
        .execute(),
    );
  });
});
