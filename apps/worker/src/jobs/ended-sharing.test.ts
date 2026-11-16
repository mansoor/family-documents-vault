import { randomBytes, randomUUID } from 'node:crypto';
import { EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { appendAudit, createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeEndedSharing } from './ended-sharing.js';

const MASTER = 'ended-sharing-test-master-key-with-32-bytes';

/**
 * Ended links and requests removed after a while (0.9.0, RQ): what ended
 * for good longer ago than the household keeps it goes; what is paused,
 * used up, still changeable, recent, waiting on a file or on its pages'
 * files stays; a filed file keeps its row (and so its document's history);
 * the activity log keeps every line, and what it needs to know whom each is
 * for.
 */
describe.skipIf(!testAdminUrl())('ended links and requests, removed', () => {
  let tdb: TestDatabase;
  let admin: pg.Pool;
  let db: Db;
  const hh = randomUUID();
  /** A household that keeps them for ever. */
  const never = randomUUID();
  const keys = new ScopeKeys(new EnvKeyProvider(MASTER));
  const people: Record<'owner' | 'adult', { account: string; member: string }> = {} as never;
  let vault = '';
  let scope = '';
  let doc = '';
  let version = '';
  const logged: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
  const deps = () => ({
    admin,
    db,
    log: (_l: string, msg: string, extra?: Record<string, unknown>) => {
      logged.push({ msg, ...(extra ? { extra } : {}) });
    },
  });
  const days = (n: number) => new Date(Date.now() - n * 864e5);

  beforeAll(async () => {
    tdb = await createTestDatabase();
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    db = createDb(createPool(tdb.appUrl, 2));
    await admin.query("insert into household (id, name) values ($1, 'Ended'), ($2, 'Never')", [
      hh,
      never,
    ]);
    await admin.query('update household set ended_sharing_days = null where id = $1', [never]);
    // Kept since long ago: the upgrade's own grace is tried below.
    await admin.query(
      "update household set ended_sharing_from = now() - interval '2 years' where id = $1",
      [hh],
    );
    for (const role of ['owner', 'adult'] as const) {
      const member = (
        await admin.query<{ id: string }>(
          'insert into member (household_id, display_name) values ($1, $2) returning id',
          [hh, role],
        )
      ).rows[0]?.id as string;
      const account = (
        await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
          `${role}-${randomBytes(3).toString('hex')}@ended.test`,
        ])
      ).rows[0]?.id as string;
      await admin.query(
        'insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, $4)',
        [account, hh, member, role],
      );
      people[role] = { account, member };
    }
    await withSystem(db, hh, async (trx) => {
      await keys.mintHouseholdKeys(trx, hh);
      const v = await trx
        .insertInto('vault')
        .values({ household_id: hh, kind: 'local', label: 'test', status: 'ok' })
        .returning('id')
        .executeTakeFirstOrThrow();
      vault = v.id;
    });
    scope = (
      await admin.query<{ id: string }>(
        "select id from scope_key where household_id = $1 and kind = 'household'",
        [hh],
      )
    ).rows[0]?.id as string;
    doc = (
      await admin.query<{ id: string }>(
        "insert into document (household_id, title) values ($1, 'Filed') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    version = (
      await admin.query<{ id: string }>(
        `insert into document_version
           (household_id, document_id, version_no, filename, mime, byte_size, sha256,
            cipher_bytes, cipher_sha256, storage_key, vault_id, file_key_wrapped, wrapped_by_scope)
         values ($1, $2, 1, 'a.pdf', 'application/pdf', 1, '\\x00', 1, '\\x00', $3, $4, '\\x00', $5)
         returning id`,
        [hh, doc, `${hh}/${doc}/1/${randomUUID()}.enc`, vault, scope],
      )
    ).rows[0]?.id as string;
  }, 90_000);

  afterAll(async () => {
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  /** A link to the document, ending at `expires`; `set` changes it after. */
  const link = async (expires: Date, set?: string, household = hh) => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into share_link (household_id, document_id, token_hash, created_by, expires_at,
                               permission, recipient_label, created_at)
       values ($1, $2, $3, $4, $5, 'view', 'the visa agent', $5::timestamptz - interval '1 day')
       returning id`,
      [
        household,
        household === hh ? doc : await neverDoc(),
        randomBytes(32),
        people.owner.account,
        expires,
      ],
    );
    const id = rows[0]?.id as string;
    if (set) await admin.query(`update share_link set ${set} where id = $1`, [id]);
    return id;
  };
  let neverDocument = '';
  const neverDoc = async () => {
    if (!neverDocument) {
      neverDocument = (
        await admin.query<{ id: string }>(
          "insert into document (household_id, title) values ($1, 'Theirs') returning id",
          [never],
        )
      ).rows[0]?.id as string;
    }
    return neverDocument;
  };

  /** A request, ending at `expires`; `set` changes it after. */
  const request = async (expires: Date, set?: string) => {
    const { rows } = await admin.query<{ id: string }>(
      `insert into upload_request
         (household_id, created_by, requester_member_id, title, recipient_label, token_hash,
          expires_at, created_at, review_by)
       values ($1, $2, $3, 'Tax papers', 'Jane, accountant', $4, $5,
               $5::timestamptz - interval '1 day', 'me')
       returning id`,
      [hh, people.adult.account, people.adult.member, randomBytes(32), expires],
    );
    const id = rows[0]?.id as string;
    if (set) await admin.query(`update upload_request set ${set} where id = $1`, [id]);
    return id;
  };

  /** A file sent through it: waiting, filed, or refused; its bytes gone unless said. */
  const file = async (
    requestId: string,
    state: 'received' | 'accepted' | 'rejected',
    opts: { bytesGone?: boolean } = {},
  ) => {
    const item = (
      await admin.query<{ id: string }>(
        `insert into upload_request_item (household_id, request_id, position, label)
         values ($1, $2, (select coalesce(max(position), 0) + 1 from upload_request_item
                           where request_id = $2), 'W-2')
         returning id`,
        [hh, requestId],
      )
    ).rows[0]?.id as string;
    const decided = state !== 'received';
    const gone = decided && opts.bytesGone !== false;
    const { rows } = await admin.query<{ id: string }>(
      `insert into incoming_file
         (household_id, request_id, review_by, requester_member_id, item_id, state, original_name,
          mime, byte_size, sha256, cipher_bytes, cipher_sha256, storage_key, vault_id,
          file_key_wrapped, wrapped_by_scope, scope, scan_state, received_at, submitted_at,
          decided_by, decided_at, document_id, version_id, object_removed_at)
       values ($1, $2, 'me', $3, $4, $5, $6, 'application/pdf', 10, '\\x01', 10, '\\x01', $7, $8,
               '\\x00', $9, 'member', 'unscanned', now(), now(), $10, $11, $12, $13, $14)
       returning id`,
      [
        hh,
        requestId,
        people.adult.member,
        item,
        state,
        state === 'rejected' ? null : 'W-2.pdf',
        `${hh}/incoming/${requestId}/${randomUUID()}.enc`,
        vault,
        scope,
        decided ? people.adult.account : null,
        decided ? new Date() : null,
        state === 'accepted' ? doc : null,
        state === 'accepted' ? version : null,
        gone ? new Date() : null,
      ],
    );
    return rows[0]?.id as string;
  };

  const exists = async (table: string, id: string) =>
    ((await admin.query(`select 1 from ${table} where id = $1`, [id])).rowCount ?? 0) > 0;

  it('links: taken back or past their end longer ago than kept go; the rest stay', async () => {
    const takenBack = await link(
      new Date(Date.now() + 5 * 864e5),
      `revoked_at = '${days(100).toISOString()}'`,
    );
    const expiredLong = await link(days(95));
    const expiredLately = await link(days(10));
    const paused = await link(
      new Date(Date.now() + 5 * 864e5),
      "paused_at = now() - interval '200 days', paused_reason = 'restored'",
    );
    const usedUp = await link(new Date(Date.now() + 5 * 864e5), 'max_opens = 1, open_count = 1');
    const locked = await link(new Date(Date.now() + 5 * 864e5), 'attempts = 10');
    const live = await link(new Date(Date.now() + 5 * 864e5));
    // Its pages' files not yet deleted: it waits for the nightly prune.
    const withPages = await link(days(120));
    await admin.query(
      `insert into share_page (household_id, share_id, document_id, version_id, n, storage_key)
       values ($1, $2, $3, $4, 1, 'pages/1.enc')`,
      [hh, withPages, doc, version],
    );
    // Somebody else's household, which keeps them for ever.
    const theirs = await link(days(400), undefined, never);
    // The activity log's lines about one.
    await withSystem(db, hh, (trx) =>
      appendAudit(trx, {
        householdId: hh,
        actorAccountId: people.owner.account,
        action: 'share.revoked',
        objectType: 'document',
        objectId: doc,
        detail: { share_id: takenBack },
      }),
    );

    const r = await removeEndedSharing(deps());
    expect(r.links).toBe(2);
    expect(await exists('share_link', takenBack)).toBe(false);
    expect(await exists('share_link', expiredLong)).toBe(false);
    for (const stays of [expiredLately, paused, usedUp, locked, live, withPages, theirs]) {
      expect(await exists('share_link', stays)).toBe(true);
    }
    // The line stays, and still names it.
    const lines = await admin.query(
      "select 1 from audit_event where household_id = $1 and detail->>'share_id' = $2",
      [hh, takenBack],
    );
    expect(lines.rowCount).toBe(1);
    // A document's link leaves no tombstone: its lines are the document's.
    expect(await exists('share_link_tombstone', takenBack)).toBe(false);
  });

  it("a collection's link leaves a tombstone: who made it, its collection, what it gave", async () => {
    const collection = (
      await admin.query<{ id: string }>(
        `insert into doc_collection (household_id, name, audience, owner_member_id)
         values ($1, 'For the valuer', 'everyone', $2) returning id`,
        [hh, people.owner.member],
      )
    ).rows[0]?.id as string;
    await admin.query(
      `insert into doc_collection_item (collection_id, document_id, household_id, position)
       values ($1, $2, $3, 1)`,
      [collection, doc, hh],
    );
    const { rows } = await admin.query<{ id: string }>(
      `insert into share_link (household_id, collection_id, token_hash, created_by, expires_at,
                               permission, recipient_label, created_at, revoked_at)
       values ($1, $2, $3, $4, now() - interval '100 days', 'view', 'the valuer',
               now() - interval '101 days', now() - interval '100 days') returning id`,
      [hh, collection, randomBytes(32), people.owner.account],
    );
    const id = rows[0]?.id as string;
    await admin.query(
      `insert into share_link_item (share_id, household_id, collection_id, document_id, position)
       values ($1, $2, $3, $4, 1)`,
      [id, hh, collection, doc],
    );
    expect((await removeEndedSharing(deps())).links).toBe(1);
    expect(await exists('share_link', id)).toBe(false);
    const tomb = await admin.query(
      'select created_by, collection_id, document_ids from share_link_tombstone where id = $1',
      [id],
    );
    expect(tomb.rows[0]).toEqual({
      created_by: people.owner.account,
      collection_id: collection,
      document_ids: [doc],
    });
    // The collection, and what is in it, are untouched.
    expect(await exists('doc_collection', collection)).toBe(true);
    expect(await exists('document', doc)).toBe(true);
  });

  it('requests: ended long ago and everything decided go; a filed file keeps its row and its history', async () => {
    const done = await request(
      new Date(Date.now() + 5 * 864e5),
      `revoked_at = '${days(100).toISOString()}'`,
    );
    const filed = await file(done, 'accepted');
    const refused = await file(done, 'rejected');
    const waiting = await request(days(100));
    const stillWaiting = await file(waiting, 'received');
    const bytesLeft = await request(days(100));
    await file(bytesLeft, 'rejected', { bytesGone: false });
    const closedLately = await request(
      new Date(Date.now() + 5 * 864e5),
      `closed_at = '${days(10).toISOString()}', closed_reason = 'submitted'`,
    );
    const paused = await request(
      new Date(Date.now() + 5 * 864e5),
      "paused_at = now() - interval '200 days', paused_reason = 'restored'",
    );
    const empty = await request(days(91));
    await withSystem(db, hh, (trx) =>
      appendAudit(trx, {
        householdId: hh,
        actorAccountId: people.adult.account,
        action: 'upload_request.created',
        objectType: 'upload_request',
        objectId: done,
      }),
    );

    logged.length = 0;
    const r = await removeEndedSharing(deps());
    expect(r.requests).toBe(2);
    expect(r.filesKept).toBe(1);
    expect(await exists('upload_request', done)).toBe(false);
    expect(await exists('upload_request', empty)).toBe(false);
    for (const stays of [waiting, bytesLeft, closedLately, paused]) {
      expect(await exists('upload_request', stays)).toBe(true);
    }
    // The waiting file is untouched.
    expect(await exists('incoming_file', stillWaiting)).toBe(true);
    // The filed file stays, let go of its request, saying whom it was for.
    const kept = await admin.query(
      `select request_id, item_id, session_id, state, document_id, version_id, request_label,
              request_removed_at is not null as removed
         from incoming_file where id = $1`,
      [filed],
    );
    expect(kept.rows[0]).toEqual({
      request_id: null,
      item_id: null,
      session_id: null,
      state: 'accepted',
      document_id: doc,
      version_id: version,
      request_label: 'Jane, accountant',
      removed: true,
    });
    // A refused file's row goes with its request; its bytes were gone.
    expect(await exists('incoming_file', refused)).toBe(false);
    // The document and its version stay.
    expect(await exists('document_version', version)).toBe(true);
    // The activity log keeps its line, and whom it is for.
    const lines = await admin.query(
      "select 1 from audit_event where household_id = $1 and object_type = 'upload_request' and object_id = $2",
      [hh, done],
    );
    expect(lines.rowCount).toBe(1);
    const tomb = await admin.query(
      'select requester_member_id, review_by, moved_to_owners_at from upload_request_tombstone where id = $1',
      [done],
    );
    expect(tomb.rows[0]).toEqual({
      requester_member_id: people.adult.member,
      review_by: 'me',
      moved_to_owners_at: null,
    });
    // How many, never what.
    const said = JSON.stringify(logged);
    expect(said).toContain('ended links and requests removed');
    expect(said).not.toContain('Jane');
    expect(said).not.toContain('Tax papers');
    expect(said).not.toContain(done);
  });

  it('a second night removes nothing more; Never keeps everything', async () => {
    const r = await removeEndedSharing(deps());
    expect(r).toMatchObject({ links: 0, requests: 0 });
    // Never, for this household too: nothing of it is looked at.
    await admin.query('update household set ended_sharing_days = null where id = $1', [hh]);
    const old = await link(days(500));
    expect((await removeEndedSharing(deps())).links).toBe(0);
    expect(await exists('share_link', old)).toBe(true);
    // 30 days: one ended 40 days ago goes.
    await admin.query('update household set ended_sharing_days = 30 where id = $1', [hh]);
    const forty = await link(days(40));
    expect((await removeEndedSharing(deps())).links).toBeGreaterThanOrEqual(2);
    expect(await exists('share_link', forty)).toBe(false);
  });

  it('the tombstones are written by the vault alone, and never changed or removed', async () => {
    const asOwner = async (q: string) => {
      const c = new pg.Client({ connectionString: tdb.appUrl });
      await c.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                  set_config('app.role', 'owner', true)`,
          [hh, people.owner.account, people.owner.member],
        );
        return await c.query(q);
      } finally {
        await c.query('rollback').catch(() => undefined);
        await c.end();
      }
    };
    await expect(
      asOwner(
        `insert into upload_request_tombstone (id, household_id, requester_member_id, review_by)
         values ('${randomUUID()}', '${hh}', '${people.owner.member}', 'adults')`,
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(asOwner('delete from upload_request_tombstone')).rejects.toThrow(
      /permission denied/,
    );
    await expect(asOwner('update share_link_tombstone set document_ids = default')).rejects.toThrow(
      /permission denied/,
    );
  });
  it('after the upgrade, nothing goes sooner than the household’s time: counted from when 0106 ran (the review)', async () => {
    const fresh = randomUUID();
    // A household as the upgrade (or a restore of an older backup) leaves it:
    // the keeping begins now, whatever ended long before.
    await admin.query("insert into household (id, name) values ($1, 'Upgraded')", [fresh]);
    const doc2 = (
      await admin.query<{ id: string }>(
        "insert into document (household_id, title) values ($1, 'Theirs') returning id",
        [fresh],
      )
    ).rows[0]?.id as string;
    const old = (
      await admin.query<{ id: string }>(
        `insert into share_link (household_id, document_id, token_hash, created_by, expires_at,
                                 permission, created_at)
         values ($1, $2, $3, $4, now() - interval '400 days', 'view', now() - interval '401 days')
         returning id`,
        [fresh, doc2, randomBytes(32), people.owner.account],
      )
    ).rows[0]?.id as string;
    await removeEndedSharing(deps());
    expect(await exists('share_link', old)).toBe(true);
    // 89 days on: still kept. 91: gone.
    const at = (d: number) => () => new Date(Date.now() + d * 864e5);
    await removeEndedSharing({ ...deps(), now: at(89) });
    expect(await exists('share_link', old)).toBe(true);
    await removeEndedSharing({ ...deps(), now: at(91) });
    expect(await exists('share_link', old)).toBe(false);
    // Nobody signed in moves when the keeping began.
    const c = new pg.Client({ connectionString: tdb.appUrl });
    await c.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.role', 'owner', true)`,
        [fresh],
      );
      await expect(
        c.query("update household set ended_sharing_from = now() - interval '5 years'"),
      ).rejects.toThrow(/the vault's/);
    } finally {
      await c.query('rollback').catch(() => undefined);
      await c.end();
    }
  });

  it('one household failing is said by its id and code alone, and the others have their turn', async () => {
    const failing = randomUUID();
    await admin.query(
      "insert into household (id, name, ended_sharing_from) values ($1, 'Failing', now() - interval '2 years')",
      [failing],
    );
    const theirDoc = (
      await admin.query<{ id: string }>(
        "insert into document (household_id, title) values ($1, 'Theirs') returning id",
        [failing],
      )
    ).rows[0]?.id as string;
    const theirs = (
      await admin.query<{ id: string }>(
        `insert into share_link (household_id, document_id, token_hash, created_by, expires_at,
                                 permission, recipient_label, created_at)
         values ($1, $2, $3, $4, now() - interval '200 days', 'view', 'Secret Sam',
                 now() - interval '201 days')
         returning id`,
        [failing, theirDoc, randomBytes(32), people.owner.account],
      )
    ).rows[0]?.id as string;
    await admin.query(
      `create function test_refuse_link_delete() returns trigger language plpgsql as $f$
       begin
         if old.household_id = '${failing}' then raise exception 'refused for the test'; end if;
         return old;
       end $f$`,
    );
    await admin.query(
      `create trigger test_refuse_link_delete before delete on share_link
         for each row execute function test_refuse_link_delete()`,
    );
    try {
      const ours = await link(days(200));
      logged.length = 0;
      const r = await removeEndedSharing(deps());
      expect(r.failed).toBe(1);
      expect(await exists('share_link', theirs)).toBe(true);
      expect(await exists('share_link', ours)).toBe(false);
      const warned = logged.find((l) => l.msg.includes('could not be removed'));
      expect(warned?.extra).toEqual({ household: failing, code: 'P0001' });
      expect(JSON.stringify(logged)).not.toContain('Secret Sam');
    } finally {
      await admin.query('drop trigger test_refuse_link_delete on share_link');
      await admin.query('drop function test_refuse_link_delete()');
    }
  });

  it("a collection's link's tombstone is read as the link was: by the family, and by a restricted viewer only for a collection granted", async () => {
    const viewer = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name) values ($1, 'Vee') returning id",
        [hh],
      )
    ).rows[0]?.id as string;
    const viewerAccount = (
      await admin.query<{ id: string }>('insert into account (email) values ($1) returning id', [
        `vee-${randomBytes(3).toString('hex')}@ended.test`,
      ])
    ).rows[0]?.id as string;
    await admin.query(
      "insert into account_household (account_id, household_id, member_id, role) values ($1, $2, $3, 'viewer')",
      [viewerAccount, hh, viewer],
    );
    await admin.query('insert into access_restriction (member_id, household_id) values ($1, $2)', [
      viewer,
      hh,
    ]);
    const collection = async (name: string) =>
      (
        await admin.query<{ id: string }>(
          `insert into doc_collection (household_id, name, audience, owner_member_id)
           values ($1, $2, 'everyone', $3) returning id`,
          [hh, name, people.owner.member],
        )
      ).rows[0]?.id as string;
    const granted = await collection('Granted');
    const notGranted = await collection('Not granted');
    await admin.query(
      `insert into access_restriction_collection (restricted_member_id, household_id, collection_id)
       values ($1, $2, $3)`,
      [viewer, hh, granted],
    );
    const ended = async (collectionId: string) =>
      (
        await admin.query<{ id: string }>(
          `insert into share_link (household_id, collection_id, token_hash, created_by, expires_at,
                                   permission, created_at)
           values ($1, $2, $3, $4, now() - interval '100 days', 'view', now() - interval '101 days')
           returning id`,
          [hh, collectionId, randomBytes(32), people.owner.account],
        )
      ).rows[0]?.id as string;
    const links = [await ended(granted), await ended(notGranted)];
    /** Which of these links (or their tombstones) somebody signed in is given. */
    const given = async (role: string, member: string, account: string, table: string) => {
      const c = new pg.Client({ connectionString: tdb.appUrl });
      await c.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                  set_config('app.role', $4, true)`,
          [hh, account, member, role],
        );
        const { rows } = await c.query<{ id: string }>(
          `select id from ${table} where id = any($1::uuid[]) order by id`,
          [links],
        );
        return rows.map((r) => r.id);
      } finally {
        await c.query('rollback').catch(() => undefined);
        await c.end();
      }
    };
    // A teen is given the links (and so their lines are kept from them by the
    // log's own rule); a restricted viewer, only the granted collection's.
    const who = [
      ['owner', people.owner.member, people.owner.account],
      ['teen', people.adult.member, people.adult.account],
      ['viewer', viewer, viewerAccount],
    ] as const;
    const before: string[][] = [];
    for (const [role, m, a] of who) before.push(await given(role, m, a, 'share_link'));
    expect(before[1]).toHaveLength(2);
    expect(before[2]).toEqual([links[0]]);
    await removeEndedSharing(deps());
    expect(await exists('share_link', links[0] as string)).toBe(false);
    const after: string[][] = [];
    for (const [role, m, a] of who) after.push(await given(role, m, a, 'share_link_tombstone'));
    expect(after).toEqual(before);
  });
});
