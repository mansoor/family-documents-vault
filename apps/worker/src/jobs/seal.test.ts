import { randomUUID } from 'node:crypto';
import { EnvKeyProvider, openPrivate, ScopeKeys } from '@fdv/crypto';
import { createPool, withSystem, type Db, type Schema } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshStatus } from './reminders.js';
import { sealPrivateValues } from './seal.js';

const MASTER = 'worker-test-master-key-with-32-bytes-or-more';

/**
 * private.seal (0.5.8): the notes and details of documents that were Only
 * me before 0.5.8, sealed under their owner's key, one document per
 * transaction, the plain columns emptied. Nobody edited anything, so no
 * document's updated_at moves.
 */
describe.skipIf(!testAdminUrl())('the private.seal job', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let db: Db;
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const hh = randomUUID();
  const members: Record<'mansoor' | 'sana' | 'rahul', string> = {
    mansoor: '',
    sana: '',
    rahul: '',
  };
  const ids: Record<'car' | 'box' | 'noNumber' | 'binned' | 'shared' | 'rahuls', string> = {
    car: '',
    box: '',
    noNumber: '',
    binned: '',
    shared: '',
    rahuls: '',
  };
  /** A type of the household's own, whose box number is required. */
  const boxType = 'h_sealedbox2';
  const boxNumber = 'h_boxnumber2';
  const branch = 'h_branchname';
  /** Every transaction the job opens, by the household it says it is for. */
  const opened: unknown[] = [];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    db = new Kysely<Schema>({
      dialect: new PostgresDialect({ pool: createPool(tdb.appUrl, 2) }),
      log(event) {
        if (event.level === 'query' && event.query.sql.includes("set_config('app.actor'")) {
          opened.push(event.query.parameters[0]);
        }
      },
    });
    await admin.query("insert into household (id, name, timezone) values ($1, 'Seal', 'UTC')", [
      hh,
    ]);
    await admin.query(
      `insert into document_type (key, label, category, household_id, fields)
       values ($1, 'Safe deposit box', 'financial', $2, $3)`,
      [
        boxType,
        hh,
        JSON.stringify([
          { key: boxNumber, label: 'Box number', kind: 'text', required: true },
          { key: branch, label: 'Branch', kind: 'text', required: false },
        ]),
      ],
    );
    for (const name of Object.keys(members) as Array<keyof typeof members>) {
      members[name] = (
        await admin.query<{ id: string }>(
          'insert into member (household_id, display_name) values ($1, $2) returning id',
          [hh, name],
        )
      ).rows[0]?.id as string;
    }
    await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      for (const m of Object.values(members)) await keys.mintMemberKey(trx, hh, m, null);
      // As 0.5.7 left them: an Only me document's notes and details plain.
      const doc = async (values: Record<string, unknown>) =>
        (
          await trx
            .insertInto('document')
            .values({
              household_id: hh,
              owner_member_id: members.mansoor,
              visibility: 'private',
              updated_at: new Date('2026-01-02T03:04:05Z'),
              ...(values as Record<string, never>),
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      ids.car = await doc({
        title: 'My car',
        type_key: 'vehicle_registration',
        expires_on: '2031-03-31',
        expires_precision: 'month',
        notes: 'Spare key under the geranium pot',
        extra: JSON.stringify({ vin: 'OLDVIN0000000001', plate: 'OL12 DPL' }),
      });
      ids.box = await doc({
        title: 'Bank box',
        type_key: boxType,
        extra: JSON.stringify({ [boxNumber]: '0413', [branch]: 'High Street' }),
      });
      ids.noNumber = await doc({
        title: 'Other bank box',
        type_key: boxType,
        extra: JSON.stringify({ [branch]: 'Market Square' }),
      });
      ids.binned = await doc({
        title: 'In the bin',
        owner_member_id: members.sana,
        notes: 'Still in every backup',
        deleted_at: new Date(),
      });
      ids.shared = await doc({ title: 'Family notes', visibility: 'household', notes: 'Shared' });
      ids.rahuls = await doc({ title: "Rahul's", owner_member_id: members.rahul, notes: 'Rahul' });
    });
  }, 60_000);
  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  const row = (id: string) =>
    withSystem(db, hh, (trx) =>
      trx
        .selectFrom('document')
        .select([
          'notes',
          'extra',
          'notes_sealed',
          'extra_sealed',
          'sealed_details',
          'updated_at',
          'status_cache',
        ])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
  const openedFor = async (id: string, member: string) => {
    const r = await row(id);
    const key = await withSystem(db, hh, (trx) =>
      keys.unwrap(trx, { householdId: hh, kind: 'member', memberId: member }),
    );
    return openPrivate(key.key, id, r);
  };

  it('seals every Only me document, one document per transaction, and a failure stops only its own', async () => {
    // Rahul's key will not unwrap: his document cannot be sealed.
    const { rows } = await admin.query<{ key_wrapped: Buffer }>(
      'select key_wrapped from scope_key where member_id = $1',
      [members.rahul],
    );
    const good = rows[0]?.key_wrapped as Buffer;
    await admin.query('update scope_key set key_wrapped = $1 where member_id = $2', [
      Buffer.from(good).fill(7, 20),
      members.rahul,
    ]);
    const log: Array<Record<string, unknown>> = [];
    opened.length = 0;
    const r = await sealPrivateValues({
      admin,
      app: db,
      keys,
      log: (level, msg, extra) => log.push({ level, msg, ...extra }),
    });
    // What went wrong comes back too, for a restore to say (5.9 review).
    expect(r).toEqual({
      sealed: 4,
      failed: 1,
      firstError: 'cannot unwrap key: wrong wrapping key or binding',
    });
    // A transaction of its own for each of the five, all in their household.
    expect(opened).toEqual([hh, hh, hh, hh, hh]);
    expect(log).toMatchObject([{ level: 'error', document_id: ids.rahuls }]);

    // Sealed, the plain columns emptied, and nobody's edit.
    const car = await row(ids.car);
    expect(car).toMatchObject({ notes: null, extra: {} });
    expect([...car.sealed_details].sort()).toEqual(['plate', 'vin']);
    expect(car.updated_at.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(await openedFor(ids.car, members.mansoor)).toEqual({
      notes: 'Spare key under the geranium pot',
      extra: { vin: 'OLDVIN0000000001', plate: 'OL12 DPL' },
    });
    // In the bin too, under its own owner's key.
    expect((await row(ids.binned)).notes).toBeNull();
    expect((await openedFor(ids.binned, members.sana)).notes).toBe('Still in every backup');
    // The family's is not touched; Rahul's is as it was, and the rest stay done.
    expect(await row(ids.shared)).toMatchObject({ notes: 'Shared', notes_sealed: null });
    expect(await row(ids.rahuls)).toMatchObject({ notes: 'Rahul', notes_sealed: null });

    // Once his key is right again, the next run seals his, and only his.
    await admin.query('update scope_key set key_wrapped = $1 where member_id = $2', [
      good,
      members.rahul,
    ]);
    expect(await sealPrivateValues({ admin, app: db, keys, log: () => undefined })).toEqual({
      sealed: 1,
      failed: 0,
    });
    expect((await openedFor(ids.rahuls, members.rahul)).notes).toBe('Rahul');
    // And then there is nothing left to do.
    opened.length = 0;
    expect(await sealPrivateValues({ admin, app: db, keys, log: () => undefined })).toEqual({
      sealed: 0,
      failed: 0,
    });
    expect(opened).toEqual([]);
  });

  it('the nightly status reads what was written down of them, not the empty columns', async () => {
    await refreshStatus({ admin, app: db });
    // Its box number is sealed, so the box has what it needs; the other has none.
    expect(await row(ids.box)).toMatchObject({ extra: {}, status_cache: 'valid' });
    expect((await row(ids.noNumber)).status_cache).toBe('needs_info');
  });
});
