import { randomUUID } from 'node:crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView, VersionView } from '@fdv/shared';
import argon2 from 'argon2';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/**
 * The Phase 1 exit, over HTTP: a second adult with a real account cannot
 * reach the first adult's private document by any endpoint, and marking
 * private moves the OCR text out of the index.
 */
describe.skipIf(!testAdminUrl())('visibility and the private boundary', () => {
  let h: Harness;
  let owner: Tokens;
  let other: Tokens;
  let docId: string;
  let versionId: string;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();

    // A second adult, the way 3.2's invitation will create one.
    const otherMember = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('member')
        .values({ household_id: owner.household_id, display_name: 'Sana' })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const account = await h.db
      .insertInto('account')
      .values({
        email: 'sana@example.test',
        password_hash: await argon2.hash('sanas password 123'),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('account_household')
        .values({
          account_id: account.id,
          household_id: owner.household_id,
          member_id: otherMember.id,
          role: 'adult',
        })
        .execute(),
    );
    const { ScopeKeys, EnvKeyProvider } = await import('@fdv/crypto');
    const { TEST_MASTER } = await import('../test-harness.js');
    await withSystem(h.db, owner.household_id, (trx) =>
      new ScopeKeys(new EnvKeyProvider(TEST_MASTER)).mintMemberKey(
        trx,
        owner.household_id,
        otherMember.id,
        'sanas password 123',
      ),
    );
    const signIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'sana@example.test', password: 'sanas password 123' },
    });
    other = signIn.json<Tokens>();
    expect(other.role).toBe('adult');

    // The owner's document with a version and OCR text.
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: {
        type_key: 'will',
        title: 'My will',
        owner_member_id: owner.member_id,
        visibility: 'adults',
      },
    });
    docId = created.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'will.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docId}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    versionId = up.json<VersionView>().id;
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('document_text')
        .values({
          version_id: versionId,
          household_id: owner.household_id,
          document_id: docId,
          content: 'Last will and testament. Executor: Rahul. Clause seven.',
        })
        .execute(),
    );
  });
  afterAll(() => h.close());

  const get = (t: Tokens, url: string) => h.app.inject({ url, headers: h.as(t) });

  it('the other adult can see an adults-only document and find it by its words', async () => {
    expect((await get(other, `/api/v1/documents/${docId}`)).statusCode).toBe(200);
    expect(
      (await get(other, `/api/v1/search?q=executor`)).json<{ items: unknown[] }>().items,
    ).toHaveLength(1);
    expect((await get(other, `/api/v1/versions/${versionId}/content`)).statusCode).toBe(200);
  });

  it('only the owning member can make it private', async () => {
    const refused = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docId}/visibility`,
      headers: h.as(other),
      payload: { visibility: 'private' },
    });
    expect(refused.statusCode).toBe(403);
    const ok = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docId}/visibility`,
      headers: h.as(owner),
      payload: { visibility: 'private' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('afterwards the file key is under the member scope and the text is sealed', async () => {
    const v = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('document_version')
        .innerJoin('scope_key', 'scope_key.id', 'document_version.wrapped_by_scope')
        .select(['scope_key.kind', 'scope_key.member_id'])
        .where('document_version.id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(v).toEqual({ kind: 'member', member_id: owner.member_id });
    const plain = await withSystem(h.db, owner.household_id, (trx) =>
      trx.selectFrom('document_text').selectAll().where('document_id', '=', docId).execute(),
    );
    expect(plain).toEqual([]);
    const sealed = await withSystem(h.db, owner.household_id, (trx) =>
      trx.selectFrom('document_text_sealed').selectAll().where('document_id', '=', docId).execute(),
    );
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.content_cipher.toString('latin1')).not.toContain('Executor');
  });

  it('the other adult cannot reach it by any endpoint — and the owner still can', async () => {
    expect((await get(other, `/api/v1/documents/${docId}`)).statusCode).toBe(404);
    expect((await get(other, `/api/v1/documents/${docId}/versions`)).statusCode).toBe(404);
    expect((await get(other, `/api/v1/versions/${versionId}/content`)).statusCode).toBe(404);
    expect((await get(other, `/api/v1/versions/${versionId}/thumbnail`)).statusCode).toBe(404);
    expect(
      (await get(other, '/api/v1/documents'))
        .json<{ items: DocumentView[] }>()
        .items.map((d) => d.id),
    ).not.toContain(docId);
    expect(
      (await get(other, '/api/v1/search?q=executor')).json<{ items: unknown[] }>().items,
    ).toEqual([]);
    expect(
      (await get(other, '/api/v1/documents/counts'))
        .json<{ by_member: Array<{ member_id: string; count: number }> }>()
        .by_member.find((m) => m.member_id === owner.member_id),
    ).toBeUndefined();
    const patch = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${docId}`,
      headers: h.as(other),
      payload: { title: 'x' },
    });
    expect(patch.statusCode).toBe(404);

    expect((await get(owner, `/api/v1/documents/${docId}`)).statusCode).toBe(200);
    expect((await get(owner, `/api/v1/versions/${versionId}/content`)).rawPayload.equals(PDF)).toBe(
      true,
    );
    // The owner's own private text is not in the server index either (2.5 searches it in-session).
    const own = (await get(owner, '/api/v1/search?q=executor')).json<{
      items: unknown[];
      sealed_pending: { count: number };
    }>();
    expect(own.items).toEqual([]);
    expect(own.sealed_pending.count).toBe(1);
  });

  it('making it household again restores the index and the shared key', async () => {
    const ok = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docId}/visibility`,
      headers: h.as(owner),
      payload: { visibility: 'household' },
    });
    expect(ok.statusCode).toBe(200);
    expect(
      (await get(other, `/api/v1/search?q=executor`)).json<{ items: unknown[] }>().items,
    ).toHaveLength(1);
    expect((await get(other, `/api/v1/versions/${versionId}/content`)).rawPayload.equals(PDF)).toBe(
      true,
    );
  });
});

/**
 * A72 (5.17c): a teen may change who sees their own documents, between
 * Only me and Everyone, and nothing else. Owners and adults keep what they
 * had; a viewer, nothing.
 */
describe.skipIf(!testAdminUrl())('a teen and who sees their own documents (A72)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let viewer: Tokens;

  beforeAll(async () => {
    h = await createHarness();
    admin = createPool(h.adminUrl, 1);
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Sam', email: 'sam-a72@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Tess', email: 'tess-a72@example.test', role: 'teen' });
    viewer = await h.join(owner, { name: 'Vic', email: 'vic-a72@example.test', role: 'viewer' });
  }, 90_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  const make = async (as: Tokens, payload: Record<string, unknown>) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(as),
      payload,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<DocumentView>();
  };
  const upload = async (as: Tokens, id: string) => {
    const form = new FormData();
    form.append('file', PDF, { filename: 'card.pdf', contentType: 'application/pdf' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(as), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<VersionView>().id;
  };
  const show = (as: Tokens, id: string, visibility: string) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/visibility`,
      headers: h.as(as),
      payload: { visibility },
    });
  const get = (as: Tokens, url: string) => h.app.inject({ url, headers: h.as(as) });
  const visibilityOf = async (id: string) =>
    (
      await admin.query<{ visibility: string }>('select visibility from document where id = $1', [
        id,
      ])
    ).rows[0]?.visibility;
  const refusal = (res: { statusCode: number; json: () => unknown }) => {
    expect(res.statusCode).toBe(403);
    return (res.json() as { error: { code: string; message: string; action?: string } }).error;
  };

  it('a teen switches their own Only me document to Everyone and back', async () => {
    // Their social security card: their Only me by default (Option A).
    const card = await make(teen, { title: 'Tess social security card', type_key: 'national_id' });
    expect(card.visibility).toBe('private');
    const version = await upload(teen, card.id);
    expect((await get(viewer, `/api/v1/documents/${card.id}`)).statusCode).toBe(404);

    // Everyone: the family, viewers included, can open it and its file.
    const widened = await show(teen, card.id, 'household');
    expect(widened.statusCode, widened.body).toBe(200);
    expect(await visibilityOf(card.id)).toBe('household');
    expect((await get(viewer, `/api/v1/documents/${card.id}`)).statusCode).toBe(200);
    const read = await get(viewer, `/api/v1/versions/${version}/content`);
    expect(read.statusCode).toBe(200);
    expect(read.rawPayload.equals(PDF)).toBe(true);

    // And back to Only me: theirs alone again, and still theirs to open.
    const narrowed = await show(teen, card.id, 'private');
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(await visibilityOf(card.id)).toBe('private');
    expect((await get(viewer, `/api/v1/documents/${card.id}`)).statusCode).toBe(404);
    expect((await get(owner, `/api/v1/documents/${card.id}`)).statusCode).toBe(404);
    const mine = await get(teen, `/api/v1/versions/${version}/content`);
    expect(mine.rawPayload.equals(PDF)).toBe(true);

    // Both are in the activity log, as any change of who can see it is.
    const logged = await admin.query<{ detail: { from: string; to: string } }>(
      `select detail from audit_event where action = 'document.visibility_changed'
         and object_id = $1 order by id`,
      [card.id],
    );
    expect(logged.rows.map((r) => [r.detail.from, r.detail.to])).toEqual([
      ['private', 'household'],
      ['household', 'private'],
    ]);

    // Out of Only me asks what opening it asks, as it does for anybody.
    await admin.query(
      `update session set verified_at = now() - interval '10 minutes'
        where account_id = (select account_id from account_household where member_id = $1)`,
      [teen.member_id],
    );
    const asked = refusal(await show(teen, card.id, 'household'));
    expect(asked).toMatchObject({ code: 'step_up_required', action: 'open_private_document' });
    expect(await visibilityOf(card.id)).toBe('private');
    // Into it asks nothing.
    const bill = await make(teen, { title: 'Tess phone bill', type_key: 'utility_bill' });
    expect((await show(teen, bill.id, 'private')).statusCode).toBe(200);
  });

  it('a teen cannot make their own document Adults only', async () => {
    const letter = await make(teen, { title: 'Tess school letter', type_key: 'utility_bill' });
    expect(letter.visibility).toBe('household');
    expect(refusal(await show(teen, letter.id, 'adults'))).toMatchObject({
      code: 'forbidden',
      message:
        'Adults only would hide it from you too. You can make the documents you filed Only me or Everyone.',
    });
    // Nor by an edit.
    const edited = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${letter.id}`,
      headers: h.as(teen),
      payload: { visibility: 'adults' },
    });
    expect(refusal(edited).code).toBe('forbidden');
    expect(await visibilityOf(letter.id)).toBe('household');
  });

  it("a teen cannot change anyone else's document", async () => {
    const family = await make(owner, { title: 'Council tax', type_key: 'utility_bill' });
    const theirs = await make(adult, {
      title: 'Nadia passport',
      type_key: 'passport',
      owner_member_id: owner.member_id,
      visibility: 'household',
    });
    for (const [id, to] of [
      [family.id, 'private'],
      [family.id, 'household'],
      [theirs.id, 'private'],
      [theirs.id, 'household'],
    ] as const) {
      expect(refusal(await show(teen, id, to)), `${id} ${to}`).toMatchObject({
        code: 'forbidden',
        message: 'Only an adult can change who is able to see a document.',
      });
    }
    // Somebody else's Only me is not there at all.
    const secret = await make(adult, {
      title: 'Sam diary',
      type_key: 'utility_bill',
      owner_member_id: adult.member_id,
      visibility: 'private',
    });
    expect((await show(teen, secret.id, 'household')).statusCode).toBe(404);
    expect(await visibilityOf(family.id)).toBe('household');
    expect(await visibilityOf(theirs.id)).toBe('household');
    expect(await visibilityOf(secret.id)).toBe('private');
    // A viewer, as before: refused before anything is looked up.
    expect(refusal(await show(viewer, family.id, 'adults')).message).toBe(
      'Only an adult can change who is able to see a document.',
    );
    expect((await show(viewer, randomUUID(), 'adults')).statusCode).toBe(403);
  });

  it('a teen cannot make a document an owner filed for them Only me, and the owner keeps it', async () => {
    // Filed by an owner, for the teen: theirs, but not theirs to hide from
    // the family, who would lose it with no trace (the 5.17c review).
    const letter = await make(owner, {
      title: 'Tess school report',
      type_key: 'utility_bill',
      owner_member_id: teen.member_id,
      visibility: 'household',
    });
    expect(letter.filed_by_me).toBe(true);
    const asTeen = await get(teen, `/api/v1/documents/${letter.id}`);
    expect(asTeen.json<DocumentView>()).toMatchObject({
      owner_member_id: teen.member_id,
      filed_by_me: false,
    });
    for (const to of ['private', 'adults'] as const) {
      expect(refusal(await show(teen, letter.id, to)), to).toMatchObject({
        code: 'forbidden',
        message: 'Only an adult can change who is able to see a document.',
      });
    }
    const edited = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${letter.id}`,
      headers: h.as(teen),
      payload: { visibility: 'private' },
    });
    expect(refusal(edited).message).toBe('Only an adult can change who is able to see a document.');
    // The owner keeps it, and the family still sees it.
    expect(await visibilityOf(letter.id)).toBe('household');
    expect((await get(owner, `/api/v1/documents/${letter.id}`)).statusCode).toBe(200);
    expect((await get(viewer, `/api/v1/documents/${letter.id}`)).statusCode).toBe(200);
    // One the teen filed says so, to them alone.
    const own = await make(teen, { title: 'Tess bus pass', type_key: 'utility_bill' });
    expect(own.filed_by_me).toBe(true);
    expect((await get(owner, `/api/v1/documents/${own.id}`)).json<DocumentView>().filed_by_me).toBe(
      false,
    );
  });

  it('GET, PATCH and POST visibility with an id that is not one are 404, not 500', async () => {
    for (const as of [owner, teen]) {
      const answers = [
        await get(as, '/api/v1/documents/abc'),
        await h.app.inject({
          method: 'PATCH',
          url: '/api/v1/documents/abc',
          headers: h.as(as),
          payload: { title: 'x' },
        }),
        await show(as, 'abc', 'private'),
        await show(as, 'abc', 'household'),
      ];
      for (const res of answers) {
        expect(res.statusCode, res.body).toBe(404);
        expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found');
      }
    }
  });

  it("an owner still cannot change a teen's Only me document, which they cannot see", async () => {
    const card = await make(teen, { title: 'Tess ID card', type_key: 'national_id' });
    expect(card.visibility).toBe('private');
    for (const as of [owner, adult]) {
      for (const to of ['household', 'adults', 'private']) {
        const res = await show(as, card.id, to);
        expect(res.statusCode, to).toBe(404);
        expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found');
      }
    }
    expect(await visibilityOf(card.id)).toBe('private');
    // And owners and adults keep what they had on everything else.
    const bill = await make(adult, { title: 'Water bill', type_key: 'utility_bill' });
    expect((await show(owner, bill.id, 'adults')).statusCode).toBe(200);
    expect((await show(adult, bill.id, 'household')).statusCode).toBe(200);
    expect(refusal(await show(owner, bill.id, 'private')).message).toBe(
      'Only the person a document belongs to can make it private, or un-private it.',
    );
  });
});
