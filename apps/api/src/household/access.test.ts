import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type {
  AccessPreview,
  ActivityLine,
  Capabilities,
  CollectionDetail,
  DocumentView,
  Member,
  MemberAccess,
  MemberAccount,
  Me,
} from '@fdv/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeFor } from '../auth/totp.js';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';
import { LIMITED_WORDS } from './co-owners.js';
import { LIMITS_REQUIRED } from './invitations.js';
import { ADULTS_ONLY_OWNERS, CONFIRM_PRIVATE, ONLY_EVERYONE } from './restrictions.js';

/**
 * Limiting what a viewer can see, from the API (5.33): PUT and DELETE
 * /members/{id}/access, the preview, an invitation's `restriction`,
 * `/me.restriction`, a collection's warning, and the activity log. The rule
 * itself is 0054's, held by access-restriction.test.ts.
 *
 * The family: an owner (two-step sign-in), a second owner with a password
 * alone, Ahmed and Sara (adults), and Val, a viewer.
 */

const json = <T>(r: { json: () => unknown }) => r.json() as T;
type Res = Awaited<ReturnType<Harness['app']['inject']>>;
const error = (r: Res) =>
  json<{ error: { code: string; message: string; action?: string; detail?: string } }>(r).error;

describe.skipIf(!testAdminUrl())('limit what a viewer can see (5.33)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  let owner: Tokens;
  let second: Tokens;
  let ahmed: Tokens;
  let sara: Tokens;
  let val: Tokens;
  let hh = '';
  /** The owner's authenticator, for a real step-up by code. */
  let ownerSecret = '';
  let everyone = '';
  let teens = '';
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.33.${Math.floor(++nth / 200)}.${nth % 200}` });

  /** Every document, by name. */
  const docs: Record<string, string> = {};

  /** Their sessions just saw a passkey or a code, as an owner power asks (A54). */
  const fresh = async (t: Tokens) => {
    await admin.query(
      `update session set verified_at = now(), factor_verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)`,
      [t.member_id],
    );
  };
  const make = async (
    name: string,
    payload: { type_key: string; visibility: string; owner_member_id: string | null },
  ) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: `Limited ${name}`, ...payload },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = json<DocumentView>(created).id;
    docs[name] = id;
    return id;
  };
  const put = (who: Tokens, member: string, payload: Record<string, unknown>) =>
    h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${member}/access`,
      headers: h.as(who),
      payload,
    });
  const remove = (who: Tokens, member: string) =>
    h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${member}/access`,
      headers: h.as(who),
    });
  const preview = async (who: Tokens, member: string | null, query: Record<string, string>) => {
    const q = new URLSearchParams(query).toString();
    const res = await h.app.inject({
      url: member ? `/api/v1/members/${member}/access/preview?${q}` : `/api/v1/access/preview?${q}`,
      headers: h.as(who),
    });
    expect(res.statusCode, res.body).toBe(200);
    return json<AccessPreview>(res);
  };
  /** What somebody's list of documents gives them, by id: every page. */
  const seenBy = async (who: Tokens): Promise<string[]> => {
    const res = await h.app.inject({ url: '/api/v1/documents?limit=200', headers: h.as(who) });
    expect(res.statusCode, res.body).toBe(200);
    return json<{ items: DocumentView[] }>(res)
      .items.map((d) => d.id)
      .sort();
  };
  const named = (...names: string[]) => names.map((n) => docs[n] as string).sort();
  const me = async (who: Tokens) =>
    json<Me>(await h.app.inject({ url: '/api/v1/me', headers: h.as(who) }));
  /** Every line of the log somebody reads, newest first: every page. */
  const activity = async (who: Tokens) => {
    const lines: string[] = [];
    let before: number | null = null;
    for (;;) {
      const res: Res = await h.app.inject({
        url: `/api/v1/audit?limit=100${before ? `&before=${before}` : ''}`,
        headers: h.as(who),
      });
      if (res.statusCode !== 200) return lines;
      const page: { items: ActivityLine[]; next: number | null } = json(res);
      lines.push(...page.items.map((l: ActivityLine) => l.text));
      if (page.next === null) return lines;
      before = page.next;
    }
  };
  const accountCard = async (who: Tokens, member: string) => {
    await fresh(who);
    const res = await h.app.inject({
      url: `/api/v1/members/${member}/account`,
      headers: h.as(who),
    });
    expect(res.statusCode, res.body).toBe(200);
    return json<MemberAccount>(res);
  };
  const restrictionRow = async (member: string) =>
    (
      await admin.query<{ reconfirm_since: Date | null; include_adults_only: boolean }>(
        'select * from access_restriction where member_id = $1',
        [member],
      )
    ).rows[0];
  /** An invitation made and accepted: their tokens, from the answer to accepting. */
  const invite = async (by: Tokens, payload: Record<string, unknown>) => {
    await fresh(by);
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: h.as(by),
      payload,
    });
    return made;
  };
  const accept = (made: Res, ...[password]: [string?]) => {
    const { link_token, code } = json<{ link_token: string; code: string }>(made);
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: link_token, code, password: password ?? 'a viewer’s own password' },
      ...peer(),
    });
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    app = createPool(h.appUrl, 2);
    owner = await h.setup();
    hh = owner.household_id;
    // Two-step sign-in for the owner (A54); each owner power below is then
    // asked as if a code had just been given (`fresh`).
    const enrol = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: h.as(owner),
    });
    const secret = json<{ secret: string }>(enrol).secret;
    ownerSecret = secret;
    const confirmed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      headers: h.as(owner),
      payload: { code: codeFor(secret) },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(204);
    second = await h.join(owner, {
      name: 'Second',
      email: 'second-533@example.test',
      role: 'owner',
    });
    ahmed = await h.join(owner, { name: 'Ahmed', email: 'ahmed-533@example.test', role: 'adult' });
    sara = await h.join(owner, { name: 'Sara', email: 'sara-533@example.test', role: 'adult' });
    val = await h.join(owner, { name: 'Val', email: 'val-533@example.test', role: 'viewer' });

    await make('ahmedTax', {
      type_key: 'tax_return',
      visibility: 'household',
      owner_member_id: ahmed.member_id,
    });
    await make('ahmedWill', {
      type_key: 'will',
      visibility: 'household',
      owner_member_id: ahmed.member_id,
    });
    await make('ahmedAdults', {
      type_key: 'tax_return',
      visibility: 'adults',
      owner_member_id: ahmed.member_id,
    });
    await make('saraTax', {
      type_key: 'tax_return',
      visibility: 'household',
      owner_member_id: sara.member_id,
    });
    await make('saraBill', {
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: sara.member_id,
    });
    await make('deed', {
      type_key: 'property_deed',
      visibility: 'household',
      owner_member_id: null,
    });
    await make('valOwn', {
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: val.member_id,
    });

    const collection = async (name: string, audience: string, items: string[]) => {
      const made = await h.app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: h.as(owner),
        payload: { name, audience },
      });
      expect(made.statusCode, made.body).toBe(201);
      const id = json<CollectionDetail>(made).id;
      if (items.length > 0) {
        const added = await h.app.inject({
          method: 'POST',
          url: `/api/v1/collections/${id}/items`,
          headers: h.as(owner),
          payload: { document_ids: items },
        });
        expect(added.statusCode, added.body).toBe(200);
      }
      return id;
    };
    everyone = await collection('For the accountant', 'everyone', [docs.saraBill as string]);
    teens = await collection('Teen papers', 'teens', [docs.saraTax as string]);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await app?.end();
    await h?.close();
  });

  it('the vault says it can (features.access_restrictions)', async () => {
    const caps = json<Capabilities>(await h.app.inject({ url: '/api/v1/capabilities' }));
    expect(caps.features.access_restrictions).toBe(true);
  });

  it('a password-only owner cannot restrict', async () => {
    // An owner with a password alone is refused the power outright (A54),
    // the limits and taking them off alike, and nothing is written.
    await fresh(second);
    for (const res of [
      await put(second, val.member_id, { people: [ahmed.member_id] }),
      await remove(second, val.member_id),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(error(res)).toMatchObject({
        code: 'totp_required_for_owner',
        message: 'Turn on two-step sign-in to limit what a viewer can see.',
      });
    }
    expect(await restrictionRow(val.member_id)).toBeUndefined();
    // An owner with two-step sign-in is asked for a passkey or a code — a
    // password just given is not that.
    await admin.query(
      `update session set verified_at = now(), factor_verified_at = null
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    const asked = await put(owner, val.member_id, { people: [ahmed.member_id] });
    expect(asked.statusCode).toBe(403);
    expect(error(asked)).toMatchObject({ code: 'step_up_required', action: 'limit_access' });
    // Nobody but an owner, whoever they are.
    await fresh(ahmed);
    const adult = await put(ahmed, val.member_id, { people: [ahmed.member_id] });
    expect(adult.statusCode).toBe(403);
    expect(error(adult).code).toBe('forbidden');
    expect((await remove(ahmed, val.member_id)).statusCode).toBe(403);
    expect(await restrictionRow(val.member_id)).toBeUndefined();
  });

  it('only a viewer, of the family, with what the family has', async () => {
    await fresh(owner);
    const adult = await put(owner, ahmed.member_id, { people: [sara.member_id] });
    expect(adult.statusCode).toBe(409);
    expect(error(adult).code).toBe('not_a_viewer');
    const nobody = await put(owner, '00000000-0000-4000-8000-000000000000', {});
    expect(nobody.statusCode).toBe(404);
    for (const [payload, field] of [
      [{ people: ['00000000-0000-4000-8000-000000000001'] }, 'people'],
      [{ types: ['no_such_kind'] }, 'types'],
      [{ collections: ['00000000-0000-4000-8000-000000000002'] }, 'collections'],
      [{ expires_at: new Date(Date.now() - 60_000).toISOString() }, 'expires_at'],
    ] as const) {
      const res = await put(owner, val.member_id, payload);
      expect(res.statusCode, field).toBe(422);
      expect(error(res).detail).toBe(field);
    }
    expect(await restrictionRow(val.member_id)).toBeUndefined();
  });

  it('a Teens and up collection cannot be granted to a viewer, and one changed away from Everyone leaves its grants', async () => {
    await fresh(owner);
    const refused = await put(owner, val.member_id, { collections: [teens] });
    expect(refused.statusCode).toBe(422);
    expect(error(refused).message).toBe(ONLY_EVERYONE('Teen papers', 'teens'));
    expect(error(refused).message).toBe(
      '“Teen papers” is for Teens and up, so it cannot be given to a viewer. Only a collection for Everyone in the family can be.',
    );
    expect(await restrictionRow(val.member_id)).toBeUndefined();
    // Nor by an invitation.
    const invited = await invite(owner, {
      display_name: 'Tia',
      email: 'tia-533@example.test',
      role: 'viewer',
      restriction: { collections: [teens] },
    });
    expect(invited.statusCode).toBe(422);
    expect(error(invited).message).toBe(ONLY_EVERYONE('Teen papers', 'teens'));
    // The database refuses one too, written straight in by an owner.
    const direct = await app.connect();
    try {
      await direct.query('begin');
      await direct.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.member_id', $2, true), set_config('app.role', 'owner', true),
                set_config('app.account_id', $3, true)`,
        [hh, owner.member_id, (await me(owner)).account_id],
      );
      await direct.query(
        'insert into access_restriction (member_id, household_id) values ($1, $2)',
        [val.member_id, hh],
      );
      await expect(
        direct.query(
          `insert into access_restriction_collection (restricted_member_id, household_id, collection_id)
           values ($1, $2, $3)`,
          [val.member_id, hh, teens],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await direct.query('rollback').catch(() => undefined);
      direct.release();
    }

    // For Everyone, it is given: what is in it, Val sees.
    const given = await put(owner, val.member_id, { collections: [everyone] });
    expect(given.statusCode, given.body).toBe(200);
    expect(json<MemberAccess>(given).collections).toEqual([everyone]);
    expect(await seenBy(val)).toEqual(named('saraBill', 'valOwn'));
    // Its maker makes it Teens and up: in the same transaction it leaves
    // every grant, and Val sees nothing of it.
    const changed = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${everyone}`,
      headers: h.as(owner),
      payload: { audience: 'teens' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const left = await admin.query(
      'select 1 from access_restriction_collection where collection_id = $1',
      [everyone],
    );
    expect(left.rows).toEqual([]);
    expect(await seenBy(val)).toEqual(named('valOwn'));
    expect((await accountCard(owner, val.member_id)).access?.collections).toEqual([]);
    // Back to Everyone, it is not given again by itself.
    const back = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${everyone}`,
      headers: h.as(owner),
      payload: { audience: 'everyone' },
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(await seenBy(val)).toEqual(named('valOwn'));
    await fresh(owner);
    expect((await remove(owner, val.member_id)).statusCode).toBe(204);
  });

  it('the preview count equals what the viewer then sees', async () => {
    const grants: Array<Record<string, string>> = [
      // Ahmed's tax returns, the house's papers of that kind (none), the collection.
      {
        people: ahmed.member_id,
        types: 'tax_return',
        collections: everyone,
        include_no_person_docs: 'true',
      },
      // Everyone's tax returns and wills, Adults only included.
      { types: 'tax_return,will', include_adults_only: 'true' },
      // Ahmed's and Sara's everything, and what belongs to no one.
      { people: `${ahmed.member_id},${sara.member_id}`, include_no_person_docs: 'true' },
      // Nothing but their own.
      {},
    ];
    for (const given of grants) {
      // Exactly this grant, as the web sends one: whether people and kinds
      // are named at all, said (an empty list left unsaid keeps what the
      // restriction says now; the 5.33 review).
      const q: Record<string, string> = {
        ...given,
        limits_people: String(Boolean(given.people)),
        limits_types: String(Boolean(given.types)),
      };
      await fresh(owner);
      const counted = await preview(owner, val.member_id, q);
      expect(counted.keeps_private).toBe(false);
      await fresh(owner);
      const body = {
        people: q.people ? q.people.split(',') : [],
        types: q.types ? q.types.split(',') : [],
        collections: q.collections ? q.collections.split(',') : [],
        include_adults_only: q.include_adults_only === 'true',
        include_no_person_docs: q.include_no_person_docs === 'true',
        limits_people: q.limits_people === 'true',
        limits_types: q.limits_types === 'true',
      };
      const res = await put(owner, val.member_id, body);
      expect(res.statusCode, res.body).toBe(200);
      const seen = await seenBy(val);
      expect(seen.length, JSON.stringify(q)).toBe(counted.documents);
      // For somebody not yet in the family: the same, but for Val's own.
      const someoneNew = await preview(owner, null, q);
      expect(someoneNew.documents).toBe(counted.documents - 1);
    }
    expect(
      (
        await preview(owner, val.member_id, {
          people: ahmed.member_id,
          types: 'tax_return',
          collections: everyone,
          include_no_person_docs: 'true',
        })
      ).documents,
    ).toBe(3); // Ahmed's tax return, Sara's bill in the collection, and Val's own.
    // An adult may count for an invitation, never with Adults only documents.
    expect((await preview(sara, null, { types: 'tax_return' })).documents).toBe(2);
    const adults = await h.app.inject({
      url: `/api/v1/access/preview?types=tax_return&include_adults_only=true`,
      headers: h.as(sara),
    });
    expect(adults.statusCode).toBe(403);
    expect(error(adults).message).toBe(ADULTS_ONLY_OWNERS);
    // A viewer counts nothing.
    expect(
      (await h.app.inject({ url: '/api/v1/access/preview', headers: h.as(val) })).statusCode,
    ).toBe(403);
    await fresh(owner);
    expect((await remove(owner, val.member_id)).statusCode).toBe(204);
  });

  it("a change applies on the viewer's next request", async () => {
    // Unlimited, Val sees every family document but the Adults only one.
    const everything = named('ahmedTax', 'ahmedWill', 'saraTax', 'saraBill', 'deed', 'valOwn');
    expect(await seenBy(val)).toEqual(everything);
    expect((await me(val)).restriction).toBeNull();
    await fresh(owner);
    const first = await put(owner, val.member_id, {
      people: [ahmed.member_id],
      types: ['tax_return'],
    });
    expect(first.statusCode, first.body).toBe(200);
    // The same token, the next request: limited.
    expect(await seenBy(val)).toEqual(named('ahmedTax', 'valOwn'));
    await fresh(owner);
    expect(
      (
        await put(owner, val.member_id, {
          people: [sara.member_id],
          include_adults_only: true,
          // No longer by kind: said, as an empty list alone keeps it (the 5.33 review).
          limits_types: false,
        })
      ).statusCode,
    ).toBe(200);
    expect(await seenBy(val)).toEqual(named('saraTax', 'saraBill', 'valOwn'));
    // With Adults only allowed (D6), the next request sees Ahmed's too once
    // he is named: worked out again for every request.
    await fresh(owner);
    expect(
      (await put(owner, val.member_id, { people: [ahmed.member_id], include_adults_only: true }))
        .statusCode,
    ).toBe(200);
    expect(await seenBy(val)).toEqual(named('ahmedTax', 'ahmedWill', 'ahmedAdults', 'valOwn'));
    // Taken off: everything again, Adults only no more.
    await fresh(owner);
    expect((await remove(owner, val.member_id)).statusCode).toBe(204);
    expect(await seenBy(val)).toEqual(everything);
    expect(await restrictionRow(val.member_id)).toBeUndefined();
    // Nothing to take off is no change, and nothing is logged.
    const lines = (await activity(owner)).length;
    await fresh(owner);
    expect((await remove(owner, val.member_id)).statusCode).toBe(204);
    expect((await activity(owner)).length).toBe(lines);
  });

  it('expiry leaves nothing visible', async () => {
    await fresh(owner);
    const until = new Date(Date.now() + 3600_000).toISOString();
    const res = await put(owner, val.member_id, { people: [ahmed.member_id], expires_at: until });
    expect(res.statusCode, res.body).toBe(200);
    expect(json<MemberAccess>(res).expires_at).toBe(until);
    expect(await seenBy(val)).toEqual(named('ahmedTax', 'ahmedWill', 'valOwn'));
    // Its end, come: as the database's clock would have it.
    await admin.query(
      `update access_restriction set expires_at = now() - interval '1 minute' where member_id = $1`,
      [val.member_id],
    );
    expect(await seenBy(val)).toEqual([]);
    // Not even their own, by its id.
    const own = await h.app.inject({
      url: `/api/v1/documents/${docs.valOwn}`,
      headers: h.as(val),
    });
    expect(own.statusCode).toBe(404);
    expect((await me(val)).restriction?.summary).toBe(
      'An owner limited what you can see, and it has ended: you see nothing for now.',
    );
    // And the owner is told it has ended.
    const family = json<{ items: Member[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    ).items;
    expect(family.find((m) => m.id === val.member_id)?.restriction?.summary).toMatch(
      /^Restricted, and ended .*: sees nothing\.$/,
    );
    await fresh(owner);
    expect((await remove(owner, val.member_id)).statusCode).toBe(204);
  });

  it('/me says what a restricted viewer can see, in their words; the family list tells owners alone', async () => {
    await fresh(owner);
    expect(
      (
        await put(owner, val.member_id, {
          people: [ahmed.member_id],
          types: ['tax_return', 'will'],
          collections: [everyone],
        })
      ).statusCode,
    ).toBe(200);
    const mine = (await me(val)).restriction;
    expect(mine).toMatchObject({
      people: [{ id: ahmed.member_id, display_name: 'Ahmed' }],
      collections: [{ id: everyone, name: 'For the accountant' }],
      include_adults_only: false,
      include_no_person_docs: false,
      expires_at: null,
    });
    expect(mine?.types.map((t) => t.key).sort()).toEqual(['tax_return', 'will']);
    expect(mine?.summary).toMatch(
      /^You can see: .+ documents for Ahmed, the collection “For the accountant” and your own\.$/,
    );
    // Nobody else is restricted.
    for (const who of [owner, ahmed]) expect((await me(who)).restriction).toBeNull();
    // The collection given to her is hers to open (A17, U515-11), with what
    // in it she is given; a viewer with no limits is given none.
    const listed = json<{ items: Array<{ id: string; name: string }> }>(
      await h.app.inject({ url: '/api/v1/collections', headers: h.as(val) }),
    ).items;
    expect(listed.map((c) => c.name)).toEqual(['For the accountant']);
    const opened = await h.app.inject({
      url: `/api/v1/collections/${everyone}`,
      headers: h.as(val),
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(json<CollectionDetail>(opened).items.map((i) => i.document.id)).toEqual(
      named('saraBill'),
    );
    // Not one for Teens and up, which no viewer is ever given.
    const narrower = await h.app.inject({
      url: `/api/v1/collections/${teens}`,
      headers: h.as(val),
    });
    expect(narrower.statusCode).toBe(404);
    // Owners read who is limited, in a sentence; nobody else is told.
    const asOwner = json<{ items: Member[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    ).items;
    expect(asOwner.find((m) => m.id === val.member_id)?.restriction?.summary).toBe(
      "Restricted: sees 1 person's documents of 2 kinds and 1 collection.",
    );
    expect(asOwner.find((m) => m.id === ahmed.member_id)?.restriction).toBeNull();
    const asAdult = json<{ items: Member[] }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(ahmed) }),
    ).items;
    expect(asAdult.every((m) => !('restriction' in m))).toBe(true);
    // The owner's card shows the limits, to change.
    const card = await accountCard(owner, val.member_id);
    expect(card.access).toMatchObject({
      member_id: val.member_id,
      people: [ahmed.member_id],
      collections: [everyone],
      reconfirm_since: null,
      private_confirmed: false,
    });
    // An adult's card has none: not a viewer.
    expect((await accountCard(owner, ahmed.member_id)).access).toBeNull();
  });

  it('putting a document in a granted collection says who else will see it', async () => {
    // Val is given the collection (above).
    const added = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${everyone}/items`,
      headers: h.as(owner),
      payload: { document_ids: [docs.ahmedTax] },
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(json<CollectionDetail>(added).warnings).toEqual([
      'Val (viewer) will be able to see this.',
    ]);
    // An Adults only document Val is not given: nobody to tell of it.
    const adults = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${everyone}/items`,
      headers: h.as(owner),
      payload: { document_ids: [docs.ahmedAdults] },
    });
    expect(adults.statusCode, adults.body).toBe(200);
    expect(json<CollectionDetail>(adults).warnings).toBeUndefined();
    // Two at once, one of them given.
    const two = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${everyone}/items`,
      headers: h.as(owner),
      payload: { document_ids: [docs.deed, docs.ahmedWill] },
    });
    expect(json<CollectionDetail>(two).warnings).toEqual([
      'Val (viewer) will be able to see 1 of these.',
    ]);
    // A collection nobody is given says nothing.
    const quiet = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${teens}/items`,
      headers: h.as(owner),
      payload: { document_ids: [docs.saraBill] },
    });
    expect(json<CollectionDetail>(quiet).warnings).toBeUndefined();
    // Asked straight, by a restricted caller, the database answers nothing.
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.member_id', $2, true), set_config('app.role', 'viewer', true),
                set_config('app.account_id', $3, true)`,
        [hh, val.member_id, (await me(val)).account_id],
      );
      const r = await c.query('select * from collection_viewers_given($1, $2)', [
        everyone,
        [docs.ahmedTax],
      ]);
      expect(r.rows).toEqual([]);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  });

  it('restricting someone who keeps Only me documents asks the owner first, and tells them', async () => {
    const wes = await h.join(owner, { name: 'Wes', email: 'wes-533@example.test', role: 'viewer' });
    const theirs = await make('wesPrivate', {
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: wes.member_id,
    });
    await admin.query(`update document set visibility = 'private' where id = $1`, [theirs]);
    await fresh(owner);
    expect((await preview(owner, wes.member_id, {})).keeps_private).toBe(true);
    // An owner's to know, who is asked before limiting them: an adult counting
    // for an invitation is not told.
    expect((await preview(sara, wes.member_id, {})).keeps_private).toBeUndefined();
    await fresh(owner);
    const asked = await put(owner, wes.member_id, { people: [ahmed.member_id] });
    expect(asked.statusCode).toBe(409);
    expect(error(asked)).toMatchObject({
      code: 'confirm_private',
      message: CONFIRM_PRIVATE('Wes'),
    });
    expect(await restrictionRow(wes.member_id)).toBeUndefined();
    const since = h.jobs.length;
    const confirmed = await put(owner, wes.member_id, {
      people: [ahmed.member_id],
      confirm_private: true,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(json<MemberAccess>(confirmed).private_confirmed).toBe(true);
    expect(
      h.jobs
        .slice(since)
        .filter((j) => j.name === 'alert.send')
        .map((j) => j.data.subject),
    ).toEqual(['What you can see in The Test family has been limited']);
    // They still see their own Only me document.
    expect(await seenBy(wes)).toEqual([theirs, docs.ahmedTax, docs.ahmedWill].sort());
  });

  it('a sign-in given back asks to confirm the limits again; the same limits put again confirm them', async () => {
    await fresh(owner);
    expect((await put(owner, val.member_id, { people: [ahmed.member_id] })).statusCode).toBe(200);
    const away = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${val.member_id}/sign-in`,
      headers: h.as(owner),
    });
    expect(away.statusCode, away.body).toBe(204);
    const back = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${val.member_id}/sign-in`,
      headers: h.as(owner),
      payload: { role: 'viewer' },
    });
    expect(back.statusCode, back.body).toBe(200);
    const waiting = await accountCard(owner, val.member_id);
    expect(waiting.access?.reconfirm_since).toEqual(expect.any(String));
    // The same grant again: confirmed, and said so.
    await fresh(owner);
    const again = await put(owner, val.member_id, { people: [ahmed.member_id] });
    expect(again.statusCode, again.body).toBe(200);
    expect(json<MemberAccess>(again).reconfirm_since).toBeNull();
    expect(await activity(owner)).toContain('Owner confirmed what Val can see');
    // The same again, with nothing waiting: nothing to say.
    const lines = (await activity(owner)).length;
    await fresh(owner);
    expect((await put(owner, val.member_id, { people: [ahmed.member_id] })).statusCode).toBe(200);
    expect((await activity(owner)).length).toBe(lines);
    // Given back again, then taken off: the confirmation waiting goes with it.
    await admin.query(
      'update access_restriction set reconfirm_since = now() where member_id = $1',
      [val.member_id],
    );
    await fresh(owner);
    expect((await remove(owner, val.member_id)).statusCode).toBe(204);
    expect(await restrictionRow(val.member_id)).toBeUndefined();
  });

  it('an adult cannot invite an unrestricted viewer or include adults-only', async () => {
    const unrestricted = await invite(sara, {
      display_name: 'Una',
      email: 'una-533@example.test',
      role: 'viewer',
    });
    expect(unrestricted.statusCode).toBe(403);
    expect(error(unrestricted)).toMatchObject({ code: 'forbidden', message: LIMITS_REQUIRED });
    const adults = await invite(sara, {
      display_name: 'Una',
      email: 'una-533@example.test',
      role: 'viewer',
      restriction: { people: [ahmed.member_id], include_adults_only: true },
    });
    expect(adults.statusCode).toBe(403);
    expect(error(adults)).toMatchObject({ code: 'forbidden', message: ADULTS_ONLY_OWNERS });
    // Nobody named Una was made by either.
    const una = await admin.query("select 1 from member where display_name = 'Una'");
    expect(una.rows).toEqual([]);
    // Limits only for a viewer, whoever asks.
    const teen = await invite(owner, {
      display_name: 'Tom',
      email: 'tom-533@example.test',
      role: 'teen',
      restriction: { people: [ahmed.member_id] },
    });
    expect(teen.statusCode).toBe(422);
    // With limits, an adult may: the invitation says it is limited.
    const limited = await invite(sara, {
      display_name: 'Una',
      email: 'una-533@example.test',
      role: 'viewer',
      restriction: { people: [sara.member_id], types: ['tax_return'] },
    });
    expect(limited.statusCode, limited.body).toBe(201);
    expect(json<{ invitation: { limited: boolean } }>(limited).invitation.limited).toBe(true);
    const accepted = await accept(limited);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const una2 = json<Tokens>(accepted);
    expect(await seenBy(una2)).toEqual(named('saraTax'));
    // Logged as Sara's doing: for the owners, Una, and Sara — not Ahmed.
    const line = 'Sara limited what Una can see, as they accepted their invitation';
    expect(await activity(owner)).toContain(line);
    expect(await activity(sara)).toContain(line);
    expect(await activity(ahmed)).not.toContain(line);
  });

  it('an owner can invite an unrestricted viewer', async () => {
    const made = await invite(owner, {
      display_name: 'Otto',
      email: 'otto-533@example.test',
      role: 'viewer',
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(json<{ invitation: { limited: boolean } }>(made).invitation.limited).toBe(false);
    const accepted = await accept(made);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const otto = json<Tokens>(accepted);
    expect((await me(otto)).restriction).toBeNull();
    // Every family document but the Adults only one, and Wes's Only me one.
    expect(await seenBy(otto)).toEqual(
      named('ahmedTax', 'ahmedWill', 'saraTax', 'saraBill', 'deed', 'valOwn'),
    );
    // And an owner may give Adults only documents to a viewer they invite.
    const withAdults = await invite(owner, {
      display_name: 'Ada',
      email: 'ada-533@example.test',
      role: 'viewer',
      restriction: { people: [ahmed.member_id], include_adults_only: true },
    });
    expect(withAdults.statusCode, withAdults.body).toBe(201);
    const ada = json<Tokens>(await accept(withAdults));
    expect(await seenBy(ada)).toEqual(named('ahmedTax', 'ahmedWill', 'ahmedAdults'));
  });

  it('the restriction applies in the same transaction as accept', async () => {
    const made = await invite(sara, {
      display_name: 'Ivy',
      email: 'ivy-533@example.test',
      role: 'viewer',
      restriction: { people: [ahmed.member_id], types: ['tax_return'], collections: [everyone] },
    });
    expect(made.statusCode, made.body).toBe(201);
    const ivy = json<{ invitation: { member_id: string } }>(made).invitation.member_id;
    // The restriction cannot be written: nor then is the sign-in.
    await admin.query(`create function fdv_test_refuse() returns trigger language plpgsql as
      $$ begin raise exception 'refused for the test'; end $$`);
    await admin.query(`create trigger fdv_test_refuse before insert on access_restriction
      for each row execute function fdv_test_refuse()`);
    try {
      const refused = await accept(made);
      expect(refused.statusCode).toBe(500);
    } finally {
      await admin.query('drop trigger fdv_test_refuse on access_restriction');
      await admin.query('drop function fdv_test_refuse()');
    }
    const after = await admin.query(
      `select (select count(*)::int from account where email = 'ivy-533@example.test') as accounts,
              (select count(*)::int from account_household where member_id = $1) as sign_ins,
              (select count(*)::int from invitation where member_id = $1 and accepted_at is not null) as accepted`,
      [ivy],
    );
    expect(after.rows[0]).toEqual({ accounts: 0, sign_ins: 0, accepted: 0 });
    // Accepted, the very first request is limited: never a moment without.
    const accepted = await accept(made);
    expect(accepted.statusCode, accepted.body).toBe(201);
    const tokens = json<Tokens>(accepted);
    // Ahmed's tax return; and from the collection, Sara's bill and Ahmed's
    // will — not the house's deed (nobody's, without the checkbox) nor his
    // Adults only one.
    expect(await seenBy(tokens)).toEqual(named('ahmedTax', 'saraBill', 'ahmedWill'));
    const row = await restrictionRow(ivy);
    expect(row?.reconfirm_since).toBeNull();
  });

  it("an owner's invitation replaces limits an owner set; an adult's leaves them, for the owners to confirm", async () => {
    const person = async (name: string) =>
      json<{ id: string }>(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/members',
          headers: h.as(owner),
          payload: { display_name: name },
        }),
      ).id;
    await fresh(owner);
    const pat = await person('Pat');
    const quinn = await person('Quinn');
    for (const who of [pat, quinn]) {
      await fresh(owner);
      expect((await put(owner, who, { people: [ahmed.member_id] })).statusCode).toBe(200);
    }
    const byAdult = await invite(sara, {
      member_id: pat,
      email: 'pat-533@example.test',
      role: 'viewer',
      restriction: { people: [sara.member_id] },
    });
    expect(byAdult.statusCode, byAdult.body).toBe(201);
    const patTokens = json<Tokens>(await accept(byAdult));
    expect(await seenBy(patTokens)).toEqual(named('ahmedTax', 'ahmedWill'));
    expect((await restrictionRow(pat))?.reconfirm_since).toBeInstanceOf(Date);

    const byOwner = await invite(owner, {
      member_id: quinn,
      email: 'quinn-533@example.test',
      role: 'viewer',
      restriction: { people: [sara.member_id] },
    });
    expect(byOwner.statusCode, byOwner.body).toBe(201);
    const quinnTokens = json<Tokens>(await accept(byOwner));
    expect(await seenBy(quinnTokens)).toEqual(named('saraTax', 'saraBill'));
    expect((await restrictionRow(quinn))?.reconfirm_since).toBeNull();
  });

  it('a collection changed away from Everyone while it is being given is refused, never kept (0055)', async () => {
    // A collection of its own, for Everyone, whose maker is making it Teens
    // and up at this moment: the change is made, not yet committed.
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(owner),
      payload: { name: 'Changing', audience: 'everyone' },
    });
    const changing = json<CollectionDetail>(made).id;
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query(`update doc_collection set audience = 'teens' where id = $1`, [changing]);
      await fresh(owner);
      const asked = put(owner, val.member_id, { collections: [changing] });
      // The grant waits on the collection, held FOR SHARE as it is named.
      for (let i = 0; ; i += 1) {
        const r = await admin.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if ((r.rows[0]?.n ?? 0) >= 1) break;
        if (i > 200) throw new Error('the grant never waited on the collection');
        await new Promise((done) => setTimeout(done, 25));
      }
      await holder.query('commit');
      const res = await asked;
      expect(res.statusCode, res.body).toBe(422);
      expect(error(res).message).toBe(
        'A collection you chose is no longer for Everyone in the family. Choose again.',
      );
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    const kept = await admin.query(
      'select 1 from access_restriction_collection where collection_id = $1',
      [changing],
    );
    expect(kept.rows).toEqual([]);
  });

  it('what an invitation names that is gone by the time it is accepted is left out, and still narrows', async () => {
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(owner),
      payload: { name: 'Soon for teens', audience: 'everyone' },
    });
    const soon = json<CollectionDetail>(made).id;
    const added = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${soon}/items`,
      headers: h.as(owner),
      payload: { document_ids: [docs.saraBill] },
    });
    expect(added.statusCode, added.body).toBe(200);
    const gone = json<{ id: string }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/members',
        headers: h.as(owner),
        payload: { display_name: 'Gone Soon' },
      }),
    ).id;
    const invited = await invite(owner, {
      display_name: 'Nell',
      email: 'nell-533@example.test',
      role: 'viewer',
      restriction: { people: [gone], collections: [soon] },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const nell = json<{ invitation: { member_id: string } }>(invited).invitation.member_id;
    // Before it is accepted: the person is removed, the collection made Teens and up.
    await admin.query('delete from member where id = $1', [gone]);
    const narrowed = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${soon}`,
      headers: h.as(owner),
      payload: { audience: 'teens' },
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    const accepted = await accept(invited);
    expect(accepted.statusCode, accepted.body).toBe(201);
    // Named, and gone: nobody's documents by person — never "anybody's".
    expect(await seenBy(json<Tokens>(accepted))).toEqual([]);
    const row = await admin.query<{ limits_people: boolean; collections: number }>(
      `select r.limits_people,
              (select count(*)::int from access_restriction_collection g
                where g.restricted_member_id = r.member_id) as collections
         from access_restriction r where r.member_id = $1`,
      [nell],
    );
    expect(row.rows).toEqual([{ limits_people: true, collections: 0 }]);
  });

  it('the activity log: owners, the person and whoever did it', async () => {
    const lines = await activity(owner);
    expect(lines).toContain('Owner limited what Val can see');
    expect(lines).toContain('Owner changed what Val can see');
    expect(lines).toContain('Owner took the limits off what Val can see');
    expect(lines.some((l) => l.startsWith('Owner limited what Val can see until '))).toBe(true);
    // Another adult reads none of them.
    const theirs = await activity(ahmed);
    expect(theirs.some((l) => l.includes('what Val can see'))).toBe(false);
    // What it gives is never written: counts, not names or ids.
    const { rows } = await admin.query<{ detail: unknown }>(
      "select detail from audit_event where action like 'access.%'",
    );
    const log = JSON.stringify(rows);
    for (const id of [ahmed.member_id, sara.member_id, everyone, 'tax_return']) {
      expect(log).not.toContain(id);
    }
  });

  // ------------------------------------------------------ the review round

  /** What the card shows, as "Keep these limits" sends it back. */
  const keepOf = (a: MemberAccess) => ({
    people: a.people,
    types: a.types,
    collections: a.collections,
    include_adults_only: a.include_adults_only,
    include_no_person_docs: a.include_no_person_docs,
    expires_at: a.expires_at,
    limits_people: a.limits_people,
    limits_types: a.limits_types,
  });
  /** A new viewer, joined through an owner's invitation. */
  const viewerNamed = async (name: string) => {
    await fresh(owner);
    return h.join(owner, {
      name,
      email: `${name.toLowerCase()}-533r@example.test`,
      role: 'viewer',
    });
  };

  it('a kind named and deleted since keeps narrowing: putting back what the card shows widens nothing (R532-01, the 5.33 review)', async () => {
    const vic = await viewerNamed('Vic');
    await fresh(owner);
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/document-types',
      headers: h.as(owner),
      payload: { label: 'Boat papers', category: 'other' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const boat = json<{ key: string }>(made).key;
    await fresh(owner);
    const limited = await put(owner, vic.member_id, {
      people: [ahmed.member_id],
      types: [boat],
      include_adults_only: true,
    });
    expect(limited.statusCode, limited.body).toBe(200);
    expect(await seenBy(vic)).toEqual([]);
    // An adult deletes the kind, unused: the restriction still names kinds.
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/document-types/${boat}`,
      headers: h.as(ahmed),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const card = (await accountCard(owner, vic.member_id)).access as MemberAccess;
    expect(card).toMatchObject({ types: [], limits_types: true, limits_people: true });
    expect(card.summary).toContain('Every kind it named has been deleted');
    // The count, with the flags left out, is what a PUT would keep: nothing.
    await fresh(owner);
    expect(
      (
        await preview(owner, vic.member_id, {
          people: ahmed.member_id,
          include_adults_only: 'true',
        })
      ).documents,
    ).toBe(0);
    // "Keep these limits", after a sign-in given back: exactly what is shown.
    await admin.query(
      'update access_restriction set reconfirm_since = now() where member_id = $1',
      [vic.member_id],
    );
    await fresh(owner);
    const kept = await put(owner, vic.member_id, keepOf(card));
    expect(kept.statusCode, kept.body).toBe(200);
    expect(json<MemberAccess>(kept)).toMatchObject({ limits_types: true, reconfirm_since: null });
    expect(await seenBy(vic)).toEqual([]);
    // A client that leaves the flags out keeps them too, and nothing is said.
    const lines = (await activity(owner)).length;
    await fresh(owner);
    const older = await put(owner, vic.member_id, {
      people: [ahmed.member_id],
      include_adults_only: true,
    });
    expect(older.statusCode, older.body).toBe(200);
    expect(json<MemberAccess>(older).limits_types).toBe(true);
    expect(await seenBy(vic)).toEqual([]);
    expect((await activity(owner)).length).toBe(lines);
    // Only an explicit false lets "none chosen" mean every kind — and that
    // widening is logged as a change, never a confirmation.
    await fresh(owner);
    const widened = await put(owner, vic.member_id, {
      people: [ahmed.member_id],
      include_adults_only: true,
      limits_types: false,
    });
    expect(widened.statusCode, widened.body).toBe(200);
    expect(await seenBy(vic)).toEqual(named('ahmedTax', 'ahmedWill', 'ahmedAdults'));
    const said = await activity(owner);
    expect(said[0]).toBe('Owner changed what Vic can see');
    expect(said).toContain('Owner confirmed what Vic can see');
  });

  it('a granted collection deleted leaves every grant: keeping the limits works, and brought back it gives nothing (L533-02)', async () => {
    const wyn = await viewerNamed('Wyn');
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(owner),
      payload: { name: 'Tax season', audience: 'everyone' },
    });
    const season = json<CollectionDetail>(made).id;
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${season}/items`,
      headers: h.as(owner),
      payload: { document_ids: [docs.ahmedTax] },
    });
    await fresh(owner);
    expect(
      (await put(owner, wyn.member_id, { people: [sara.member_id], collections: [season] }))
        .statusCode,
    ).toBe(200);
    expect(await seenBy(wyn)).toEqual(named('saraTax', 'saraBill', 'ahmedTax'));
    // Deleted: it leaves the grant in the same transaction.
    const gone = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${season}`,
      headers: h.as(owner),
    });
    expect(gone.statusCode, gone.body).toBe(204);
    const rows = await admin.query(
      'select 1 from access_restriction_collection where collection_id = $1',
      [season],
    );
    expect(rows.rows).toEqual([]);
    const card = (await accountCard(owner, wyn.member_id)).access as MemberAccess;
    expect(card.collections).toEqual([]);
    // Confirming, after a sign-in given back, is not refused.
    await admin.query(
      'update access_restriction set reconfirm_since = now() where member_id = $1',
      [wyn.member_id],
    );
    await fresh(owner);
    const kept = await put(owner, wyn.member_id, keepOf(card));
    expect(kept.statusCode, kept.body).toBe(200);
    expect(json<MemberAccess>(kept).reconfirm_since).toBeNull();
    // Brought back, it is not given again by itself.
    await admin.query('update doc_collection set deleted_at = null where id = $1', [season]);
    expect(await seenBy(wyn)).toEqual(named('saraTax', 'saraBill'));
    // A row left from before, written past every rule, is never shown, and
    // never refuses a save or a count: a deleted collection is left out.
    await admin.query('update doc_collection set deleted_at = now() where id = $1', [season]);
    await admin.query(
      `insert into access_restriction_collection (restricted_member_id, household_id, collection_id)
       values ($1, $2, $3)`,
      [wyn.member_id, hh, season],
    );
    const stale = (await accountCard(owner, wyn.member_id)).access as MemberAccess;
    expect(stale.collections).toEqual([]);
    await fresh(owner);
    expect(
      (await preview(owner, wyn.member_id, { people: sara.member_id, collections: season }))
        .documents,
    ).toBe(2);
    const saved = await put(owner, wyn.member_id, { ...keepOf(stale), collections: [season] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(json<MemberAccess>(saved).collections).toEqual([]);
    expect(
      (
        await admin.query('select 1 from access_restriction_collection where collection_id = $1', [
          season,
        ])
      ).rows,
    ).toEqual([]);
  });

  it('whether somebody keeps Only me documents is told only to an owner who just gave a code, and only of somebody who could be limited (S533-05)', async () => {
    // Its own: somebody with no sign-in yet, who keeps an Only me document.
    await fresh(owner);
    const pia = json<{ id: string }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/members',
        headers: h.as(owner),
        payload: { display_name: 'Pia' },
      }),
    ).id;
    const hers = await make('piaPrivate', {
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: pia,
    });
    await admin.query(`update document set visibility = 'private' where id = $1`, [hers]);
    const raw = (who: Tokens, member: string) =>
      h.app.inject({ url: `/api/v1/members/${member}/access/preview`, headers: h.as(who) });
    const stepUp = async (who: Tokens, payload: Record<string, string>) => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/step-up',
        headers: h.as(who),
        payload,
      });
      expect(res.statusCode, res.body).toBe(200);
    };
    const nothingFresh = (who: Tokens) =>
      admin.query(
        `update session set verified_at = null, factor_verified_at = null
          where account_id = (select account_id from account_household where member_id = $1)`,
        [who.member_id],
      );

    // The second owner: a password alone, and no step-up at all.
    await nothingFresh(second);
    const counted = await raw(second, pia);
    expect(counted.statusCode, counted.body).toBe(200);
    expect(json<Record<string, unknown>>(counted)).not.toHaveProperty('keeps_private');
    // An owner with a code: a password just given is not a code.
    await nothingFresh(owner);
    await stepUp(owner, { password: 'correct horse battery' });
    const byPassword = await raw(owner, pia);
    expect(byPassword.statusCode, byPassword.body).toBe(200);
    expect(json<Record<string, unknown>>(byPassword)).not.toHaveProperty('keeps_private');
    // A code just given is.
    await stepUp(owner, { code: codeFor(ownerSecret) });
    expect((await preview(owner, pia, {})).keeps_private).toBe(true);
    // Nobody but a viewer, or somebody with no sign-in, is counted at all.
    for (const who of [ahmed.member_id, second.member_id]) {
      await fresh(owner);
      const refused = await raw(owner, who);
      expect(refused.statusCode).toBe(409);
      expect(error(refused).code).toBe('not_a_viewer');
    }
  });

  it('a sign-in given back to somebody limited tells them so; anybody else, nothing of it (L533-03)', async () => {
    const zed = await viewerNamed('Zed');
    const yan = await viewerNamed('Yan');
    await fresh(owner);
    expect((await put(owner, zed.member_id, { people: [ahmed.member_id] })).statusCode).toBe(200);
    const givenBack = async (who: Tokens) => {
      await fresh(owner);
      const away = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/members/${who.member_id}/sign-in`,
        headers: h.as(owner),
      });
      expect(away.statusCode, away.body).toBe(204);
      const since = h.jobs.length;
      const back = await h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${who.member_id}/sign-in`,
        headers: h.as(owner),
        payload: { role: 'viewer' },
      });
      expect(back.statusCode, back.body).toBe(200);
      const told = h.jobs.slice(since).filter((j) => j.name === 'alert.send');
      expect(told).toHaveLength(1);
      return String(told[0]?.data.body);
    };
    const toZed = await givenBack(zed);
    expect(toZed).toContain(LIMITED_WORDS);
    // Nothing of what is given.
    expect(toZed).not.toContain('Ahmed');
    expect(await givenBack(yan)).not.toContain(LIMITED_WORDS);
  });

  it('an ended restriction waiting for confirmation is kept as it is, ended; a new end in the past is still refused (L533-05)', async () => {
    const xan = await viewerNamed('Xan');
    await fresh(owner);
    expect(
      (
        await put(owner, xan.member_id, {
          people: [ahmed.member_id],
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        })
      ).statusCode,
    ).toBe(200);
    await admin.query(
      `update access_restriction set expires_at = now() - interval '1 day', reconfirm_since = now()
        where member_id = $1`,
      [xan.member_id],
    );
    const card = (await accountCard(owner, xan.member_id)).access as MemberAccess;
    expect(card.summary).toMatch(/^Restricted, and ended /);
    // Counted as kept: ended, so nothing — never refused.
    await fresh(owner);
    expect(
      (
        await preview(owner, xan.member_id, {
          people: ahmed.member_id,
          expires_at: card.expires_at as string,
        })
      ).documents,
    ).toBe(0);
    await fresh(owner);
    const kept = await put(owner, xan.member_id, keepOf(card));
    expect(kept.statusCode, kept.body).toBe(200);
    expect(json<MemberAccess>(kept)).toMatchObject({
      expires_at: card.expires_at,
      reconfirm_since: null,
    });
    expect(await seenBy(xan)).toEqual([]);
    await fresh(owner);
    const moved = await put(owner, xan.member_id, {
      ...keepOf(card),
      expires_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    expect(moved.statusCode).toBe(422);
    expect(error(moved).detail).toBe('expires_at');
  });

  it('PUT /members/{id}/access refuses in one order: who, the shape, the step-up, whom, what it names (L533-06)', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const nobody = '00000000-0000-4000-8000-000000000009';
    // Anybody but an owner, whatever they send.
    await fresh(ahmed);
    const adult = await put(ahmed, nobody, { people: 'nobody' });
    expect([adult.statusCode, error(adult).code]).toEqual([403, 'forbidden']);
    // The shape, before the step-up.
    await admin.query(
      `update session set factor_verified_at = null
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    const shape = await put(owner, nobody, { people: 'nobody' });
    expect([shape.statusCode, error(shape).code]).toEqual([422, 'validation_failed']);
    // The step-up, before whom and what the grant names.
    const asked = await put(owner, nobody, { expires_at: past, collections: [teens] });
    expect([asked.statusCode, error(asked).code]).toEqual([403, 'step_up_required']);
    await fresh(owner);
    // Whom: nobody of the family, then anybody but a viewer.
    const missing = await put(owner, nobody, { expires_at: past, collections: [teens] });
    expect([missing.statusCode, error(missing).code]).toEqual([404, 'not_found']);
    const adultOne = await put(owner, ahmed.member_id, { expires_at: past, collections: [teens] });
    expect([adultOne.statusCode, error(adultOne).code]).toEqual([409, 'not_a_viewer']);
    // Then what it names.
    const named422 = await put(owner, val.member_id, { expires_at: past, collections: [teens] });
    expect([named422.statusCode, error(named422).code]).toEqual([422, 'validation_failed']);
  });

  it("an owner's invitation leaves limits an owner set after it was made (the lead's decision on the 5.33 review)", async () => {
    await fresh(owner);
    const kim = json<{ id: string }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/members',
        headers: h.as(owner),
        payload: { display_name: 'Kim' },
      }),
    ).id;
    const invited = await invite(owner, {
      member_id: kim,
      email: 'kim-533@example.test',
      role: 'viewer',
      restriction: { people: [sara.member_id] },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    // Limits an owner sets after the invitation was made: newer, they stay.
    await fresh(owner);
    expect((await put(owner, kim, { people: [ahmed.member_id] })).statusCode).toBe(200);
    const accepted = await accept(invited);
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(await seenBy(json<Tokens>(accepted))).toEqual(named('ahmedTax', 'ahmedWill'));
    // And the owners are asked to confirm them, as for any sign-in given to
    // somebody limited.
    expect((await restrictionRow(kim))?.reconfirm_since).toBeInstanceOf(Date);
  });

  it("an owner's invitation with the flags left out keeps them, as a PUT does: a kind deleted since still narrows (N533A-01)", async () => {
    await fresh(owner);
    const ola = json<{ id: string }>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/members',
        headers: h.as(owner),
        payload: { display_name: 'Ola' },
      }),
    ).id;
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/document-types',
      headers: h.as(owner),
      payload: { label: 'Kayak papers', category: 'other' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const kayak = json<{ key: string }>(made).key;
    await fresh(owner);
    expect((await put(owner, ola, { people: [ahmed.member_id], types: [kayak] })).statusCode).toBe(
      200,
    );
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/document-types/${kayak}`,
      headers: h.as(owner),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    // Newer than the limits, it replaces them; its kinds left unsaid, they
    // stay limited — and the owner's count said as much.
    await fresh(owner);
    expect((await preview(owner, ola, { people: ahmed.member_id })).documents).toBe(0);
    const invited = await invite(owner, {
      member_id: ola,
      email: 'ola-533@example.test',
      role: 'viewer',
      restriction: { people: [ahmed.member_id] },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const accepted = await accept(invited);
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(await seenBy(json<Tokens>(accepted))).toEqual([]);
    const row = await admin.query<{ limits_types: boolean }>(
      'select limits_types from access_restriction where member_id = $1',
      [ola],
    );
    expect(row.rows).toEqual([{ limits_types: true }]);
  });
});
