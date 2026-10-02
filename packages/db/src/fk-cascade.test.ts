import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * A document removed for good (5.24) is one `delete`: every row that names
 * it goes with it, by its foreign key. A table added later that names a
 * document without cascading would make that delete fail, or leave a row
 * pointing at nothing — so each is held to it here, from the catalogue
 * itself, as the database has them.
 */
describe.skipIf(!testAdminUrl())('foreign keys to a document', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
  });
  afterAll(async () => {
    await admin.end();
    await tdb.drop();
  });

  /** Every foreign key to a table: from where, and what a delete of the row does to it. */
  const keysTo = async (table: string) =>
    (
      await admin.query<{ name: string; from_table: string; on_delete: string }>(
        `select c.conname as name, c.conrelid::regclass::text as from_table,
                c.confdeltype as on_delete
           from pg_constraint c
          where c.contype = 'f' and c.confrelid = $1::regclass
          order by 2, 1`,
        [`public.${table}`],
      )
    ).rows;

  it('every foreign key to document cascades', async () => {
    const keys = await keysTo('document');
    // The tables of 0006 to 0042 that name a document, at the least.
    expect(new Set(keys.map((k) => k.from_table))).toEqual(
      new Set([
        'document_version',
        'upload_idempotency',
        'document_link',
        'document_text',
        'document_text_sealed',
        'reminder',
        'share_link',
        'private_notice',
        'doc_collection_item',
        'share_session_use',
        'share_page',
        'share_link_item',
        'share_page_failure',
      ]),
    );
    // 'c': on delete cascade.
    expect(keys.filter((k) => k.on_delete !== 'c')).toEqual([]);
  });

  it("every foreign key to a document's version cascades", async () => {
    const keys = await keysTo('document_version');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => k.on_delete !== 'c')).toEqual([]);
  });

  it('every table that names a document by its id has a foreign key to it that cascades; only the tombstone outlives it', async () => {
    // A column called document_id with no key to the document at all would
    // pass the tests above and still point at nothing once it is removed.
    const { rows } = await admin.query<{ table_name: string }>(
      `select a.attrelid::regclass::text as table_name
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and a.attname = 'document_id' and not a.attisdropped
          and not exists (
            select 1 from pg_constraint k
             where k.contype = 'f' and k.conrelid = a.attrelid
               and k.confrelid = 'public.document'::regclass
               and k.confdeltype = 'c'
               and a.attnum = any(k.conkey))
        order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
    // The tombstone names its document by its own id, and no key: it is
    // what is left once the document is not.
    const tombstone = await admin.query(
      `select 1 from pg_constraint where conrelid = 'public.document_tombstone'::regclass
          and contype = 'f' and confrelid = 'public.document'::regclass`,
    );
    expect(tombstone.rowCount).toBe(0);
  });
});
