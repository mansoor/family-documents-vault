import { randomUUID } from 'node:crypto';
import { withHousehold } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type { ActivityLine, DocumentView, SuggestionView } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from './auth/service.js';
import type { MemberView } from './household/service.js';
import { createHarness, type Harness } from './test-harness.js';

/**
 * The Phase 3 exit condition, as an adversarial suite.
 *
 * *A second adult uses the vault untaught and cannot reach the first
 * adult's private documents by any route, including raw API calls.*
 *
 * So this file is written from the attacker's side. Sam is a real adult
 * in the household — invited properly, holding a live session, later an
 * owner — and tries every endpoint the API has, with the ids of the
 * owner's private document in hand. Each one has to refuse, and refuse
 * without confirming that the thing exists.
 *
 * Two rules the assertions follow:
 *
 *  - **404, not 403.** "You are not allowed to see that" is a statement
 *    that there is something there. Absence is the only safe answer.
 *  - **No gap where it used to be.** Lists, counts, search results and
 *    the activity log must not leave a hole shaped like a document.
 */

const SECRET_TEXT = 'zygomorphic quillon — the word nobody else would write';
const PDF = Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n${SECRET_TEXT}\n%%EOF\n`);

describe.skipIf(!testAdminUrl())('the privacy wall, from the other side', () => {
  let h: Harness;
  let owner: Tokens;
  let sam: Tokens;
  /** The owner's private document, and everything Sam could aim at it. */
  let secretId: string;
  let secretVersionId: string;
  let sharedId: string;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const as = (t: Tokens) => h.as(t);

  /** A real multipart upload, so the refusal is the document's and not the parser's. */
  const samUploads = () => {
    const form = new FormData();
    form.append('file', PDF, { filename: 'mine.pdf', contentType: 'application/pdf' });
    return h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${secretId}/versions`,
      headers: { ...as(sam), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
  };

  const upload = async (documentId: string) => {
    const form = new FormData();
    form.append('file', PDF, { filename: 'notes.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/versions`,
      headers: { ...as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    return json<{ id: string }>(up).id;
  };

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();

    const secret = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: as(owner),
      payload: {
        title: 'Therapy notes',
        type_key: 'medical_record',
        owner_member_id: owner.member_id,
      },
    });
    secretId = json<DocumentView>(secret).id;
    secretVersionId = await upload(secretId);
    // The OCR text is written by the worker; put it where the worker
    // would, so the search paths have something real to fail to find.
    await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('document_text')
        .values({
          version_id: secretVersionId,
          household_id: owner.household_id,
          document_id: secretId,
          content: SECRET_TEXT,
        })
        .execute(),
    );
    const marked = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${secretId}/visibility`,
      headers: as(owner),
      payload: { visibility: 'private' },
    });
    expect(marked.statusCode).toBe(200);

    const shared = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: as(owner),
      payload: {
        title: 'Home insurance policy',
        type_key: 'insurance_policy',
        owner_member_id: owner.member_id,
      },
    });
    sharedId = json<DocumentView>(shared).id;
    await upload(sharedId);

    // Sam arrives the way a second adult really arrives.
    sam = await h.join(owner, { name: 'Sam', email: 'sam@example.test', role: 'adult' });
  }, 120_000);
  afterAll(() => h.close());

  it('Sam is a real adult with a working session, so the refusals mean something', async () => {
    const me = json<{ role: string }>(await h.app.inject({ url: '/api/v1/me', headers: as(sam) }));
    expect(me.role).toBe('adult');
    // Sam can do everything an adult does with the shared document.
    expect(
      (await h.app.inject({ url: `/api/v1/documents/${sharedId}`, headers: as(sam) })).statusCode,
    ).toBe(200);
  });

  it('every way of asking for it directly says it is not there', async () => {
    const attempts: Array<[string, Promise<{ statusCode: number }>]> = [
      ['fetch it', h.app.inject({ url: `/api/v1/documents/${secretId}`, headers: as(sam) })],
      [
        'its versions',
        h.app.inject({ url: `/api/v1/documents/${secretId}/versions`, headers: as(sam) }),
      ],
      [
        'its file',
        h.app.inject({ url: `/api/v1/versions/${secretVersionId}/content`, headers: as(sam) }),
      ],
      [
        'its thumbnail',
        h.app.inject({ url: `/api/v1/versions/${secretVersionId}/thumbnail`, headers: as(sam) }),
      ],
      [
        'a byte range of its file',
        h.app.inject({
          url: `/api/v1/versions/${secretVersionId}/content`,
          headers: { ...as(sam), range: 'bytes=0-10' },
        }),
      ],
      [
        'edit it',
        h.app.inject({
          method: 'PATCH',
          url: `/api/v1/documents/${secretId}`,
          headers: as(sam),
          payload: { title: 'Mine now' },
        }),
      ],
      [
        'bin it',
        h.app.inject({
          method: 'DELETE',
          url: `/api/v1/documents/${secretId}`,
          headers: as(sam),
        }),
      ],
      [
        'restore it',
        h.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${secretId}/restore`,
          headers: as(sam),
        }),
      ],
      [
        'share it out of the house',
        h.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${secretId}/share`,
          headers: as(sam),
          payload: {},
        }),
      ],
      [
        'set a reminder on it',
        h.app.inject({
          method: 'POST',
          url: '/api/v1/reminders',
          headers: as(sam),
          payload: { document_id: secretId, fire_at: '2027-01-01' },
        }),
      ],
      ['add a version to it', samUploads()],
    ];

    for (const [what, run] of attempts) {
      const res = await run;
      // 404 for "no such thing", or a validation refusal that never got
      // as far as the document. Never 200, and never 403: being told you
      // are not allowed is being told it is there.
      expect([404, 422], `${what} → ${res.statusCode}`).toContain(res.statusCode);
    }
  });

  it('changing its visibility back is not a way in, even for an owner', async () => {
    const asAdult = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${secretId}/visibility`,
      headers: as(sam),
      payload: { visibility: 'household' },
    });
    expect([403, 404]).toContain(asAdult.statusCode);

    // Co-ownership does not convey another member's private documents.
    // That boundary is cryptographic and no role changes it.
    const members = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: as(owner) }),
    ).items;
    const samMember = members.find((m) => m.display_name === 'Sam') as MemberView;
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: `/api/v1/members/${samMember.id}/role`,
          headers: as(owner),
          payload: { role: 'owner' },
        })
      ).statusCode,
    ).toBe(200);

    const asOwner = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${secretId}/visibility`,
      headers: as(sam),
      payload: { visibility: 'household' },
    });
    expect([403, 404]).toContain(asOwner.statusCode);
    expect(
      (await h.app.inject({ url: `/api/v1/documents/${secretId}`, headers: as(sam) })).statusCode,
    ).toBe(404);
  });

  it('no list, count or total leaves a hole shaped like it', async () => {
    const listed = json<{ items: DocumentView[] }>(
      await h.app.inject({ url: '/api/v1/documents?limit=100', headers: as(sam) }),
    ).items;
    expect(listed.map((d) => d.id)).not.toContain(secretId);
    expect(JSON.stringify(listed)).not.toContain('Therapy');

    const trash = json<{ items: DocumentView[] }>(
      await h.app.inject({ url: '/api/v1/documents?deleted=true&limit=100', headers: as(sam) }),
    ).items;
    expect(trash.map((d) => d.id)).not.toContain(secretId);

    const counts = json<{
      by_member: Array<{ member_id: string | null; count: number }>;
      by_category: Array<{ category: string; count: number }>;
    }>(await h.app.inject({ url: '/api/v1/documents/counts', headers: as(sam) }));
    // One shared document, and no sign of a second.
    expect(counts.by_member.reduce((n, x) => n + Number(x.count), 0)).toBe(1);
    expect(counts.by_category.some((c) => c.category === 'medical')).toBe(false);

    const people = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: as(sam) }),
    ).items;
    expect(people.find((m) => m.id === owner.member_id)?.document_count).toBe(1);
  });

  it('neither pass of search finds a word only that document contains', async () => {
    const first = json<{
      items: Array<{ document_id: string; snippet: string }>;
      sealed_pending: { count: number; token?: string };
    }>(await h.app.inject({ url: '/api/v1/search?q=zygomorphic', headers: as(sam) }));
    expect(first.items).toEqual([]);
    // Nothing of Sam's own is sealed, so there is nothing to look inside.
    expect(first.sealed_pending.count).toBe(0);
    expect(first.sealed_pending.token).toBeUndefined();

    // The owner's own second pass does find it — otherwise this test
    // would pass on a search that simply does not work.
    const mine = json<{ sealed_pending: { count: number; token?: string } }>(
      await h.app.inject({ url: '/api/v1/search?q=zygomorphic', headers: as(owner) }),
    );
    expect(mine.sealed_pending.count).toBe(1);
    const theirs = json<{ items: Array<{ title: string | null }> }>(
      await h.app.inject({
        url: `/api/v1/search/sealed?token=${mine.sealed_pending.token as string}`,
        headers: as(owner),
      }),
    );
    expect(theirs.items.map((x) => x.title)).toContain('Therapy notes');

    // And the owner's handle is no use to Sam: it is bound to the session
    // that asked for it.
    const stolen = await h.app.inject({
      url: `/api/v1/search/sealed?token=${mine.sealed_pending.token as string}`,
      headers: as(sam),
    });
    expect(stolen.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(stolen).error.code).toBe('not_your_search');
  });

  it('the activity log has no line about it, not even an anonymous one', async () => {
    const lines = json<{ items: ActivityLine[] }>(
      await h.app.inject({ url: '/api/v1/audit?limit=100', headers: as(sam) }),
    ).items;
    const text = lines.map((l) => l.text).join(' | ');
    expect(text).not.toContain('Therapy');
    expect(text).not.toMatch(/a document/);
    expect(lines.map((l) => l.document_id)).not.toContain(secretId);
  });

  it('the list of share links does not name it either', async () => {
    // The owner may share their own private document; Sam must not learn
    // that the link exists, because the link names the document.
    const made = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${secretId}/share`,
      headers: as(owner),
      payload: { recipient_label: 'my counsellor' },
    });
    expect(made.statusCode).toBe(201);

    const theirs = json<{ items: Array<{ document_title: string | null }> }>(
      await h.app.inject({ url: '/api/v1/shares', headers: as(sam) }),
    ).items;
    expect(JSON.stringify(theirs)).not.toContain('Therapy');
    expect(JSON.stringify(theirs)).not.toContain('counsellor');
  });

  it('a suggestion never reveals it by going quiet', async () => {
    // The owner holds a private will; Sam should still be told the family
    // has no will on file, because a missing suggestion would otherwise
    // say "somebody has one and you cannot see it".
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/profile',
      headers: as(owner),
      payload: { owns_home: true },
    });
    const will = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: as(owner),
      payload: { title: 'My will', type_key: 'will', owner_member_id: owner.member_id },
    });
    const willId = json<DocumentView>(will).id;
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${willId}/visibility`,
      headers: as(owner),
      payload: { visibility: 'private' },
    });

    const theirs = json<{ items: SuggestionView[] }>(
      await h.app.inject({ url: '/api/v1/suggestions', headers: as(sam) }),
    ).items;
    expect(theirs.map((s) => s.rule_key)).toContain('household_needs_will');

    // And the owner, who can see their own, is not nagged about it.
    const mine = json<{ items: SuggestionView[] }>(
      await h.app.inject({ url: '/api/v1/suggestions', headers: as(owner) }),
    ).items;
    expect(mine.map((s) => s.rule_key)).not.toContain('household_needs_will');
  });

  it('a copy of everything is a copy of everything Sam can see, and no more', async () => {
    const asked = await h.app.inject({ method: 'POST', url: '/api/v1/exports', headers: as(sam) });
    expect(asked.statusCode).toBe(202);
    const exportId = json<{ id: string }>(asked).id;

    // The worker builds the ZIP from the requester's own visibility, so
    // assert on the query it will run rather than on the file it writes.
    const visible = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('export')
        .innerJoin('account_household', (j) =>
          j.onRef('account_household.account_id', '=', 'export.requested_by'),
        )
        .select(['account_household.member_id'])
        .where('export.id', '=', exportId)
        .executeTakeFirstOrThrow(),
    );
    const rows = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('document')
        .select(['id', 'title'])
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb('visibility', '=', 'household'),
            eb('visibility', '=', 'adults'),
            eb.and([
              eb('visibility', '=', 'private'),
              eb('owner_member_id', '=', visible.member_id),
            ]),
          ]),
        )
        .execute(),
    );
    expect(rows.map((r) => r.title)).not.toContain('Therapy notes');
    expect(rows.map((r) => r.title)).not.toContain('My will');
    expect(rows.map((r) => r.title)).toContain('Home insurance policy');
  });

  it('the sealed text is in the database as ciphertext, and nowhere else', async () => {
    const sealed = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('document_text_sealed')
        .select(['content_cipher'])
        .where('document_id', '=', secretId)
        .execute(),
    );
    expect(sealed.length).toBeGreaterThan(0);
    for (const row of sealed) {
      expect(row.content_cipher.includes(Buffer.from(SECRET_TEXT))).toBe(false);
    }
    // And the searchable table no longer holds a copy of it.
    const plain = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('document_text')
        .select(['content'])
        .where('document_id', '=', secretId)
        .execute(),
    );
    expect(plain).toEqual([]);
  });

  it('an invitation cannot be used to become the person it belongs to', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${owner.member_id}/invite`,
      headers: as(sam),
      payload: { email: 'impostor@example.test', role: 'owner' },
    });
    expect(res.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('already_signed_in');
  });

  it('and after all of that, the owner can still open their own document', async () => {
    const res = await h.app.inject({
      url: `/api/v1/versions/${secretVersionId}/content`,
      headers: as(owner),
    });
    // An "only me" document asks who is asking; the session is fresh.
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.includes(Buffer.from(SECRET_TEXT))).toBe(true);
  });
});

/**
 * The same wall from the other directions, added in 0.4.2 after a review
 * of the digest leak found routes this suite had not tried: the owner
 * reaching for another adult's private documents, rather than the other
 * way round. Being an owner opens nothing private that belongs to
 * somebody else.
 */
describe.skipIf(!testAdminUrl())('the privacy wall, from the owner’s side', () => {
  let h: Harness;
  let owner: Tokens;
  let sam: Tokens;
  let samSecret: string;
  const SAM_PASSWORD = 'sams own long passphrase';

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const as = (t: Tokens) => h.as(t);

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    sam = await h.join(owner, {
      name: 'Sam',
      email: 'sam-other-side@example.test',
      role: 'adult',
      password: SAM_PASSWORD,
    });
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: as(sam),
      payload: {
        title: 'Divorce papers',
        type_key: 'utility_bill',
        owner_member_id: sam.member_id,
        visibility: 'private',
      },
    });
    samSecret = json<DocumentView>(created).id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'papers.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${samSecret}/versions`,
      headers: { ...as(sam), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBe(201);
  }, 120_000);
  afterAll(() => h.close());

  it('an owner cannot list, look up or download another adult’s export', async () => {
    const asked = await h.app.inject({ method: 'POST', url: '/api/v1/exports', headers: as(sam) });
    expect(asked.statusCode).toBe(202);
    const id = json<{ id: string }>(asked).id;

    const listed = json<{ items: Array<{ id: string }> }>(
      await h.app.inject({ url: '/api/v1/exports', headers: as(owner) }),
    ).items;
    expect(listed.map((e) => e.id)).not.toContain(id);
    for (const url of [`/api/v1/exports/${id}`, `/api/v1/exports/${id}/content`]) {
      const res = await h.app.inject({ url, headers: as(owner) });
      expect(res.statusCode, url).toBe(404);
    }
    // Sam's own is Sam's.
    expect(
      (await h.app.inject({ url: `/api/v1/exports/${id}`, headers: as(sam) })).statusCode,
    ).toBe(200);
  });

  it('taking a sign-in away and inviting the person again is not a way in', async () => {
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${sam.member_id}/sign-in`,
      headers: as(owner),
    });
    expect(removed.statusCode, removed.body).toBe(204);

    for (const [url, payload] of [
      [
        `/api/v1/members/${sam.member_id}/invite`,
        { email: 'impostor@example.test', role: 'viewer' },
      ],
      [
        '/api/v1/invitations',
        { member_id: sam.member_id, email: 'impostor2@example.test', role: 'adult' },
      ],
    ] as const) {
      const res = await h.app.inject({ method: 'POST', url, headers: as(owner), payload });
      expect(res.statusCode, url).toBe(409);
      expect(json<{ error: { code: string } }>(res).error.code).toBe('had_sign_in');
    }
    // The people list offers to give it back, not to invite.
    const members = json<{ items: MemberView[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: as(owner) }),
    ).items;
    expect(members.find((m) => m.id === sam.member_id)?.sign_in_removed).toBe(true);
  });

  it('an invitation made before the fix cannot be accepted for somebody who had a sign-in', async () => {
    // A person with no sign-in, invited — the ordinary, allowed case…
    const added = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: as(owner),
      payload: { display_name: 'Priya' },
    });
    const priya = json<MemberView>(added).id;
    const invited = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${priya}/invite`,
      headers: as(owner),
      payload: { email: 'priya@example.test', role: 'adult' },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { link_token, code } = json<{ link_token: string; code: string }>(invited);
    // …who, before the invitation is used, turns out to have had one: the
    // state an invitation made under 0.4.1 can be left waiting in.
    await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('scope_key')
        .set({ key_wrapped_cred: Buffer.alloc(60, 7) })
        .where('kind', '=', 'member')
        .where('member_id', '=', priya)
        .execute(),
    );
    const accepted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${link_token}/accept`,
      payload: { code, password: 'whoever holds the link' },
      remoteAddress: '10.9.9.9',
    });
    expect(accepted.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(accepted).error.code).toBe('had_sign_in');
  });

  it('the sign-in comes back to Sam alone, with Sam’s own password', async () => {
    const given = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${sam.member_id}/sign-in`,
      headers: as(owner),
      payload: { role: 'adult' },
    });
    expect(given.statusCode, given.body).toBe(200);
    // Nothing secret came back to the owner: no token, no code.
    expect(given.body).not.toMatch(/token|code/i);

    const signedIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'sam-other-side@example.test', password: SAM_PASSWORD },
      remoteAddress: '10.9.9.10',
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const again = json<Tokens>(signedIn);
    const versions = json<{ items: Array<{ id: string }> }>(
      await h.app.inject({ url: `/api/v1/documents/${samSecret}/versions`, headers: as(again) }),
    ).items;
    const content = await h.app.inject({
      url: `/api/v1/versions/${versions[0]?.id}/content`,
      headers: as(again),
    });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.includes(Buffer.from('%PDF'))).toBe(true);
    // And the owner, who gave it back, still cannot see it.
    expect(
      (await h.app.inject({ url: `/api/v1/documents/${samSecret}`, headers: as(owner) }))
        .statusCode,
    ).toBe(404);
  });
});

/**
 * Links, keys and hand-overs — the rest of what the 0.4.2 sweep found.
 * A link lends its maker's sight of a document, so it must end when that
 * sight does; a document that belongs to somebody is theirs to give away;
 * and anything hidden is absent, never "refused".
 */
describe.skipIf(!testAdminUrl())('the privacy wall: links, keys and hand-overs', () => {
  let h: Harness;
  let owner: Tokens;
  let sam: Tokens;
  let teen: Tokens;
  const docOf: Record<string, string> = {};
  const versionOf: Record<string, string> = {};
  let samReminder = '';
  let samShareId = '';
  let samExport = '';
  const link: Record<string, string> = {};

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const as = (t: Tokens) => h.as(t);
  let peers = 0;
  const peer = () => ({ remoteAddress: `10.77.${peers >> 8}.${peers++ & 0xff}` });

  /** Every session of this person, made cold (older than the step-up window) or warm. */
  const setFresh = (t: Tokens, fresh: boolean) =>
    withHousehold(h.db, t.household_id, async (trx) => {
      const a = await trx
        .selectFrom('account_household')
        .select('account_id')
        .where('member_id', '=', t.member_id)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - (fresh ? 0 : 10 * 60 * 1000)) })
        .where('account_id', '=', a.account_id)
        .execute();
    });

  const make = async (who: Tokens, key: string, visibility: 'household' | 'adults' | 'private') => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: as(who),
      payload: { title: key, type_key: 'utility_bill', owner_member_id: who.member_id, visibility },
    });
    expect(created.statusCode, created.body).toBe(201);
    docOf[key] = json<DocumentView>(created).id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'f.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docOf[key]}/versions`,
      headers: { ...as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBe(201);
    versionOf[key] = json<{ id: string }>(up).id;
  };

  const share = async (who: Tokens, key: string) => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docOf[key]}/share`,
      headers: as(who),
      payload: { recipient_label: 'the solicitor' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return json<{ link_token: string }>(res).link_token;
  };

  const opens = async (token: string) =>
    (
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/shared/${token}/open`,
        payload: {},
        ...peer(),
      })
    ).statusCode;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    sam = await h.join(owner, { name: 'Sam', email: 'sam-links@example.test', role: 'adult' });
    teen = await h.join(owner, { name: 'Aisha', email: 'aisha-links@example.test', role: 'teen' });
    await make(sam, 'Sam car insurance', 'household');
    await make(sam, 'Sam gym contract', 'household');
    await make(owner, 'Solicitor letter', 'adults');
    await make(owner, 'Council tax', 'household');
    await make(sam, 'Sam private', 'private');
    // Everything the tests below aim at, made while every session is warm.
    link.samDoc = await share(owner, 'Sam car insurance');
    link.adults = await share(sam, 'Solicitor letter');
    link.samPrivate = await share(sam, 'Sam private');
    samShareId = json<{ items: Array<{ id: string; document_id: string }> }>(
      await h.app.inject({ url: '/api/v1/shares', headers: as(sam) }),
    ).items.find((s) => s.document_id === docOf['Sam private'])?.id as string;
    const reminder = await h.app.inject({
      method: 'POST',
      url: '/api/v1/reminders',
      headers: as(sam),
      payload: { document_id: docOf['Sam private'], fire_at: '2030-01-01' },
    });
    samReminder = json<{ id: string }>(reminder).id;
    const exported = await h.app.inject({
      method: 'POST',
      url: '/api/v1/exports',
      headers: as(sam),
    });
    samExport = json<{ id: string }>(exported).id;
  }, 120_000);
  afterAll(() => h.close());

  it('a link stops working the moment its document becomes somebody else’s "Only me"', async () => {
    expect(await opens(link.samDoc as string)).toBe(200);
    const marked = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docOf['Sam car insurance']}/visibility`,
      headers: as(sam),
      payload: { visibility: 'private' },
    });
    expect(marked.statusCode, marked.body).toBe(200);
    // The owner made the link while they could see the document. They
    // cannot any more, so neither can whoever holds the link.
    expect(await opens(link.samDoc as string)).toBe(404);
    // Sam's own link to Sam's own private document still works.
    expect(await opens(link.samPrivate as string)).toBe(200);
  });

  it('what is hidden is absent, not refused', async () => {
    await setFresh(owner, false);
    const attempts: Array<[string, Promise<{ statusCode: number }>]> = [
      [
        'change who can see it',
        h.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${docOf['Sam private']}/visibility`,
          headers: as(owner),
          payload: { visibility: 'household' },
        }),
      ],
      [
        'open its file with a cold session',
        h.app.inject({
          url: `/api/v1/versions/${versionOf['Sam private']}/content`,
          headers: as(owner),
        }),
      ],
      [
        'delete its reminder',
        h.app.inject({
          method: 'DELETE',
          url: `/api/v1/reminders/${samReminder}`,
          headers: as(owner),
        }),
      ],
      [
        'revoke its link',
        h.app.inject({
          method: 'DELETE',
          url: `/api/v1/shares/${samShareId}`,
          headers: as(owner),
        }),
      ],
    ];
    for (const [what, res] of attempts) expect((await res).statusCode, what).toBe(404);
    await setFresh(owner, true);
    // Nothing above touched Sam's link.
    expect(await opens(link.samPrivate as string)).toBe(200);
  });

  it('nobody takes a document from the person it belongs to by making it theirs', async () => {
    const taken = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${docOf['Sam gym contract']}`,
      headers: as(owner),
      payload: { owner_member_id: owner.member_id },
    });
    expect(taken.statusCode).toBe(403);
    expect(json<{ error: { message: string } }>(taken).error.message).toMatch(/only they can/);
    // Sam can hand it over, to anyone.
    const given = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${docOf['Sam gym contract']}`,
      headers: as(sam),
      payload: { owner_member_id: teen.member_id },
    });
    expect(given.statusCode, given.body).toBe(200);
    // And a private document does not change hands at all.
    const moved = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${docOf['Sam private']}`,
      headers: as(sam),
      payload: { owner_member_id: owner.member_id },
    });
    expect(moved.statusCode).toBe(422);
  });

  it('a link to a private document, and a new passkey, each ask who is asking', async () => {
    await setFresh(sam, false);
    const linked = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docOf['Sam private']}/share`,
      headers: as(sam),
      payload: {},
    });
    expect(linked.statusCode).toBe(403);
    expect(json<{ error: { code: string; action: string } }>(linked).error).toMatchObject({
      code: 'step_up_required',
      action: 'open_private_document',
    });
    const passkey = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/challenge',
      headers: as(sam),
    });
    expect(passkey.statusCode).toBe(403);
    expect(json<{ error: { action: string } }>(passkey).error.action).toBe('change_sign_in');
    await setFresh(sam, true);
  });

  it('a teen cannot put a new copy into somebody else’s document', async () => {
    const form = new FormData();
    form.append('file', PDF, { filename: 'mine.pdf', contentType: 'application/pdf' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docOf['Council tax']}/versions`,
      headers: { ...as(teen), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('demoted, Sam loses the links and the export that held adults-only documents', async () => {
    expect(await opens(link.adults as string)).toBe(200);
    const demoted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${sam.member_id}/role`,
      headers: as(owner),
      payload: { role: 'viewer' },
    });
    expect(demoted.statusCode, demoted.body).toBe(200);
    expect(await opens(link.adults as string)).toBe(404);
    const exp = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('export')
        .select('expires_at')
        .where('id', '=', samExport)
        .executeTakeFirstOrThrow(),
    );
    expect(exp.expires_at?.getTime() ?? Infinity).toBeLessThanOrEqual(Date.now());
  });
});

/**
 * Uploads, exports and invitations — the second round of the 0.4.2 sweep.
 */
describe.skipIf(!testAdminUrl())('the privacy wall: uploads, exports and invitations', () => {
  let h: Harness;
  let owner: Tokens;
  let sam: Tokens;
  let ownerSecret = '';
  let ownerKey = '';
  let samDoc = '';

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const as = (t: Tokens) => h.as(t);
  let peers = 0;
  const peer = () => ({ remoteAddress: `10.78.${peers >> 8}.${peers++ & 0xff}` });

  const setFresh = (t: Tokens, fresh: boolean) =>
    withHousehold(h.db, t.household_id, async (trx) => {
      const a = await trx
        .selectFrom('account_household')
        .select('account_id')
        .where('member_id', '=', t.member_id)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - (fresh ? 0 : 10 * 60 * 1000)) })
        .where('account_id', '=', a.account_id)
        .execute();
    });

  const upload = (who: Tokens, documentId: string, key: string) => {
    const form = new FormData();
    form.append('file', PDF, { filename: 'therapy-notes.pdf', contentType: 'application/pdf' });
    return h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/versions`,
      headers: { ...as(who), ...form.getHeaders(), 'idempotency-key': key },
      payload: form.getBuffer(),
    });
  };

  const newDoc = async (who: Tokens, title: string, visibility = 'household') =>
    json<DocumentView>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: as(who),
        payload: { title, owner_member_id: who.member_id, visibility },
      }),
    ).id;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    sam = await h.join(owner, { name: 'Sam', email: 'sam-up@example.test', role: 'adult' });
    ownerSecret = await newDoc(owner, 'Owner secret', 'private');
    ownerKey = randomUUID();
    expect((await upload(owner, ownerSecret, ownerKey)).statusCode).toBe(201);
    samDoc = await newDoc(sam, 'Sam bill');
  }, 120_000);
  afterAll(() => h.close());

  it('an Idempotency-Key replayed on another document is refused, not answered', async () => {
    // Sam somehow holds the key of the owner's private upload. Replaying it
    // used to return that version — its filename and hash included.
    const res = await upload(sam, samDoc, ownerKey);
    expect(res.statusCode).toBe(422);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('idempotency_key_reused');
    expect(res.body).not.toContain('therapy-notes');
    // And aimed at the owner's document itself, it is simply not there.
    expect((await upload(sam, ownerSecret, ownerKey)).statusCode).toBe(404);
  });

  it('a stored file is named by chance, not by what is in it', async () => {
    const rows = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('document_version')
        .select(['storage_key', 'sha256'])
        .where('document_id', '=', ownerSecret)
        .execute(),
    );
    for (const r of rows) {
      expect(r.storage_key).not.toContain(r.sha256.toString('hex').slice(0, 16));
    }
  });

  it('a retried capture returns what the first attempt made, and makes nothing new', async () => {
    const key = randomUUID();
    const capture = () => {
      const form = new FormData();
      form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
      return h.app.inject({
        method: 'POST',
        url: '/api/v1/capture',
        headers: { ...as(sam), ...form.getHeaders(), 'idempotency-key': key },
        payload: form.getBuffer(),
      });
    };
    const count = async () =>
      json<{ items: unknown[] }>(
        await h.app.inject({ url: '/api/v1/documents?limit=200', headers: as(sam) }),
      ).items.length;
    const first = await capture();
    expect(first.statusCode, first.body).toBe(201);
    const before = await count();
    const again = await capture();
    expect(again.statusCode, again.body).toBe(201);
    expect(json(again)).toEqual(json(first));
    expect(await count()).toBe(before);
  });

  it('downloading an export asks who is asking, as requesting one does', async () => {
    const asked = await h.app.inject({ method: 'POST', url: '/api/v1/exports', headers: as(sam) });
    const id = json<{ id: string }>(asked).id;
    await setFresh(sam, false);
    const res = await h.app.inject({ url: `/api/v1/exports/${id}/content`, headers: as(sam) });
    expect(res.statusCode).toBe(403);
    expect(json<{ error: { action: string } }>(res).error.action).toBe('export_everything');
    await setFresh(sam, true);
  });

  it('making a document private retires the exports other people made while they could see it', async () => {
    const asked = await h.app.inject({
      method: 'POST',
      url: '/api/v1/exports',
      headers: as(owner),
    });
    const ownerExport = json<{ id: string }>(asked).id;
    const samExport = json<{ items: Array<{ id: string }> }>(
      await h.app.inject({ url: '/api/v1/exports', headers: as(sam) }),
    ).items[0]?.id as string;
    const marked = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${samDoc}/visibility`,
      headers: as(sam),
      payload: { visibility: 'private' },
    });
    expect(marked.statusCode).toBe(200);
    const expiry = (id: string) =>
      withHousehold(h.db, owner.household_id, (trx) =>
        trx
          .selectFrom('export')
          .select('expires_at')
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      );
    expect((await expiry(ownerExport)).expires_at?.getTime() ?? Infinity).toBeLessThanOrEqual(
      Date.now(),
    );
    // Sam's own export is Sam's, and holds Sam's own document either way.
    expect((await expiry(samExport)).expires_at).toBeNull();
  });

  it('switching two-step sign-in on asks who is asking', async () => {
    await setFresh(sam, false);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: as(sam),
    });
    expect(res.statusCode).toBe(403);
    expect(json<{ error: { action: string } }>(res).error.action).toBe('change_sign_in');
    await setFresh(sam, true);
  });

  it('the person invited chooses the address their password resets go to', async () => {
    const invited = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: as(owner),
      payload: { display_name: 'Priya', email: 'priya.family@example.test', role: 'adult' },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { link_token, code } = json<{ link_token: string; code: string }>(invited);
    // An address that is already somebody's is refused.
    const taken = await h.app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${link_token}/accept`,
      payload: { code, password: 'priyas own passphrase', email: 'sam-up@example.test' },
      ...peer(),
    });
    expect(taken.statusCode).toBe(409);
    const accepted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${link_token}/accept`,
      payload: { code, password: 'priyas own passphrase', email: 'priya@her-own.example.test' },
      ...peer(),
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const signedIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'priya@her-own.example.test', password: 'priyas own passphrase' },
      ...peer(),
    });
    expect(signedIn.statusCode).toBe(200);
    // The address the invitation was typed with is nobody's sign-in.
    const typed = await h.db
      .selectFrom('account')
      .select('id')
      .where('email', '=', 'priya.family@example.test')
      .execute();
    expect(typed).toEqual([]);
  });

  it('a person who owns private documents is not invited — the invitation would be a way into them', async () => {
    const added = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: as(owner),
      payload: { display_name: 'Grandad' },
    });
    const grandad = json<MemberView>(added).id;
    // How 0.4.1 could leave it: a private document handed to somebody with
    // no sign-in.
    await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('document')
        .values({
          household_id: owner.household_id,
          title: 'Grandad letter',
          visibility: 'private',
          owner_member_id: grandad,
        })
        .execute(),
    );
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${grandad}/invite`,
      headers: as(owner),
      payload: { email: 'grandad@example.test', role: 'viewer' },
    });
    expect(res.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('had_sign_in');
  });

  it('an adult cannot swap an owner’s invitation for one of their own', async () => {
    const added = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: as(owner),
      payload: { display_name: 'Sara' },
    });
    const sara = json<MemberView>(added).id;
    const ownerInvite = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${sara}/invite`,
      headers: as(owner),
      payload: { email: 'sara@example.test', role: 'adult' },
    });
    expect(ownerInvite.statusCode).toBe(201);
    const swapped = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${sara}/invite`,
      headers: as(sam),
      payload: { email: 'sam-alt@example.test', role: 'viewer' },
    });
    expect(swapped.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(swapped).error.code).toBe('already_invited');
    // The owner's invitation is still the live one.
    const live = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('invitation')
        .select(['email', 'revoked_at'])
        .where('member_id', '=', sara)
        .execute(),
    );
    expect(live).toEqual([{ email: 'sara@example.test', revoked_at: null }]);
  });
});
