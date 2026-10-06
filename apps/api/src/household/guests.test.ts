import { createPool } from '@fdv/db';
import { testAdminUrl, zoneShortOfAYear } from '@fdv/db/testing';
import {
  GUEST_ALWAYS_LIMITED,
  GUEST_OWNS_NOTHING,
  type ActivityLine,
  type DocumentView,
  type InvitationPreview,
  type Me,
  type Member,
  type MemberAccount,
  type SuggestionView,
} from '@fdv/shared';
import FormData from 'form-data';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeFor } from '../auth/totp.js';
import type { Tokens } from '../auth/service.js';
import { alertsSent, createHarness, type Harness } from '../test-harness.js';

/**
 * Someone outside the family with a sign-in of their own: a guest (5.34,
 * D4, A27, A28, A34, A54). A viewer on the wire, always limited, ending on a
 * day an owner renews, never among the family, with no member key — and
 * the database holds to each (0056).
 *
 * The family: an owner with two-step sign-in, a second owner with a
 * password alone, Ahmed and Sara (adults). Jane Smith, an attorney, is the
 * guest; she is given Ahmed's tax documents.
 */

const json = <T>(r: { json: () => unknown }) => r.json() as T;
type Res = Awaited<ReturnType<Harness['app']['inject']>>;
const error = (r: Res) =>
  json<{ error: { code: string; message: string; action?: string; reason?: string } }>(r).error;
const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const BOUNDARY = 'fdv-guest-capture-boundary';

describe.skipIf(!testAdminUrl())('someone outside the family (5.34)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let app: ReturnType<typeof createPool>;
  let owner: Tokens;
  let second: Tokens;
  let ahmed: Tokens;
  let sara: Tokens;
  let jane: Tokens;
  let hh = '';
  let ownerSecret = '';
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.34.${Math.floor(++nth / 200)}.${nth % 200}` });
  const docs: Record<string, string> = {};

  /** Their sessions just saw a passkey or a code, as an owner power asks (A54). */
  const fresh = async (t: Tokens) => {
    await admin.query(
      `update session set verified_at = now(), factor_verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)`,
      [t.member_id],
    );
  };
  /** Their sessions just saw the password, and no passkey or code for ten minutes. */
  const passwordOnly = async (t: Tokens) => {
    await admin.query(
      `update session set verified_at = now(), factor_verified_at = now() - interval '10 minutes'
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
      payload: { title: `Guest ${name}`, ...payload },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = json<DocumentView>(created).id;
    docs[name] = id;
    return id;
  };
  const guestInvite = (overrides: Record<string, unknown> = {}) => ({
    display_name: 'Jane Smith',
    relationship: 'attorney',
    email: `guest-${randomUUID().slice(0, 8)}@example.test`,
    role: 'viewer',
    kind: 'guest',
    restriction: { people: [ahmed.member_id], types: ['tax_return'] },
    access_expires_at: inDays(30),
    ...overrides,
  });
  const invite = (by: Tokens, payload: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: h.as(by),
      payload,
    });
  const accept = (made: Res, password = 'the guest’s own password') => {
    const { link_token, code } = json<{ link_token: string; code: string }>(made);
    return h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: link_token, code, password },
      ...peer(),
    });
  };
  /** A guest invited by the owner and accepted: their tokens. */
  const guest = async (overrides: Record<string, unknown> = {}, password?: string) => {
    await fresh(owner);
    const made = await invite(owner, guestInvite(overrides));
    expect(made.statusCode, made.body).toBe(201);
    const accepted = await accept(made, password);
    expect(accepted.statusCode, accepted.body).toBe(201);
    return json<Tokens>(accepted);
  };
  const signIn = (email: string, password: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email, password },
      ...peer(),
    });
  const me = async (who: Tokens) =>
    json<Me>(await h.app.inject({ url: '/api/v1/me', headers: h.as(who) }));
  const seenBy = async (who: Tokens) => {
    const res = await h.app.inject({ url: '/api/v1/documents?limit=200', headers: h.as(who) });
    expect(res.statusCode, res.body).toBe(200);
    return json<{ items: DocumentView[] }>(res)
      .items.map((d) => d.id)
      .sort();
  };
  const members = async (who: Tokens, query = '') => {
    const res = await h.app.inject({ url: `/api/v1/members${query}`, headers: h.as(who) });
    return res;
  };
  /** What somebody signed in is given by the database, asked as them: one statement. */
  const asThem = async <T extends object>(
    who: { member: string; role: string; account?: string },
    text: string,
  ): Promise<T[]> => {
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.member_id', $2, true), set_config('app.role', $3, true),
                set_config('app.account_id', $4, true)`,
        [hh, who.member, who.role, who.account ?? ''],
      );
      return (await client.query<T>(text)).rows;
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  };
  /**
   * A statement as somebody signed in, committed: what it changed, or the
   * error's code. In `zone`, the session's time zone, when one is given.
   */
  const writeAs = async (
    who: { member: string; role: string; account?: string },
    text: string,
    args: unknown[] = [],
    zone?: string,
  ): Promise<number | string> => {
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.member_id', $2, true), set_config('app.role', $3, true),
                set_config('app.account_id', $4, true)`,
        [hh, who.member, who.role, who.account ?? ''],
      );
      if (zone) await client.query(`select set_config('timezone', $1, true)`, [zone]);
      const n = (await client.query(text, args)).rowCount ?? 0;
      await client.query('commit');
      return n;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      return (err as { code?: string }).code ?? 'error';
    } finally {
      client.release();
    }
  };
  const accountOf = async (t: Tokens) =>
    (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [t.member_id],
      )
    ).rows[0]?.account_id as string;
  const ownerActor = async () => ({
    member: owner.member_id,
    role: 'owner',
    account: await accountOf(owner),
  });
  const activity = async (who: Tokens) => {
    const res = await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(who) });
    expect(res.statusCode, res.body).toBe(200);
    return json<{ items: ActivityLine[] }>(res).items.map((l) => l.text);
  };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    app = createPool(h.appUrl, 2);
    owner = await h.setup();
    hh = owner.household_id;
    const enrol = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: h.as(owner),
    });
    ownerSecret = json<{ secret: string }>(enrol).secret;
    const confirmed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      headers: h.as(owner),
      payload: { code: codeFor(ownerSecret) },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(204);
    second = await h.join(owner, {
      name: 'Second',
      email: 'second-534@example.test',
      role: 'owner',
    });
    ahmed = await h.join(owner, { name: 'Ahmed', email: 'ahmed-534@example.test', role: 'adult' });
    sara = await h.join(owner, { name: 'Sara', email: 'sara-534@example.test', role: 'adult' });
    await make('ahmedTax', {
      type_key: 'tax_return',
      visibility: 'household',
      owner_member_id: ahmed.member_id,
    });
    await make('ahmedWill', {
      type_key: 'will',
      visibility: 'adults',
      owner_member_id: ahmed.member_id,
    });
    await make('saraBill', {
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: sara.member_id,
    });
    jane = await guest({ email: 'jane-534@example.test' });
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await app?.end();
    await h?.close();
  });

  it('a guest is a viewer of kind guest, limited from the moment they accept, with no member key', async () => {
    expect(jane.role).toBe('viewer');
    const mine = await me(jane);
    expect(mine).toMatchObject({ role: 'viewer', kind: 'guest' });
    expect(mine.access_expires_at).toEqual(expect.any(String));
    // In her words, and nothing "of her own": a guest owns nothing.
    expect(mine.restriction?.summary).toBe('You can see: Tax return documents for Ahmed.');
    // The family's sign-ins say they are of it, and have no end.
    expect(await me(owner)).toMatchObject({ kind: 'family', access_expires_at: null });
    // Ahmed's tax return, and nothing else.
    expect(await seenBy(jane)).toEqual([docs.ahmedTax]);
    // No member key was ever made for her (invitations.ts), and none can be (0056).
    const keys = await admin.query<{ n: number }>(
      `select count(*)::int as n from scope_key where kind = 'member' and member_id = $1`,
      [jane.member_id],
    );
    expect(keys.rows[0]?.n).toBe(0);
    const minted = await writeAs(
      await ownerActor(),
      `insert into scope_key (household_id, kind, member_id, key_wrapped)
       values ($1, 'member', $2, '\\x00')`,
      [hh, jane.member_id],
    );
    expect(minted).toBe('23514');
    // The invitation, the person and the log say so.
    const lines = await activity(owner);
    expect(
      lines.some((l) =>
        // With the year (the 5.34 review): it may be a year away.
        /^Owner invited jane-534@example\.test to sign in as a guest until \d{1,2} \w+ \d{4} at \d{2}:\d{2}$/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(lines).toContain('Owner added Jane Smith as a guest from outside the family');
  });

  it('a guest is absent from People, pickers, counts and suggestions', async () => {
    // People: the family's list never names her, to anybody.
    for (const who of [owner, ahmed, sara]) {
      const res = await members(who);
      expect(res.statusCode).toBe(200);
      const listed = json<{ items: Member[] }>(res).items;
      expect(listed.map((m) => m.id)).not.toContain(jane.member_id);
      expect(listed.every((m) => m.kind === 'family')).toBe(true);
    }
    // She sees herself as a guest, and Ahmed, whose document she is given.
    const hers = json<{ items: Member[] }>(await members(jane)).items;
    expect(hers.map((m) => m.id).sort()).toEqual([jane.member_id, ahmed.member_id].sort());
    expect(hers.find((m) => m.id === jane.member_id)).toMatchObject({
      kind: 'guest',
      access_expires_at: expect.any(String) as unknown,
    });
    // Owners list the people outside the family apart, with their limits and end.
    const outside = json<{ items: Member[] }>(await members(owner, '?kind=guest')).items;
    expect(outside).toHaveLength(1);
    expect(outside[0]).toMatchObject({
      id: jane.member_id,
      display_name: 'Jane Smith',
      relationship: 'attorney',
      kind: 'guest',
      role: 'viewer',
      access_expires_at: expect.any(String) as unknown,
      restriction: {
        summary: expect.stringMatching(/^Restricted: sees 1 person's documents/) as unknown,
      },
    });
    // Nobody but an owner lists them.
    for (const who of [ahmed, jane]) {
      const refused = await members(who, '?kind=guest');
      expect(refused.statusCode).toBe(403);
    }
    // Pickers: a guest is nobody's way in, and whose a document is.
    await fresh(owner);
    const viewer = await h.join(owner, {
      name: 'Vic',
      email: 'vic-534@example.test',
      role: 'viewer',
    });
    await fresh(owner);
    const picked = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${viewer.member_id}/access`,
      headers: h.as(owner),
      payload: { people: [jane.member_id] },
    });
    expect(picked.statusCode).toBe(422);
    expect(error(picked).message).toBe('Choose people from the family.');
    const owned = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: 'For Jane', type_key: 'will', owner_member_id: jane.member_id },
    });
    expect(owned.statusCode).toBe(422);
    // Counts: nothing of hers, ever.
    const counts = json<{ by_member: Array<{ member_id: string | null }> }>(
      await h.app.inject({ url: '/api/v1/documents/counts', headers: h.as(owner) }),
    );
    expect(counts.by_member.map((c) => c.member_id)).not.toContain(jane.member_id);
    // Suggestions: none for her. A child of the family is suggested a birth
    // certificate; were she a child too, she would not be.
    await fresh(owner);
    const child = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: h.as(owner),
      payload: { display_name: 'Aisha', date_of_birth: '2016-05-01' },
    });
    expect(child.statusCode, child.body).toBe(201);
    await admin.query(`update member set date_of_birth = '2016-05-01' where id = $1`, [
      jane.member_id,
    ]);
    const suggested = await h.app.inject({ url: '/api/v1/suggestions', headers: h.as(owner) });
    expect(suggested.statusCode, suggested.body).toBe(200);
    const items = json<{ items: SuggestionView[] }>(suggested).items;
    expect(items.map((s) => s.member_id)).toContain(json<Member>(child).id);
    expect(items.map((s) => s.member_id)).not.toContain(jane.member_id);
    await admin.query('update member set date_of_birth = null where id = $1', [jane.member_id]);
    // Identity: no record of hers, to an owner or to her (A34); none can be written.
    for (const who of [owner, jane]) {
      const res = await h.app.inject({
        url: `/api/v1/members/${jane.member_id}/identity`,
        headers: h.as(who),
      });
      expect(res.statusCode).toBe(404);
    }
    // A shared part, as an owner may write anybody's — well formed, under
    // the household's identity key — but for a guest.
    await admin.query(
      `insert into scope_key (household_id, kind, key_wrapped)
       values ($1, 'identity', decode(repeat('00', 60), 'hex'))
       on conflict (household_id, kind) where member_id is null do nothing`,
      [hh],
    );
    const shared = `insert into member_identity
         (household_id, member_id, part, sealed, dek_wrapped, wrapped_by_scope)
       select $1, $2, 'shared', decode(repeat('00', 40), 'hex'), decode(repeat('00', 60), 'hex'), id
         from scope_key where household_id = $1 and kind = 'identity'`;
    // Ahmed's: written (and rolled back by the next test's needs: removed).
    expect(await writeAs(await ownerActor(), shared, [hh, ahmed.member_id])).toBe(1);
    await admin.query('delete from member_identity where member_id = $1', [ahmed.member_id]);
    expect(await writeAs(await ownerActor(), shared, [hh, jane.member_id])).toBe('23514');
    // The household's answers: none of them, by the API or the database.
    const profile = json<{ owns_home: unknown }>(
      await h.app.inject({ url: '/api/v1/profile', headers: h.as(jane) }),
    );
    expect(profile.owns_home).toBeNull();
    const answers = await asThem<{ n: number }>(
      { member: jane.member_id, role: 'viewer', account: await accountOf(jane) },
      'select count(*)::int as n from household_profile',
    );
    expect(answers[0]?.n).toBe(0);
  });

  it('a guest cannot own a document, by any path', async () => {
    const refusedAs = (r: Res) => {
      expect(r.statusCode, r.body).toBe(422);
      return error(r).message;
    };
    // Made for her.
    expect(
      refusedAs(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/documents',
          headers: h.as(owner),
          payload: { title: 'Jane’s', type_key: 'will', owner_member_id: jane.member_id },
        }),
      ),
    ).toBe(GUEST_OWNS_NOTHING);
    // Changed, or handed over, to her.
    const mine = await make('ownerNote', {
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: owner.member_id,
    });
    expect(
      refusedAs(
        await h.app.inject({
          method: 'PATCH',
          url: `/api/v1/documents/${mine}`,
          headers: h.as(owner),
          payload: { owner_member_id: jane.member_id },
        }),
      ),
    ).toBe(GUEST_OWNS_NOTHING);
    // A phone's capture naming her: refused before a byte is kept.
    const field = (name: string, value: string) =>
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      );
    const captured = await h.app.inject({
      method: 'POST',
      url: '/api/v1/capture',
      headers: {
        ...h.as(owner),
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'idempotency-key': randomUUID(),
      },
      payload: Buffer.concat([
        field('metadata', JSON.stringify({ title: 'Scan', owner_member_id: jane.member_id })),
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        ),
        PDF,
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
    });
    expect(captured.statusCode, captured.body).toBe(422);
    // Asked of the family before anything is kept, as for anybody not of it.
    expect(error(captured).message).toBe('That person is not in the family.');
    // The database, whoever writes: the vault's own role, and the owning role too.
    const owned = await admin.query<{ n: number }>(
      'select count(*)::int as n from document where owner_member_id = $1',
      [jane.member_id],
    );
    expect(owned.rows[0]?.n).toBe(0);
    expect(
      await writeAs(
        await ownerActor(),
        `insert into document (household_id, title, owner_member_id, visibility)
         values ($1, 'Direct', $2, 'household')`,
        [hh, jane.member_id],
      ),
    ).toBe('FDV04');
    expect(
      await writeAs(await ownerActor(), 'update document set owner_member_id = $2 where id = $1', [
        docs.saraBill,
        jane.member_id,
      ]),
    ).toBe('FDV04');
    await expect(
      admin.query('update document set owner_member_id = $2 where id = $1', [
        docs.saraBill,
        jane.member_id,
      ]),
    ).rejects.toMatchObject({ code: 'FDV04' });
    // Nor is she made one of the family, who may own them.
    expect(
      await writeAs(await ownerActor(), "update member set kind = 'family' where id = $1", [
        jane.member_id,
      ]),
    ).toBe('23514');
  });

  it('an adult cannot give a guest adults-only documents', async () => {
    await fresh(ahmed);
    // An adult invites a guest only limited to what the adult sees (A27)...
    const asked = await invite(ahmed, guestInvite({ restriction: { people: [ahmed.member_id] } }));
    expect(asked.statusCode, asked.body).toBe(201);
    // ...never with Adults only documents (D6).
    const adults = await invite(
      ahmed,
      guestInvite({ restriction: { people: [ahmed.member_id], include_adults_only: true } }),
    );
    expect(adults.statusCode).toBe(403);
    expect(error(adults).message).toBe('Only an owner can let a viewer see Adults only documents.');
    // Nor afterwards: limits are an owner's to change.
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${jane.member_id}/access`,
      headers: h.as(ahmed),
      payload: { people: [ahmed.member_id], include_adults_only: true },
    });
    expect(put.statusCode).toBe(403);
    // An owner may, with a passkey or a code: then Ahmed's will is hers to see.
    await fresh(owner);
    const given = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${jane.member_id}/access`,
      headers: h.as(owner),
      payload: {
        people: [ahmed.member_id],
        types: ['tax_return', 'will'],
        include_adults_only: true,
      },
    });
    expect(given.statusCode, given.body).toBe(200);
    expect(await seenBy(jane)).toEqual([docs.ahmedTax, docs.ahmedWill].sort());
    await fresh(owner);
    const back = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${jane.member_id}/access`,
      headers: h.as(owner),
      payload: { people: [ahmed.member_id], types: ['tax_return'] },
    });
    expect(back.statusCode, back.body).toBe(200);
  });

  it('a password-only owner is refused a guest invitation, and step-up by password is refused', async () => {
    const decided = [
      // A guest given Adults only documents (D6)...
      guestInvite({
        restriction: { people: [ahmed.member_id], include_adults_only: true },
      }),
      // ...and a viewer who sees every family document (A27).
      {
        display_name: 'Una',
        email: `unlimited-${randomUUID().slice(0, 8)}@example.test`,
        role: 'viewer',
      },
    ];
    for (const payload of decided) {
      // An owner with a password alone: refused outright.
      await fresh(second);
      const refused = await invite(second, payload);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(error(refused)).toMatchObject({
        code: 'totp_required_for_owner',
        message: 'Turn on two-step sign-in to limit what a viewer can see.',
      });
      // An owner with two-step sign-in, who last gave only the password.
      await passwordOnly(owner);
      const asked = await invite(owner, payload);
      expect(asked.statusCode).toBe(403);
      expect(error(asked)).toMatchObject({ code: 'step_up_required', action: 'limit_access' });
      const byPassword = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/step-up',
        headers: h.as(owner),
        payload: { password: 'correct horse battery' },
      });
      expect(byPassword.statusCode, byPassword.body).toBe(200);
      const still = await invite(owner, payload);
      expect(error(still)).toMatchObject({ code: 'step_up_required', action: 'limit_access' });
      // A code from the authenticator: the decision is made.
      const byCode = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/step-up',
        headers: h.as(owner),
        payload: { code: codeFor(ownerSecret) },
      });
      expect(byCode.statusCode, byCode.body).toBe(200);
      const made = await invite(owner, payload);
      expect(made.statusCode, made.body).toBe(201);
    }
    // Any guest an owner invites is an owner's decision (the lead, on the
    // 5.34 review): a guest limited to what the owner sees too.
    await fresh(second);
    const plain = await invite(second, guestInvite());
    expect(plain.statusCode).toBe(403);
    expect(error(plain).code).toBe('totp_required_for_owner');
    await passwordOnly(owner);
    expect(error(await invite(owner, guestInvite()))).toMatchObject({
      code: 'step_up_required',
      action: 'limit_access',
    });
    // An adult's guest is no owner's decision: the ordinary step-up.
    await passwordOnly(ahmed);
    const adults = await invite(ahmed, guestInvite({ restriction: { people: [ahmed.member_id] } }));
    expect(adults.statusCode, adults.body).toBe(201);
    // Nor is a limited viewer of the family an owner invites (W534-10): the
    // password, just given, is enough.
    await passwordOnly(second);
    const family = await invite(second, {
      display_name: 'Lou',
      email: `limited-${randomUUID().slice(0, 8)}@example.test`,
      role: 'viewer',
      restriction: { people: [ahmed.member_id] },
    });
    expect(family.statusCode, family.body).toBe(201);
  });

  it('an owner deciding what a guest sees is asked once, for a passkey or a code, never the password first (W534-02)', async () => {
    // Nothing given for a while: neither the password nor a code is fresh.
    await admin.query(
      `update session set verified_at = now() - interval '1 hour',
              factor_verified_at = now() - interval '1 hour'
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    // Asked for a code first — not the password, then a code.
    const asked = await invite(owner, guestInvite());
    expect(asked.statusCode).toBe(403);
    expect(error(asked)).toMatchObject({ code: 'step_up_required', action: 'limit_access' });
    const byCode = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/step-up',
      headers: h.as(owner),
      payload: { code: codeFor(ownerSecret) },
    });
    expect(byCode.statusCode, byCode.body).toBe(200);
    // And that one answer serves: made, nothing more asked.
    const made = await invite(owner, guestInvite());
    expect(made.statusCode, made.body).toBe(201);
    // A family invitation with nothing to decide still asks the password
    // first, as before.
    await admin.query(
      `update session set verified_at = now() - interval '1 hour',
              factor_verified_at = now() - interval '1 hour'
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    const plain = await invite(owner, {
      display_name: 'Ivo',
      email: `ivo-${randomUUID().slice(0, 8)}@example.test`,
      role: 'adult',
    });
    expect(error(plain)).toMatchObject({ code: 'step_up_required', action: 'change_people' });
  });

  it('an adult cannot re-invite a removed guest, nor keep an owner’s Adults only grant (S534-01)', async () => {
    // A guest an owner gave Adults only documents, whose sign-in an owner
    // then took away.
    const ann = await guest(
      {
        display_name: 'Ann',
        email: 'ann-534@example.test',
        restriction: { people: [ahmed.member_id], include_adults_only: true },
      },
      'ann’s password',
    );
    expect(await seenBy(ann)).toEqual([docs.ahmedTax, docs.ahmedWill].sort());
    await fresh(owner);
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${ann.member_id}/sign-in`,
      headers: h.as(owner),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const again = {
      email: `ann-again-${randomUUID().slice(0, 8)}@example.test`,
      role: 'viewer',
      kind: 'guest',
      restriction: { people: [ahmed.member_id], types: ['tax_return'] },
      access_expires_at: inDays(360),
    };
    // An adult, the same person: refused — giving it back is an owner's.
    await fresh(ahmed);
    const byAdult = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${ann.member_id}/invite`,
      headers: h.as(ahmed),
      payload: again,
    });
    expect(byAdult.statusCode).toBe(409);
    expect(error(byAdult).code).toBe('had_sign_in');
    expect(error(byAdult).message).toMatch(
      /^Ann has had a sign-in here\. An owner can give it back/,
    );
    // An owner too: they give it back, with a new end (renew_guest).
    await fresh(owner);
    const byOwner = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${ann.member_id}/invite`,
      headers: h.as(owner),
      payload: again,
    });
    expect(error(byOwner).code).toBe('had_sign_in');
    // As somebody new, by her name: a new person, with the adult's limits.
    await fresh(ahmed);
    const anew = await invite(
      ahmed,
      guestInvite({
        display_name: 'Ann',
        restriction: { people: [ahmed.member_id], types: ['tax_return'] },
      }),
    );
    expect(anew.statusCode, anew.body).toBe(201);
    const fresher = json<{ invitation: { member_id: string } }>(anew).invitation.member_id;
    expect(fresher).not.toBe(ann.member_id);
    const accepted = json<Tokens>(await accept(anew, 'ann’s new password'));
    expect(await seenBy(accepted)).toEqual([docs.ahmedTax]);

    // Somebody of the family who never signed in, given Adults only by an
    // owner: an adult's invitation would keep it, so it is refused...
    await fresh(owner);
    const added = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: h.as(owner),
      payload: { display_name: 'Mona' },
    });
    const mona = json<Member>(added).id;
    await fresh(owner);
    expect(
      (
        await h.app.inject({
          method: 'PUT',
          url: `/api/v1/members/${mona}/access`,
          headers: h.as(owner),
          payload: { people: [ahmed.member_id], include_adults_only: true },
        })
      ).statusCode,
    ).toBe(200);
    await fresh(ahmed);
    const asked = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${mona}/invite`,
      headers: h.as(ahmed),
      payload: {
        email: `mona-${randomUUID().slice(0, 8)}@example.test`,
        role: 'viewer',
        restriction: { people: [ahmed.member_id] },
      },
    });
    expect(asked.statusCode).toBe(403);
    expect(error(asked).message).toBe(
      'An owner gave them Adults only documents, so only an owner can invite them.',
    );
    // ...and asked again as it is accepted: given after it was made.
    await fresh(owner);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${mona}/access`,
      headers: h.as(owner),
      payload: { people: [ahmed.member_id] },
    });
    await fresh(ahmed);
    const made = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${mona}/invite`,
      headers: h.as(ahmed),
      payload: {
        email: `mona-${randomUUID().slice(0, 8)}@example.test`,
        role: 'viewer',
        restriction: { people: [ahmed.member_id] },
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    await fresh(owner);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${mona}/access`,
      headers: h.as(owner),
      payload: { people: [ahmed.member_id], include_adults_only: true },
    });
    const late = await accept(made, 'mona’s password');
    expect(late.statusCode).toBe(409);
    expect(error(late).code).toBe('owner_needed');
    expect(
      (await admin.query('select 1 from account_household where member_id = $1', [mona])).rowCount,
    ).toBe(0);

    // And a guest invitation accepted meanwhile elsewhere: asked as accepted.
    await fresh(owner);
    const pending = await invite(owner, guestInvite({ display_name: 'Pia' }));
    const pia = json<{ invitation: { member_id: string } }>(pending).invitation.member_id;
    await admin.query('update member set former_account_id = $2 where id = $1', [
      pia,
      await accountOf(owner),
    ]);
    const blocked = await accept(pending, 'pia’s password');
    expect(blocked.statusCode).toBe(409);
    expect(error(blocked).code).toBe('had_sign_in');
    await admin.query('update member set former_account_id = null where id = $1', [pia]);
  });

  it('a guest is named as one where a collection says who will see what is put in it (W534-08)', async () => {
    await fresh(owner);
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(owner),
      payload: { name: 'For the attorney', audience: 'everyone' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const collection = json<{ id: string }>(made).id;
    await fresh(owner);
    const given = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${jane.member_id}/access`,
      headers: h.as(owner),
      payload: { people: [ahmed.member_id], types: ['tax_return'], collections: [collection] },
    });
    expect(given.statusCode, given.body).toBe(200);
    const added = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${collection}/items`,
      headers: h.as(owner),
      payload: { document_ids: [docs.saraBill] },
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(json<{ warnings?: string[] }>(added).warnings).toContain(
      'Jane Smith (guest) will be able to see this.',
    );
    await fresh(owner);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${jane.member_id}/access`,
      headers: h.as(owner),
      payload: { people: [ahmed.member_id], types: ['tax_return'] },
    });
  });

  it('a limited caller is told nothing of where files are kept or of the mail server (S534-06)', async () => {
    // A file of Ahmed's tax return, which Jane is given.
    const form = new FormData();
    form.append('file', PDF, { filename: 'tax.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${docs.ahmedTax}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBe(201);
    const version = json<{ id: string }>(up).id;
    await admin.query(
      `insert into smtp_settings (household_id, host, port, secure, from_email, status)
       values ($1, 'mail.example.test', 587, false, 'family@example.test', 'ok')
       on conflict (household_id) do nothing`,
      [hh],
    );
    const viewer = await h.join(owner, {
      name: 'Val',
      email: 'val-534@example.test',
      role: 'viewer',
    });
    await fresh(owner);
    await h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${viewer.member_id}/access`,
      headers: h.as(owner),
      payload: { people: [sara.member_id] },
    });
    for (const who of [jane, viewer]) {
      for (const url of ['/api/v1/vaults', '/api/v1/notifications/smtp']) {
        const res = await h.app.inject({ url, headers: h.as(who) });
        expect(res.statusCode, `${url}`).toBe(403);
      }
    }
    for (const url of ['/api/v1/vaults', '/api/v1/notifications/smtp']) {
      expect((await h.app.inject({ url, headers: h.as(owner) })).statusCode).toBe(200);
    }
    // The database: no mail settings; only the place holding what she is
    // given — which her download reads.
    const [row] = await asThem<{ smtp: number; vaults: number; all: number }>(
      { member: jane.member_id, role: 'viewer', account: await accountOf(jane) },
      `select (select count(*)::int from smtp_settings) as smtp,
              (select count(*)::int from vault) as vaults,
              (select count(distinct v.vault_id)::int from document_version v) as all`,
    );
    expect(row).toEqual({ smtp: 0, vaults: 1, all: 1 });
    const content = await h.app.inject({
      url: `/api/v1/versions/${version}/content`,
      headers: h.as(jane),
    });
    expect(content.statusCode, content.body).toBe(200);
    // Somebody limited, given nothing with a file: no place at all.
    const [none] = await asThem<{ vaults: number }>(
      { member: viewer.member_id, role: 'viewer', account: await accountOf(viewer) },
      'select count(*)::int as vaults from vault',
    );
    expect(none?.vaults).toBe(0);
  });

  it('an invitation accepted while its guest is removed is refused as one no longer valid, never a 500 (N534A-01)', async () => {
    await fresh(owner);
    const pending = await invite(owner, guestInvite({ display_name: 'Rory' }));
    expect(pending.statusCode, pending.body).toBe(201);
    const rory = json<{ invitation: { member_id: string } }>(pending).invitation.member_id;
    const lockWaits = async () =>
      (
        await admin.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and datname = current_database()`,
        )
      ).rows[0]?.n ?? 0;
    const queued = async (n: number) => {
      for (let i = 0; i < 400 && (await lockWaits()) < n; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await lockWaits()).toBeGreaterThanOrEqual(n);
    };
    // The person held, so that the removal and the acceptance queue on them:
    // the removal first, the acceptance behind it.
    const holder = await admin.connect();
    let removing: Promise<Res> | undefined;
    let accepting: Promise<Res> | undefined;
    try {
      await holder.query('begin');
      await holder.query('select 1 from member where id = $1 for update', [rory]);
      removing = h.app.inject({
        method: 'DELETE',
        url: `/api/v1/members/${rory}`,
        headers: h.as(owner),
      });
      await queued(1);
      accepting = accept(pending, 'rory’s own password');
      await queued(2);
    } finally {
      await holder.query('commit');
      holder.release();
    }
    const [removed, accepted] = await Promise.all([removing, accepting]);
    expect(removed?.statusCode, removed?.body).toBe(204);
    expect(accepted?.statusCode, accepted?.body).toBe(404);
    expect(accepted && error(accepted).code).toBe('invitation_not_valid');

    // The preview too: an invitation whose person is gone (left behind here
    // as the owning role, its cascade switched off) is no longer valid.
    await fresh(owner);
    const orphaned = await invite(owner, guestInvite({ display_name: 'Ora' }));
    const ora = json<{ invitation: { member_id: string } }>(orphaned).invitation.member_id;
    const { link_token: oraLink } = json<{ link_token: string }>(orphaned);
    // While she is there, the preview says when her access ends, and on
    // whose clock: the household's (the second round of the review).
    const before = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/lookup',
      payload: { token: oraLink },
      ...peer(),
    });
    expect(before.statusCode, before.body).toBe(200);
    const zone = (
      await admin.query<{ timezone: string }>('select timezone from household where id = $1', [hh])
    ).rows[0]?.timezone;
    expect(json<InvitationPreview>(before)).toMatchObject({
      kind: 'guest',
      access_expires_at: expect.stringMatching(/^\d{4}-/) as unknown,
      timezone: zone,
    });
    const raw = await admin.connect();
    try {
      await raw.query('begin');
      await raw.query(`set local session_replication_role = replica`);
      await raw.query('delete from member where id = $1', [ora]);
      await raw.query('commit');
    } finally {
      raw.release();
    }
    try {
      const looked = await h.app.inject({
        method: 'POST',
        url: '/api/v1/invitations/lookup',
        payload: { token: oraLink },
        ...peer(),
      });
      expect(looked.statusCode, looked.body).toBe(404);
      expect(error(looked).code).toBe('invitation_not_valid');
    } finally {
      await admin.query('delete from invitation where member_id = $1', [ora]);
    }
  });

  it('a guest who never signed in is removed by an owner; anybody who has had a sign-in is kept (W534-03)', async () => {
    await fresh(owner);
    const pending = await invite(owner, guestInvite({ display_name: 'Rex' }));
    expect(pending.statusCode, pending.body).toBe(201);
    const rex = json<{ invitation: { member_id: string } }>(pending).invitation.member_id;
    const remove = (who: Tokens, member: string) =>
      h.app.inject({ method: 'DELETE', url: `/api/v1/members/${member}`, headers: h.as(who) });
    await fresh(ahmed);
    expect((await remove(ahmed, rex)).statusCode).toBe(403);
    await fresh(owner);
    expect(error(await remove(owner, jane.member_id)).code).toBe('had_sign_in');
    expect(error(await remove(owner, sara.member_id)).code).toBe('not_a_guest');
    expect((await remove(owner, rex)).statusCode).toBe(204);
    expect((await admin.query('select 1 from member where id = $1', [rex])).rowCount).toBe(0);
    expect(
      (await admin.query('select 1 from invitation where member_id = $1', [rex])).rowCount,
    ).toBe(0);
    expect(await activity(owner)).toContain('Owner removed Rex, a guest who never signed in');
    // The database too: an adult removes nobody; nor an owner anybody else.
    expect(
      await writeAs(
        { member: ahmed.member_id, role: 'adult', account: await accountOf(ahmed) },
        'delete from member where id = $1',
        [sara.member_id],
      ),
    ).toBe(0);
    expect(
      await writeAs(await ownerActor(), 'delete from member where id = $1', [jane.member_id]),
    ).toBe(0);
  });

  it('an owner corrects a guest and signs them out everywhere, as People outside the family does (W534-03)', async () => {
    const kim = await guest({ display_name: 'Kim', relationship: 'notary' });
    await fresh(owner);
    const read = await h.app.inject({ url: '/api/v1/members?kind=guest', headers: h.as(owner) });
    const before = json<{ items: Array<{ id: string; version: number }> }>(read).items.find(
      (m) => m.id === kim.member_id,
    );
    const edited = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/members/${kim.member_id}`,
      headers: { ...h.as(owner), 'if-match': `"${before?.version}"` },
      payload: { display_name: 'Kim Lee', relationship: 'the family’s notary' },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(json<{ display_name: string; relationship: string }>(edited)).toMatchObject({
      display_name: 'Kim Lee',
      relationship: 'the family’s notary',
    });
    const out = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${kim.member_id}/sessions`,
      headers: h.as(owner),
    });
    expect(out.statusCode, out.body).toBe(200);
    expect(json<{ sessions_ended: number }>(out).sessions_ended).toBeGreaterThan(0);
    expect((await h.app.inject({ url: '/api/v1/me', headers: h.as(kim) })).statusCode).toBe(401);
    // Their sign-in stays: they are still listed with it.
    const after = await h.app.inject({ url: '/api/v1/members?kind=guest', headers: h.as(owner) });
    expect(
      json<{ items: Array<{ id: string; has_account: boolean }> }>(after).items.find(
        (m) => m.id === kim.member_id,
      )?.has_account,
    ).toBe(true);
  });

  it("an owner's invitation whose limits would replace limits already set asks for a passkey or a code (S533-02)", async () => {
    // Somebody with no sign-in yet, limited by an owner.
    await fresh(owner);
    const added = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: h.as(owner),
      payload: { display_name: 'Lena' },
    });
    expect(added.statusCode, added.body).toBe(201);
    const lena = json<Member>(added).id;
    await fresh(owner);
    const limited = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/members/${lena}/access`,
      headers: h.as(owner),
      payload: { people: [sara.member_id] },
    });
    expect(limited.statusCode, limited.body).toBe(200);
    const replacing = {
      member_id: lena,
      email: `lena-${randomUUID().slice(0, 8)}@example.test`,
      role: 'viewer',
      restriction: { people: [ahmed.member_id] },
    };
    // An adult's invitation never replaces them (limitsPlan), and asks
    // nothing more than the ordinary step-up.
    await fresh(ahmed);
    const adults = await invite(ahmed, {
      ...replacing,
      email: `lena2-${randomUUID().slice(0, 8)}@example.test`,
    });
    expect(adults.statusCode, adults.body).toBe(201);
    // A password-only owner: refused.
    await fresh(second);
    const refused = await invite(second, replacing);
    expect(refused.statusCode).toBe(403);
    expect(error(refused).code).toBe('totp_required_for_owner');
    // The password alone: asked for a passkey or a code.
    await passwordOnly(owner);
    const asked = await invite(owner, replacing);
    expect(error(asked)).toMatchObject({ code: 'step_up_required', action: 'limit_access' });
    // With one: made, and the limits are replaced as she accepts.
    await fresh(owner);
    const made = await invite(owner, replacing);
    expect(made.statusCode, made.body).toBe(201);
    const accepted = await accept(made, 'lena’s own password');
    expect(accepted.statusCode, accepted.body).toBe(201);
    const people = await admin.query<{ member_id: string }>(
      'select member_id from access_restriction_member where restricted_member_id = $1',
      [lena],
    );
    expect(people.rows.map((r) => r.member_id)).toEqual([ahmed.member_id]);
  });

  it("a guest's sign-in stops at its end date", async () => {
    const gil = await guest(
      { display_name: 'Gil', email: 'gil-534@example.test' },
      'gil’s password',
    );
    expect((await me(gil)).kind).toBe('guest');
    expect(await seenBy(gil)).toEqual([docs.ahmedTax]);
    // Its end, passed (as the owning role: nobody else may set it so).
    await admin.query(
      `update account_household set access_expires_at = now() - interval '1 minute'
        where member_id = $1`,
      [gil.member_id],
    );
    // Every session answers nothing: 401, `access_ended`.
    const asked = await h.app.inject({ url: '/api/v1/me', headers: h.as(gil) });
    expect(asked.statusCode).toBe(401);
    expect(error(asked)).toMatchObject({ code: 'session_ended', reason: 'access_ended' });
    const refreshed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: gil.refresh_token },
    });
    expect(refreshed.statusCode).toBe(401);
    expect(error(refreshed)).toMatchObject({ code: 'session_ended', reason: 'access_ended' });
    // Signing in: refused once the password is right, with the day.
    const wrong = await signIn('gil-534@example.test', 'not gil’s password');
    expect(error(wrong).code).toBe('invalid_credentials');
    const ended = await signIn('gil-534@example.test', 'gil’s password');
    expect(ended.statusCode).toBe(403);
    expect(error(ended)).toMatchObject({ code: 'access_ended', reason: 'access_ended' });
    expect(error(ended).message).toMatch(
      /^Your access to this family vault ended .+ \(UTC\)\. Ask whoever invited you to renew it\.$/,
    );
    // And the database gives an ended guest nothing, whoever asks as them.
    const given = await asThem<{ n: number }>(
      { member: gil.member_id, role: 'viewer', account: await accountOf(gil) },
      'select count(*)::int as n from document',
    );
    expect(given[0]?.n).toBe(0);
    // Renewed by an owner: in again, as before.
    await fresh(owner);
    const renewed = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${gil.member_id}/renew`,
      headers: h.as(owner),
      payload: { access_expires_at: inDays(10) },
    });
    expect(renewed.statusCode, renewed.body).toBe(200);
    const back = await signIn('gil-534@example.test', 'gil’s password');
    expect(back.statusCode, back.body).toBe(200);
    expect(await seenBy(json<Tokens>(back))).toEqual([docs.ahmedTax]);
  });

  it("renewing a guest's sign-in is an owner's, with a passkey or a code, within a year", async () => {
    const renew = (who: Tokens, member: string, payload: Record<string, unknown>) =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${member}/renew`,
        headers: h.as(who),
        payload,
      });
    const end = { access_expires_at: inDays(90) };
    await fresh(ahmed);
    expect((await renew(ahmed, jane.member_id, end)).statusCode).toBe(403);
    await fresh(second);
    expect(error(await renew(second, jane.member_id, end)).code).toBe('totp_required_for_owner');
    await passwordOnly(owner);
    expect(error(await renew(owner, jane.member_id, end))).toMatchObject({
      code: 'step_up_required',
      action: 'renew_guest',
    });
    await fresh(owner);
    expect(
      (await renew(owner, jane.member_id, { access_expires_at: inDays(367) })).statusCode,
    ).toBe(422);
    expect((await renew(owner, jane.member_id, { access_expires_at: inDays(-1) })).statusCode).toBe(
      422,
    );
    expect((await renew(owner, jane.member_id, {})).statusCode).toBe(422);
    const family = await renew(owner, ahmed.member_id, end);
    expect(family.statusCode).toBe(409);
    expect(error(family).code).toBe('not_a_guest');
    expect((await renew(owner, randomUUID(), end)).statusCode).toBe(404);
    const done = await renew(owner, jane.member_id, end);
    expect(done.statusCode, done.body).toBe(200);
    expect(json(done)).toEqual({
      member_id: jane.member_id,
      access_expires_at: end.access_expires_at,
    });
    expect((await me(jane)).access_expires_at).toBe(end.access_expires_at);
    // The owners' card says it too.
    await fresh(owner);
    const card = json<MemberAccount>(
      await h.app.inject({
        url: `/api/v1/members/${jane.member_id}/account`,
        headers: h.as(owner),
      }),
    );
    expect(card).toMatchObject({
      kind: 'guest',
      role: 'viewer',
      access_expires_at: end.access_expires_at,
    });
    expect(card.access).not.toBeNull();
    // And the log names her as a guest, never as one of the family.
    const lines = await activity(owner);
    expect(lines.find((l) => l.startsWith('Owner renewed the sign-in of'))).toMatch(
      /^Owner renewed the sign-in of Guest — Jane Smith, attorney until \d{1,2} \w+ \d{4} at \d{2}:\d{2}$/,
    );
  });

  it('a guest is a viewer and nothing else, and is always limited', async () => {
    await fresh(owner);
    const promoted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${jane.member_id}/role`,
      headers: h.as(owner),
      payload: { role: 'adult' },
    });
    expect(promoted.statusCode).toBe(409);
    expect(error(promoted)).toMatchObject({
      code: 'guest',
      message:
        'Jane Smith is from outside the family: a guest is always a viewer, limited to what they are given.',
    });
    // The database too, whoever asks: FDV03.
    expect(
      await writeAs(
        await ownerActor(),
        "update account_household set role = 'adult' where member_id = $1",
        [jane.member_id],
      ),
    ).toBe('FDV03');
    // Their limits stay on.
    await fresh(owner);
    const off = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${jane.member_id}/access`,
      headers: h.as(owner),
    });
    expect(off.statusCode).toBe(409);
    expect(error(off)).toMatchObject({
      code: 'guest_always_limited',
      message: GUEST_ALWAYS_LIMITED,
    });
  });

  it('a guest cannot be left without a restriction', async () => {
    const actor = await ownerActor();
    // Taken away while she can sign in: refused as the transaction commits.
    expect(
      await writeAs(actor, 'delete from access_restriction where member_id = $1', [jane.member_id]),
    ).toBe('23514');
    expect(
      (await admin.query('select 1 from access_restriction where member_id = $1', [jane.member_id]))
        .rowCount,
    ).toBe(1);
    // A guest's sign-in made with no restriction: refused as it commits.
    const person = randomUUID();
    const account = randomUUID();
    await admin.query(
      `insert into member (id, household_id, display_name, kind) values ($1, $2, 'Hal', 'guest')`,
      [person, hh],
    );
    await admin.query('insert into account (id, email) values ($1, $2)', [
      account,
      `hal-${person}@example.test`,
    ]);
    expect(
      await writeAs(
        actor,
        `insert into account_household (account_id, household_id, member_id, role, access_expires_at)
         values ($1, $2, $3, 'viewer', now() + interval '10 days')`,
        [account, hh, person],
      ),
    ).toBe('23514');
    // Nor with no end, nor one more than a year away; nor a family sign-in with one.
    await admin.query('insert into access_restriction (member_id, household_id) values ($1, $2)', [
      person,
      hh,
    ]);
    expect(
      await writeAs(
        actor,
        `insert into account_household (account_id, household_id, member_id, role)
         values ($1, $2, $3, 'viewer')`,
        [account, hh, person],
      ),
    ).toBe('23514');
    expect(
      await writeAs(
        actor,
        `update account_household set access_expires_at = now() + interval '400 days'
          where member_id = $1`,
        [jane.member_id],
      ),
    ).toBe('23514');
    // A year as the API counts it — 366 days of 24 hours — to the minute,
    // whatever the database's clock: in a zone whose clocks go forward twice
    // within the year, 366 of its days are an hour short (L534-06).
    const zone = await zoneShortOfAYear(h.adminUrl);
    expect(
      await writeAs(
        actor,
        `update account_household
            set access_expires_at = now() + interval '8784 hours' + interval '1 minute'
          where member_id = $1`,
        [jane.member_id],
        zone,
      ),
    ).toBe('23514');
    expect(
      await writeAs(
        actor,
        `update account_household
            set access_expires_at = now() + interval '8784 hours' - interval '1 minute'
          where member_id = $1`,
        [jane.member_id],
        zone,
      ),
    ).toBe(1);
    expect(
      await writeAs(
        actor,
        `update account_household set access_expires_at = now() + interval '10 days'
          where member_id = $1`,
        [sara.member_id],
      ),
    ).toBe('23514');
    // With both: a sign-in.
    expect(
      await writeAs(
        actor,
        `insert into account_household (account_id, household_id, member_id, role, access_expires_at)
         values ($1, $2, $3, 'viewer', now() + interval '10 days')`,
        [account, hh, person],
      ),
    ).toBe(1);
  });

  it("remove and restore a guest's sign-in: still restricted", async () => {
    const kim = await guest(
      { display_name: 'Kim', email: 'kim-534@example.test' },
      'kim’s password',
    );
    await fresh(owner);
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${kim.member_id}/sign-in`,
      headers: h.as(owner),
    });
    expect(removed.statusCode, removed.body).toBe(204);
    // The restriction is hers, not her sign-in's.
    const kept = await admin.query('select 1 from access_restriction where member_id = $1', [
      kim.member_id,
    ]);
    expect(kept.rowCount).toBe(1);
    const back = (payload: Record<string, unknown>) =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${kim.member_id}/sign-in`,
        headers: h.as(owner),
        payload,
      });
    // Never as anything but a viewer, and never without an end.
    await fresh(owner);
    const asAdult = await back({ role: 'adult', access_expires_at: inDays(30) });
    expect(asAdult.statusCode).toBe(409);
    expect(error(asAdult).code).toBe('guest');
    await fresh(owner);
    expect((await back({ role: 'viewer' })).statusCode).toBe(422);
    // With an end: a renewal, with a passkey or a code.
    await passwordOnly(owner);
    expect(error(await back({ role: 'viewer', access_expires_at: inDays(30) }))).toMatchObject({
      code: 'step_up_required',
      action: 'renew_guest',
    });
    // Nothing given for a while: asked for the code first — never the
    // password, then a code — and that one answer serves (N534W-01).
    await admin.query(
      `update session set verified_at = now() - interval '1 hour',
              factor_verified_at = now() - interval '1 hour'
        where account_id = (select account_id from account_household where member_id = $1)`,
      [owner.member_id],
    );
    expect(error(await back({ role: 'viewer', access_expires_at: inDays(30) }))).toMatchObject({
      code: 'step_up_required',
      action: 'renew_guest',
    });
    // A guest's asks the same with no end sent, before saying one is needed.
    expect(error(await back({ role: 'viewer' }))).toMatchObject({
      code: 'step_up_required',
      action: 'renew_guest',
    });
    const byCode = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/step-up',
      headers: h.as(owner),
      payload: { code: codeFor(ownerSecret) },
    });
    expect(byCode.statusCode, byCode.body).toBe(200);
    const given = await back({ role: 'viewer', access_expires_at: inDays(30) });
    expect(given.statusCode, given.body).toBe(200);
    // Still limited, and the owners asked to confirm it again.
    const row = await admin.query<{ reconfirm_since: Date | null }>(
      'select reconfirm_since from access_restriction where member_id = $1',
      [kim.member_id],
    );
    expect(row.rows[0]?.reconfirm_since).not.toBeNull();
    const signedIn = await signIn('kim-534@example.test', 'kim’s password');
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const kimAgain = json<Tokens>(signedIn);
    expect(await seenBy(kimAgain)).toEqual([docs.ahmedTax]);
    expect((await me(kimAgain)).kind).toBe('guest');
    // A family member's sign-in has no end to give back with.
    await fresh(owner);
    const sid = await h.join(owner, { name: 'Sid', email: 'sid-534@example.test', role: 'teen' });
    await fresh(owner);
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${sid.member_id}/sign-in`,
      headers: h.as(owner),
    });
    await fresh(owner);
    const family = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${sid.member_id}/sign-in`,
      headers: h.as(owner),
      payload: { role: 'teen', access_expires_at: inDays(30) },
    });
    expect(family.statusCode).toBe(422);
  });

  it('a guest whose restriction row is deleted sees nothing', async () => {
    const ned = await guest({ display_name: 'Ned', email: 'ned-534@example.test' });
    expect(await seenBy(ned)).toEqual([docs.ahmedTax]);
    // As only the owning role can (the guards ask nothing of it).
    await admin.query('delete from access_restriction where member_id = $1', [ned.member_id]);
    // Still restricted: given nothing at all.
    expect(await seenBy(ned)).toEqual([]);
    const people = json<{ items: Member[] }>(await members(ned)).items;
    expect(people.map((m) => m.id)).toEqual([ned.member_id]);
    const account = await accountOf(ned);
    const [row] = await asThem<{ restricted: boolean; documents: number; collections: number }>(
      { member: ned.member_id, role: 'viewer', account },
      `select app_restricted() as restricted,
              (select count(*)::int from document) as documents,
              (select count(*)::int from doc_collection) as collections`,
    );
    expect(row).toEqual({ restricted: true, documents: 0, collections: 0 });
  });

  it('a guest is never in an identity audience: not told of a widening, and never holding one back (A34)', async () => {
    // Jane's sign-in locked: one of the family's would hold a widening back.
    await fresh(owner);
    const locked = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${jane.member_id}/lock`,
      headers: h.as(owner),
      payload: {},
    });
    expect(locked.statusCode, locked.body).toBe(200);
    try {
      await fresh(owner);
      const before = h.jobs.length;
      const widened = await h.app.inject({
        method: 'PUT',
        url: '/api/v1/household/identity-audience',
        headers: h.as(owner),
        payload: { audience: 'family' },
      });
      expect(widened.statusCode, widened.body).toBe(200);
      // Told: the family with a sign-in, but the owner asking; no guest.
      const guests = await admin.query<{ account_id: string }>(
        `select a.account_id from account_household a join member m on m.id = a.member_id
          where m.kind = 'guest'`,
      );
      expect(guests.rows.length).toBeGreaterThan(0);
      const told = h.jobs
        .slice(before)
        .filter((j) => j.name === 'alert.send')
        .flatMap((j) => (j.data.account_ids as string[] | undefined) ?? []);
      expect(told).toContain(await accountOf(ahmed));
      for (const g of guests.rows) expect(told).not.toContain(g.account_id);
      // Back as it was.
      await fresh(owner);
      const narrowed = await h.app.inject({
        method: 'PUT',
        url: '/api/v1/household/identity-audience',
        headers: h.as(owner),
        payload: { audience: 'owners_and_self' },
      });
      expect(narrowed.statusCode, narrowed.body).toBe(200);
    } finally {
      await fresh(owner);
      const unlocked = await h.app.inject({
        method: 'DELETE',
        url: `/api/v1/members/${jane.member_id}/lock`,
        headers: h.as(owner),
      });
      expect(unlocked.statusCode, unlocked.body).toBe(204);
    }
  });

  it('an adult cannot read an account of another household, even with no WHERE', async () => {
    // Another household, with its own sign-in.
    const other = randomUUID();
    const stranger = randomUUID();
    const strangerAccount = randomUUID();
    await admin.query("insert into household (id, name) values ($1, 'Next door')", [other]);
    await admin.query(
      `insert into member (id, household_id, display_name) values ($1, $2, 'Stranger')`,
      [stranger, other],
    );
    await admin.query('insert into account (id, email) values ($1, $2)', [
      strangerAccount,
      `stranger-${other}@example.test`,
    ]);
    await admin.query(
      `insert into account_household (account_id, household_id, member_id, role)
       values ($1, $2, $3, 'owner')`,
      [strangerAccount, other, stranger],
    );
    const ahmedAccount = await accountOf(ahmed);
    const seen = await asThem<{ id: string }>(
      { member: ahmed.member_id, role: 'adult', account: ahmedAccount },
      'select id from account',
    );
    const ids = seen.map((r) => r.id);
    expect(ids).toContain(ahmedAccount);
    expect(ids).toContain(await accountOf(owner));
    expect(ids).not.toContain(strangerAccount);
    // Exactly the household's sign-ins; an owner also those whose sign-in
    // was taken away, to give one back — an adult and a teen not (S534-04).
    const signIns = (
      await admin.query<{ id: string }>(
        'select account_id as id from account_household where household_id = $1',
        [hh],
      )
    ).rows.map((r) => r.id);
    const formers = (
      await admin.query<{ id: string }>(
        'select former_account_id as id from member where household_id = $1 and former_account_id is not null',
        [hh],
      )
    ).rows.map((r) => r.id);
    expect(formers.length).toBeGreaterThan(0);
    expect(ids.sort()).toEqual([...signIns].sort());
    const teen = await h.join(owner, { name: 'Tia', email: 'tia-534@example.test', role: 'teen' });
    const teens = await asThem<{ id: string }>(
      { member: teen.member_id, role: 'teen', account: await accountOf(teen) },
      'select id from account',
    );
    for (const f of formers) expect(teens.map((r) => r.id)).not.toContain(f);
    const owners = await asThem<{ id: string }>(await ownerActor(), 'select id from account');
    expect(owners.map((r) => r.id).sort()).toEqual(
      [...new Set([...signIns, await accountOf(teen), ...formers])].sort(),
    );
    // The paths that read an account as somebody signed in still work: the
    // owner's card on a sign-in, two-step sign-in's own row, a password change.
    await fresh(owner);
    const card = await h.app.inject({
      url: `/api/v1/members/${sara.member_id}/account`,
      headers: h.as(owner),
    });
    expect(card.statusCode, card.body).toBe(200);
    expect(json<MemberAccount>(card).email).toBe('sara-534@example.test');
    // A caller who is no account actor reads as before: a sign-in by address.
    const signedIn = await signIn('ahmed-534@example.test', 'another correct horse');
    expect(signedIn.statusCode, signedIn.body).toBe(200);
  });

  it('with no member key: a guest signs in, refreshes, changes their password, is reset, exports and asks for offline copies, and each works or refuses cleanly', async () => {
    const pat = await guest(
      { display_name: 'Pat', email: 'pat-534@example.test' },
      'pat’s password',
    );
    // Signs in, and refreshes.
    const signed = await signIn('pat-534@example.test', 'pat’s password');
    expect(signed.statusCode, signed.body).toBe(200);
    const tokens = json<Tokens>(signed);
    const refreshed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: tokens.refresh_token },
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const now = json<Tokens>(refreshed);
    // The log names her as a guest, never as one of the family.
    const seen = await activity(owner);
    expect(seen).toContain('Guest — Pat, attorney signed in');
    expect(seen).toContain(
      'Owner limited what Guest — Pat, attorney can see, as they accepted their invitation',
    );
    // Changes her password, with the one she has.
    const changed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: h.as(now),
      payload: { current_password: 'pat’s password', new_password: 'pat’s new password' },
    });
    expect(changed.statusCode, changed.body).toBe(204);
    expect((await signIn('pat-534@example.test', 'pat’s new password')).statusCode).toBe(200);
    // Is reset by an owner, by the operator's mail (5.29's path 1).
    await fresh(owner);
    const before = h.jobs.length;
    const reset = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${pat.member_id}/password-reset`,
      headers: h.as(owner),
      payload: {},
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(json<{ path: string }>(reset).path).toBe('mail');
    const mailed = alertsSent({ jobs: h.jobs.slice(before) })
      .map((a) => a.url)
      .find((u): u is string => typeof u === 'string');
    const token = (mailed ?? '').split('#')[1] as string;
    const spent = await h.app.inject({
      method: 'POST',
      url: '/api/v1/password-resets/complete',
      payload: { token, password: 'pat’s reset password' },
      ...peer(),
    });
    expect(spent.statusCode, spent.body).toBe(200);
    const back = await signIn('pat-534@example.test', 'pat’s reset password');
    expect(back.statusCode, back.body).toBe(200);
    const after = json<Tokens>(back);
    expect(await seenBy(after)).toEqual([docs.ahmedTax]);
    // Exports and offline copies: refused, as for every viewer, and cleanly.
    const exported = await h.app.inject({
      method: 'POST',
      url: '/api/v1/exports',
      headers: h.as(after),
    });
    expect(exported.statusCode).toBe(403);
    expect(error(exported).code).toBe('forbidden');
    const offline = await h.app.inject({
      method: 'POST',
      url: '/api/v1/offline/grant',
      headers: h.as(after),
      payload: { password: 'pat’s reset password' },
    });
    expect(offline.statusCode).toBe(403);
    expect(error(offline).message).toBe(
      "People outside the family can't keep documents on a phone.",
    );
    // And still no member key, after all of it.
    const keys = await admin.query<{ n: number }>(
      `select count(*)::int as n from scope_key where kind = 'member' and member_id = $1`,
      [pat.member_id],
    );
    expect(keys.rows[0]?.n).toBe(0);
  });
});

/**
 * A reset an owner starts for a guest by 5.29's path 2: no mail server, so
 * a link to hand over — which a guest's is, having no member key, nothing
 * else private and (a viewer) no export.
 */
describe.skipIf(!testAdminUrl())("a guest's reset handed over (5.34, 5.29's path 2)", () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000, operatorMail: false });
    admin = createPool(h.adminUrl, 1);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('the owner is handed a link, and spending it works', async () => {
    const owner = await h.setup();
    await h.decider(owner);
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: h.as(owner),
      payload: {
        display_name: 'Quinn',
        email: 'quinn-534@example.test',
        role: 'viewer',
        kind: 'guest',
        restriction: { people: [owner.member_id] },
        access_expires_at: inDays(30),
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    const { link_token, code } = json<{ link_token: string; code: string }>(made);
    const accepted = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: link_token, code, password: 'quinn’s password' },
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const quinn = json<Tokens>(accepted);
    await h.decider(owner);
    const card = json<MemberAccount>(
      await h.app.inject({
        url: `/api/v1/members/${quinn.member_id}/account`,
        headers: h.as(owner),
      }),
    );
    expect(card.reset_path).toBe('handover');
    await h.decider(owner);
    const reset = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${quinn.member_id}/password-reset`,
      headers: h.as(owner),
      payload: {},
    });
    expect(reset.statusCode, reset.body).toBe(200);
    const link = json<{ path: string; link: string }>(reset);
    expect(link.path).toBe('handover');
    const spent = await h.app.inject({
      method: 'POST',
      url: '/api/v1/password-resets/complete',
      payload: { token: link.link.split('#')[1], password: 'quinn’s new password' },
    });
    expect(spent.statusCode, spent.body).toBe(200);
    const back = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'quinn-534@example.test', password: 'quinn’s new password' },
    });
    expect(back.statusCode, back.body).toBe(200);
    const keys = await admin.query<{ n: number }>(
      `select count(*)::int as n from scope_key where kind = 'member' and member_id = $1`,
      [quinn.member_id],
    );
    expect(keys.rows[0]?.n).toBe(0);
  });
});
