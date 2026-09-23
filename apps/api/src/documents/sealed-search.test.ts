import { randomUUID } from 'node:crypto';
import { withHousehold, withScope } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { DocumentView } from '@fdv/shared';
import argon2 from 'argon2';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import { signSealedToken } from './sealed-token.js';
import type { SearchHit } from './service.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

interface FirstPass {
  items: SearchHit[];
  sealed_pending: { count: number; token?: string };
}

/**
 * FND-08: the caller's own private documents are searched by opening them,
 * one at a time, in their session — because their text is sealed and has
 * no index. Nobody else's session can do it, and nor can the same session
 * with someone else's handle.
 */
describe.skipIf(!testAdminUrl())('the second pass of search', () => {
  let h: Harness;
  let owner: Tokens;
  let other: Tokens;
  let willId: string;
  let diaryId: string;

  /** A document with OCR text, made private so the text ends up sealed. */
  const privateDocument = async (title: string, content: string, tags: string[] = []) => {
    const doc = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title, tags, owner_member_id: owner.member_id },
    });
    const id = doc.json<DocumentView>().id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    const versionId = up.json<{ id: string }>().id;
    // Stand in for the worker's OCR.
    await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('document_text')
        .values({
          version_id: versionId,
          household_id: owner.household_id,
          document_id: id,
          content,
        })
        .execute(),
    );
    const hidden = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/visibility`,
      headers: h.as(owner),
      payload: { visibility: 'private' },
    });
    expect(hidden.statusCode).toBe(200);
    return id;
  };

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();

    willId = await privateDocument(
      'Will',
      'Last will and testament of Mansoor Seikh. Executor: Rahul Bose. ' +
        'Should Rahul be unwilling to act, my sister is to take his place. ' +
        'The residue of my estate passes to my children in equal shares.',
    );
    diaryId = await privateDocument(
      'Notes to myself',
      'Rahul owes me for the kitchen. Ask about the estate agent in March.',
    );
    // Household-visible, indexed, and mentioning the same word.
    const open = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'Rahul — contact details', owner_member_id: owner.member_id },
    });
    expect(open.statusCode).toBe(201);

    // A second adult with a real account, as 3.2's invitation will make one.
    const member = await withHousehold(h.db, owner.household_id, (trx) =>
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
          member_id: member.id,
          role: 'adult',
        })
        .execute(),
    );
    const { ScopeKeys, EnvKeyProvider } = await import('@fdv/crypto');
    await withHousehold(h.db, owner.household_id, (trx) =>
      new ScopeKeys(new EnvKeyProvider(TEST_MASTER)).mintMemberKey(
        trx,
        owner.household_id,
        member.id,
        'sanas password 123',
      ),
    );
    other = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: 'sana@example.test', password: 'sanas password 123' },
      })
    ).json<Tokens>();
  }, 60_000);
  afterAll(() => h.close());

  const first = async (q: string, who = owner, extra = '') =>
    h.app
      .inject({ url: `/api/v1/search?q=${encodeURIComponent(q)}${extra}`, headers: h.as(who) })
      .then((r) => r.json<FirstPass>());

  const second = async (token: string, who = owner) =>
    h.app.inject({
      url: `/api/v1/search/sealed?token=${encodeURIComponent(token)}`,
      headers: h.as(who),
    });

  it('the first pass says what it could not look inside, and hands over a handle', async () => {
    const r = await first('executor');
    expect(r.items).toEqual([]); // nothing indexed contains it
    expect(r.sealed_pending.count).toBe(2);
    expect(typeof r.sealed_pending.token).toBe('string');
  });

  it('the second pass finds the word that only exists inside a sealed document', async () => {
    const r = await first('executor');
    const res = await second(r.sealed_pending.token as string);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: SearchHit[]; searched: number }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ document_id: willId, matched_in: 'content' });
    expect(body.items[0]?.snippet).toContain('<em>Executor</em>');
    expect(body.searched).toBe(2);
  });

  it('orders by how often the word appears, and honours or, phrases and not', async () => {
    const many = await first('rahul');
    const hits = (await second(many.sealed_pending.token as string)).json<{ items: SearchHit[] }>()
      .items;
    expect(hits.map((i) => i.document_id)).toEqual([willId, diaryId]);

    const phrase = await first('"estate agent"');
    expect(
      (await second(phrase.sealed_pending.token as string))
        .json<{ items: SearchHit[] }>()
        .items.map((i) => i.document_id),
    ).toEqual([diaryId]);

    const not = await first('rahul -kitchen');
    expect(
      (await second(not.sealed_pending.token as string))
        .json<{ items: SearchHit[] }>()
        .items.map((i) => i.document_id),
    ).toEqual([willId]);
  });

  it('does not repeat a document the first pass already returned', async () => {
    // "Will" matches the sealed document's own title, so the indexed pass
    // returns it; the second pass must not hand it back again.
    const r = await first('will');
    expect(r.items.map((i) => i.document_id)).toContain(willId);
    expect(
      (await second(r.sealed_pending.token as string)).json<{ items: SearchHit[] }>().items,
    ).toEqual([]);
  });

  it('another adult gets a handle for their own documents, and finds nothing of mine', async () => {
    const r = await first('executor', other);
    // Sana has no private documents at all.
    expect(r.sealed_pending.count).toBe(0);
    expect(r.sealed_pending.token).toBeUndefined();
  });

  it("another adult cannot use the owner's handle", async () => {
    const mine = await first('executor');
    const stolen = await second(mine.sealed_pending.token as string, other);
    expect(stolen.statusCode).toBe(403);
    expect(stolen.json<{ error: { message: string } }>().error.message).toMatch(
      /different sign-in/,
    );
  });

  it('a handle from a session that has signed out is refused', async () => {
    const r = await first('executor');
    const token = r.sealed_pending.token as string;
    const fresh = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'owner@example.test', password: 'correct horse battery' },
    });
    const later = fresh.json<Tokens>();
    // Same person, same household — but a different session.
    expect((await second(token, later)).statusCode).toBe(403);
    // Their own handle works.
    const theirs = await first('executor', later);
    expect((await second(theirs.sealed_pending.token as string, later)).statusCode).toBe(200);
  });

  it('an expired handle asks the person to search again, in plain words', async () => {
    const { SignJWT } = await import('jose');
    const { deriveSealedKey } = await import('./sealed-token.js');
    const expired = await new SignJWT({
      // The session does not matter here: expiry is checked first.
      sid: 'any session',
      hid: owner.household_id,
      mid: owner.member_id,
      q: 'executor',
      limit: 25,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('fdv')
      .setAudience('fdv-sealed-search')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(deriveSealedKey(TEST_MASTER));

    const res = await second(expired);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toBe(
      'That search has expired. Run it again.',
    );
  });

  it('a handle signed with the wrong key is refused the same way', async () => {
    const forged = await signSealedToken(new Uint8Array(32), {
      sid: 'anything',
      hid: owner.household_id,
      mid: owner.member_id,
      q: 'executor',
      limit: 25,
    });
    expect((await second(forged)).statusCode).toBe(400);
  });

  it('stays quick when there is a drawer full of them to open (NFR-02)', async () => {
    // The second pass decrypts every candidate, so its cost is linear in
    // the caller's own private documents. This is the guard against that
    // line bending: a dozen documents must still feel instant.
    for (let i = 0; i < 12; i++) {
      await privateDocument(
        `Private note ${i}`,
        `Filler text for document ${i}. ${'lorem ipsum dolor sit amet '.repeat(40)} needle${i}`,
      );
    }
    const r = await first('needle7');
    expect(r.sealed_pending.count).toBe(14);
    const t0 = performance.now();
    const res = await second(r.sealed_pending.token as string);
    const ms = performance.now() - t0;
    const body = res.json<{ items: SearchHit[]; searched: number }>();
    expect(body.searched).toBe(14);
    expect(body.items).toHaveLength(1);
    expect(ms).toBeLessThan(500);
  }, 60_000);

  it('nonsense in, nothing out — and a missing handle is a 422', async () => {
    const r = await first('zqxjkv');
    expect(
      (await second(r.sealed_pending.token as string)).json<{ items: SearchHit[] }>().items,
    ).toEqual([]);
    expect(
      (await h.app.inject({ url: '/api/v1/search/sealed', headers: h.as(owner) })).statusCode,
    ).toBe(422);
  });
});
