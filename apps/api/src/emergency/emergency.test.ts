import { randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type {
  ActivityLine,
  CreatedShare,
  EmergencyLinks,
  EmergencyView,
  Share,
  SharedSession,
  ShareLinkPreview,
  Tokens,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertsSent, createHarness, mailSent, type Harness } from '../test-harness.js';

/**
 * A person's emergency information (0.9.0, H4 of the health plan), through
 * the API and from the side of whoever must not see it.
 *
 * Zain (an adult) keeps his page. The owners read it and so, by default, do
 * the adults; a teen, a viewer and a guest never do unless chosen, and a
 * viewer or a guest never at all. Sara reads it as his caregiver while the
 * grant lives, and not after. Zain alone chooses who sees it, and makes a
 * clinician's link: view-only, for hours, every opening written down for
 * him, never indexable, and nothing of it in an email or the activity log.
 */

const ALLERGY = 'PENICILLIN-H4-771';
const MEDICATION = 'WARFARIN-H4-771';
const CONDITION = 'EPILEPSY-H4-771';
const MARKERS = [ALLERGY, MEDICATION, CONDITION];

const PAGE = {
  blood_type: 'O-',
  allergies: [{ id: 'a1', name: ALLERGY, note: 'hives' }],
  medications: [{ id: 'm1', name: MEDICATION, dose: '5 mg daily' }],
  conditions: [{ id: 'c1', name: CONDITION }],
  emergency_contacts: [{ id: 'p1', name: 'Mona', role: 'sister', phone: '+44 7700 900123' }],
};

describe.skipIf(!testAdminUrl())('emergency information (0.9.0, H4)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let zain: Tokens;
  let sara: Tokens;
  let rafi: Tokens;
  let tia: Tokens;
  let vic: Tokens;
  let gwen: Tokens;
  /** Omar, a child with no sign-in. */
  let omar = '';

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const errorOf = (r: LightMyRequestResponse) =>
    json<{ error: { code: string; action?: string } }>(r).error;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.47.${Math.floor(++nth / 200)}.${nth % 200}` });
  const call = (
    who: Tokens,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method,
      url,
      headers: { ...h.as(who), ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      ...peer(),
    });
  const ok = async <T>(r: Promise<LightMyRequestResponse>, status = 200): Promise<T> => {
    const res = await r;
    expect(res.statusCode, res.body).toBe(status);
    return (res.body === '' ? undefined : json<T>(res)) as T;
  };
  /** Refused, and nothing of the page in the answer. */
  const refused = async (r: Promise<LightMyRequestResponse>, status: number, what: string) => {
    const res = await r;
    expect(res.statusCode, `${what}: ${res.body}`).toBe(status);
    for (const m of MARKERS) expect(res.body, what).not.toContain(m);
    return res;
  };
  const page = (who: Tokens, member: string) =>
    call(who, 'GET', `/api/v1/members/${member}/emergency`);
  const write = (who: Tokens, member: string, fields: unknown, ifMatch?: string) =>
    call(
      who,
      'PUT',
      `/api/v1/members/${member}/emergency`,
      { fields },
      ifMatch ? { 'if-match': ifMatch } : {},
    );
  const audience = (who: Tokens, member: string, body: Record<string, unknown>) =>
    call(who, 'PUT', `/api/v1/members/${member}/emergency/audience`, body);
  const links = (who: Tokens, member: string) =>
    call(who, 'GET', `/api/v1/members/${member}/emergency/links`);
  const makeLink = (who: Tokens, member: string, body: Record<string, unknown>) =>
    call(who, 'POST', `/api/v1/members/${member}/emergency/links`, body);
  const accountOf = async (t: Tokens) =>
    json<{ account_id: string }>(await h.app.inject({ url: '/api/v1/me', headers: h.as(t) }))
      .account_id;
  /** As if they had confirmed it's them just now, or ten minutes ago. */
  const confirmed = async (t: Tokens, yes = true) =>
    admin.query(
      `update session set verified_at = now() - make_interval(mins => $2)
        where account_id = $1 and revoked_at is null`,
      [await accountOf(t), yes ? 0 : 10],
    );
  const audit = async (who: Tokens) =>
    (await ok<{ items: ActivityLine[] }>(call(who, 'GET', '/api/v1/audit?limit=100'))).items;
  const preview = (token: string) =>
    h.app.inject({ method: 'POST', url: '/api/v1/shared/preview', payload: { token }, ...peer() });
  const unlock = (token: string, secret?: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token, ...(secret !== undefined ? { secret } : {}) },
      headers: { 'user-agent': 'ClinicBrowser/1.0' },
      ...peer(),
    });
  const sessionCookie = (r: LightMyRequestResponse) =>
    (r.cookies as Array<{ name: string; value: string }>).find((c) => c.name === 'fdv_share')
      ?.value as string;
  const items = (cookie: string) =>
    h.app.inject({ method: 'GET', url: '/api/v1/shared/items', cookies: { fdv_share: cookie } });

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      publicUrl: 'https://share.example.test',
    });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    zain = await h.join(owner, { name: 'Zain', email: 'zain-h4@example.test', role: 'adult' });
    sara = await h.join(owner, { name: 'Sara', email: 'sara-h4@example.test', role: 'adult' });
    rafi = await h.join(owner, { name: 'Rafi', email: 'rafi-h4@example.test', role: 'adult' });
    tia = await h.join(owner, { name: 'Tia', email: 'tia-h4@example.test', role: 'teen' });
    vic = await h.join(owner, { name: 'Vic', email: 'vic-h4@example.test', role: 'viewer' });
    // A guest from outside the family: invited by an owner who confirms it's them.
    await h.decider(owner);
    const invited = await call(owner, 'POST', '/api/v1/invitations', {
      display_name: 'Gwen',
      relationship: 'attorney',
      email: 'gwen-h4@example.test',
      role: 'viewer',
      kind: 'guest',
      restriction: { people: [zain.member_id], types: ['medical_record'] },
      access_expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const { link_token, code } = json<{ link_token: string; code: string }>(invited);
    const accepted = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: link_token, code, password: 'the guest’s own password' },
      ...peer(),
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    gwen = json<Tokens>(accepted);
    omar = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name, created_at) values ($1, 'Omar', '2020-01-01') returning id",
        [owner.household_id],
      )
    ).rows[0]?.id as string;
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('the person writes their page, with an ETag; a stale If-Match is a conflict', async () => {
    // Nothing yet: the person sees an empty page they can write.
    const empty = await ok<EmergencyView>(page(zain, zain.member_id));
    expect(empty).toMatchObject({
      version: 0,
      can_edit: true,
      can_choose: true,
      audience: 'adults',
    });
    const first = await write(zain, zain.member_id, PAGE);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers.etag).toBe('"1"');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(json<EmergencyView>(first).fields.allergies?.[0]?.name).toBe(ALLERGY);
    // Made from a version moved on: refused, and nothing written.
    const stale = await write(zain, zain.member_id, { ...PAGE, notes: 'late' }, '"0"');
    expect(stale.statusCode, stale.body).toBe(409);
    expect(errorOf(stale).code).toBe('conflict');
    // From the version read: written.
    const second = await write(
      zain,
      zain.member_id,
      { ...PAGE, notes: 'Carries an inhaler' },
      '"1"',
    );
    expect(second.statusCode, second.body).toBe(200);
    expect(second.headers.etag).toBe('"2"');
    // Nothing different is no change.
    const same = await write(zain, zain.member_id, { ...PAGE, notes: 'Carries an inhaler' }, '"2"');
    expect(same.headers.etag).toBe('"2"');
    const got = await page(zain, zain.member_id);
    expect(got.headers.etag).toBe('"2"');
    expect(got.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('is read by the owners and the adults by default; never a teen, a viewer or a guest', async () => {
    expect((await ok<EmergencyView>(page(owner, zain.member_id))).fields.blood_type).toBe('O-');
    expect((await ok<EmergencyView>(page(rafi, zain.member_id))).can_edit).toBe(false);
    await refused(page(tia, zain.member_id), 404, 'a teen');
    await refused(page(vic, zain.member_id), 404, 'a viewer');
    await refused(page(gwen, zain.member_id), 404, 'a guest');
    // Only the person and the owners write it.
    await refused(write(rafi, zain.member_id, { notes: 'x' }), 403, 'another adult writes');
    await refused(write(tia, zain.member_id, { notes: 'x' }), 404, 'a teen writes');
    await refused(write(vic, zain.member_id, { notes: 'x' }), 404, 'a viewer writes');
    // The links and who opened them: the person's and the owners'.
    await refused(links(rafi, zain.member_id), 404, 'another adult lists links');
    // Nor anybody else's household, or nobody at all.
    await refused(page(owner, randomUUID()), 404, 'nobody');
  });

  it('the person alone chooses who sees it; an adult not chosen, a teen chosen', async () => {
    // An owner may not choose for a grown-up, nor another adult, nor a teen.
    await refused(audience(owner, zain.member_id, { audience: 'family' }), 403, 'an owner');
    await refused(audience(rafi, zain.member_id, { audience: 'family' }), 403, 'another adult');
    // Never a viewer or a guest named, nor the person themselves.
    await refused(
      audience(zain, zain.member_id, { audience: 'adults', chosen_member_ids: [vic.member_id] }),
      422,
      'a viewer named',
    );
    await refused(
      audience(zain, zain.member_id, { audience: 'adults', chosen_member_ids: [gwen.member_id] }),
      422,
      'a guest named',
    );
    const narrowed = await ok<EmergencyView>(
      audience(zain, zain.member_id, {
        audience: 'owners_and_self',
        chosen_member_ids: [tia.member_id],
      }),
    );
    expect(narrowed.chosen).toEqual([{ member_id: tia.member_id, name: 'Tia' }]);
    await refused(page(rafi, zain.member_id), 404, 'an adult not chosen');
    await refused(page(sara, zain.member_id), 404, 'an adult not chosen, before a grant');
    const asTia = await ok<EmergencyView>(page(tia, zain.member_id));
    expect(asTia.fields.medications?.[0]?.name).toBe(MEDICATION);
    // Named, she reads it, and nothing more: not who else is named, not its links.
    expect(asTia).toMatchObject({
      can_edit: false,
      can_choose: false,
      can_see_links: false,
      chosen: [],
    });
    await refused(links(tia, zain.member_id), 404, 'a teen chosen lists links');
    await refused(audience(tia, zain.member_id, { audience: 'family' }), 403, 'a teen chosen');
    // Still the owners'.
    expect((await ok<EmergencyView>(page(owner, zain.member_id))).version).toBeGreaterThan(0);
  });

  it('a caregiver with a live grant kept reads it, read-only, and not after a revoke', async () => {
    await ok(
      call(zain, 'POST', `/api/v1/members/${zain.member_id}/caregivers`, {
        caregiver_member_id: sara.member_id,
      }),
      201,
    );
    const asCarer = await ok<EmergencyView>(page(sara, zain.member_id));
    expect(asCarer).toMatchObject({ caregiver: true, can_edit: false, can_choose: false });
    expect(asCarer.fields.allergies?.[0]?.name).toBe(ALLERGY);
    await refused(write(sara, zain.member_id, { notes: 'x' }), 403, 'a caregiver writes');
    await refused(links(sara, zain.member_id), 404, 'a caregiver lists links');
    await refused(
      makeLink(sara, zain.member_id, { fields: ['allergies'] }),
      403,
      'a caregiver shares',
    );
    // The grant widens nothing else: Tia's page, kept for the owners, stays hers.
    await ok(write(tia, tia.member_id, { notes: 'Tia’s own' }));
    await ok(audience(owner, tia.member_id, { audience: 'owners_and_self' }));
    await refused(page(sara, tia.member_id), 404, 'a caregiver, another person');
    // Revoked: nothing.
    await ok(
      call(zain, 'POST', `/api/v1/members/${zain.member_id}/caregivers/${sara.member_id}/revoke`),
      204,
    );
    await refused(page(sara, zain.member_id), 404, 'a caregiver after a revoke');
  });

  it('a parent chooses for a child; the teen writes their own and chooses nothing', async () => {
    // Tia (a teen): she writes her own, an owner chose who sees it (above).
    await refused(audience(tia, tia.member_id, { audience: 'family' }), 403, 'a teen chooses');
    expect((await ok<EmergencyView>(page(tia, tia.member_id))).can_choose).toBe(false);
    await refused(page(rafi, tia.member_id), 404, 'an adult, a teen’s page for the owners');
    // Omar, with no sign-in: an owner writes and chooses; an adult does neither.
    await ok(write(owner, omar, { allergies: [{ id: 'a', name: ALLERGY }] }));
    await refused(write(rafi, omar, { notes: 'x' }), 403, 'an adult writes a child’s');
    await refused(
      audience(rafi, omar, { audience: 'family' }),
      403,
      'an adult chooses for a child',
    );
    expect((await ok<EmergencyView>(audience(owner, omar, { audience: 'family' }))).audience).toBe(
      'family',
    );
    expect((await ok<EmergencyView>(page(tia, omar))).fields.allergies?.length).toBe(1);
    // A teen makes no link, of their own or anybody's.
    await refused(makeLink(tia, tia.member_id, { fields: ['allergies'] }), 403, 'a teen shares');
  });

  it('the activity log says who changed it, never what — and only to the owners, the person and whoever did it', async () => {
    const zains = (await audit(zain)).map((l) => l.text);
    expect(zains).toContain('Zain updated their emergency information');
    expect(zains).toContain('Zain changed who can see their emergency information');
    const owners = (await audit(owner)).map((l) => l.text);
    expect(owners.some((t) => /updated Omar’s emergency information/.test(t))).toBe(true);
    const rafis = (await audit(rafi)).map((l) => l.text);
    expect(rafis.join('\n')).not.toMatch(/emergency information/);
    for (const who of [owner, zain, rafi, tia]) {
      const all = JSON.stringify(await audit(who));
      for (const m of MARKERS) expect(all).not.toContain(m);
      expect(all).not.toMatch(/allerg|medication|condition|blood/i);
    }
    // Not searchable, and not in anybody's documents.
    for (const who of [owner, zain, rafi]) {
      const found = await call(who, 'GET', `/api/v1/documents?q=${ALLERGY}`);
      expect(found.body).not.toContain(ALLERGY);
      const search = await call(who, 'GET', `/api/v1/search?q=${MEDICATION}`);
      expect(search.body).not.toContain(MEDICATION);
    }
  });

  describe('a clinician’s link', () => {
    let made: CreatedShare;

    it('is made by the person, once they confirm it’s them; hours, never days', async () => {
      await refused(
        makeLink(owner, zain.member_id, { fields: ['allergies'] }),
        403,
        'an owner, a grown-up’s',
      );
      await refused(
        makeLink(rafi, zain.member_id, { fields: ['allergies'] }),
        404,
        'an adult not chosen',
      );
      await confirmed(zain, false);
      const asked = await makeLink(zain, zain.member_id, { fields: ['allergies'] });
      expect(asked.statusCode, asked.body).toBe(403);
      expect(errorOf(asked)).toMatchObject({ code: 'step_up_required', action: 'share_emergency' });
      await confirmed(zain);
      await refused(
        makeLink(zain, zain.member_id, { fields: ['allergies'], expires_in_hours: 25 }),
        422,
        'past a day',
      );
      await refused(
        makeLink(zain, zain.member_id, {
          fields: ['allergies'],
          expires_at: new Date(Date.now() + 30 * 3_600_000).toISOString(),
        }),
        422,
        'past a day, as a time',
      );
      await refused(makeLink(zain, zain.member_id, { fields: [] }), 422, 'nothing ticked');
      const res = await makeLink(zain, zain.member_id, {
        fields: ['blood_type', 'allergies'],
        with_pin: true,
        recipient_label: 'Dr Patel',
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      made = json<CreatedShare>(res);
      expect(made.pin).toMatch(/^\d{4}$/);
      expect(made.link_url).toBe(`https://share.example.test/s#${made.link_token}`);
      const hours = (Date.parse(made.share.expires_at) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(3.9);
      expect(hours).toBeLessThanOrEqual(4);
      expect(made.share).toMatchObject({
        permission: 'view',
        protection: ['pin'],
        document_id: null,
      });
      // Not in the family's list of links, and not taken back through it.
      expect(
        (await ok<{ items: Share[] }>(call(owner, 'GET', '/api/v1/shares'))).items.some(
          (s) => s.id === made.share.id,
        ),
      ).toBe(false);
      await refused(
        call(rafi, 'DELETE', `/api/v1/shares/${made.share.id}`),
        404,
        'the family’s revoke',
      );
    });

    it('says nothing before Open, is never indexed, and shows only what was ticked', async () => {
      const before = await preview(made.link_token);
      expect(before.statusCode, before.body).toBe(200);
      expect(before.headers['x-robots-tag']).toBe('noindex, nofollow');
      const p = json<ShareLinkPreview>(before);
      // Behind its PIN, not even that it is emergency information, nor who
      // sent it (the H4 review): what any withheld link's page says.
      expect(p).toMatchObject({ kind: 'document', shared_by: null, document_title: null });
      expect(p).not.toHaveProperty('person_name');
      expect(p).not.toHaveProperty('permission');
      expect(before.body).not.toContain('Zain');
      expect(before.body).not.toMatch(/emergency/i);
      for (const m of MARKERS) expect(before.body).not.toContain(m);
      // A wrong PIN opens nothing.
      const wrong = await unlock(made.link_token, made.pin === '0000' ? '1111' : '0000');
      expect(wrong.statusCode).toBe(401);
      expect(errorOf(wrong).code).toBe('pin_wrong');
      for (const m of MARKERS) expect(wrong.body).not.toContain(m);
      const opened = await unlock(made.link_token, made.pin);
      expect(opened.statusCode, opened.body).toBe(200);
      expect(opened.headers['x-robots-tag']).toBe('noindex, nofollow');
      const s = json<SharedSession>(opened);
      expect(s.kind).toBe('emergency');
      expect(s.items).toEqual([]);
      expect(s.emergency).toMatchObject({
        person_name: 'Zain',
        shown: ['blood_type', 'allergies'],
        fields: { blood_type: 'O-', allergies: [{ id: 'a1', name: ALLERGY, note: 'hives' }] },
      });
      // What was not ticked is not there at all.
      expect(opened.body).not.toContain(MEDICATION);
      expect(opened.body).not.toContain(CONDITION);
      expect(opened.body).not.toContain('Mona');
      const again = await items(sessionCookie(opened));
      expect(again.statusCode, again.body).toBe(200);
      expect(again.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(json<SharedSession>(again).emergency?.fields.allergies?.[0]?.name).toBe(ALLERGY);
    });

    it('every opening is written down for the person, and the owners; nobody else', async () => {
      const mine = await ok<EmergencyLinks>(links(zain, zain.member_id));
      const link = mine.items.find((l) => l.id === made.share.id);
      expect(link?.emergency_fields).toEqual(['blood_type', 'allergies']);
      expect(link?.openings).toHaveLength(1);
      expect(link?.openings[0]?.network).toMatch(/^10\.47\.\d+\.0\/24$/);
      expect(link?.openings[0]?.user_agent).toBe('ClinicBrowser/1.0');
      expect(link?.open_count).toBe(1);
      expect((await ok<EmergencyLinks>(links(owner, zain.member_id))).items).toHaveLength(
        mine.items.length,
      );
      await refused(links(tia, zain.member_id), 404, 'a teen');
      await refused(links(vic, zain.member_id), 404, 'a viewer');
      // The log: made and opened, for Zain and the owners; never what was read.
      const zains = (await audit(zain)).map((l) => l.text);
      expect(zains).toContain(
        'Zain made a view-only link to their emergency information for Dr Patel',
      );
      expect(zains).toContain('Shared link (Dr Patel) opened Zain’s emergency information');
      // Not to another adult, a teen (her own page's lines aside) or his caregiver.
      for (const who of [rafi, tia, sara]) {
        const theirs = JSON.stringify(await audit(who));
        expect(theirs).not.toMatch(/Zain’s emergency information|Dr Patel|link to their/);
      }
    });

    it('is emailed with no word of what it gives', async () => {
      const to = `clinic.${randomUUID().slice(0, 6)}@example.com`;
      const sent = await call(zain, 'POST', `/api/v1/shares/${made.share.id}/email`, { to });
      expect(sent.statusCode, sent.body).toBe(200);
      const mail = mailSent(h).find((m) => m.to === to);
      const whole = `${mail?.subject ?? ''}\n${mail?.text ?? ''}`;
      expect(whole).toContain('has shared some information with you');
      expect(whole).toContain(made.link_token);
      for (const m of MARKERS) expect(whole).not.toContain(m);
      expect(whole).not.toMatch(/allerg|medication|condition|blood|emergency|health/i);
      expect(whole).not.toContain(made.pin as string);
      // Somebody else's link is not theirs to email.
      await refused(
        call(owner, 'POST', `/api/v1/shares/${made.share.id}/email`, { to }),
        404,
        'an owner emails it',
      );
    });

    it('stops when taken back, when it runs out, and after ten wrong PINs', async () => {
      const opened = await unlock(made.link_token, made.pin);
      const cookie = sessionCookie(opened);
      await refused(
        call(rafi, 'DELETE', `/api/v1/members/${zain.member_id}/emergency/links/${made.share.id}`),
        404,
        'another adult takes it back',
      );
      await ok(
        call(zain, 'DELETE', `/api/v1/members/${zain.member_id}/emergency/links/${made.share.id}`),
        204,
      );
      await refused(unlock(made.link_token, made.pin), 404, 'revoked: Open');
      await refused(preview(made.link_token), 404, 'revoked: its page');
      const after = await items(cookie);
      expect(after.statusCode).toBeGreaterThanOrEqual(400);
      for (const m of MARKERS) expect(after.body).not.toContain(m);
      expect(
        (await ok<EmergencyLinks>(links(zain, zain.member_id))).items.find(
          (l) => l.id === made.share.id,
        )?.state,
      ).toBe('revoked');

      // Run out.
      await confirmed(zain);
      const brief = await ok<CreatedShare>(
        makeLink(zain, zain.member_id, { fields: ['allergies'], expires_in_hours: 1 }),
        201,
      );
      const live = await unlock(brief.link_token);
      expect(live.statusCode, live.body).toBe(200);
      await admin.query(
        `update share_link set expires_at = now() - interval '1 minute' where id = $1`,
        [brief.share.id],
      );
      await refused(preview(brief.link_token), 404, 'expired: its page');
      await refused(unlock(brief.link_token), 404, 'expired: Open');
      const ran = await items(sessionCookie(live));
      expect(ran.statusCode).toBeGreaterThanOrEqual(400);
      for (const m of MARKERS) expect(ran.body).not.toContain(m);

      // Ten wrong PINs.
      const pinned = await ok<CreatedShare>(
        makeLink(zain, zain.member_id, { fields: ['allergies'], with_pin: true }),
        201,
      );
      const bad = pinned.pin === '0000' ? '1111' : '0000';
      for (let i = 0; i < 10; i++) await unlock(pinned.link_token, bad);
      await refused(unlock(pinned.link_token, pinned.pin), 404, 'locked: the right PIN');
    });

    it('an owner’s for a child names them only when chosen, and gives no document', async () => {
      await confirmed(owner);
      const forOmar = await ok<CreatedShare>(
        makeLink(owner, omar, { fields: ['allergies'], show_title: true }),
        201,
      );
      const p = json<ShareLinkPreview>(await preview(forOmar.link_token));
      expect(p.person_name).toBe('Omar');
      // Not shown, it is not said.
      const quiet = await ok<CreatedShare>(makeLink(owner, omar, { fields: ['allergies'] }), 201);
      const unsaid = await preview(quiet.link_token);
      expect(json<ShareLinkPreview>(unsaid).person_name).toBeNull();
      expect(unsaid.body).not.toContain('Omar');
      const opened = json<SharedSession>(await unlock(forOmar.link_token));
      expect(opened.emergency?.person_name).toBe('Omar');
      // No document is given by any id.
      const cookie = sessionCookie(await unlock(forOmar.link_token));
      const doc = await h.app.inject({
        method: 'GET',
        url: `/api/v1/shared/items/${randomUUID()}/content`,
        cookies: { fdv_share: cookie },
      });
      expect(doc.statusCode).toBe(404);
    });
  });
  describe('the H4 review', () => {
    it('many pages of a clinician’s link at once, more than the pool holds, all answer: nothing waits on a second connection', async () => {
      await confirmed(zain);
      const open = await ok<CreatedShare>(
        makeLink(zain, zain.member_id, { fields: ['allergies'] }),
        201,
      );
      // Opens at once, each its own session: more than the harness's pool of four.
      const opens = await Promise.race([
        Promise.all(Array.from({ length: 8 }, () => unlock(open.link_token))),
        new Promise<never>((_, no) =>
          setTimeout(() => no(new Error('Open waited for the pool')), 30_000),
        ),
      ]);
      for (const r of opens) expect(r.statusCode, r.body).toBe(200);
      const cookie = sessionCookie(opens[0] as LightMyRequestResponse);
      const pages = await Promise.race([
        Promise.all(Array.from({ length: 16 }, () => items(cookie))),
        new Promise<never>((_, no) =>
          setTimeout(() => no(new Error('the page waited for the pool')), 30_000),
        ),
      ]);
      for (const r of pages) {
        expect(r.statusCode, r.body).toBe(200);
        expect(json<SharedSession>(r).emergency?.fields.allergies?.[0]?.name).toBe(ALLERGY);
        // Nothing of how it was read goes out with it.
        expect(r.body).not.toContain('pendingEmergency');
      }
    }, 60_000);

    it('a link its own person made, not named, says neither whose it is nor who sent it before Open', async () => {
      await confirmed(zain);
      const quiet = await ok<CreatedShare>(
        makeLink(zain, zain.member_id, { fields: ['allergies'] }),
        201,
      );
      const p = json<ShareLinkPreview>(await preview(quiet.link_token));
      expect(p).toMatchObject({ kind: 'emergency', person_name: null, shared_by: null });
      const named = await ok<CreatedShare>(
        makeLink(zain, zain.member_id, { fields: ['allergies'], show_title: true }),
        201,
      );
      expect(json<ShareLinkPreview>(await preview(named.link_token))).toMatchObject({
        kind: 'emergency',
        person_name: 'Zain',
        shared_by: 'Zain',
      });
    });

    it('narrowing who sees it ends the exports of whoever loses sight, and nobody else’s', async () => {
      await ok(
        audience(zain, zain.member_id, { audience: 'adults', chosen_member_ids: [tia.member_id] }),
      );
      const exportOf = async (t: Tokens) =>
        (
          await admin.query<{ id: string }>(
            `insert into export (household_id, requested_by, state, expires_at)
             values ($1, $2, 'done', now() + interval '7 days') returning id`,
            [owner.household_id, await accountOf(t)],
          )
        ).rows[0]?.id as string;
      const made = {
        rafi: await exportOf(rafi),
        tia: await exportOf(tia),
        owner: await exportOf(owner),
        zain: await exportOf(zain),
      };
      await ok(audience(zain, zain.member_id, { audience: 'owners_and_self' }));
      const ended = async (id: string) =>
        (
          await admin.query<{ ended: boolean }>(
            'select expires_at <= now() as ended from export where id = $1',
            [id],
          )
        ).rows[0]?.ended;
      expect(await ended(made.rafi)).toBe(true);
      expect(await ended(made.tia)).toBe(true);
      expect(await ended(made.owner)).toBe(false);
      expect(await ended(made.zain)).toBe(false);
    });

    it('a page nobody has written is the person’s and the owners’ to be told of; to anybody else, the same 404', async () => {
      // Rafi has written nothing.
      await refused(page(sara, rafi.member_id), 404, 'an adult, an unwritten page');
      await refused(page(tia, rafi.member_id), 404, 'a teen, an unwritten page');
      expect((await ok<EmergencyView>(page(rafi, rafi.member_id))).version).toBe(0);
      expect((await ok<EmergencyView>(page(owner, rafi.member_id))).version).toBe(0);
    });

    it('somebody whose access is limited is told there is no page, never refused by the database', async () => {
      await admin.query(
        'insert into access_restriction (member_id, household_id) values ($1, $2)',
        [rafi.member_id, owner.household_id],
      );
      try {
        await refused(page(rafi, zain.member_id), 404, 'limited: read');
        await refused(write(rafi, zain.member_id, { notes: 'x' }), 404, 'limited: write');
        await refused(page(rafi, omar), 404, 'limited: a child’s');
      } finally {
        await admin.query('delete from access_restriction where member_id = $1', [rafi.member_id]);
      }
    });

    it('an owner’s link for a teen ends once the teen signs in as a grown-up: theirs to share then', async () => {
      await confirmed(owner);
      const forTia = await ok<CreatedShare>(
        makeLink(owner, tia.member_id, { fields: ['notes'] }),
        201,
      );
      expect((await preview(forTia.link_token)).statusCode).toBe(200);
      await admin.query("update account_household set role = 'adult' where member_id = $1", [
        tia.member_id,
      ]);
      try {
        await refused(preview(forTia.link_token), 404, 'grown up: its page');
        await refused(unlock(forTia.link_token), 404, 'grown up: Open');
        // And no owner makes one for her now.
        await refused(makeLink(owner, tia.member_id, { fields: ['notes'] }), 403, 'grown up');
      } finally {
        await admin.query("update account_household set role = 'teen' where member_id = $1", [
          tia.member_id,
        ]);
      }
    });

    it('a link that locks tells its maker in words that name nothing of what it gave', () => {
      // The ten wrong PINs above locked one of Zain's links.
      const locked = alertsSent(h).filter(
        (a) => a.subject === 'A link you shared has stopped working',
      );
      expect(locked.length).toBeGreaterThan(0);
      for (const a of locked) {
        expect(String(a.body)).toContain('make a new link if they still need it.');
        expect(String(a.body)).not.toMatch(/document|emergency|allerg|medication|condition/i);
      }
    });
  });
});
