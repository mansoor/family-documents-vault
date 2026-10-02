import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit, verifyAuditChain } from './audit.js';
import {
  createDb,
  createPool,
  withPrincipal,
  withScope,
  withSystem,
  type Db,
  type ScopePrincipal,
} from './client.js';
import { listMigrations, migrateUp } from './migrate.js';
import { createEmptyDatabase, testAdminUrl, type TestDatabase } from './testing.js';

/**
 * Migration 0039: lists are called collections (5.17b, A70). Renamed in
 * place, not copied: every row keeps its id and every item its place, and
 * the rules, the trigger and the grants 0036 gave the tables go on doing
 * what they did, under their new names. The activity log is not touched.
 */
describe.skipIf(!testAdminUrl())('migration 0039: lists are called collections', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let app: Db;
  let dir: string;
  const hh = randomUUID();
  /** The owner; an adult; and somebody whose sign-in has gone. */
  const member = { owner: randomUUID(), adult: randomUUID(), gone: randomUUID() };
  const account = { owner: randomUUID(), adult: randomUUID() };
  const docs = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  /** For everyone, by the owner; the adult's Only me; and one nobody may change. */
  const made = { everyone: randomUUID(), onlyMe: randomUUID(), stranded: randomUUID() };
  let lists: Array<Record<string, unknown>> = [];
  let items: Array<Record<string, unknown>> = [];
  let log: Array<Record<string, unknown>> = [];

  const as = (who: 'owner' | 'adult'): ScopePrincipal => ({
    householdId: hh,
    accountId: account[who],
    memberId: member[who],
    role: who,
  });

  beforeAll(async () => {
    tdb = await createEmptyDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    // 0.5.16's schema: lists, in doc_list and doc_list_item.
    dir = await mkdtemp(path.join(tmpdir(), 'fdv-0038-'));
    for (const m of await listMigrations()) {
      if (m.version <= 38) await copyFile(m.file, path.join(dir, path.basename(m.file)));
    }
    await migrateUp(admin, dir);
    app = createDb(createPool(tdb.appUrl, 2));

    await admin.query("insert into household (id, name) values ($1, 'Renamed')", [hh]);
    await admin.query(
      `insert into member (id, household_id, display_name)
       values ($1, $4, 'Owner'), ($2, $4, 'Adult'), ($3, $4, 'Gone')`,
      [member.owner, member.adult, member.gone, hh],
    );
    await admin.query(`insert into account (id, email) values ($1, $3), ($2, $4)`, [
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
    for (const [i, id] of docs.entries()) {
      await admin.query(`insert into document (id, household_id, title) values ($1, $2, $3)`, [
        id,
        hh,
        `Paper ${i}`,
      ]);
    }
    await admin.query(
      `insert into doc_list (id, household_id, name, description, audience, owner_member_id, created_by)
       values ($1, $4, 'For the broker', 'Before the move', 'everyone', $5, $7),
              ($2, $4, 'Divorce', null, 'only_me', $6, $8),
              ($3, $4, 'Nobody''s now', null, 'everyone', $9, null)`,
      [
        made.everyone,
        made.onlyMe,
        made.stranded,
        hh,
        member.owner,
        member.adult,
        account.owner,
        account.adult,
        member.gone,
      ],
    );
    // Put there out of the order of their ids, so the order kept is the
    // order they were put there.
    await admin.query(
      `insert into doc_list_item (list_id, document_id, household_id, added_by, position)
       values ($1, $4, $3, $6, 1), ($1, $5, $3, $6, 2), ($1, $7, $3, $6, 3),
              ($2, $5, $3, null, 1), ($8, $4, $3, null, 1)`,
      [made.everyone, made.onlyMe, hh, docs[2], docs[0], account.owner, docs[3], made.stranded],
    );
    // Lines about a list, as 0.5.12 to 0.5.16 wrote them.
    await withSystem(app, hh, async (trx) => {
      await appendAudit(trx, {
        householdId: hh,
        actorAccountId: account.owner,
        action: 'list.created',
        objectType: 'list',
        objectId: made.everyone,
      });
      await appendAudit(trx, {
        householdId: hh,
        actorAccountId: account.owner,
        action: 'list.item_added',
        objectType: 'document',
        objectId: docs[2],
        detail: { list_id: made.everyone },
      });
    });

    const rows = async (text: string) => (await admin.query<Record<string, unknown>>(text)).rows;
    lists = await rows('select * from doc_list order by id');
    items = await rows('select * from doc_list_item order by list_id, position');
    log = await rows('select * from audit_event order by id');
    expect(lists).toHaveLength(3);
    expect(items).toHaveLength(5);

    await migrateUp(admin);
  }, 60_000);
  afterAll(async () => {
    await app?.destroy();
    await admin?.end();
    await tdb?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('rows, ids and item order survive the rename; the policies and triggers keep working under their new names', async () => {
    // Every row, column for column, by its own id; every item in its place.
    expect((await admin.query('select * from doc_collection order by id')).rows).toEqual(lists);
    expect(
      (await admin.query('select * from doc_collection_item order by collection_id, position'))
        .rows,
    ).toEqual(items.map(({ list_id, ...rest }) => ({ collection_id: list_id, ...rest })));
    const order = await admin.query<{ document_id: string }>(
      'select document_id from doc_collection_item where collection_id = $1 order by position',
      [made.everyone],
    );
    expect(order.rows.map((r) => r.document_id)).toEqual([docs[2], docs[0], docs[3]]);

    // Everything named for them has their new name, and nothing the old one.
    const { rows: rules } = await admin.query<{ name: string; tbl: string; restrictive: boolean }>(
      `select polname::text as name, polrelid::regclass::text as tbl, not polpermissive as restrictive
         from pg_policy
        where polrelid in ('doc_collection'::regclass, 'doc_collection_item'::regclass)`,
    );
    const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : 1);
    expect(rules.sort(byName)).toEqual([
      { name: 'doc_collection_actor', tbl: 'doc_collection', restrictive: true },
      // 0042's (5.19): a collection's link reads, and nobody but the family
      // and the vault writes.
      { name: 'doc_collection_actor_insert', tbl: 'doc_collection', restrictive: true },
      { name: 'doc_collection_changes', tbl: 'doc_collection', restrictive: true },
      { name: 'doc_collection_item_actor', tbl: 'doc_collection_item', restrictive: true },
      { name: 'doc_collection_item_actor_delete', tbl: 'doc_collection_item', restrictive: true },
      { name: 'doc_collection_item_actor_insert', tbl: 'doc_collection_item', restrictive: true },
      { name: 'doc_collection_item_actor_update', tbl: 'doc_collection_item', restrictive: true },
      { name: 'doc_collection_item_collection', tbl: 'doc_collection_item', restrictive: true },
      { name: 'doc_collection_item_tenant', tbl: 'doc_collection_item', restrictive: false },
      { name: 'doc_collection_only_me', tbl: 'doc_collection', restrictive: true },
      { name: 'doc_collection_tenant', tbl: 'doc_collection', restrictive: false },
    ]);
    const { rows: named } = await admin.query<{ names: string[] }>(
      `select array(
         select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname like 'doc\\_collection%'
         union all
         select conname::text from pg_constraint where conname like 'doc\\_collection%'
       ) as names`,
    );
    // A primary key and a unique constraint are each a constraint and an index.
    const names = [
      'doc_collection',
      'doc_collection_audience_check',
      'doc_collection_created_by_fkey',
      'doc_collection_description_check',
      'doc_collection_household_id_fkey',
      'doc_collection_household_idx',
      'doc_collection_id_household_id_key',
      'doc_collection_id_household_id_key',
      'doc_collection_item',
      'doc_collection_item_added_by_fkey',
      'doc_collection_item_collection_id_household_id_fkey',
      'doc_collection_item_document_id_household_id_fkey',
      'doc_collection_item_document_idx',
      'doc_collection_item_household_id_fkey',
      'doc_collection_item_pkey',
      'doc_collection_item_pkey',
      'doc_collection_name_check',
      'doc_collection_only_me_owner',
      'doc_collection_owner_member_id_fkey',
      'doc_collection_pkey',
      'doc_collection_pkey',
    ];
    expect(named[0]?.names.sort()).toEqual(names.sort());
    const { rows: guard } = await admin.query(
      `select t.tgname::text as name, t.tgrelid::regclass::text as tbl, p.proname::text as fn
         from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where not t.tgisinternal and t.tgrelid = 'doc_collection'::regclass`,
    );
    expect(guard).toEqual([
      {
        name: 'doc_collection_owner_writes',
        tbl: 'doc_collection',
        fn: 'doc_collection_owner_writes',
      },
    ]);
    const { rows: gone } = await admin.query(
      `select to_regclass('public.doc_list') as list, to_regclass('public.doc_list_item') as item,
              to_regprocedure('public.list_audience_has(text, text)') as has,
              to_regprocedure('public.doc_list_stranded(uuid, text)') as stranded,
              has_function_privilege('fdv_app', 'public.doc_collection_stranded(uuid, text)',
                                     'execute') as may_ask,
              has_table_privilege('fdv_app', 'public.doc_collection', 'delete') as may_delete`,
    );
    expect(gone).toEqual([
      { list: null, item: null, has: null, stranded: null, may_ask: true, may_delete: false },
    ]);

    // Who is given what, as the application asks: the adult's Only me
    // collection is the adult's alone, and so is what is in it.
    const given = (scope: Parameters<typeof withScope>[1]) =>
      withScope(app, scope, async (trx) => ({
        collections: (
          await trx.selectFrom('doc_collection').select('id').orderBy('id').execute()
        ).map((r) => r.id),
        items: (await trx.selectFrom('doc_collection_item').select('collection_id').execute())
          .length,
      }));
    const sorted = (...ids: string[]) => [...ids].sort();
    const signedIn = (who: 'owner' | 'adult') => {
      const p = as(who);
      return {
        householdId: hh,
        actor: {
          kind: 'account' as const,
          accountId: p.accountId,
          memberId: p.memberId,
          role: p.role,
        },
      };
    };
    expect(await given(signedIn('owner'))).toEqual({
      collections: sorted(made.everyone, made.stranded),
      items: 4,
    });
    expect(await given(signedIn('adult'))).toEqual({
      collections: sorted(made.everyone, made.onlyMe, made.stranded),
      items: 5,
    });
    expect(await given({ householdId: hh, actor: { kind: 'anonymous' } })).toEqual({
      collections: [],
      items: 0,
    });

    // Nobody hands a collection on, its maker included…
    await expect(
      withPrincipal(app, as('adult'), (trx) =>
        trx
          .updateTable('doc_collection')
          .set({ owner_member_id: member.owner })
          .where('id', '=', made.onlyMe)
          .execute(),
      ),
    ).rejects.toThrow(/a collection keeps its maker and its household/);
    // …an owner changes nothing of one whose maker has gone but that it is
    // deleted, and nobody takes a row away outright.
    await expect(
      withPrincipal(app, as('owner'), (trx) =>
        trx
          .updateTable('doc_collection')
          .set({ name: 'Taken' })
          .where('id', '=', made.stranded)
          .execute(),
      ),
    ).rejects.toThrow(/only its maker changes a collection/);
    const adult = await withPrincipal(app, as('adult'), async (trx) =>
      Number(
        (
          await trx
            .updateTable('doc_collection')
            .set({ deleted_at: new Date() })
            .where('id', '=', made.everyone)
            .executeTakeFirst()
        ).numUpdatedRows,
      ),
    );
    expect(adult).toBe(0);
    const marked = await withPrincipal(app, as('owner'), async (trx) =>
      Number(
        (
          await trx
            .updateTable('doc_collection')
            .set({ deleted_at: new Date() })
            .where('id', '=', made.stranded)
            .executeTakeFirst()
        ).numUpdatedRows,
      ),
    );
    expect(marked).toBe(1);
    await expect(
      withPrincipal(app, as('owner'), (trx) =>
        trx.deleteFrom('doc_collection').where('id', '=', made.everyone).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    // Nothing is put in a collection the caller is not given.
    await expect(
      withPrincipal(app, as('owner'), (trx) =>
        trx
          .insertInto('doc_collection_item')
          .values({
            collection_id: made.onlyMe,
            document_id: docs[1] as string,
            household_id: hh,
            position: 2,
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('the audit chain still verifies after the rename', async () => {
    // Not a row of the log was rewritten: its lines about a list are as
    // they were written, and the chain through them holds.
    expect((await admin.query('select * from audit_event order by id')).rows).toEqual(log);
    const chain = await withSystem(app, hh, (trx) => verifyAuditChain(trx, hh));
    expect(chain).toEqual({ ok: true, checked: 2 });
    // And it goes on: a line written now follows them.
    await withSystem(app, hh, (trx) =>
      appendAudit(trx, {
        householdId: hh,
        actorAccountId: account.owner,
        action: 'collection.renamed',
        objectType: 'collection',
        objectId: made.everyone,
      }),
    );
    expect(await withSystem(app, hh, (trx) => verifyAuditChain(trx, hh))).toEqual({
      ok: true,
      checked: 3,
    });
  });
});
