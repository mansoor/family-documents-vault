import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * A document removed for good (5.24) is one `delete`: every row that names
 * it goes with it, by its foreign key. A table added later that names a
 * document without cascading would make that delete fail, or leave a row
 * pointing at nothing — so each is held to it here, from the catalogue
 * itself, as the database has them.
 *
 * A file sent through a request and filed (0044, 5.21) goes with the
 * document it became too (0047, 5.23): until then it kept its place in the
 * request's history and forgot where it went (`on delete set null`), and
 * with it the sender's name for it and their note — something of a document
 * removed for good. None outlives it now.
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
    // The tables of 0006 to 0044 that name a document, at the least.
    expect(new Set(keys.map((k) => k.from_table))).toEqual(
      new Set([
        'incoming_file',
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
        // A version filed through review (0074, R0): goes with its document.
        'review_filing',
        // Another document, replaced by it (0082, 0.9.0): see below.
        'document',
        // A document a Reading check sent to an AI reader (0092, AIR3).
        'ai_reader_send',
        // A caregiver's look at it (0098, H1b): goes with it.
        'caregiver_view',
        // A paper pinned into somebody's folder (0099, C2): goes with it.
        'cabinet_pin',
        // A create's Idempotency-Key (0100, 0.9.0-dev.45): goes with what it
        // made; a later try under it makes a new one.
        'create_idempotency',
        // What a connected app sent (0109, APP1): lets go of the id alone.
        'connected_app_intake',
        // A connected app's link (0111, APP3): nothing without its document,
        // so it goes with it.
        'connected_app_link',
        // Somebody's open of it, for Home's Recent (0132, 0.9.0-dev.102):
        // goes with it.
        'document_recent_open',
        // When each of its tags was put on it (0133, 0.9.0-dev.103): goes
        // with it.
        'document_tag_use',
      ]),
    );
    // 'c': on delete cascade, every one — but a document no longer needed,
    // replaced by this one, which stays: only the link goes ('n', set null);
    // and what a connected app sent, which keeps it from being filed twice.
    expect(
      keys.filter((k) => k.on_delete !== 'c').sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      {
        name: 'connected_app_intake_document_id_household_id_fkey',
        from_table: 'connected_app_intake',
        on_delete: 'n',
      },
      { name: 'document_replaced_by_fkey', from_table: 'document', on_delete: 'n' },
    ]);
  });

  it("every foreign key to a document's version cascades", async () => {
    const keys = await keysTo('document_version');
    expect(keys.map((k) => k.from_table)).toContain('incoming_file');
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
    // What a connected app sent outlives what it became (0.9.0, APP1): it
    // keeps a send from being filed twice. Its key lets go of the id alone.
    // And a connected app's feed (0.9.0, APP2): what it was told of a
    // document, and its lines, are what tell it the document is no longer
    // available — a document removed for good included — so they name it by
    // its id alone, with no key, and the worker lets them go after 90 days.
    expect(rows.map((r) => r.table_name)).toEqual([
      'connected_app_change',
      'connected_app_intake',
      'connected_app_seen',
    ]);
    const feed = await admin.query(
      `select 1 from pg_constraint
        where conrelid in ('public.connected_app_change'::regclass, 'public.connected_app_seen'::regclass)
          and contype = 'f' and confrelid = 'public.document'::regclass`,
    );
    expect(feed.rowCount).toBe(0);
    const intake = await admin.query<{ on_delete: string }>(
      `select confdeltype as on_delete from pg_constraint
        where conrelid = 'public.connected_app_intake'::regclass
          and contype = 'f' and confrelid = 'public.document'::regclass`,
    );
    expect(intake.rows).toEqual([{ on_delete: 'n' }]);
    // The tombstone names its document by its own id, and no key: it is
    // what is left once the document is not.
    const tombstone = await admin.query(
      `select 1 from pg_constraint where conrelid = 'public.document_tombstone'::regclass
          and contype = 'f' and confrelid = 'public.document'::regclass`,
    );
    expect(tombstone.rowCount).toBe(0);
  });
});
