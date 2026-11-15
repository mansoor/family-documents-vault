import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool, withPrincipal, withSystem, type Db } from './client.js';
import { askGrownUps } from './grown-up.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

type Role = 'owner' | 'adult' | 'teen' | 'viewer';

/**
 * A caregiver for somebody's medical papers, and the turning-18 question
 * (0098, 0.9.0, H1b), as the application role meets them: who is given a
 * grant, who writes one and how, what `caregiver_reads()` gives and to
 * whom, that nothing is written through a grant, that a caregiver's looks
 * are their person's alone, and that the question is asked once by the
 * vault and answered once.
 */
describe.skipIf(!testAdminUrl())('caregivers and turning 18, in the database (0098)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  const hh = randomUUID();
  const other = randomUUID();
  const who: Record<string, { account: string; member: string; role: Role }> = {};
  /** Omar, a child with no sign-in. */
  let omar = '';
  let papers: Record<string, string> = {};

  const as = <T>(name: string, fn: (trx: Db) => Promise<T>, household = hh): Promise<T> => {
    const w = who[name] as { account: string; member: string; role: Role };
    return withPrincipal(
      db,
      { householdId: household, accountId: w.account, memberId: w.member, role: w.role },
      fn,
    );
  };
  const grantRow = (person: string, caregiver: string, confirmed: boolean, by?: string) => ({
    household_id: hh,
    person_member_id: person,
    caregiver_member_id: caregiver,
    // As whoever names them, signed in; the vault's own, nobody.
    granted_by: by ?? null,
    person_confirmed_at: confirmed ? new Date() : null,
  });
  const reads = (name: string, doc: string, household = hh) =>
    as(
      name,
      async (trx) =>
        (
          await sql<{ ok: boolean }>`
            select coalesce((select caregiver_reads(d.owner_member_id, d.type_key, d.category)
                               from document d where d.id = ${doc}::uuid), false) as ok`.execute(
            trx,
          )
        ).rows[0]?.ok === true,
      household,
    );

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 4));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    for (const [id, tz] of [
      [hh, 'UTC'],
      [other, 'UTC'],
    ] as const) {
      await admin.query("insert into household (id, name, timezone) values ($1, 'T', $2)", [
        id,
        tz,
      ]);
    }
    for (const [name, role] of [
      ['owner', 'owner'],
      ['zain', 'adult'],
      ['sara', 'adult'],
      ['rafi', 'adult'],
      ['tia', 'teen'],
    ] as const) {
      const m = await admin.query<{ id: string }>(
        'insert into member (household_id, display_name) values ($1, $2) returning id',
        [hh, name],
      );
      const a = await admin.query<{ id: string }>(
        'insert into account (email) values ($1) returning id',
        [`${name}-${hh.slice(0, 8)}@example.test`],
      );
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [a.rows[0]?.id, hh, m.rows[0]?.id, role],
      );
      who[name] = { account: a.rows[0]?.id as string, member: m.rows[0]?.id as string, role };
    }
    omar = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Omar') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    const doc = async (
      owner: string,
      type: string,
      visibility: string,
      extra: { category?: string; deleted?: boolean; noCategory?: boolean } = {},
    ) =>
      // Its kind's category written on it, as the vault files a paper —
      // unless asked for none.
      (
        await admin.query<{ id: string }>(
          `insert into document (household_id, owner_member_id, type_key, visibility, title,
                                 category, deleted_at)
           values ($1, $2, $3, $4, $5,
                   case when $8 then null
                        else coalesce($6, (select t.category from document_type t where t.key = $3))
                   end, $7) returning id`,
          [
            hh,
            owner,
            type,
            visibility,
            `${type} ${visibility}`,
            extra.category ?? null,
            extra.deleted ? new Date() : null,
            extra.noCategory === true,
          ],
        )
      ).rows[0]?.id as string;
    const zain = who.zain?.member as string;
    papers = {
      medicalPrivate: await doc(zain, 'medical_record', 'private'),
      prescriptionPrivate: await doc(zain, 'prescription', 'private'),
      passportPrivate: await doc(zain, 'passport', 'private'),
      medicalFiledAsTax: await doc(zain, 'medical_record', 'private', { category: 'tax' }),
      // A Medical kind, no category of its own (written after 0098's backfill).
      medicalNoCategory: await doc(zain, 'medical_record', 'private', { noCategory: true }),
      medicalTrash: await doc(zain, 'medical_record', 'private', { deleted: true }),
      medicalFamily: await doc(zain, 'medical_record', 'household'),
      omarPrivate: await doc(omar, 'medical_record', 'private'),
    };
  }, 120_000);

  beforeEach(async () => {
    await admin.query('delete from caregiver_view where household_id = $1', [hh]);
    await admin.query('delete from caregiver_grant where household_id = $1', [hh]);
    await admin.query("update household set protection_mode = 'standard' where id = $1", [hh]);
  });

  afterAll(async () => {
    await db.destroy();
    await admin.end();
    await tdb.drop();
  });

  it('a grant is given to its person, its caregiver and the owners — not another adult, nor a teen', async () => {
    await withSystem(db, hh, (trx) =>
      trx
        .insertInto('caregiver_grant')
        .values(grantRow(who.zain?.member as string, who.sara?.member as string, true))
        .execute(),
    );
    const seen = (name: string) =>
      as(
        name,
        async (trx) => (await trx.selectFrom('caregiver_grant').select('id').execute()).length,
      );
    expect(await seen('zain')).toBe(1);
    expect(await seen('sara')).toBe(1);
    expect(await seen('owner')).toBe(1);
    expect(await seen('rafi')).toBe(0);
    expect(await seen('tia')).toBe(0);
  });

  it('the person names a caregiver for themselves, kept as made; nobody else does, and an owner only for somebody without a sign-in, unkept', async () => {
    const zain = who.zain?.member as string;
    const sara = who.sara?.member as string;
    await as('zain', (trx) =>
      trx
        .insertInto('caregiver_grant')
        .values(grantRow(zain, sara, true, who.zain?.account))
        .execute(),
    );
    // Another adult, for Zain.
    await expect(
      as('rafi', (trx) =>
        trx
          .insertInto('caregiver_grant')
          .values(grantRow(zain, who.rafi?.member as string, true, who.rafi?.account))
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    // An owner, for somebody who signs in themselves.
    await expect(
      as('owner', (trx) =>
        trx
          .insertInto('caregiver_grant')
          .values(grantRow(zain, who.owner?.member as string, false, who.owner?.account))
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    // An owner, for Omar: unkept only.
    await expect(
      as('owner', (trx) =>
        trx
          .insertInto('caregiver_grant')
          .values(grantRow(omar, sara, true, who.owner?.account))
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    // Named in somebody else's name: refused.
    await expect(
      as('owner', (trx) =>
        trx
          .insertInto('caregiver_grant')
          .values(grantRow(omar, sara, false, who.zain?.account))
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await as('owner', (trx) =>
      trx
        .insertInto('caregiver_grant')
        .values(grantRow(omar, sara, false, who.owner?.account))
        .execute(),
    );
    // A teen is never a caregiver; nor is somebody locked out.
    await expect(
      as('zain', (trx) =>
        trx
          .insertInto('caregiver_grant')
          .values(grantRow(zain, who.tia?.member as string, true, who.zain?.account))
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await admin.query(
      'update account_household set suspended_at = now(), suspend_reason = $2 where member_id = $1',
      [who.rafi?.member, 'locked'],
    );
    try {
      await expect(
        as('zain', (trx) =>
          trx
            .insertInto('caregiver_grant')
            .values(grantRow(zain, who.rafi?.member as string, true, who.zain?.account))
            .execute(),
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await admin.query(
        'update account_household set suspended_at = null, suspend_reason = null where member_id = $1',
        [who.rafi?.member],
      );
    }
  });

  it('only its person keeps a grant; a caregiver only gives it up; a revoked grant is history; nobody signed in removes one', async () => {
    const zain = who.zain?.member as string;
    const sara = who.sara?.member as string;
    const g = await withSystem(db, hh, (trx) =>
      trx
        .insertInto('caregiver_grant')
        .values(grantRow(zain, sara, false))
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    await expect(
      as('sara', (trx) =>
        trx
          .updateTable('caregiver_grant')
          .set({ person_confirmed_at: new Date() })
          .where('id', '=', g.id)
          .execute(),
      ),
    ).rejects.toThrow(/only its person keeps/);
    // An owner, for somebody who answers for themselves, is given no row to keep.
    const byOwner = await as('owner', (trx) =>
      trx
        .updateTable('caregiver_grant')
        .set({ person_confirmed_at: new Date() })
        .where('id', '=', g.id)
        .executeTakeFirst(),
    );
    expect(Number(byOwner.numUpdatedRows)).toBe(0);
    // Nor in somebody else's name.
    await expect(
      as('sara', (trx) =>
        trx
          .updateTable('caregiver_grant')
          .set({ revoked_at: new Date(), revoked_by: who.zain?.account as string })
          .where('id', '=', g.id)
          .execute(),
      ),
    ).rejects.toThrow(/in the name of whoever revokes/);
    // Another adult is given no row to change.
    const r = await as('rafi', (trx) =>
      trx
        .updateTable('caregiver_grant')
        .set({ revoked_at: new Date(), revoked_by: who.rafi?.account as string })
        .where('id', '=', g.id)
        .executeTakeFirst(),
    );
    expect(Number(r.numUpdatedRows)).toBe(0);
    await as('zain', (trx) =>
      trx
        .updateTable('caregiver_grant')
        .set({ person_confirmed_at: new Date() })
        .where('id', '=', g.id)
        .execute(),
    );
    await as('sara', (trx) =>
      trx
        .updateTable('caregiver_grant')
        .set({ revoked_at: new Date(), revoked_by: who.sara?.account as string })
        .where('id', '=', g.id)
        .execute(),
    );
    await expect(
      as('zain', (trx) =>
        trx
          .updateTable('caregiver_grant')
          .set({ revoked_at: null, revoked_by: null })
          .where('id', '=', g.id)
          .execute(),
      ),
    ).rejects.toThrow(/history/);
    const gone = await as('owner', (trx) =>
      trx.deleteFrom('caregiver_grant').where('id', '=', g.id).executeTakeFirst(),
    );
    expect(Number(gone.numDeletedRows)).toBe(0);
  });

  it('the PG 16 upsert keeps the same rules: ON CONFLICT DO UPDATE cannot keep somebody else’s grant, nor name a teen', async () => {
    const zain = who.zain?.member as string;
    const sara = who.sara?.member as string;
    await withSystem(db, hh, (trx) =>
      trx
        .insertInto('caregiver_grant')
        .values(grantRow(zain, sara, false))
        .execute(),
    );
    // Sara, the caregiver, trying to keep it for Zain through the conflict path.
    await expect(
      as('sara', (trx) =>
        sql`insert into caregiver_grant (household_id, person_member_id, caregiver_member_id, person_confirmed_at, granted_by)
            values (${hh}::uuid, ${zain}::uuid, ${sara}::uuid, now(), ${who.sara?.account as string}::uuid)
            on conflict (household_id, person_member_id, caregiver_member_id) where revoked_at is null
            do update set person_confirmed_at = now() where caregiver_grant.person_confirmed_at is null`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/row-level security|only its person keeps/);
    // Zain's own upsert keeps it.
    await as('zain', (trx) =>
      sql`insert into caregiver_grant (household_id, person_member_id, caregiver_member_id, person_confirmed_at, granted_by)
          values (${hh}::uuid, ${zain}::uuid, ${sara}::uuid, now(), ${who.zain?.account as string}::uuid)
          on conflict (household_id, person_member_id, caregiver_member_id) where revoked_at is null
          do update set person_confirmed_at = now() where caregiver_grant.person_confirmed_at is null`.execute(
        trx,
      ),
    );
    const kept = await admin.query<{ n: number }>(
      'select count(*)::int as n from caregiver_grant where household_id = $1 and person_confirmed_at is not null and revoked_at is null',
      [hh],
    );
    expect(kept.rows[0]?.n).toBe(1);
  });

  it('caregiver_reads gives the caregiver their person’s Only me Medical papers alone, while the grant lives and is kept', async () => {
    const zain = who.zain?.member as string;
    const sara = who.sara?.member as string;
    // No grant: nothing.
    expect(await reads('sara', papers.medicalPrivate as string)).toBe(false);
    const g = await withSystem(db, hh, (trx) =>
      trx
        .insertInto('caregiver_grant')
        .values(grantRow(zain, sara, true))
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    expect(await reads('sara', papers.medicalPrivate as string)).toBe(true);
    expect(await reads('sara', papers.prescriptionPrivate as string)).toBe(true);
    // Not another category, nor a Medical kind filed elsewhere.
    expect(await reads('sara', papers.passportPrivate as string)).toBe(false);
    expect(await reads('sara', papers.medicalFiledAsTax as string)).toBe(false);
    // Its own category alone: a kind's is never asked.
    expect(await reads('sara', papers.medicalNoCategory as string)).toBe(false);
    // Not anybody else: a third adult, a teen, an owner, the person themselves.
    for (const name of ['rafi', 'tia', 'owner', 'zain']) {
      expect(await reads(name, papers.medicalPrivate as string), name).toBe(false);
    }
    // Not as a teen: the same person, signed in with another role.
    expect(
      await withPrincipal(
        db,
        { householdId: hh, accountId: who.sara?.account as string, memberId: sara, role: 'teen' },
        async (trx) =>
          (
            await sql<{
              ok: boolean;
            }>`select caregiver_reads(${zain}::uuid, 'medical_record', null) as ok`.execute(trx)
          ).rows[0]?.ok,
      ),
    ).toBe(false);
    // Not in another household.
    expect(await reads('sara', papers.medicalPrivate as string, other)).toBe(false);
    // Not under 'private' protection: it fails closed.
    await admin.query("update household set protection_mode = 'private' where id = $1", [hh]);
    expect(await reads('sara', papers.medicalPrivate as string)).toBe(false);
    await admin.query("update household set protection_mode = 'standard' where id = $1", [hh]);
    // Revoked: at once.
    await as('zain', (trx) =>
      trx
        .updateTable('caregiver_grant')
        .set({ revoked_at: new Date(), revoked_by: who.zain?.account as string })
        .where('id', '=', g.id)
        .execute(),
    );
    expect(await reads('sara', papers.medicalPrivate as string)).toBe(false);
  });

  it('an owner’s naming reaches nobody’s Only me papers until its person keeps it', async () => {
    const sara = who.sara?.member as string;
    await as('owner', (trx) =>
      trx
        .insertInto('caregiver_grant')
        .values(grantRow(omar, sara, false, who.owner?.account))
        .execute(),
    );
    expect(await reads('sara', papers.omarPrivate as string)).toBe(false);
    // An owner naming themselves for Omar: still nothing of his Only me.
    await as('owner', (trx) =>
      trx
        .insertInto('caregiver_grant')
        .values(grantRow(omar, who.owner?.member as string, false, who.owner?.account))
        .execute(),
    );
    expect(await reads('owner', papers.omarPrivate as string)).toBe(false);
  });

  it('nothing of a paper a grant gives is written by its caregiver: not the document, a link between papers or a reminder (the rest through the API)', async () => {
    const zain = who.zain?.member as string;
    const sara = who.sara?.member as string;
    await withSystem(db, hh, (trx) =>
      trx
        .insertInto('caregiver_grant')
        .values(grantRow(zain, sara, true))
        .execute(),
    );
    const doc = papers.medicalPrivate as string;
    await expect(
      as('sara', (trx) =>
        trx.updateTable('document').set({ title: 'changed' }).where('id', '=', doc).execute(),
      ),
    ).rejects.toThrow(/changes none of them/);
    await expect(
      as('sara', (trx) => trx.deleteFrom('document').where('id', '=', doc).execute()),
    ).rejects.toThrow(/changes none of them/);
    await expect(
      as('sara', (trx) =>
        trx
          .insertInto('reminder')
          .values({
            household_id: hh,
            document_id: doc,
            kind: 'manual',
            fire_at: '2030-01-01',
            status: 'scheduled',
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security|only for a document its writer can see/);
    const [a, b] = [doc, papers.medicalFamily as string].sort();
    await expect(
      as('sara', (trx) =>
        trx
          .insertInto('document_link')
          .values({ household_id: hh, a: a as string, b: b as string })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    // Nor does she take away what is there: its link to another paper, its
    // reminder; nor change the reminder (each is given her as nothing to change).
    await admin.query('insert into document_link (household_id, a, b) values ($1, $2, $3)', [
      hh,
      a,
      b,
    ]);
    const rem = await admin.query<{ id: string }>(
      `insert into reminder (household_id, document_id, kind, fire_at, status)
       values ($1, $2, 'manual', '2030-01-01', 'scheduled') returning id`,
      [hh, doc],
    );
    const unlinked = await as('sara', (trx) =>
      trx
        .deleteFrom('document_link')
        .where('a', '=', a as string)
        .executeTakeFirst(),
    );
    expect(Number(unlinked.numDeletedRows)).toBe(0);
    const snoozed = await as('sara', (trx) =>
      trx
        .updateTable('reminder')
        .set({ status: 'snoozed' })
        .where('id', '=', rem.rows[0]?.id as string)
        .executeTakeFirst(),
    );
    expect(Number(snoozed.numUpdatedRows)).toBe(0);
    const unreminded = await as('sara', (trx) =>
      trx
        .deleteFrom('reminder')
        .where('id', '=', rem.rows[0]?.id as string)
        .executeTakeFirst(),
    );
    expect(Number(unreminded.numDeletedRows)).toBe(0);
    // Zain, its person, still does both.
    const own = await as('zain', (trx) =>
      trx
        .updateTable('reminder')
        .set({ status: 'snoozed' })
        .where('id', '=', rem.rows[0]?.id as string)
        .executeTakeFirst(),
    );
    expect(Number(own.numUpdatedRows)).toBe(1);
    await admin.query('delete from document_link where a = $1', [a]);
    await admin.query('delete from reminder where id = $1', [rem.rows[0]?.id]);
    // A paper she reads only through the grant is still held for a reader's log.
    await as('sara', (trx) =>
      trx.selectFrom('document').select('id').where('id', '=', doc).forKeyShare().execute(),
    );
    // And the person themselves changes their own.
    await as('zain', (trx) =>
      trx.updateTable('document').set({ title: 'theirs' }).where('id', '=', doc).execute(),
    );
  });

  it('a look is written only for a caregiver reading through a grant, and given to its person alone', async () => {
    const zain = who.zain?.member as string;
    const sara = who.sara?.member as string;
    await withSystem(db, hh, (trx) =>
      trx
        .insertInto('caregiver_grant')
        .values(grantRow(zain, sara, true))
        .execute(),
    );
    const record = (name: string, doc: string) =>
      as(
        name,
        async (trx) =>
          (
            await sql<{
              ok: boolean;
            }>`select record_caregiver_view(${doc}::uuid, 'opened') as ok`.execute(trx)
          ).rows[0]?.ok,
      );
    expect(await record('sara', papers.medicalPrivate as string)).toBe(true);
    // Once a sitting: the same look again at once is the one already written.
    expect(await record('sara', papers.medicalPrivate as string)).toBe(false);
    // Nothing for one Sara sees anyway, one she does not see, or somebody else.
    expect(await record('sara', papers.medicalFamily as string)).toBe(false);
    expect(await record('sara', papers.passportPrivate as string)).toBe(false);
    expect(await record('rafi', papers.medicalPrivate as string)).toBe(false);
    // Nobody signed in writes one themselves.
    await expect(
      as('sara', (trx) =>
        sql`insert into caregiver_view (household_id, grant_id, person_member_id, caregiver_member_id, document_id, action)
            select household_id, id, person_member_id, caregiver_member_id, ${papers.medicalPrivate}::uuid, 'opened' from caregiver_grant`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const looks = (name: string) =>
      as(
        name,
        async (trx) => (await trx.selectFrom('caregiver_view').select('id').execute()).length,
      );
    expect(await looks('zain')).toBe(1);
    // The owners too (14 Nov 2026); never the caregiver, another adult or a teen.
    expect(await looks('owner')).toBe(1);
    for (const name of ['sara', 'rafi', 'tia']) expect(await looks(name), name).toBe(0);
    // Nor does the person write, change or remove one.
    await expect(
      as('zain', (trx) =>
        sql`insert into caregiver_view (household_id, grant_id, person_member_id, caregiver_member_id, document_id, action)
            select household_id, id, person_member_id, caregiver_member_id, ${papers.medicalPrivate}::uuid, 'opened' from caregiver_grant`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const gone = await as('zain', (trx) => trx.deleteFrom('caregiver_view').executeTakeFirst());
    expect(Number(gone.numDeletedRows)).toBe(0);
    const moved = await as('zain', (trx) =>
      trx.updateTable('caregiver_view').set({ action: 'previewed' }).executeTakeFirst(),
    );
    expect(Number(moved.numUpdatedRows)).toBe(0);
    expect(await looks('zain')).toBe(1);
  });

  it('a caregiver whose role moves to a teen’s, or whose sign-in goes, is one no more', async () => {
    const zain = who.zain?.member as string;
    const rafi = who.rafi?.member as string;
    await withSystem(db, hh, (trx) =>
      trx
        .insertInto('caregiver_grant')
        .values(grantRow(zain, rafi, true))
        .execute(),
    );
    await admin.query("update account_household set role = 'viewer' where member_id = $1", [rafi]);
    try {
      const live = await admin.query<{ n: number }>(
        'select count(*)::int as n from caregiver_grant where caregiver_member_id = $1 and revoked_at is null',
        [rafi],
      );
      expect(live.rows[0]?.n).toBe(0);
    } finally {
      await admin.query("update account_household set role = 'adult' where member_id = $1", [rafi]);
    }
  });

  it('the turning-18 question: asked by the vault alone, once, and answered once — Only me by the person alone', async () => {
    const zain = who.zain?.member as string;
    await admin.query('delete from grown_up_question where household_id = $1', [hh]);
    await withSystem(db, hh, (trx) =>
      trx
        .insertInto('grown_up_question')
        .values({ household_id: hh, member_id: zain, turned_on: '2026-11-14' })
        .execute(),
    );
    await withSystem(db, hh, (trx) =>
      trx
        .insertInto('grown_up_question')
        .values({ household_id: hh, member_id: omar, turned_on: '2026-11-14' })
        .execute(),
    );
    await expect(
      as('owner', (trx) =>
        trx
          .insertInto('grown_up_question')
          .values({
            household_id: hh,
            member_id: who.rafi?.member as string,
            turned_on: '2026-11-14',
          })
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    const seen = (name: string) =>
      as(
        name,
        async (trx) =>
          (await trx.selectFrom('grown_up_question').select('member_id').execute()).length,
      );
    expect(await seen('zain')).toBe(1);
    expect(await seen('owner')).toBe(2);
    expect(await seen('rafi')).toBe(0);
    const answer = (name: string, member: string, a: 'keep' | 'only_me') =>
      as(name, (trx) =>
        trx
          .updateTable('grown_up_question')
          .set({ answered_at: new Date(), answer: a, answered_by: who[name]?.account as string })
          .where('member_id', '=', member)
          .execute(),
      );
    // An owner answers for Zain, who signs in: refused. Only me for Omar: refused.
    await expect(answer('owner', zain, 'keep')).rejects.toThrow(/only the person answers/);
    await expect(answer('owner', omar, 'only_me')).rejects.toThrow(/only the person answers/);
    // Tia signs in as a teen: hers to answer once she is an adult, never an owner's.
    await withSystem(db, hh, (trx) =>
      trx
        .insertInto('grown_up_question')
        .values({ household_id: hh, member_id: who.tia?.member as string, turned_on: '2026-11-14' })
        .execute(),
    );
    await expect(answer('owner', who.tia?.member as string, 'keep')).rejects.toThrow(
      /only the person answers/,
    );
    await expect(answer('tia', who.tia?.member as string, 'keep')).rejects.toThrow(
      /signed in as a grown-up/,
    );
    // Written as it is, by whoever gives it: in nobody else's name, and Keep
    // makes nothing Only me.
    await expect(
      as('owner', (trx) =>
        trx
          .updateTable('grown_up_question')
          .set({
            answered_at: new Date(),
            answer: 'keep',
            answered_by: who.zain?.account as string,
          })
          .where('member_id', '=', omar)
          .execute(),
      ),
    ).rejects.toThrow(/written as it is/);
    await expect(
      as('owner', (trx) =>
        trx
          .updateTable('grown_up_question')
          .set({
            answered_at: new Date(),
            answer: 'keep',
            answered_by: who.owner?.account as string,
            made_private: 3,
          })
          .where('member_id', '=', omar)
          .execute(),
      ),
    ).rejects.toThrow(/written as it is/);
    await answer('owner', omar, 'keep');
    await answer('zain', zain, 'only_me');
    await expect(answer('zain', zain, 'keep')).rejects.toThrow(/has been answered/);
  });

  describe('the first look asks everybody already grown up, once (14 Nov 2026)', () => {
    const caught = randomUUID();
    let ava = '';
    beforeAll(async () => {
      await admin.query("insert into household (id, name, timezone) values ($1, 'Catch', 'UTC')", [
        caught,
      ]);
      // 46, no sign-in, a Medical paper the family sees.
      ava = (
        await admin.query<{ id: string }>(
          `insert into member (household_id, display_name, date_of_birth, created_at)
           values ($1, 'Ava', '1980-03-02', '2020-01-01') returning id`,
          [caught],
        )
      ).rows[0]?.id as string;
      await admin.query(
        `insert into document (household_id, owner_member_id, type_key, visibility, title, category)
         values ($1, $2, 'prescription', 'household', 'Statins', 'medical')`,
        [caught, ava],
      );
    });
    const ask = (now: Date) =>
      withSystem(db, caught, (trx) => askGrownUps(trx, caught, 'UTC', now));

    it('asks them, the owners reminded today, and never again — nor anybody later', async () => {
      expect(await ask(new Date('2026-11-14T09:00:00Z'))).toBe(1);
      const q = await admin.query<{ turned_on: string }>(
        'select turned_on::text as turned_on from grown_up_question where member_id = $1',
        [ava],
      );
      expect(q.rows).toEqual([{ turned_on: '1998-03-02' }]);
      const r = await admin.query<{ fire_at: string }>(
        "select fire_at::text as fire_at from reminder where member_id = $1 and kind = 'turned_18'",
        [ava],
      );
      expect(r.rows).toEqual([{ fire_at: '2026-11-14' }]);
      expect(await ask(new Date('2026-11-14T10:00:00Z'))).toBe(0);
      // A grown-up whose Medical paper comes later is not asked: the catch-up was once.
      const ben = (
        await admin.query<{ id: string }>(
          `insert into member (household_id, display_name, date_of_birth, created_at)
           values ($1, 'Ben', '1990-01-01', '2020-01-01') returning id`,
          [caught],
        )
      ).rows[0]?.id as string;
      await admin.query(
        `insert into document (household_id, owner_member_id, type_key, visibility, title, category)
         values ($1, $2, 'medical_record', 'household', 'X-ray', 'medical')`,
        [caught, ben],
      );
      expect(await ask(new Date('2026-11-15T09:00:00Z'))).toBe(0);
      // A household restored from before it (the mark not there yet) is caught up as it starts.
      await admin.query('update household set grown_ups_asked_at = null where id = $1', [caught]);
      expect(await ask(new Date('2026-11-16T09:00:00Z'))).toBe(1);
      expect(await ask(new Date('2026-11-16T10:00:00Z'))).toBe(0);
    });
  });

  describe('asked as somebody turns 18 on the family’s calendar', () => {
    const tz = randomUUID();
    let person = '';
    beforeAll(async () => {
      await admin.query(
        "insert into household (id, name, timezone) values ($1, 'Auckland', 'Pacific/Auckland')",
        [tz],
      );
      // 18 on 15 Nov 2026: in Auckland, at noon UTC on the 14th, already.
      person = (
        await admin.query<{ id: string }>(
          `insert into member (household_id, display_name, date_of_birth, created_at)
           values ($1, 'Lena', '2008-11-15', '2020-01-01') returning id`,
          [tz],
        )
      ).rows[0]?.id as string;
      await admin.query(
        `insert into document (household_id, owner_member_id, type_key, visibility, title, category)
         values ($1, $2, 'medical_record', 'household', 'Vaccinations', 'medical')`,
        [tz, person],
      );
      // Somebody with no Medical papers the family can see is asked nothing.
      const nothing = (
        await admin.query<{ id: string }>(
          `insert into member (household_id, display_name, date_of_birth, created_at)
           values ($1, 'Noor', '2008-11-15', '2020-01-01') returning id`,
          [tz],
        )
      ).rows[0]?.id as string;
      await admin.query(
        `insert into document (household_id, owner_member_id, type_key, visibility, title, category)
         values ($1, $2, 'passport', 'household', 'Passport', 'identity')`,
        [tz, nothing],
      );
    });
    const ask = (now: Date) =>
      withSystem(db, tz, (trx) => askGrownUps(trx, tz, 'Pacific/Auckland', now));
    const count = async (table: string) =>
      (
        await admin.query<{ n: number }>(
          `select count(*)::int as n from ${table} where household_id = $1${table === 'reminder' ? " and kind = 'turned_18'" : ''}`,
          [tz],
        )
      ).rows[0]?.n;

    it('not the day before, on the family’s calendar', async () => {
      // 10:00 UTC on the 14th is 23:00 on the 14th in Auckland: still 17.
      expect(await ask(new Date('2026-11-14T10:00:00Z'))).toBe(0);
      expect(await count('grown_up_question')).toBe(0);
    });

    it('on the day, once, however often the vault looks; and the owners reminded, as Lena has no sign-in', async () => {
      // 12:00 UTC on the 14th is 01:00 on the 15th in Auckland: 18.
      expect(await ask(new Date('2026-11-14T12:00:00Z'))).toBe(1);
      expect(await ask(new Date('2026-11-14T13:00:00Z'))).toBe(0);
      expect(await ask(new Date('2026-11-16T09:00:00Z'))).toBe(0);
      expect(await count('grown_up_question')).toBe(1);
      expect(await count('reminder')).toBe(1);
      const q = await admin.query<{ member_id: string; turned_on: string }>(
        'select member_id, turned_on::text as turned_on from grown_up_question where household_id = $1',
        [tz],
      );
      expect(q.rows).toEqual([{ member_id: person, turned_on: '2026-11-15' }]);
    });

    it('answered, the owners’ reminder is done with at the next look', async () => {
      await admin.query(
        "update grown_up_question set answered_at = now(), answer = 'keep' where member_id = $1",
        [person],
      );
      await ask(new Date('2026-11-16T12:00:00Z'));
      const r = await admin.query<{ status: string }>(
        "select status from reminder where household_id = $1 and kind = 'turned_18'",
        [tz],
      );
      expect(r.rows.map((x) => x.status)).toEqual(['resolved']);
    });

    it('two looks at once ask once', async () => {
      const twin = (
        await admin.query<{ id: string }>(
          `insert into member (household_id, display_name, date_of_birth, created_at)
           values ($1, 'Twin', '2008-11-20', '2020-01-01') returning id`,
          [tz],
        )
      ).rows[0]?.id as string;
      await admin.query(
        `insert into document (household_id, owner_member_id, type_key, visibility, title, category)
         values ($1, $2, 'prescription', 'adults', 'Inhaler', 'medical')`,
        [tz, twin],
      );
      const at = new Date('2026-11-20T00:00:00Z');
      const made = await Promise.all([ask(at), ask(at), ask(at)]);
      expect(made.reduce((x, y) => x + y, 0)).toBe(1);
      const n = await admin.query<{ n: number }>(
        'select count(*)::int as n from grown_up_question where member_id = $1',
        [twin],
      );
      expect(n.rows[0]?.n).toBe(1);
    });
  });
});
