import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, withPrincipal, withScope, withSystem, type Db } from './client.js';
import { createTestDatabase, testAdminUrl, type TestDatabase } from './testing.js';

type Role = 'owner' | 'adult' | 'teen' | 'viewer';

/**
 * A person's emergency information (0102, 0.9.0, H4), as the application
 * role meets it: who is given a page, who writes one and how, who chooses
 * who sees it, a caregiver's live grant and nothing after it, a viewer and
 * a guest never, another household never, the PG 16 upsert under the same
 * rules — and a clinician's link given its one person's page and nothing
 * else, only while it is live.
 */
describe.skipIf(!testAdminUrl())('emergency information, in the database (0102)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  const hh = randomUUID();
  const other = randomUUID();
  const who: Record<string, { account: string; member: string; role: Role; household: string }> =
    {};
  /** Omar, a child with no sign-in. */
  let omar = '';
  let identityKey = '';
  let otherKey = '';

  const as = <T>(name: string, fn: (trx: Db) => Promise<T>): Promise<T> => {
    const w = who[name] as { account: string; member: string; role: Role; household: string };
    return withPrincipal(
      db,
      { householdId: w.household, accountId: w.account, memberId: w.member, role: w.role },
      fn,
    );
  };
  const seen = (name: string) =>
    as(name, async (trx) =>
      (await trx.selectFrom('member_emergency').select('member_id').execute())
        .map((r) => r.member_id)
        .sort(),
    );
  const sees = async (name: string, person: string) => (await seen(name)).includes(person);
  const sealed = () => ({ sealed: Buffer.alloc(40, 7), dek_wrapped: Buffer.alloc(40, 9) });
  const page = (member: string, extra: Record<string, unknown> = {}) =>
    withSystem(db, hh, (trx) =>
      trx
        .insertInto('member_emergency')
        .values({
          household_id: hh,
          member_id: member,
          ...sealed(),
          wrapped_by_scope: identityKey,
          ...extra,
        })
        .execute(),
    );
  const setAudience = (audience: string, chosen: string[], member: string) =>
    admin.query('update member_emergency set audience = $1, chosen = $2 where member_id = $3', [
      audience,
      chosen,
      member,
    ]);
  const grant = async (person: string, carer: string, kept: boolean) =>
    (
      await admin.query<{ id: string }>(
        `insert into caregiver_grant (household_id, person_member_id, caregiver_member_id, person_confirmed_at)
         values ($1, $2, $3, $4) returning id`,
        [hh, person, carer, kept ? new Date() : null],
      )
    ).rows[0]?.id as string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 4));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    for (const id of [hh, other]) {
      await admin.query("insert into household (id, name, timezone) values ($1, 'T', 'UTC')", [id]);
    }
    for (const [name, role, household, kind] of [
      ['owner', 'owner', hh, 'family'],
      ['zain', 'adult', hh, 'family'],
      ['sara', 'adult', hh, 'family'],
      ['rafi', 'adult', hh, 'family'],
      ['tia', 'teen', hh, 'family'],
      ['vic', 'viewer', hh, 'family'],
      ['gwen', 'viewer', hh, 'guest'],
      ['stranger', 'owner', other, 'family'],
    ] as const) {
      const m = await admin.query<{ id: string }>(
        'insert into member (household_id, display_name, kind) values ($1, $2, $3) returning id',
        [household, name, kind],
      );
      const a = await admin.query<{ id: string }>(
        'insert into account (email) values ($1) returning id',
        [`${name}-${hh.slice(0, 8)}@example.test`],
      );
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [a.rows[0]?.id, household, m.rows[0]?.id, role],
      );
      who[name] = {
        account: a.rows[0]?.id as string,
        member: m.rows[0]?.id as string,
        role,
        household,
      };
    }
    omar = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Omar') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    identityKey = (
      await admin.query<{ id: string }>(
        "insert into scope_key (household_id, kind, key_wrapped) values ($1, 'identity', '\\x00') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    otherKey = (
      await admin.query<{ id: string }>(
        "insert into scope_key (household_id, kind, key_wrapped) values ($1, 'household', '\\x00') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    await page(who.zain?.member as string);
    await page(who.tia?.member as string);
    await page(omar);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  it('is given to the person, the owners and, by default, the adults; never a teen, a viewer or a guest', async () => {
    const zain = who.zain?.member as string;
    expect(await sees('zain', zain)).toBe(true);
    expect(await sees('owner', zain)).toBe(true);
    expect(await sees('rafi', zain)).toBe(true);
    expect(await sees('tia', zain)).toBe(false);
    expect(await sees('vic', zain)).toBe(false);
    expect(await sees('gwen', zain)).toBe(false);
    // Another household's owner: nothing of this one.
    expect(await seen('stranger')).toEqual([]);
    // Somebody signed in with no role and no member: nothing.
    const bare = await withScope(
      db,
      {
        householdId: hh,
        actor: { kind: 'account', accountId: randomUUID(), memberId: '', role: '' } as never,
      },
      (trx) => trx.selectFrom('member_emergency').select('member_id').execute(),
    ).catch(() => []);
    expect(bare).toEqual([]);
  });

  it('narrowed and named: an adult not chosen loses it, a teen chosen gains it, a viewer never', async () => {
    const zain = who.zain?.member as string;
    await setAudience(
      'owners_and_self',
      [who.tia?.member as string, who.vic?.member as string],
      zain,
    );
    try {
      expect(await sees('rafi', zain)).toBe(false);
      expect(await sees('tia', zain)).toBe(true);
      // Named, a viewer is still given nothing: the rule asks the role.
      expect(await sees('vic', zain)).toBe(false);
      expect(await sees('owner', zain)).toBe(true);
      await setAudience('family', [], zain);
      expect(await sees('tia', zain)).toBe(true);
      expect(await sees('gwen', zain)).toBe(false);
    } finally {
      await setAudience('adults', [], zain);
    }
  });

  it('a caregiver reads it while a grant lives and is kept; not unkept, revoked, or in private mode', async () => {
    const zain = who.zain?.member as string;
    const sara = who.sara?.member as string;
    await setAudience('owners_and_self', [], zain);
    try {
      expect(await sees('sara', zain)).toBe(false);
      const unkept = await grant(zain, sara, false);
      expect(await sees('sara', zain)).toBe(false);
      await admin.query('update caregiver_grant set revoked_at = now() where id = $1', [unkept]);
      const g = await grant(zain, sara, true);
      expect(await sees('sara', zain)).toBe(true);
      // Nobody else's, through it: not Tia's, not Omar's.
      await setAudience('owners_and_self', [], who.tia?.member as string);
      expect(await sees('sara', who.tia?.member as string)).toBe(false);
      await admin.query("update household set protection_mode = 'private' where id = $1", [hh]);
      expect(await sees('sara', zain)).toBe(false);
      await admin.query("update household set protection_mode = 'standard' where id = $1", [hh]);
      await admin.query('update caregiver_grant set revoked_at = now() where id = $1', [g]);
      expect(await sees('sara', zain)).toBe(false);
    } finally {
      await setAudience('adults', [], zain);
      await setAudience('adults', [], who.tia?.member as string);
    }
  });

  it('is written by the person and the owners; its audience chosen by the person, or an owner for a child', async () => {
    const zain = who.zain?.member as string;
    const tia = who.tia?.member as string;
    const write = (name: string, member: string, set: Record<string, unknown>) =>
      as(name, async (trx) =>
        Number(
          (
            await trx
              .updateTable('member_emergency')
              .set(set)
              .where('member_id', '=', member)
              .executeTakeFirst()
          ).numUpdatedRows,
        ),
      );
    // Another adult, who reads it, writes none of it.
    expect(await write('rafi', zain, sealed())).toBe(0);
    // The person, and an owner, write what is on it.
    expect(await write('zain', zain, { ...sealed(), sealed: Buffer.alloc(41, 1) })).toBe(1);
    expect(await write('owner', zain, { ...sealed(), sealed: Buffer.alloc(42, 1) })).toBe(1);
    // Who sees a grown-up's: theirs alone, not an owner's.
    await expect(write('owner', zain, { audience: 'family' })).rejects.toThrow(/chooses who sees/);
    expect(await write('zain', zain, { audience: 'family' })).toBe(1);
    expect(await write('zain', zain, { audience: 'adults' })).toBe(1);
    // A teen writes her own; an owner chooses who sees it.
    expect(await write('tia', tia, { ...sealed(), sealed: Buffer.alloc(43, 1) })).toBe(1);
    await expect(write('tia', tia, { audience: 'family' })).rejects.toThrow(/chooses who sees/);
    expect(await write('owner', tia, { audience: 'family' })).toBe(1);
    expect(await write('owner', omar, { audience: 'owners_and_self' })).toBe(1);
    // Never the person named, nor anybody of another household.
    await expect(write('zain', zain, { chosen: [zain] })).rejects.toThrow(/of their family/);
    await expect(write('zain', zain, { chosen: [who.stranger?.member as string] })).rejects.toThrow(
      /of their family/,
    );
    // A viewer writes nothing, of anybody's — their own neither.
    expect(await write('vic', zain, sealed())).toBe(0);
    // Under the household's identity key, and no other.
    await expect(write('zain', zain, { wrapped_by_scope: otherKey })).rejects.toThrow(
      /identity key/,
    );
    // Nobody removes one.
    await expect(
      as('owner', (trx) =>
        trx.deleteFrom('member_emergency').where('member_id', '=', zain).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    // The version is the database's.
    const v = await admin.query<{ version: number }>(
      'select version from member_emergency where member_id = $1',
      [zain],
    );
    expect(v.rows[0]?.version).toBeGreaterThanOrEqual(5);
  });

  it('a first write takes the default audience unless its writer chooses; a guest keeps none', async () => {
    const rafi = who.rafi?.member as string;
    // Rafi's first, by an owner (who does not choose for a grown-up): only the default.
    const insert = (name: string, member: string, extra: Record<string, unknown> = {}) =>
      as(name, (trx) =>
        trx
          .insertInto('member_emergency')
          .values({
            household_id: hh,
            member_id: member,
            ...sealed(),
            wrapped_by_scope: identityKey,
            ...extra,
          })
          .execute(),
      );
    await expect(insert('owner', rafi, { audience: 'family' })).rejects.toThrow(/chooses who sees/);
    await expect(insert('sara', rafi)).rejects.toThrow(/row-level security/);
    await insert('rafi', rafi, { audience: 'owners_and_self' });
    expect(await sees('sara', rafi)).toBe(false);
    await expect(
      withSystem(db, hh, (trx) =>
        trx
          .insertInto('member_emergency')
          .values({
            household_id: hh,
            member_id: who.gwen?.member as string,
            ...sealed(),
            wrapped_by_scope: identityKey,
          })
          .execute(),
      ),
    ).rejects.toThrow(/guest keeps no emergency information/);
  });

  it('the PG 16 upsert keeps the same rules: ON CONFLICT DO UPDATE … WHERE neither writes nor widens for whoever may not', async () => {
    const zain = who.zain?.member as string;
    const before = async () =>
      (
        await admin.query<{ sealed: Buffer; audience: string; version: number }>(
          'select sealed, audience, version from member_emergency where member_id = $1',
          [zain],
        )
      ).rows[0];
    /** The page's words written through the conflict path, as `name`, when `when` holds. */
    const upsertWords = (name: string, when: string) =>
      as(name, (trx) =>
        sql`insert into member_emergency (household_id, member_id, sealed, dek_wrapped, wrapped_by_scope)
            values (${hh}::uuid, ${zain}::uuid, decode(repeat('ab', 30), 'hex'),
                    decode(repeat('00', 30), 'hex'), ${identityKey}::uuid)
            on conflict (member_id)
            do update set sealed = excluded.sealed
            where ${sql.raw(when)}`.execute(trx),
      );
    const upsertAudience = (name: string, audience: string) =>
      as(name, (trx) =>
        sql`insert into member_emergency (household_id, member_id, sealed, dek_wrapped, wrapped_by_scope, audience)
            values (${hh}::uuid, ${zain}::uuid, decode(repeat('00', 30), 'hex'),
                    decode(repeat('00', 30), 'hex'), ${identityKey}::uuid, ${audience})
            on conflict (member_id)
            do update set audience = excluded.audience
            where member_emergency.audience is distinct from excluded.audience`.execute(trx),
      );
    const was = await before();
    // Another adult, who reads it: refused on the conflict path.
    await expect(upsertWords('rafi', 'true')).rejects.toThrow(/row-level security/);
    // With a WHERE that holds for no row: still refused, by the insert's own
    // rule on the row proposed — the writer rules are the same both ways, so
    // nobody passes one and fails the other.
    await expect(upsertWords('rafi', 'member_emergency.version < 0')).rejects.toThrow(
      /row-level security policy "member_emergency_writer_insert"/,
    );
    // A teen, who does not read it: refused too.
    await expect(upsertWords('tia', 'true')).rejects.toThrow(/row-level security/);
    expect(await before()).toEqual(was);
    // An owner: may write its words, but not choose who sees a grown-up's.
    await expect(upsertAudience('owner', 'family')).rejects.toThrow(/chooses who sees/);
    await expect(upsertAudience('rafi', 'family')).rejects.toThrow(
      /row-level security|chooses who sees/,
    );
    expect((await before())?.audience).toBe(was?.audience);
    // The person: theirs to choose.
    await upsertAudience('zain', 'family');
    expect((await before())?.audience).toBe('family');
    await setAudience('adults', [], zain);
  });

  it('a clinician’s link is given its one person’s page while it is live, and nothing else', async () => {
    const zain = who.zain?.member as string;
    const link = async (member: string, by: string) =>
      (
        await admin.query<{ id: string }>(
          `insert into share_link (household_id, emergency_member_id, emergency_fields, token_hash,
                                   created_by, expires_at, permission)
           values ($1, $2, $3, $4, $5, now() + interval '4 hours', 'view') returning id`,
          [
            hh,
            member,
            ['allergies'],
            createHash('sha256').update(randomUUID()).digest(),
            who[by]?.account,
          ],
        )
      ).rows[0]?.id as string;
    const given = (shareId: string) =>
      withScope(db, { householdId: hh, actor: { kind: 'link', shareId } }, async (trx) =>
        (await trx.selectFrom('member_emergency').select('member_id').execute()).map(
          (r) => r.member_id,
        ),
      );
    const mine = await link(zain, 'zain');
    expect(await given(mine)).toEqual([zain]);
    // An owner's for a child.
    expect(await given(await link(omar, 'owner'))).toEqual([omar]);
    // Made by another adult for Zain's page: lends nothing.
    expect(await given(await link(zain, 'rafi'))).toEqual([]);
    // A link that is not this household's: nothing.
    expect(await given(randomUUID())).toEqual([]);
    // Taken back, or run out: nothing.
    await admin.query('update share_link set revoked_at = now() where id = $1', [mine]);
    expect(await given(mine)).toEqual([]);
    const brief = await link(zain, 'zain');
    await admin.query(
      "update share_link set expires_at = now() - interval '1 minute' where id = $1",
      [brief],
    );
    expect(await given(brief)).toEqual([]);
    // Longer than a day, a document's too, or to download: refused by the database.
    await expect(
      admin.query(
        `insert into share_link (household_id, emergency_member_id, emergency_fields, token_hash,
                                 created_by, expires_at, permission)
         values ($1, $2, '{allergies}', '\\x01', $3, now() + interval '25 hours', 'view')`,
        [hh, zain, who.zain?.account],
      ),
    ).rejects.toThrow(/share_link_emergency_shape/);
    await expect(
      admin.query(
        `insert into share_link (household_id, emergency_member_id, emergency_fields, token_hash,
                                 created_by, expires_at, permission)
         values ($1, $2, '{allergies}', '\\x02', $3, now() + interval '2 hours', 'download')`,
        [hh, zain, who.zain?.account],
      ),
    ).rejects.toThrow(/share_link_emergency_shape/);
    await expect(
      admin.query(
        `insert into share_link (household_id, emergency_member_id, emergency_fields, token_hash,
                                 created_by, expires_at, permission)
         values ($1, $2, '{passwords}', '\\x03', $3, now() + interval '2 hours', 'view')`,
        [hh, zain, who.zain?.account],
      ),
    ).rejects.toThrow(/share_link_emergency_fields/);
    // Who makes one: the person signed in as a grown-up, an owner for a child.
    const make = (name: string, member: string) =>
      as(name, (trx) =>
        trx
          .insertInto('share_link')
          .values({
            household_id: hh,
            document_id: null,
            emergency_member_id: member,
            emergency_fields: ['allergies'],
            token_hash: createHash('sha256').update(randomUUID()).digest(),
            created_by: who[name]?.account as string,
            expires_at: new Date(Date.now() + 3_600_000),
            permission: 'view',
          })
          .execute(),
      );
    await make('zain', zain);
    await make('owner', omar);
    await expect(make('owner', zain)).rejects.toThrow(/row-level security/);
    await expect(make('tia', who.tia?.member as string)).rejects.toThrow(/row-level security/);
    await expect(make('rafi', zain)).rejects.toThrow(/row-level security/);
    // And who sees them: the person and the owners; nobody else signed in.
    const links = (name: string) =>
      as(
        name,
        async (trx) =>
          (
            await trx
              .selectFrom('share_link')
              .select('id')
              .where('emergency_member_id', '=', zain)
              .execute()
          ).length,
      );
    expect(await links('zain')).toBeGreaterThan(0);
    expect(await links('owner')).toBeGreaterThan(0);
    expect(await links('rafi')).toBe(0);
    expect(await links('tia')).toBe(0);
    expect(await links('sara')).toBe(0);
  });
});
