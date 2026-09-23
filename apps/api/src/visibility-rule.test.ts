import { testAdminUrl } from '@fdv/db/testing';
import { canSee, type DocumentView, type Role } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from './auth/service.js';
import { createHarness, type Harness } from './test-harness.js';

/**
 * One rule, several copies.
 *
 * Who may see a document is written once in words — everyone, the adults,
 * or only its owner — and several times in code: the SQL in the document
 * list, in search and in the reminder list, and `canSee` in `@fdv/shared`,
 * which the worker uses to cut each person's digest. The digest leak fixed
 * in 0.4.2 was a copy that forgot the rule entirely, so this holds every
 * copy the API serves to the same answers as the shared one, for every
 * role, over documents of every visibility and more than one owner.
 */
describe.skipIf(!testAdminUrl())('the visibility rule has one meaning everywhere', () => {
  let h: Harness;
  const people = {} as Record<Role, Tokens>;
  const docs: Array<{ id: string; visibility: string; owner_member_id: string }> = [];

  const make = async (
    as: Tokens,
    title: string,
    visibility: 'household' | 'adults' | 'private',
  ) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(as),
      payload: {
        title: `Parity ${title}`,
        type_key: 'utility_bill',
        owner_member_id: as.member_id,
        visibility,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const doc = created.json<DocumentView>();
    docs.push({ id: doc.id, visibility, owner_member_id: as.member_id });
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

  it('the rule is not vacuous: every role is refused something here', () => {
    for (const role of roles) expect(expected(role).length, role).toBeLessThan(docs.length);
    // And the two adults each see exactly one private document: their own.
    expect(expected('owner')).not.toEqual(expected('adult'));
  });
});
