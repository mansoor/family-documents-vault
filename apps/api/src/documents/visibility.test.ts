import { randomUUID } from 'node:crypto';
import { withHousehold, withScope } from '@fdv/db';
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
    const otherMember = await withHousehold(h.db, owner.household_id, (trx) =>
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
    await withScope(h.db, { householdId: owner.household_id, accountId: account.id }, (trx) =>
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
    await withHousehold(h.db, owner.household_id, (trx) =>
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
    await withHousehold(h.db, owner.household_id, (trx) =>
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
    const v = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('document_version')
        .innerJoin('scope_key', 'scope_key.id', 'document_version.wrapped_by_scope')
        .select(['scope_key.kind', 'scope_key.member_id'])
        .where('document_version.id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(v).toEqual({ kind: 'member', member_id: owner.member_id });
    const plain = await withHousehold(h.db, owner.household_id, (trx) =>
      trx.selectFrom('document_text').selectAll().where('document_id', '=', docId).execute(),
    );
    expect(plain).toEqual([]);
    const sealed = await withHousehold(h.db, owner.household_id, (trx) =>
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
