import { randomUUID } from 'node:crypto';
import { testAdminUrl } from '@fdv/db/testing';
import { canSee, mayKeepOffline, type DocumentView, type Role } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from './auth/service.js';
import { createHarness, type Harness } from './test-harness.js';

/**
 * One rule, several copies.
 *
 * Who may see a document is written once in words — everyone, the adults,
 * or only its owner — and several times in code: the SQL in the document
 * list, in search, in the reminder list, the share-link list, the tag list
 * and the issuer list, and `canSee` in `@fdv/shared`,
 * which the worker uses to cut each person's digest. The digest leak fixed
 * in 0.4.2 was a copy that forgot the rule entirely, so this holds every
 * copy the API serves to the same answers as the shared one, for every
 * role, over documents of every visibility and more than one owner.
 */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');

describe.skipIf(!testAdminUrl())('the visibility rule has one meaning everywhere', () => {
  let h: Harness;
  const people = {} as Record<Role, Tokens>;
  const docs: Array<{
    id: string;
    visibility: string;
    owner_member_id: string;
    tag: string;
    version_id: string;
  }> = [];

  let n = 0;
  const make = async (
    as: Tokens,
    title: string,
    visibility: 'household' | 'adults' | 'private',
  ) => {
    const tag = `parity${++n}`;
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(as),
      payload: {
        title: `Parity ${title}`,
        type_key: 'utility_bill',
        owner_member_id: as.member_id,
        visibility,
        tags: [tag],
        // One issuer per document, as telling as its title (0.4.10).
        issued_by: `Parity issuer ${tag}`,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const doc = created.json<DocumentView>();
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const uploaded = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc.id}/versions`,
      headers: { ...h.as(as), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    docs.push({
      id: doc.id,
      visibility,
      owner_member_id: as.member_id,
      tag,
      version_id: uploaded.json<{ id: string }>().id,
    });
    // A link out of the house to every one of them, which names it.
    const shared = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc.id}/share`,
      headers: h.as(as),
      payload: { recipient_label: 'the accountant' },
    });
    expect(shared.statusCode, shared.body).toBe(201);
    // A reminder on every one of them, set by whoever made it.
    const reminder = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reminders',
      headers: h.as(as),
      payload: { document_id: doc.id, fire_at: '2030-01-01' },
    });
    expect(reminder.statusCode, reminder.body).toBe(201);
  };

  beforeAll(async () => {
    h = await createHarness();
    people.owner = await h.setup();
    people.adult = await h.join(people.owner, {
      name: 'Adult',
      email: 'parity-adult@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Teen',
      email: 'parity-teen@example.test',
      role: 'teen',
    });
    people.viewer = await h.join(people.owner, {
      name: 'Viewer',
      email: 'parity-viewer@example.test',
      role: 'viewer',
    });
    await make(people.owner, 'household', 'household');
    await make(people.owner, 'adults', 'adults');
    await make(people.owner, 'owner private', 'private');
    await make(people.adult, 'adults by the adult', 'adults');
    await make(people.adult, 'adult private', 'private');
  }, 90_000);
  afterAll(() => h.close());

  const expected = (role: Role) =>
    docs
      .filter((d) => canSee({ role, memberId: people[role].member_id }, d))
      .map((d) => d.id)
      .sort();

  const roles: Role[] = ['owner', 'adult', 'teen', 'viewer'];

  it.each(roles)('the document list agrees with canSee for a %s', async (role) => {
    const res = await h.app.inject({
      url: '/api/v1/documents?limit=200',
      headers: h.as(people[role]),
    });
    const ids = res
      .json<{ items: DocumentView[] }>()
      .items.map((d) => d.id)
      .filter((id) => docs.some((d) => d.id === id))
      .sort();
    expect(ids).toEqual(expected(role));
  });

  it.each(roles)('the reminder list agrees with canSee for a %s', async (role) => {
    const res = await h.app.inject({
      url: '/api/v1/reminders?state=all',
      headers: h.as(people[role]),
    });
    const ids = [
      ...new Set(
        res
          .json<{ items: Array<{ document_id: string }> }>()
          .items.map((r) => r.document_id)
          .filter((id) => docs.some((d) => d.id === id)),
      ),
    ].sort();
    expect(ids).toEqual(expected(role));
  });

  it.each(roles)('search agrees with canSee for a %s', async (role) => {
    const res = await h.app.inject({
      url: '/api/v1/search?q=parity',
      headers: h.as(people[role]),
    });
    expect(res.statusCode, res.body).toBe(200);
    const ids = res
      .json<{ items: Array<{ document_id: string }> }>()
      .items.map((r) => r.document_id)
      .filter((id) => docs.some((d) => d.id === id))
      .sort();
    expect(ids).toEqual(expected(role));
  });

  it.each(roles)('the share-link list agrees with canSee for a %s', async (role) => {
    const res = await h.app.inject({ url: '/api/v1/shares', headers: h.as(people[role]) });
    expect(res.statusCode, res.body).toBe(200);
    const ids = [
      ...new Set(
        res
          .json<{ items: Array<{ document_id: string }> }>()
          .items.map((s) => s.document_id)
          .filter((id) => docs.some((d) => d.id === id)),
      ),
    ].sort();
    expect(ids).toEqual(expected(role));
  });

  it.each(roles)('the tag list agrees with canSee for a %s', async (role) => {
    const res = await h.app.inject({ url: '/api/v1/tags?q=parity', headers: h.as(people[role]) });
    expect(res.statusCode, res.body).toBe(200);
    const tags = res.json<{ items: Array<{ tag: string }> }>().items.map((t) => t.tag);
    const ids = docs
      .filter((d) => tags.includes(d.tag))
      .map((d) => d.id)
      .sort();
    expect(ids).toEqual(expected(role));
  });

  it.each(roles)('the issuer list agrees with canSee for a %s', async (role) => {
    const res = await h.app.inject({
      url: '/api/v1/issuers?q=Parity%20issuer',
      headers: h.as(people[role]),
    });
    expect(res.statusCode, res.body).toBe(200);
    const issuers = res
      .json<{ items: Array<{ issued_by: string }> }>()
      .items.map((i) => i.issued_by);
    const ids = docs
      .filter((d) => issuers.includes(`Parity issuer ${d.tag}`))
      .map((d) => d.id)
      .sort();
    expect(ids).toEqual(expected(role));
  });

  it.each(roles)('the pages endpoint agrees with canSee for a %s', async (role) => {
    const seen: string[] = [];
    for (const d of docs) {
      const res = await h.app.inject({
        url: `/api/v1/versions/${d.version_id}/pages/1`,
        headers: h.as(people[role]),
      });
      // Seen: on its way, or asking who is there. Not seen: not there at all.
      const code = res.json<{ error: { code: string } }>().error.code;
      if (code !== 'not_found') seen.push(d.id);
    }
    expect(seen.sort()).toEqual(expected(role));
  });

  describe('the offline set (0.4.13)', () => {
    beforeAll(async () => {
      // Every parity document made Essential, by whoever made it.
      for (const d of docs) {
        const who = Object.values(people).find((t) => t.member_id === d.owner_member_id) as Tokens;
        const res = await h.app.inject({
          method: 'PATCH',
          url: `/api/v1/documents/${d.id}`,
          headers: h.as(who),
          payload: { is_essential: true },
        });
        expect(res.statusCode, res.body).toBe(200);
      }
    });

    it.each(roles)('agrees with canSee and the role policy for a %s', async (role) => {
      const res = await h.app.inject({
        url: '/api/v1/offline/essentials',
        headers: h.as(people[role]),
      });
      expect(res.statusCode, res.body).toBe(200);
      const ids = res
        .json<{ items: Array<{ document: { id: string } }> }>()
        .items.map((i) => i.document.id)
        .filter((id) => docs.some((d) => d.id === id))
        .sort();
      const expectedIds = docs
        .filter((d) =>
          mayKeepOffline(
            { role, memberId: people[role].member_id },
            { ...d, is_essential: true },
            false,
          ),
        )
        .map((d) => d.id)
        .sort();
      expect(ids).toEqual(expectedIds);
    });
  });

  it('the rule is not vacuous: every role is refused something here', () => {
    for (const role of roles) expect(expected(role).length, role).toBeLessThan(docs.length);
    // And the two adults each see exactly one private document: their own.
    expect(expected('owner')).not.toEqual(expected('adult'));
  });
});
