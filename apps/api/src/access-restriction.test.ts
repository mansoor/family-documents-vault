import { randomUUID } from 'node:crypto';
import { createPool, readAs, withPrincipal, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { CollectionDetail, DocumentView } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeFor } from './auth/totp.js';
import type { Principal, Tokens } from './auth/service.js';
import { RestrictionService } from './household/restrictions.js';
import { createHarness, type Harness } from './test-harness.js';

/**
 * The restriction, enforced by the database (5.32, 0054).
 *
 * Asked the way the vault asks — as the application role, with the actor
 * set to the restricted viewer's own account — and with no WHERE clause of
 * the application's: what comes back is what the database gives them. The
 * restriction is written straight into its tables, as an operator would
 * (5.33 adds the API).
 *
 * The family: an owner; Ahmed, an adult; Val, a viewer to be restricted;
 * Uma, a viewer who is not. Val's grant, unless a test says otherwise:
 * Ahmed's tax documents, and the collection "For the accountant".
 */

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
const PASSWORD = 'another correct horse';

describe.skipIf(!testAdminUrl())('the restriction, enforced by the database (5.32)', () => {
  let h: Harness;
  let owner: Tokens;
  let ahmed: Tokens;
  let val: Tokens;
  let uma: Tokens;
  let valAccount = '';
  let umaAccount = '';
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  let hh = '';
  let collection = '';
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.32.${Math.floor(++nth / 200)}.${nth % 200}` });

  /** Every document, by name, with its newest version and its reminder. */
  const docs: Record<string, { id: string; version: string; reminder: string }> = {};

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  const accountOf = async (t: Tokens) =>
    (
      await withSystem(h.db, t.household_id, (trx) =>
        trx
          .selectFrom('account_household')
          .select('account_id')
          .where('member_id', '=', t.member_id)
          .executeTakeFirstOrThrow(),
      )
    ).account_id;

  /** Their sessions just saw a passkey or a code. */
  const fresh = async (t: Tokens) => {
    const account = await accountOf(t);
    await withSystem(h.db, t.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(), factor_verified_at: new Date() })
        .where('account_id', '=', account)
        .execute(),
    );
  };

  /** A document with a file, made through the API by `who`. */
  const make = async (
    name: string,
    who: Tokens,
    payload: { type_key: string; visibility: string; owner_member_id: string | null },
  ) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(who),
      payload: { title: `Restricted ${name}`, tags: [`tag-${name}`], ...payload },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = json<DocumentView>(created).id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBe(201);
    const version = json<{ id: string }>(up).id;
    // Its words, where the worker would put them; and a reminder on it.
    await admin.query(
      `insert into document_text (version_id, household_id, document_id, content)
       values ($1, $2, $3, $4)`,
      [version, hh, id, `words of ${name}`],
    );
    const r = await admin.query<{ id: string }>(
      `insert into reminder (household_id, document_id, kind, fire_at)
       values ($1, $2, 'manual', '2030-01-01') returning id`,
      [hh, id],
    );
    docs[name] = { id, version, reminder: r.rows[0]?.id as string };
  };

  /** Val's restriction, written as an operator would: exactly this. */
  const restrict = async (
    grant: {
      people?: string[];
      types?: string[];
      collections?: string[];
      adults?: boolean;
      noPerson?: boolean;
      expires?: Date | null;
    } = {},
  ) => {
    await admin.query('delete from access_restriction where member_id = $1', [val.member_id]);
    await admin.query(
      `insert into access_restriction
         (member_id, household_id, include_adults_only, include_no_person_docs, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [val.member_id, hh, grant.adults ?? false, grant.noPerson ?? false, grant.expires ?? null],
    );
    for (const m of grant.people ?? []) {
      await admin.query(
        `insert into access_restriction_member (restricted_member_id, household_id, member_id)
         values ($1, $2, $3)`,
        [val.member_id, hh, m],
      );
    }
    for (const t of grant.types ?? []) {
      await admin.query(
        `insert into access_restriction_type (restricted_member_id, household_id, type_key)
         values ($1, $2, $3)`,
        [val.member_id, hh, t],
      );
    }
    for (const c of grant.collections ?? []) {
      await admin.query(
        `insert into access_restriction_collection (restricted_member_id, household_id, collection_id)
         values ($1, $2, $3)`,
        [val.member_id, hh, c],
      );
    }
  };
  /** The grant most tests start from: Ahmed's tax documents, and the accountant's collection. */
  const usual = () =>
    restrict({
      people: [ahmed.member_id],
      types: ['tax_return', 'tax_form'],
      collections: [collection],
    });

  /** One statement as somebody signed in, past the application: the ids it gives. */
  const as = async (
    who: { member: string; account: string; role: string },
    text: string,
  ): Promise<string[]> => {
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                set_config('app.role', $4, true)`,
        [hh, who.account, who.member, who.role],
      );
      const r = await c.query<{ id: string }>(text);
      return r.rows.map((x) => String(x.id)).sort();
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  };
  const asVal = (text: string) =>
    as({ member: val.member_id, account: valAccount, role: 'viewer' }, text);
  const asUma = (text: string) =>
    as({ member: uma.member_id, account: umaAccount, role: 'viewer' }, text);

  const ids = (names: string[], of: 'id' | 'version' | 'reminder' = 'id') =>
    names.map((n) => docs[n]?.[of] as string).sort();

  /** What Val is given of each table that hangs off a document. */
  const seen = async () => ({
    documents: await asVal('select id from document'),
    versions: await asVal('select id from document_version'),
    texts: await asVal('select version_id as id from document_text'),
    reminders: await asVal('select id from reminder'),
    members: await asVal('select id from member'),
  });

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    app = createPool(h.appUrl, 2);
    owner = await h.setup();
    hh = owner.household_id;
    await fresh(owner);
    ahmed = await h.join(owner, { name: 'Ahmed', email: 'ahmed-532@example.test', role: 'adult' });
    val = await h.join(owner, { name: 'Val', email: 'val-532@example.test', role: 'viewer' });
    uma = await h.join(owner, { name: 'Uma', email: 'uma-532@example.test', role: 'viewer' });
    valAccount = await accountOf(val);
    umaAccount = await accountOf(uma);

    // Ahmed's: his tax return (granted), his bill (not a granted kind), his
    // Adults only tax form (only with adults-only allowed), his Only me tax
    // return (never).
    await make('ahmedTax', ahmed, {
      type_key: 'tax_return',
      visibility: 'household',
      owner_member_id: ahmed.member_id,
    });
    await make('ahmedBill', ahmed, {
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: ahmed.member_id,
    });
    await make('ahmedAdults', ahmed, {
      type_key: 'tax_form',
      visibility: 'adults',
      owner_member_id: ahmed.member_id,
    });
    await make('ahmedPrivate', ahmed, {
      type_key: 'tax_return',
      visibility: 'private',
      owner_member_id: ahmed.member_id,
    });
    // The owner's: a tax return (not a granted person), and a bill in the
    // accountant's collection (granted by the collection).
    await make('ownerTax', owner, {
      type_key: 'tax_return',
      visibility: 'household',
      owner_member_id: owner.member_id,
    });
    await make('ownerInCollection', owner, {
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: owner.member_id,
    });
    // The house's: nobody's (only with the checkbox).
    await make('nobodys', owner, {
      type_key: 'tax_return',
      visibility: 'household',
      owner_member_id: null,
    });
    // Val's own: one for everyone, and one Only me (an operator's hand:
    // only its owner may make a document Only me, and a viewer files none).
    await make('valOwn', owner, {
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: val.member_id,
    });
    await make('valPrivate', owner, {
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: val.member_id,
    });
    await admin.query(`update document set visibility = 'private' where id = $1`, [
      docs.valPrivate?.id,
    ]);

    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(owner),
      payload: { name: 'For the accountant', audience: 'everyone' },
    });
    expect(made.statusCode, made.body).toBe(201);
    collection = json<CollectionDetail>(made).id;
    const added = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${collection}/items`,
      headers: h.as(owner),
      payload: { document_ids: [docs.ownerInCollection?.id] },
    });
    expect(added.statusCode, added.body).toBe(200);
    await usual();
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await app?.end();
    await h?.close();
  });

  it('document, document_version, document_text, reminder and member each return exactly the grant', async () => {
    await usual();
    const granted = ['ahmedTax', 'ownerInCollection', 'valOwn', 'valPrivate'];
    const got = await seen();
    expect(got.documents).toEqual(ids(granted));
    expect(got.versions).toEqual(ids(granted, 'version'));
    expect(got.texts).toEqual(ids(granted, 'version'));
    expect(got.reminders).toEqual(ids(granted, 'reminder'));
    // Themselves, the person granted, and the owner of a document they can
    // see (the collection's): not Uma, of whom they see nothing.
    expect(got.members).toEqual([val.member_id, ahmed.member_id, owner.member_id].sort());

    // An unrestricted viewer is narrowed by none of it: the database gives
    // them every row, and the application's own rule decides (5.6).
    expect(await asUma('select id from document')).toHaveLength(Object.keys(docs).length);

    // And the API, which keeps its own rule as the base, agrees with the
    // database: Val's list is the grant.
    const signedIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'val-532@example.test', password: PASSWORD },
      ...peer(),
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const list = await h.app.inject({
      url: '/api/v1/documents?limit=200',
      headers: h.as(signedIn.json<Tokens>()),
    });
    expect(
      json<{ items: DocumentView[] }>(list)
        .items.map((d) => d.id)
        .sort(),
    ).toEqual(ids(granted));
  });

  it('an adults-only document is given only when an owner allows it, and a document of nobody only with the checkbox', async () => {
    await restrict({
      people: [ahmed.member_id],
      types: ['tax_return', 'tax_form'],
      adults: true,
      noPerson: true,
    });
    expect(await asVal('select id from document')).toEqual(
      ids(['ahmedTax', 'ahmedAdults', 'nobodys', 'valOwn', 'valPrivate']),
    );
    // Nobody's, with no person named: only kinds narrow it.
    await restrict({ types: ['tax_return'], noPerson: true });
    expect(await asVal('select id from document')).toEqual(
      ids(['ahmedTax', 'ownerTax', 'nobodys', 'valOwn', 'valPrivate']),
    );
    await usual();
  });

  it("an empty restriction sees nothing of anyone else's", async () => {
    await restrict();
    const got = await seen();
    expect(got.documents).toEqual(ids(['valOwn', 'valPrivate']));
    expect(got.versions).toEqual(ids(['valOwn', 'valPrivate'], 'version'));
    expect(got.reminders).toEqual(ids(['valOwn', 'valPrivate'], 'reminder'));
    expect(got.members).toEqual([val.member_id]);
    expect(await asVal('select id from doc_collection')).toEqual([]);
    expect(await asVal('select household_id as id from household_profile')).toEqual([]);
    await usual();
  });

  it('deleting a granted collection narrows', async () => {
    await usual();
    expect(await asVal('select id from document')).toContain(docs.ownerInCollection?.id);
    expect(await asVal('select id from doc_collection')).toEqual([collection]);
    await admin.query('update doc_collection set deleted_at = now() where id = $1', [collection]);
    try {
      expect(await asVal('select id from document')).not.toContain(docs.ownerInCollection?.id);
      // And its owner with it: nothing of theirs is given any more.
      expect(await asVal('select id from member')).not.toContain(owner.member_id);
    } finally {
      await admin.query('update doc_collection set deleted_at = null where id = $1', [collection]);
    }
    // A collection no longer for Everyone gives nothing either (A17).
    await admin.query(`update doc_collection set audience = 'adults' where id = $1`, [collection]);
    try {
      expect(await asVal('select id from document')).not.toContain(docs.ownerInCollection?.id);
    } finally {
      await admin.query(`update doc_collection set audience = 'everyone' where id = $1`, [
        collection,
      ]);
    }
  });

  it("another person's private document is never visible, even with its person and type granted", async () => {
    // Its person, its kind, adults-only and nobody's allowed, and in a granted collection.
    await admin.query(
      `insert into doc_collection_item (collection_id, document_id, household_id, position)
       values ($1, $2, $3, 99)`,
      [collection, docs.ahmedPrivate?.id, hh],
    );
    try {
      await restrict({
        people: [ahmed.member_id],
        types: ['tax_return'],
        collections: [collection],
        adults: true,
        noPerson: true,
      });
      const got = await seen();
      expect(got.documents).not.toContain(docs.ahmedPrivate?.id);
      expect(got.versions).not.toContain(docs.ahmedPrivate?.version);
      expect(got.texts).not.toContain(docs.ahmedPrivate?.version);
      expect(got.reminders).not.toContain(docs.ahmedPrivate?.reminder);
      expect(
        await asVal(
          `select document_id as id from doc_collection_item where collection_id = '${collection}'`,
        ),
      ).not.toContain(docs.ahmedPrivate?.id);
    } finally {
      await admin.query('delete from doc_collection_item where document_id = $1', [
        docs.ahmedPrivate?.id,
      ]);
      await usual();
    }
  });

  it('the restricted person still sees their own Only me documents', async () => {
    for (const grant of [{}, { people: [ahmed.member_id], types: ['tax_return'] }]) {
      await restrict(grant);
      expect(await asVal('select id from document')).toContain(docs.valPrivate?.id);
      expect(await asVal('select id from document_version')).toContain(docs.valPrivate?.version);
    }
    await usual();
  });

  it('an expired restriction leaves nothing visible', async () => {
    await restrict({
      people: [ahmed.member_id],
      types: ['tax_return'],
      collections: [collection],
      adults: true,
      noPerson: true,
      expires: new Date(Date.now() - 1000),
    });
    try {
      const got = await seen();
      expect(got.documents).toEqual([]);
      expect(got.versions).toEqual([]);
      expect(got.texts).toEqual([]);
      expect(got.reminders).toEqual([]);
      // Themselves alone, no collection, and the built-in kinds only.
      expect(got.members).toEqual([val.member_id]);
      expect(await asVal('select id from doc_collection')).toEqual([]);
      expect(
        await asVal('select key as id from document_type where household_id is not null'),
      ).toEqual([]);
      // Still restricted: app_restricted() says so, past its end.
      expect(await asVal('select app_restricted()::text as id')).toEqual(['true']);
    } finally {
      await usual();
    }
  });

  it('what hangs off a document follows it: links between documents, share links, tombstones and the activity log', async () => {
    await usual();
    // A link between a granted document and one that is not: neither end is shown.
    const [a, b] = [docs.ahmedTax?.id as string, docs.ownerTax?.id as string].sort();
    await admin.query('insert into document_link (household_id, a, b) values ($1, $2, $3)', [
      hh,
      a,
      b,
    ]);
    const [c, d] = [docs.ahmedTax?.id as string, docs.ownerInCollection?.id as string].sort();
    await admin.query('insert into document_link (household_id, a, b) values ($1, $2, $3)', [
      hh,
      c,
      d,
    ]);
    expect(await asVal("select a::text || '/' || b::text as id from document_link")).toEqual([
      `${c}/${d}`,
    ]);
    // A share link out of the house to each: only the granted one's.
    for (const name of ['ahmedTax', 'ownerTax']) {
      const shared = await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${docs[name]?.id}/share`,
        headers: h.as(owner),
        payload: { recipient_label: 'the accountant' },
      });
      expect(shared.statusCode, shared.body).toBe(201);
    }
    expect(await asVal('select document_id as id from share_link')).toEqual(ids(['ahmedTax']));
    // A document removed for good leaves a tombstone: one of Ahmed's is
    // given by his person alone; the owner's is not.
    const gone = [randomUUID(), randomUUID()];
    await admin.query(
      `insert into document_tombstone (id, household_id, visibility, owner_member_id)
       values ($1, $3, 'household', $4), ($2, $3, 'household', $5)`,
      [gone[0], gone[1], hh, ahmed.member_id, owner.member_id],
    );
    await restrict({ people: [ahmed.member_id] });
    expect(await asVal('select id from document_tombstone')).toEqual([gone[0]]);
    // The activity log's lines about documents: only those of what is given.
    const lines = await asVal(
      `select object_id::text as id from audit_event
        where object_type = 'document' and object_id is not null`,
    );
    expect(lines.length).toBeGreaterThan(0);
    const given = new Set([...(await asVal('select id from document')), gone[0]]);
    for (const l of lines) expect(given.has(l)).toBe(true);
    expect(lines).not.toContain(docs.ownerTax?.id);
    await usual();
  });

  it('a person reads their own restriction, and changes none of it; nobody else but an owner reads it', async () => {
    await usual();
    expect(await asVal('select member_id as id from access_restriction')).toEqual([val.member_id]);
    expect(await asUma('select member_id as id from access_restriction')).toEqual([]);
    const tryAs = async (role: string, member: string, account: string, text: string) => {
      const c = await app.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                  set_config('app.role', $4, true)`,
          [hh, account, member, role],
        );
        return (await c.query(text)).rowCount ?? 0;
      } catch (err) {
        return (err as { code?: string }).code ?? 'error';
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    };
    for (const text of [
      'delete from access_restriction',
      'delete from access_restriction_member',
      'delete from access_restriction_type',
      'delete from access_restriction_collection',
      'update access_restriction set include_adults_only = true',
      "update access_restriction set expires_at = now() + interval '1 day'",
    ]) {
      expect(await tryAs('viewer', val.member_id, valAccount, text), text).toBe(0);
    }
    expect(
      await tryAs(
        'viewer',
        val.member_id,
        valAccount,
        `insert into access_restriction_type (restricted_member_id, household_id, type_key)
         values ('${val.member_id}', '${hh}', 'will')`,
      ),
    ).toBe('42501');
    // An owner reads it, and may change it.
    const ownerAccount = await accountOf(owner);
    expect(
      await tryAs(
        'owner',
        owner.member_id,
        ownerAccount,
        'update access_restriction set include_adults_only = true',
      ),
    ).toBe(1);
  });

  it('a restricted viewer whose role changes stays restricted, and the owners are asked to confirm it again', async () => {
    // Uma, restricted to nothing but her own, then made a teen.
    await admin.query('insert into access_restriction (member_id, household_id) values ($1, $2)', [
      uma.member_id,
      hh,
    ]);
    try {
      await fresh(owner);
      const changed = await h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${uma.member_id}/role`,
        headers: h.as(owner),
        payload: { role: 'teen' },
      });
      expect(changed.statusCode, changed.body).toBe(200);
      const row = await admin.query<{ reconfirm_since: Date | null }>(
        'select reconfirm_since from access_restriction where member_id = $1',
        [uma.member_id],
      );
      expect(row.rows[0]?.reconfirm_since).toBeInstanceOf(Date);
      // Kept, it fails closed: as a teen she still sees nothing of anybody else's.
      expect(
        await as(
          { member: uma.member_id, account: umaAccount, role: 'teen' },
          'select id from document',
        ),
      ).toEqual([]);
    } finally {
      await admin.query('delete from access_restriction where member_id = $1', [uma.member_id]);
      await admin.query(`update account_household set role = 'viewer' where member_id = $1`, [
        uma.member_id,
      ]);
    }
  });

  it('remove and restore the sign-in: still restricted', async () => {
    await usual();
    await fresh(owner);
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${val.member_id}/sign-in`,
      headers: h.as(owner),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const kept = await admin.query<{ reconfirm_since: Date | null }>(
      'select reconfirm_since from access_restriction where member_id = $1',
      [val.member_id],
    );
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0]?.reconfirm_since).toBeNull();

    const restored = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${val.member_id}/sign-in`,
      headers: h.as(owner),
      payload: { role: 'viewer' },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    // Still there, and the owners are asked to confirm it again.
    const after = await admin.query<{ reconfirm_since: Date | null }>(
      'select reconfirm_since from access_restriction where member_id = $1',
      [val.member_id],
    );
    expect(after.rows[0]?.reconfirm_since).toBeInstanceOf(Date);

    // Signed in again with their own password, they see the grant, and no more.
    const signedIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'val-532@example.test', password: PASSWORD },
      ...peer(),
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const list = await h.app.inject({
      url: '/api/v1/documents?limit=200',
      headers: h.as(signedIn.json<Tokens>()),
    });
    expect(
      json<{ items: DocumentView[] }>(list)
        .items.map((d) => d.id)
        .sort(),
    ).toEqual(ids(['ahmedTax', 'ownerInCollection', 'valOwn', 'valPrivate']));
    valAccount = await accountOf(val);
  });

  it('paused by a restore and turned back on, a restricted viewer is still restricted (5.28)', async () => {
    await usual();
    // What a restore does to a viewer's sign-in (PAUSE_SIGN_INS).
    await admin.query(
      `update account_household
          set suspended_at = now(), suspend_reason = 'restored'
        where member_id = $1`,
      [val.member_id],
    );
    // An owner turns it back on: two-step sign-in, and a fresh code.
    await fresh(owner);
    const enrol = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: h.as(owner),
    });
    const secret = json<{ secret: string }>(enrol).secret;
    const confirmed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      headers: h.as(owner),
      payload: { code: codeFor(secret) },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(204);
    await fresh(owner);
    // "After a restore" shows the restriction beside the role, to confirm (A55).
    const waiting = await h.app.inject({ url: '/api/v1/after-restore', headers: h.as(owner) });
    const signIns = json<{
      sign_ins: Array<{ member_id: string; restriction: { summary: string } | null }>;
    }>(waiting).sign_ins;
    expect(signIns.find((s) => s.member_id === val.member_id)?.restriction?.summary).toBe(
      "Restricted: sees 1 person's documents of 2 kinds and 1 collection.",
    );
    const resumed = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${val.member_id}/resume`,
      headers: h.as(owner),
    });
    expect(resumed.statusCode, resumed.body).toBe(204);
    const signedIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'val-532@example.test', password: PASSWORD },
      ...peer(),
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const list = await h.app.inject({
      url: '/api/v1/documents?limit=200',
      headers: h.as(signedIn.json<Tokens>()),
    });
    expect(
      json<{ items: DocumentView[] }>(list)
        .items.map((d) => d.id)
        .sort(),
    ).toEqual(ids(['ahmedTax', 'ownerInCollection', 'valOwn', 'valPrivate']));
  });

  it("the worker reads as one person inside the vault's own transaction, and nowhere else (readAs)", async () => {
    await usual();
    await withSystem(h.db, hh, async (trx) => {
      const asVal = await readAs(
        trx,
        { accountId: valAccount, memberId: val.member_id, role: 'viewer' },
        (as) => as.selectFrom('document').select('id').execute(),
      );
      expect(asVal.map((d) => d.id).sort()).toEqual(
        ids(['ahmedTax', 'ownerInCollection', 'valOwn', 'valPrivate']),
      );
      // And the vault is the vault again: every document.
      const all = await trx.selectFrom('document').select('id').execute();
      expect(all).toHaveLength(Object.keys(docs).length);
    });
    // From anybody else's transaction it refuses: they would be reading as
    // somebody they are not.
    const ownerAccount = await accountOf(owner);
    await expect(
      withPrincipal(
        h.db,
        { householdId: hh, accountId: ownerAccount, memberId: owner.member_id, role: 'owner' },
        (trx) =>
          readAs(trx, { accountId: valAccount, memberId: val.member_id, role: 'viewer' }, (as) =>
            as.selectFrom('document').select('id').execute(),
          ),
      ),
    ).rejects.toThrow(/only for a transaction of the vault itself/);
  });

  describe("an owner's guard rails", () => {
    let service: RestrictionService;
    const alerts: Array<{ accountIds: string[]; subject: string }> = [];
    let asOwner: Principal;
    /** A viewer of their own, for these: one with an Only me document. */
    let wes: Tokens;

    beforeAll(async () => {
      service = new RestrictionService(h.db, async (a) => {
        alerts.push(a);
      });
      asOwner = {
        accountId: await accountOf(owner),
        sessionId: randomUUID(),
        householdId: hh,
        memberId: owner.member_id,
        role: 'owner',
        seesAdults: true,
      };
      wes = await h.join(owner, { name: 'Wes', email: 'wes-532@example.test', role: 'viewer' });
      // Something only Wes can see: kept from before they were a viewer.
      await make('wesPrivate', owner, {
        type_key: 'utility_bill',
        visibility: 'household',
        owner_member_id: wes.member_id,
      });
      await admin.query(`update document set visibility = 'private' where id = $1`, [
        docs.wesPrivate?.id,
      ]);
    });

    const restrictionOf = async (member: string) =>
      (await admin.query('select * from access_restriction where member_id = $1', [member]))
        .rows[0] as Record<string, unknown> | undefined;

    it('restricting someone who keeps Only me documents asks the owner to confirm, and they are told', async () => {
      await expect(
        service.restrict(asOwner, wes.member_id, { people: [ahmed.member_id] }),
      ).rejects.toMatchObject({ status: 409, code: 'confirm_private' });
      expect(await restrictionOf(wes.member_id)).toBeUndefined();
      expect(alerts).toEqual([]);

      const done = await service.restrict(
        asOwner,
        wes.member_id,
        { people: [ahmed.member_id], types: ['tax_return'] },
        { confirmPrivate: true },
      );
      expect(done).toEqual({ member_id: wes.member_id, confirmed_private: true, told: true });
      const row = await restrictionOf(wes.member_id);
      expect(row?.private_confirmed_at).toBeInstanceOf(Date);
      expect(row?.private_confirmed_by).toBe(asOwner.accountId);
      expect(row?.created_by).toBe(asOwner.accountId);
      expect(alerts).toEqual([
        expect.objectContaining({
          accountIds: [await accountOf(wes)],
          subject: 'What you can see in The Test family has been limited',
        }),
      ]);
      // And they still see their own.
      expect(
        await as(
          { member: wes.member_id, account: await accountOf(wes), role: 'viewer' },
          'select id from document',
        ),
      ).toEqual(ids(['ahmedTax', 'wesPrivate']));

      // Changed later, they are not asked, or told, again.
      await service.restrict(asOwner, wes.member_id, { people: [] });
      expect(alerts).toHaveLength(1);
    });

    it('the database refuses it too, without the confirmation', async () => {
      await admin.query('delete from access_restriction where member_id = $1', [wes.member_id]);
      const c = await app.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                  set_config('app.role', 'owner', true)`,
          [hh, asOwner.accountId, owner.member_id],
        );
        await expect(
          c.query('insert into access_restriction (member_id, household_id) values ($1, $2)', [
            wes.member_id,
            hh,
          ]),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    });

    it('only a viewer is restricted: never an adult, another owner, or oneself', async () => {
      for (const who of [ahmed.member_id, owner.member_id]) {
        await expect(service.restrict(asOwner, who, {})).rejects.toMatchObject({
          status: 409,
          code: 'not_a_viewer',
        });
        expect(await restrictionOf(who)).toBeUndefined();
      }
      // An adult cannot restrict anybody.
      await expect(
        service.restrict({ ...asOwner, role: 'adult' }, uma.member_id, {}),
      ).rejects.toMatchObject({ status: 403 });
      // And the database refuses an owner's write for an adult.
      const c = await app.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                  set_config('app.role', 'owner', true)`,
          [hh, asOwner.accountId, owner.member_id],
        );
        await expect(
          c.query('insert into access_restriction (member_id, household_id) values ($1, $2)', [
            ahmed.member_id,
            hh,
          ]),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    });
  });
});
