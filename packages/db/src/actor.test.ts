import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
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
 * The database is told who is asking (5.5), and answers each kind of caller
 * by its own rule (5.6). First, that the settings are said and end with the
 * transaction that said them; then, what each caller is given of the
 * document tables.
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
      // The vault itself is only ever withSystem; every other caller withScope.
      const inside =
        actor.kind === 'system'
          ? await withSystem(db, hh, (trx) => settings(trx))
          : await withScope(db, { householdId: hh, actor }, (trx) => settings(trx));
      expect(none(inside), actor.kind).toEqual({ ...blank, 'app.household_id': hh, ...said });

      // Same pool, one connection, next borrower: nothing is left.
      expect(none(await settings(db)), actor.kind).toEqual(blank);
    }
  });

  it('only withSystem acts as the vault: withScope refuses a system actor', async () => {
    // A type test: it fails the typecheck if withScope ever takes 'system'.
    const refused = () =>
      // @ts-expect-error — system is withSystem's alone (5.5 review)
      withScope(db, { householdId: hh, actor: { kind: 'system' } }, (trx) => settings(trx));
    expect(typeof refused).toBe('function');
    // And a cast past the type is refused as it runs (5.6 review), before
    // anything reaches the database.
    for (const actor of [{ kind: 'system' } as never, { kind: 'system' as never }]) {
      await expect(
        withScope(db, { householdId: hh, actor }, (trx) => settings(trx)),
      ).rejects.toThrow(/only withSystem acts as the vault itself/);
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

/**
 * The tables 0030 guards — the document, everything that hangs off it, and
 * exports — and the collections of documents 0036 adds, which a link is not
 * given either (5.19 gives a collection's share what it needs).
 */
const GUARDED = [
  'document',
  'document_version',
  'document_text',
  'document_text_sealed',
  'reminder',
  'reminder_delivery',
  'share_link',
  'document_link',
  'offline_fill',
  'private_notice',
  'upload_idempotency',
  'export',
  'doc_collection',
  'doc_collection_item',
] as const;
type Counts = Record<(typeof GUARDED)[number], number>;

/** How many rows of each the caller is given. */
async function counts(executor: Db): Promise<Counts> {
  const r = await sql<Counts>`select ${sql.raw(
    GUARDED.map((t) => `(select count(*)::int from ${t}) as ${t}`).join(', '),
  )}`.execute(executor);
  return r.rows[0] as Counts;
}

const nothing = Object.fromEntries(GUARDED.map((t) => [t, 0])) as Counts;

describe.skipIf(!testAdminUrl())('a rule for each kind of caller', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let db: Db;
  let everything: Counts;

  const hh = randomUUID();
  const ids = {
    account: '',
    member: '',
    lease: '',
    will: '',
    /** The lease's second scan: the newest, and the one a link is given. */
    leaseV2: '',
    /** A grown-up who shares the lease too, whose sight of it can end. */
    adultAccount: '',
    adultMember: '',
  };
  /**
   * Share links: the one asked as, one for the other document, three that
   * are over, and the adult's.
   */
  const shares = { lease: '', will: '', revoked: '', expired: '', locked: '', byAdult: '' };

  const one = async <T>(text: string, values: unknown[] = []): Promise<T> =>
    (await admin.query<T & object>(text, values)).rows[0] as T;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 1 });
    // One connection: whoever asks next is given the one somebody used before.
    db = createDb(createPool(tdb.appUrl, 1));

    // As the owning role, round every policy: two documents, each with all
    // that can hang off it.
    await admin.query("insert into household (id, name) values ($1, 'Rules')", [hh]);
    ids.member = (
      await one<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Owner') returning id",
        [hh],
      )
    ).id;
    ids.account = (
      await one<{ id: string }>('insert into account (email) values ($1) returning id', [
        `rules-${hh}@example.test`,
      ])
    ).id;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'owner')",
      [ids.account, hh, ids.member],
    );
    const vault = await one<{ id: string }>(
      "insert into vault (household_id, kind, label) values ($1, 'local', 'test') returning id",
      [hh],
    );
    const scope = await one<{ id: string }>(
      "insert into scope_key (household_id, kind, key_wrapped) values ($1, 'household', '\\x00') returning id",
      [hh],
    );
    const session = await one<{ id: string }>(
      `insert into session (account_id, household_id, refresh_hash, expires_at)
       values ($1, $2, $3, now() + interval '30 days') returning id`,
      [ids.account, hh, randomBytes(32)],
    );
    for (const title of ['lease', 'will'] as const) {
      const doc = await one<{ id: string }>(
        'insert into document (household_id, title) values ($1, $2) returning id',
        [hh, title],
      );
      ids[title] = doc.id;
      const version = await one<{ id: string }>(
        `insert into document_version
           (household_id, document_id, version_no, filename, mime, byte_size, sha256,
            cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope)
         values ($1, $2, 1, 'scan.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00', $3, $4, '\\x00', $5)
         returning id`,
        [hh, doc.id, `k-${doc.id}`, vault.id, scope.id],
      );
      await admin.query(
        'insert into document_text (version_id, household_id, document_id, content) values ($1, $2, $3, $4)',
        [version.id, hh, doc.id, `the words of the ${title}`],
      );
      await admin.query(
        "insert into document_text_sealed (version_id, household_id, document_id, content_cipher) values ($1, $2, $3, '\\x00')",
        [version.id, hh, doc.id],
      );
      const reminder = await one<{ id: string }>(
        `insert into reminder (household_id, document_id, kind, fire_at, note)
         values ($1, $2, 'manual', '2027-01-01', 'ring the broker') returning id`,
        [hh, doc.id],
      );
      await admin.query(
        "insert into reminder_delivery (reminder_id, household_id, fire_date, channel) values ($1, $2, '2027-01-01', 'email')",
        [reminder.id, hh],
      );
      await admin.query(
        'insert into offline_fill (household_id, session_id, version_id) values ($1, $2, $3)',
        [hh, session.id, version.id],
      );
      await admin.query(
        'insert into private_notice (household_id, document_id, member_id) values ($1, $2, $3)',
        [hh, doc.id, ids.member],
      );
      await admin.query(
        `insert into upload_idempotency (idempotency_key, household_id, document_id, version_id, account_id)
         values ($1, $2, $3, $4, $5)`,
        [randomUUID(), hh, doc.id, version.id, ids.account],
      );
    }
    ids.leaseV2 = (
      await one<{ id: string }>(
        `insert into document_version
           (household_id, document_id, version_no, filename, mime, byte_size, sha256,
            cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope)
         values ($1, $2, 2, 'rescan.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00', $3, $4, '\\x00', $5)
         returning id`,
        [hh, ids.lease, `k-${ids.lease}-2`, vault.id, scope.id],
      )
    ).id;
    await admin.query(
      'insert into document_link (household_id, a, b) values ($1, least($2::uuid, $3::uuid), greatest($2::uuid, $3::uuid))',
      [hh, ids.lease, ids.will],
    );
    await admin.query('insert into export (household_id, requested_by) values ($1, $2)', [
      hh,
      ids.account,
    ]);
    // A collection for everyone, with both documents in it (0036).
    const collection = await one<{ id: string }>(
      `insert into doc_collection (household_id, name, audience, owner_member_id)
       values ($1, 'Papers for the broker', 'everyone', $2) returning id`,
      [hh, ids.member],
    );
    await admin.query(
      `insert into doc_collection_item (collection_id, document_id, household_id, position)
       values ($1, $2, $3, 1), ($1, $4, $3, 2)`,
      [collection.id, ids.lease, hh, ids.will],
    );
    ids.adultMember = (
      await one<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Adult') returning id",
        [hh],
      )
    ).id;
    ids.adultAccount = (
      await one<{ id: string }>('insert into account (email) values ($1) returning id', [
        `rules-adult-${hh}@example.test`,
      ])
    ).id;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'adult')",
      [ids.adultAccount, hh, ids.adultMember],
    );
    const share = async (doc: string, ended = '', by = ids.account) => {
      const { id } = await one<{ id: string }>(
        `insert into share_link (household_id, document_id, token_hash, created_by, expires_at)
         values ($1, $2, $3, $4, now() + interval '7 days') returning id`,
        [hh, doc, randomBytes(32), by],
      );
      if (ended) await admin.query(`update share_link set ${ended} where id = $1`, [id]);
      return id;
    };
    shares.lease = await share(ids.lease);
    shares.will = await share(ids.will);
    shares.revoked = await share(ids.lease, 'revoked_at = now(), revoked_by = created_by');
    shares.expired = await share(ids.lease, "expires_at = now() - interval '1 minute'");
    // Ten wrong PINs: MAX_PIN_ATTEMPTS in shares.ts.
    shares.locked = await share(ids.lease, 'attempts = 10');
    shares.byAdult = await share(ids.lease, '', ids.adultAccount);

    everything = await counts(createDb(admin));
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  const as = <T>(actor: Actor, fn: (trx: Db) => Promise<T>) =>
    actor.kind === 'system'
      ? withSystem(db, hh, fn)
      : withScope(db, { householdId: hh, actor }, fn);
  const link = (shareId: string): Actor => ({ kind: 'link', shareId });
  const addDocument = (trx: Db) =>
    trx.insertInto('document').values({ household_id: hh, title: 'slipped in' }).execute();

  it('a transaction with no actor sees no documents', async () => {
    // Somebody asked first, on the only connection there is: an unset
    // setting now reads '' rather than null, which is the case to test.
    expect(await as({ kind: 'system' }, counts)).toEqual(everything);

    const seen = await db.transaction().execute(async (trx) => {
      await sql`select set_config('app.household_id', ${hh}, true)`.execute(trx);
      const actor = await sql<{ actor: string | null }>`
        select current_setting('app.actor', true) as actor`.execute(trx);
      return { actor: actor.rows[0]?.actor, counts: await counts(trx) };
    });
    expect(seen).toEqual({ actor: '', counts: nothing });

    // Nor may it write one.
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`select set_config('app.household_id', ${hh}, true)`.execute(trx);
        await addDocument(trx);
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('a link actor gets no row for a document outside its share', async () => {
    const seen = await as(link(shares.lease), async (trx) => ({
      documents: (await trx.selectFrom('document').select('id').execute()).map((r) => r.id),
      versions: (await trx.selectFrom('document_version').select('id').execute()).map((r) => r.id),
      shares: (await trx.selectFrom('share_link').select('id').execute()).map((r) => r.id),
      counts: await counts(trx),
    }));
    // Its document, the newest scan of it and its own share: not the first
    // scan, the text, the reminders, the link to the will, anybody's phone's
    // copy or the household's export.
    expect(seen).toEqual({
      documents: [ids.lease],
      versions: [ids.leaseV2],
      shares: [shares.lease],
      counts: { ...nothing, document: 1, document_version: 1, share_link: 1 },
    });

    await as(link(shares.lease), async (trx) => {
      // Asked for by id, the other document is not there.
      expect(
        await trx.selectFrom('document').select('id').where('id', '=', ids.will).executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await trx
          .selectFrom('document_version')
          .select('id')
          .where('document_id', '=', ids.will)
          .execute(),
      ).toEqual([]);
      // Nor can it be changed.
      const changed = await trx
        .updateTable('document')
        .set({ title: 'changed' })
        .where('id', '=', ids.will)
        .executeTakeFirst();
      expect(changed.numUpdatedRows).toBe(0n);
      // A wrong PIN is still counted, on the link's own row.
      const counted = await trx
        .updateTable('share_link')
        .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
        .where('id', '=', shares.lease)
        .returning('attempts')
        .executeTakeFirst();
      expect(counted?.attempts).toBe(1);
      // Its own document, file and share it reads, and cannot change or
      // take away: counting is the only write a link makes.
      const own = await trx
        .updateTable('document')
        .set({ title: 'changed' })
        .where('id', '=', ids.lease)
        .executeTakeFirst();
      expect(own.numUpdatedRows).toBe(0n);
      const file = await trx
        .updateTable('document_version')
        .set({ filename: 'changed.pdf' })
        .where('document_id', '=', ids.lease)
        .executeTakeFirst();
      expect(file.numUpdatedRows).toBe(0n);
      for (const gone of [
        trx.deleteFrom('share_link').where('id', '=', shares.lease),
        trx.deleteFrom('document_version').where('document_id', '=', ids.lease),
        trx.deleteFrom('document').where('id', '=', ids.lease),
      ]) {
        expect((await gone.executeTakeFirst()).numDeletedRows).toBe(0n);
      }
    });
    await expect(as(link(shares.lease), addDocument)).rejects.toThrow(/row-level security/);
    // Nor add a file to its own document.
    await expect(
      as(link(shares.lease), (trx) =>
        sql`insert into document_version
              (household_id, document_id, version_no, filename, mime, byte_size, sha256,
               cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope)
            select household_id, document_id, version_no + 1, filename, mime, byte_size, sha256,
                   cipher_bytes, cipher_sha256, storage_key || '-2', vault_id, file_key_wrapped,
                   wrapped_by_scope
              from document_version where document_id = ${ids.lease}`.execute(trx),
      ),
    ).rejects.toThrow(/row-level security/);

    // The other document's link is given that one, and only that one.
    expect(
      await as(link(shares.will), (trx) => trx.selectFrom('document').select('id').execute()),
    ).toEqual([{ id: ids.will }]);

    // A link taken back, expired or locked by wrong PINs is given nothing,
    // even of its own document.
    for (const over of [shares.revoked, shares.expired, shares.locked]) {
      expect(await as(link(over), counts)).toEqual(nothing);
    }
    // Nor is a live one whose document went in the Trash.
    await admin.query('update document set deleted_at = now() where id = $1', [ids.lease]);
    try {
      expect(await as(link(shares.lease), counts)).toEqual(nothing);
    } finally {
      await admin.query('update document set deleted_at = null where id = $1', [ids.lease]);
    }
    // And a share id from nowhere is given nothing.
    expect(await as(link(randomUUID()), counts)).toEqual(nothing);
  });

  it('a link counts its opens and wrong PINs, upwards, and changes nothing else on its share', async () => {
    const counted = await as(link(shares.lease), (trx) =>
      trx
        .updateTable('share_link')
        .set((eb) => ({ open_count: eb('open_count', '+', 1), last_opened_at: new Date() }))
        .where('id', '=', shares.lease)
        .returning('open_count')
        .executeTakeFirst(),
    );
    expect(counted?.open_count).toBeGreaterThan(0);
    // And its downloads (0041), upwards too.
    const downloaded = await as(link(shares.lease), (trx) =>
      trx
        .updateTable('share_link')
        .set((eb) => ({ downloads_used: eb('downloads_used', '+', 1) }))
        .where('id', '=', shares.lease)
        .returning('downloads_used')
        .executeTakeFirst(),
    );
    expect(downloaded?.downloads_used).toBe(1);

    // When it ends, its PIN, whom it is for, and its counts going down are
    // the sharer's.
    const theSharers: [string, (trx: Db) => Promise<unknown>][] = [
      [
        'a later end',
        (trx) =>
          trx
            .updateTable('share_link')
            .set({ expires_at: new Date('2126-01-01') })
            .where('id', '=', shares.lease)
            .execute(),
      ],
      [
        'a PIN of its own choosing',
        (trx) =>
          trx
            .updateTable('share_link')
            .set({ pin_hash: 'chosen by whoever holds the link' })
            .where('id', '=', shares.lease)
            .execute(),
      ],
      [
        'somebody else',
        (trx) =>
          trx
            .updateTable('share_link')
            .set({ recipient_label: 'somebody else' })
            .where('id', '=', shares.lease)
            .execute(),
      ],
      [
        'taken back',
        (trx) =>
          trx
            .updateTable('share_link')
            .set({ revoked_at: new Date(), revoked_by: ids.account })
            .where('id', '=', shares.lease)
            .execute(),
      ],
      [
        'fewer wrong PINs',
        (trx) =>
          trx
            .updateTable('share_link')
            .set((eb) => ({ attempts: eb('attempts', '-', 1) }))
            .where('id', '=', shares.lease)
            .execute(),
      ],
      [
        'fewer opens',
        (trx) =>
          trx
            .updateTable('share_link')
            .set((eb) => ({ open_count: eb('open_count', '-', 1) }))
            .where('id', '=', shares.lease)
            .execute(),
      ],
      // 5.18 (0041): what it gives and how often are the sharer's too.
      [
        'more opens than it was given',
        (trx) =>
          trx
            .updateTable('share_link')
            .set({ max_opens: 1000 })
            .where('id', '=', shares.lease)
            .execute(),
      ],
      [
        'the file, on a link to view',
        (trx) =>
          trx
            .updateTable('share_link')
            .set({ permission: 'view' })
            .where('id', '=', shares.lease)
            .execute(),
      ],
      [
        'fewer downloads',
        (trx) =>
          trx
            .updateTable('share_link')
            .set((eb) => ({ downloads_used: eb('downloads_used', '-', 1) }))
            .where('id', '=', shares.lease)
            .execute(),
      ],
      [
        'a new token, by way of a conflict',
        (trx) =>
          sql`insert into share_link (id, household_id, document_id, token_hash, created_by, expires_at)
              select id, household_id, document_id, ${randomBytes(32)}, created_by, expires_at
                from share_link where id = ${shares.lease}
              on conflict (id) do update set token_hash = excluded.token_hash`.execute(trx),
      ],
    ];
    for (const [what, change] of theSharers) {
      await expect(as(link(shares.lease), change), what).rejects.toThrow(
        /only count its opens|row-level security/,
      );
    }

    // Somebody signed in is not held to it: the trigger is the link's alone.
    const p = {
      householdId: hh,
      accountId: ids.account,
      memberId: ids.member,
      role: 'owner' as const,
    };
    const relabelled = await withPrincipal(db, p, (trx) =>
      trx
        .updateTable('share_link')
        .set({ recipient_label: 'the letting agent' })
        .where('id', '=', shares.lease)
        .executeTakeFirst(),
    );
    expect(relabelled.numUpdatedRows).toBe(1n);
  });

  it("a link lasts only as long as its maker's sight of the document", async () => {
    const documents = async () => (await as(link(shares.byAdult), counts)).document;
    expect(await documents()).toBe(1);

    // Made Only me by the owner: the adult no longer sees it, nor does their link.
    await admin.query(
      "update document set visibility = 'private', owner_member_id = $1 where id = $2",
      [ids.member, ids.lease],
    );
    try {
      expect(await documents()).toBe(0);
    } finally {
      await admin.query(
        "update document set visibility = 'household', owner_member_id = null where id = $1",
        [ids.lease],
      );
    }

    // For the adults, and the adult made a teen.
    await admin.query("update document set visibility = 'adults' where id = $1", [ids.lease]);
    try {
      expect(await documents()).toBe(1);
      await admin.query("update account_household set role = 'teen' where account_id = $1", [
        ids.adultAccount,
      ]);
      expect(await documents()).toBe(0);
    } finally {
      await admin.query("update account_household set role = 'adult' where account_id = $1", [
        ids.adultAccount,
      ]);
      await admin.query("update document set visibility = 'household' where id = $1", [ids.lease]);
    }

    // Their sign-in taken away.
    await admin.query('delete from account_household where account_id = $1', [ids.adultAccount]);
    try {
      expect(await documents()).toBe(0);
    } finally {
      await admin.query(
        "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'adult')",
        [ids.adultAccount, hh, ids.adultMember],
      );
    }
    expect(await documents()).toBe(1);
  });

  it("a collection's link is given what it was made with, as its sharer may see it now (0042)", async () => {
    // The adult's link to a collection for everyone with both documents in
    // it, made with the lease alone.
    const collection = await one<{ id: string }>(
      `insert into doc_collection (household_id, name, audience, owner_member_id)
       values ($1, 'For the valuer', 'everyone', $2) returning id`,
      [hh, ids.member],
    );
    // Both in it before the links are made.
    await admin.query(
      `insert into doc_collection_item (collection_id, document_id, household_id, position, added_at)
       values ($1, $2, $3, 1, now() - interval '2 hours'), ($1, $4, $3, 2, now() - interval '2 hours')`,
      [collection.id, ids.lease, hh, ids.will],
    );
    const made = async (follow: boolean) => {
      const { id } = await one<{ id: string }>(
        `insert into share_link (household_id, collection_id, follow_collection, follow_audience,
                                 token_hash, created_by, expires_at, created_at)
         values ($1, $2, $3, $4, $5, $6, now() + interval '7 days', now() - interval '1 hour')
         returning id`,
        [hh, collection.id, follow, follow ? 'everyone' : null, randomBytes(32), ids.adultAccount],
      );
      await admin.query(
        `insert into share_link_item (share_id, household_id, collection_id, document_id, position)
         values ($1, $2, $3, $4, 1)`,
        [id, hh, collection.id, ids.lease],
      );
      return id;
    };
    const snapshot = await made(false);
    const following = await made(true);
    const given = (shareId: string) =>
      as(link(shareId), async (trx) => ({
        documents: (await trx.selectFrom('document').select('id').execute()).map((r) => r.id),
        versions: (await trx.selectFrom('document_version').select('id').execute()).map(
          (r) => r.id,
        ),
        shares: (await trx.selectFrom('share_link').select('id').execute()).map((r) => r.id),
      }));
    // The lease, its newest file and the share; not the will, which was in
    // the collection when it was made and was not ticked.
    expect(await given(snapshot)).toEqual({
      documents: [ids.lease],
      versions: [ids.leaseV2],
      shares: [snapshot],
    });
    // Nothing follows by being in the collection, or put in it since (the
    // 5.19 review): only what the vault decided, as it was put in, and
    // wrote down. Written down as left out, it is not given either.
    await admin.query(
      'update doc_collection_item set added_at = now() where collection_id = $1 and document_id = $2',
      [collection.id, ids.will],
    );
    expect((await given(following)).documents).toEqual([ids.lease]);
    await admin.query(
      `insert into share_link_item (share_id, household_id, collection_id, document_id, position, kind)
       values ($1, $2, $3, $4, 2, 'left_out')`,
      [following, hh, collection.id, ids.will],
    );
    expect((await given(following)).documents).toEqual([ids.lease]);
    // Decided to follow, the will goes on the link that follows — everybody
    // the collection is for may see it — and not on the other.
    await admin.query(
      "update share_link_item set kind = 'followed' where share_id = $1 and document_id = $2",
      [following, ids.will],
    );
    expect((await given(following)).documents.sort()).toEqual([ids.lease, ids.will].sort());
    expect((await given(snapshot)).documents).toEqual([ids.lease]);
    // For the adults now, it is not everybody's: it is not given any more.
    await admin.query("update document set visibility = 'adults' where id = $1", [ids.will]);
    expect((await given(following)).documents).toEqual([ids.lease]);
    await admin.query("update document set visibility = 'household' where id = $1", [ids.will]);

    const nothing = { documents: [], versions: [], shares: [] };
    const ends: Array<[string, string, string, unknown[]]> = [
      [
        'the sharer made a teen, who never shares outside',
        "update account_household set role = 'teen' where account_id = $1",
        "update account_household set role = 'adult' where account_id = $1",
        [ids.adultAccount],
      ],
      [
        'the collection made Only me',
        "update doc_collection set audience = 'only_me' where id = $1",
        "update doc_collection set audience = 'everyone' where id = $1",
        [collection.id],
      ],
      [
        'the collection deleted',
        'update doc_collection set deleted_at = now() where id = $1',
        'update doc_collection set deleted_at = null where id = $1',
        [collection.id],
      ],
      [
        'the link paused after a restore',
        "update share_link set paused_at = now(), paused_reason = 'restored' where id = $1",
        'update share_link set paused_at = null, paused_reason = null where id = $1',
        [snapshot],
      ],
    ];
    for (const [why, end, back, values] of ends) {
      await admin.query(end, values);
      try {
        expect(await given(snapshot), why).toEqual(nothing);
      } finally {
        await admin.query(back, values);
      }
    }
    // The lease made the owner's own: the adult cannot see it, so neither
    // can the link; taken out of the collection, or put in the Trash, too.
    const items: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
      [
        'made somebody else’s Only me',
        () =>
          admin.query(
            "update document set visibility = 'private', owner_member_id = $2 where id = $1",
            [ids.lease, ids.member],
          ),
        () =>
          admin.query(
            "update document set visibility = 'household', owner_member_id = null where id = $1",
            [ids.lease],
          ),
      ],
      [
        'taken out of the collection',
        () =>
          admin.query(
            'delete from doc_collection_item where document_id = $1 and collection_id = $2',
            [ids.lease, collection.id],
          ),
        () =>
          admin.query(
            `insert into doc_collection_item (collection_id, document_id, household_id, position)
             values ($1, $2, $3, 1)`,
            [collection.id, ids.lease, hh],
          ),
      ],
      [
        'in the Trash',
        () => admin.query('update document set deleted_at = now() where id = $1', [ids.lease]),
        () => admin.query('update document set deleted_at = null where id = $1', [ids.lease]),
      ],
    ];
    for (const [why, end, back] of items) {
      await end();
      try {
        // The link is still there; the document is simply not given.
        expect(await given(snapshot), why).toEqual({ ...nothing, shares: [snapshot] });
      } finally {
        await back();
      }
    }
    expect((await given(snapshot)).documents).toEqual([ids.lease]);
    // Nor can a link be turned into another: what it is to is fixed.
    await expect(
      admin.query('update share_link set collection_id = null, document_id = $2 where id = $1', [
        snapshot,
        ids.will,
      ]),
    ).rejects.toThrow(/a link keeps what it was made for/);
    await expect(
      admin.query('update share_link set follow_collection = true where id = $1', [snapshot]),
    ).rejects.toThrow(/a link keeps what it was made for/);

    // Gone again, so the counts the other tests take are as they were.
    await admin.query('delete from share_link where id = any($1)', [[snapshot, following]]);
    await admin.query('delete from doc_collection where id = $1', [collection.id]);
  });

  it('an upload actor and an anonymous page see no document', async () => {
    for (const actor of [{ kind: 'upload', requestId: randomUUID() } as const, ANONYMOUS]) {
      expect(await as(actor, counts), actor.kind).toEqual(nothing);
      await expect(as(actor, addDocument), actor.kind).rejects.toThrow(/row-level security/);
    }
    // Somebody signed in, and the vault itself, are given all of it.
    const p = {
      householdId: hh,
      accountId: ids.account,
      memberId: ids.member,
      role: 'owner' as const,
    };
    expect(await withPrincipal(db, p, counts)).toEqual(everything);
    expect(await as({ kind: 'system' }, counts)).toEqual(everything);
  });
});
