import { testAdminUrl } from '@fdv/db/testing';
import { can, CAPABILITIES, type Capability, ROLES, type Role } from '@fdv/shared';
import type { DocumentView } from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from './auth/service.js';
import { createHarness, type Harness } from './test-harness.js';

/**
 * The role matrix, endpoint by endpoint (SHR-03).
 *
 * `packages/shared/roles.test.ts` proves the table says what the design
 * says. This proves the server obeys it: for every capability there is at
 * least one live request, made by all four roles against a real database,
 * and the answer is compared with the table rather than with what the
 * endpoint happens to do today.
 *
 * The last test is the one that matters most — it fails if a capability
 * exists that no request here exercises, so a new rule cannot be added to
 * the matrix and left unenforced.
 */
interface Probe {
  capability: Capability;
  what: string;
  call: (t: Tokens) => Promise<{ statusCode: number; json: () => unknown }>;
  /**
   * Roles refused by a rule that is not the matrix — today only the one
   * that says a teen may edit documents, but only their own.
   */
  alsoRefused?: Role[];
}

describe.skipIf(!testAdminUrl())('the role matrix, endpoint by endpoint', () => {
  let h: Harness;
  const people = {} as Record<Role, Tokens>;
  let doc: string;
  let adultsOnly: string;

  beforeAll(async () => {
    h = await createHarness();
    people.owner = await h.setup();
    people.adult = await h.join(people.owner, {
      name: 'Adult',
      email: 'adult@example.test',
      role: 'adult',
    });
    people.teen = await h.join(people.owner, {
      name: 'Teen',
      email: 'teen@example.test',
      role: 'teen',
    });
    people.viewer = await h.join(people.owner, {
      name: 'Viewer',
      email: 'viewer@example.test',
      role: 'viewer',
    });

    const make = async (title: string, visibility: 'household' | 'adults') => {
      const created = await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(people.owner),
        payload: { title, type_key: 'utility_bill', visibility },
      });
      return created.json<DocumentView>().id;
    };
    doc = await make('Everyone can see this', 'household');
    adultsOnly = await make('Adults only', 'adults');
  }, 90_000);
  afterAll(() => h.close());

  /** A household document nobody minds losing. */
  const disposable = async () => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(people.owner),
      payload: { title: 'Disposable', type_key: 'utility_bill' },
    });
    return created.json<DocumentView>().id;
  };

  /**
   * Somebody expendable, with a real sign-in. The two probes below change
   * or remove a person, so they cannot be aimed at anyone the rest of the
   * file still needs.
   */
  let spare = 0;
  const disposablePerson = async () => {
    const n = ++spare;
    const who = await h.join(people.owner, {
      name: `Spare ${n}`,
      email: `spare${n}@example.test`,
      role: 'adult',
    });
    return who.member_id;
  };

  const probes: Probe[] = [
    {
      capability: 'document.add',
      what: 'add a document',
      call: (t) =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/documents',
          headers: h.as(t),
          payload: { title: 'Something new' },
        }),
    },
    {
      capability: 'document.edit',
      what: "change someone else's document",
      alsoRefused: ['teen'],
      call: (t) =>
        h.app.inject({
          method: 'PATCH',
          url: `/api/v1/documents/${doc}`,
          headers: h.as(t),
          payload: { notes: 'edited' },
        }),
    },
    {
      capability: 'document.delete',
      what: 'move a document to the trash',
      alsoRefused: ['teen'],
      // A fresh one each time: the second caller of a shared document
      // would get 404 because the first one binned it, which would look
      // like a refusal and prove nothing.
      call: async (t) =>
        h.app.inject({
          method: 'DELETE',
          url: `/api/v1/documents/${await disposable()}`,
          headers: h.as(t),
        }),
    },
    {
      capability: 'document.visibility',
      what: 'change who can see a document',
      call: (t) =>
        h.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${doc}/visibility`,
          headers: h.as(t),
          payload: { visibility: 'household' },
        }),
    },
    {
      capability: 'reminder.manage',
      what: 'set a reminder',
      call: (t) =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/reminders',
          headers: h.as(t),
          payload: { document_id: doc, fire_at: '2027-01-01', note: 'Check this' },
        }),
    },
    {
      capability: 'profile.edit',
      what: 'change the household details',
      call: (t) =>
        h.app.inject({
          method: 'PUT',
          url: '/api/v1/profile',
          headers: h.as(t),
          payload: { has_pets: true },
        }),
    },
    {
      capability: 'member.add',
      what: 'add a person',
      call: (t) =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/members',
          headers: h.as(t),
          payload: { display_name: 'Someone' },
        }),
    },
    {
      capability: 'member.invite',
      what: 'see who has been invited',
      call: (t) => h.app.inject({ url: '/api/v1/invitations', headers: h.as(t) }),
    },
    {
      capability: 'member.invite_adult',
      what: 'invite another adult',
      call: (t) =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/invitations',
          headers: h.as(t),
          payload: {
            display_name: `Adult ${Math.random().toString(36).slice(2, 8)}`,
            email: `a${Math.random().toString(36).slice(2, 8)}@example.test`,
            role: 'adult',
          },
        }),
    },
    {
      capability: 'member.remove',
      what: "take away somebody's sign-in",
      call: async (t) =>
        h.app.inject({
          method: 'DELETE',
          url: `/api/v1/members/${await disposablePerson()}/sign-in`,
          headers: h.as(t),
        }),
    },
    {
      capability: 'role.change',
      what: 'change what somebody is allowed to do',
      call: async (t) =>
        h.app.inject({
          method: 'POST',
          url: `/api/v1/members/${await disposablePerson()}/role`,
          headers: h.as(t),
          payload: { role: 'viewer' },
        }),
    },
    {
      capability: 'audit.read',
      what: 'see what the family has been doing',
      call: (t) => h.app.inject({ url: '/api/v1/audit', headers: h.as(t) }),
    },
    {
      capability: 'storage.manage',
      what: 'change where files are kept',
      call: (t) =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/vaults',
          headers: h.as(t),
          payload: {
            provider: 'other',
            label: 'Bucket',
            endpoint: 'https://s3.example.test',
            region: 'us-east-1',
            bucket: 'fdv',
            access_key_id: 'key',
            secret_access_key: 'secret',
          },
        }),
    },
    {
      capability: 'notifications.manage',
      what: 'change how the vault sends email',
      call: (t) =>
        h.app.inject({
          method: 'PUT',
          url: '/api/v1/notifications/smtp',
          headers: h.as(t),
          payload: {
            host: 'smtp.example.test',
            port: 587,
            username: 'vault',
            password: 'hunter22222',
            from_email: 'vault@example.test',
            secure: true,
          },
        }),
    },
    {
      capability: 'export.request',
      what: 'export everything',
      call: (t) => h.app.inject({ method: 'POST', url: '/api/v1/exports', headers: h.as(t) }),
    },
  ];

  for (const probe of probes) {
    for (const role of ROLES) {
      const refused = !can(role, probe.capability) || (probe.alsoRefused ?? []).includes(role);
      it(`${role} ${refused ? 'cannot' : 'can'} ${probe.what}`, async () => {
        const res = await probe.call(people[role]);
        if (refused) {
          expect(res.statusCode).toBe(403);
          const body = res.json() as { error: { code: string; message: string } };
          // Never `step_up_required` dressed up as a refusal: these
          // sessions are fresh, and a role refusal must not be something
          // the person could get past by typing their password.
          expect(body.error.code).toBe('forbidden');
          expect(body.error.message).toMatch(/\.$/);
        } else {
          // Anything but 403. A 404 or a 422 means the request was allowed
          // and then failed on its own merits, which is not this test's
          // business.
          expect(res.statusCode).not.toBe(403);
        }
      });
    }
  }

  /**
   * Found by running the thing rather than by reading it: a teen added a
   * document, and was then refused when they tried to change it, because
   * a document with nobody named on it is a family document and a teen
   * may only change their own.
   */
  it('a document a teen adds belongs to them, and stays theirs to change', async () => {
    const mine = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(people.teen),
      payload: { title: 'School report' },
    });
    expect(mine.statusCode).toBe(201);
    const id = mine.json<DocumentView>().id;
    expect(mine.json<DocumentView>().owner_member_id).toBe(people.teen.member_id);

    for (const [what, res] of [
      [
        'edit',
        await h.app.inject({
          method: 'PATCH',
          url: `/api/v1/documents/${id}`,
          headers: h.as(people.teen),
          payload: { notes: 'Parents evening on the 4th' },
        }),
      ],
      [
        'trash',
        await h.app.inject({
          method: 'DELETE',
          url: `/api/v1/documents/${id}`,
          headers: h.as(people.teen),
        }),
      ],
      [
        'restore',
        await h.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${id}/restore`,
          headers: h.as(people.teen),
        }),
      ],
    ] as const) {
      expect(res.statusCode, what).not.toBe(403);
    }

    // Naming nobody does not make it a family document either: a teen
    // cannot file something they would then be unable to change.
    const unowned = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(people.teen),
      payload: { title: 'A family thing', owner_member_id: null },
    });
    expect(unowned.json<DocumentView>().owner_member_id).toBe(people.teen.member_id);

    // And they cannot file one under somebody else's name.
    const forSomeoneElse = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(people.teen),
      payload: { title: "Dad's thing", owner_member_id: people.owner.member_id },
    });
    expect(forSomeoneElse.statusCode).toBe(403);

    // An adult is under no such rule.
    const byAdult = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(people.adult),
      payload: { title: 'A real family thing' },
    });
    expect(byAdult.json<DocumentView>().owner_member_id).toBeNull();
  });

  /**
   * `document.see_adults` is the one capability that is not a refusal.
   * Telling a teen "you are not allowed to see that" would confirm the
   * document exists, so an adults-only document is simply not there.
   */
  it('an adults-only document is absent for a teen, not refused', async () => {
    const asAdult = await h.app.inject({
      url: `/api/v1/documents/${adultsOnly}`,
      headers: h.as(people.adult),
    });
    expect(asAdult.statusCode).toBe(200);

    for (const role of ['teen', 'viewer'] as const) {
      const res = await h.app.inject({
        url: `/api/v1/documents/${adultsOnly}`,
        headers: h.as(people[role]),
      });
      expect(res.statusCode, role).toBe(404);

      const listed = await h.app.inject({ url: '/api/v1/documents', headers: h.as(people[role]) });
      const titles = listed.json<{ items: DocumentView[] }>().items.map((d) => d.title);
      expect(titles, role).not.toContain('Adults only');

      // Nor through search, which is a different query over the same rule.
      const found = await h.app.inject({
        url: '/api/v1/search?q=adults',
        headers: h.as(people[role]),
      });
      const hits = found.json<{ items: Array<{ title: string | null }> }>().items;
      expect(
        hits.map((x) => x.title),
        role,
      ).not.toContain('Adults only');
    }
  });

  /**
   * A capability nothing enforces is worse than no capability: the matrix
   * would promise a rule the server does not keep. Everything not probed
   * above has to be named here, with the iteration that will enforce it,
   * so the list is a visible debt and not a silent hole.
   */
  const NOT_YET_ENFORCED: Partial<Record<Capability, string>> = {
    'document.see_adults': 'a filter, not a refusal — the test above',
    'family.details': 'a filter, not a refusal — household/what-viewers-see.test.ts (5.3)',
    'document.share': '3.3, share links',
  };

  it('every capability in the matrix is either exercised here or named as owed', () => {
    const probed = new Set(probes.map((p) => p.capability));
    const unaccounted = CAPABILITIES.filter((c) => !probed.has(c) && !NOT_YET_ENFORCED[c]);
    expect(unaccounted).toEqual([]);
    // And nothing is on the owed list that is in fact enforced.
    const owed = Object.keys(NOT_YET_ENFORCED) as Capability[];
    expect(owed.filter((c) => probed.has(c))).toEqual([]);
  });
});
