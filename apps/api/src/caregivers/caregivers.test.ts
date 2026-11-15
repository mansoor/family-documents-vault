import { randomUUID } from 'node:crypto';
import { askGrownUps, createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  CAREGIVER_MARK,
  GROWN_UP_QUESTION,
  type ActivityLine,
  type Capabilities,
  type CaregiverGrantView,
  type CaregiverLook,
  type DocumentPage,
  type DocumentView,
  type GrownUpQuestionView,
  type MyCaregivers,
  type PersonCaregivers,
  type SearchHit,
  type Tokens,
} from '@fdv/shared';
import FormData from 'form-data';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * A caregiver for somebody's medical papers, and turning 18 (0.9.0, H1b of
 * the health plan; the owner's decisions of 14 Nov 2026), through the API
 * and from the side of whoever must not see.
 *
 * Zain (an adult) names Sara (an adult) to see his medical papers. Sara then
 * reads his Medical papers, his Only me ones included, read-only, and every
 * look she takes is written down for Zain. Nobody else gains anything: not
 * Rafi (a third adult), not Tia (a teen), not the owner, not Sara for a
 * paper of Zain's that is not Medical, and not Sara once Zain revokes it.
 */

const PDF = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
const BLOOD = 'BLOODTEST-H1B-541';
const PASSPORT = 'PASSPORT-H1B-541';
const PROVIDER = 'Dr Quentin H1B';

describe.skipIf(!testAdminUrl())('caregivers and turning 18 (0.9.0, H1b)', () => {
  let h: Harness;
  let owner: Tokens;
  let zain: Tokens;
  let sara: Tokens;
  let rafi: Tokens;
  let tia: Tokens;
  /** Omar, with no sign-in. */
  let omar = '';
  let admin: ReturnType<typeof createPool>;
  let blood: DocumentView;
  let bloodVersion = '';
  let passport: DocumentView;
  let family: DocumentView;
  let trashed: DocumentView;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    who: Tokens = owner,
  ) =>
    h.app.inject({
      method,
      url,
      headers: h.as(who),
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const ok = async <T>(r: Promise<LightMyRequestResponse>, status = 200): Promise<T> => {
    const res = await r;
    expect(res.statusCode, res.body).toBe(status);
    return (res.body === '' ? undefined : json<T>(res)) as T;
  };
  const refused = async (r: Promise<LightMyRequestResponse>, what: string) => {
    const res = await r;
    expect(res.statusCode, `${what}: ${res.body}`).toBeGreaterThanOrEqual(400);
    expect(res.statusCode, `${what}: ${res.body}`).toBeLessThan(500);
    expect(res.body, what).not.toContain(BLOOD);
    expect(res.body, what).not.toContain(PROVIDER);
    return res;
  };
  const make = (who: Tokens, payload: Record<string, unknown>) =>
    ok<DocumentView>(call('POST', '/api/v1/documents', payload, who), 201);
  const upload = async (who: Tokens, doc: DocumentView) => {
    const form = new FormData();
    form.append('file', PDF(doc.id), { filename: 'scan.pdf', contentType: 'application/pdf' });
    return h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${doc.id}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
  };
  /** As if they had just confirmed it's them. */
  const fresh = (t: Tokens) =>
    admin.query(
      `update session set verified_at = now(), factor_verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)
          and revoked_at is null`,
      [t.member_id],
    );
  const titlesOf = async (who: Tokens) => {
    const page = await ok<DocumentPage>(
      call('GET', '/api/v1/documents?sort=title&limit=200', undefined, who),
    );
    return page.items.map((d) => d.title);
  };
  const audit = async (who: Tokens) =>
    (await ok<{ items: ActivityLine[] }>(call('GET', '/api/v1/audit?limit=100', undefined, who)))
      .items;
  const name = (person: Tokens, caregiver: string, by: Tokens = person) =>
    call(
      'POST',
      `/api/v1/members/${person.member_id}/caregivers`,
      { caregiver_member_id: caregiver },
      by,
    );
  const revoke = (person: string, caregiver: string, by: Tokens) =>
    call('POST', `/api/v1/members/${person}/caregivers/${caregiver}/revoke`, undefined, by);

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    zain = await h.join(owner, { name: 'Zain', email: 'zain-h1b@example.test', role: 'adult' });
    sara = await h.join(owner, { name: 'Sara', email: 'sara-h1b@example.test', role: 'adult' });
    rafi = await h.join(owner, { name: 'Rafi', email: 'rafi-h1b@example.test', role: 'adult' });
    tia = await h.join(owner, { name: 'Tia', email: 'tia-h1b@example.test', role: 'teen' });
    admin = createPool(h.adminUrl, 2);
    omar = (
      await admin.query<{ id: string }>(
        "insert into member (household_id, display_name, created_at) values ($1, 'Omar', '2020-01-01') returning id",
        [owner.household_id],
      )
    ).rows[0]?.id as string;
    blood = await make(zain, {
      type_key: 'prescription',
      title: BLOOD,
      owner_member_id: zain.member_id,
      visibility: 'private',
      extra: { medication: PROVIDER },
      notes: 'my own words about it',
      tags: ['h1btag'],
    });
    const up = await upload(zain, blood);
    expect(up.statusCode, up.body).toBeLessThan(300);
    bloodVersion = (
      await ok<DocumentView>(call('GET', `/api/v1/documents/${blood.id}`, undefined, zain))
    ).latest_version_id as string;
    // Kept, no longer needed, and why: his own words.
    await ok(
      call(
        'POST',
        `/api/v1/documents/${blood.id}/no-longer-needed`,
        { reason: 'the course ended' },
        zain,
      ),
    );
    passport = await make(zain, {
      type_key: 'passport',
      title: PASSPORT,
      owner_member_id: zain.member_id,
      visibility: 'private',
    });
    family = await make(zain, {
      type_key: 'prescription',
      title: 'Inhaler for the family',
      owner_member_id: zain.member_id,
      visibility: 'household',
    });
    trashed = await make(zain, {
      type_key: 'prescription',
      title: 'Old prescription H1B',
      owner_member_id: zain.member_id,
      visibility: 'private',
    });
    await ok(call('DELETE', `/api/v1/documents/${trashed.id}`, undefined, zain), 204);
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('says so in its capabilities', async () => {
    const caps = await ok<Capabilities>(call('GET', '/api/v1/capabilities'));
    expect(caps.features.caregivers).toBe(true);
  });

  it('before any grant, nobody but Zain sees his Only me medical paper', async () => {
    for (const who of [owner, sara, rafi, tia]) {
      await refused(call('GET', `/api/v1/documents/${blood.id}`, undefined, who), 'open');
      expect(await titlesOf(who)).not.toContain(BLOOD);
    }
  });

  it('who may be named: an owner or an adult signed in, never a teen, nor the person, nor by a third adult', async () => {
    const r = await name(zain, tia.member_id);
    expect(r.statusCode, r.body).toBe(422);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('caregiver_not_eligible');
    expect((await name(zain, zain.member_id)).statusCode).toBe(422);
    expect((await name(zain, omar)).statusCode).toBe(422);
    // Rafi naming Sara for Zain; the owner naming one for Zain, who signs in.
    expect((await name(zain, sara.member_id, rafi)).statusCode).toBe(403);
    expect((await name(zain, owner.member_id, owner)).statusCode).toBe(403);
    const offered = await ok<PersonCaregivers>(
      call('GET', `/api/v1/members/${zain.member_id}/caregivers`, undefined, zain),
    );
    expect(offered.may_add).toBe(true);
    const ids = offered.candidates.map((c) => c.member_id);
    expect(ids).toContain(sara.member_id);
    expect(ids).toContain(owner.member_id);
    expect(ids).not.toContain(tia.member_id);
    expect(ids).not.toContain(zain.member_id);
    expect(ids).not.toContain(omar);
  });

  it('Zain names Sara; she reads his Medical papers, Only me included, marked as a caregiver’s, read-only', async () => {
    const g = await ok<CaregiverGrantView>(name(zain, sara.member_id), 201);
    expect(g).toMatchObject({
      caregiver_name: 'Sara',
      person_name: 'Zain',
      confirmed: true,
      may_revoke: true,
      may_give_up: false,
    });
    // Named twice: the same grant.
    const again = await ok<CaregiverGrantView>(name(zain, sara.member_id), 201);
    expect(again.id).toBe(g.id);

    const seen = await ok<DocumentView>(
      call('GET', `/api/v1/documents/${blood.id}`, undefined, sara),
    );
    expect(seen.caregiver).toBe(true);
    expect(seen.title).toBe(BLOOD);
    // The paper's details, never his notes about it.
    expect(seen.extra).toMatchObject({ medication: PROVIDER });
    expect(seen.notes).toBeNull();
    expect(seen.has_notes).toBe(false);
    // Nor when, nor by whom; nor that he said why it is no longer needed.
    expect(seen.notes_updated_at).toBeNull();
    expect(seen.notes_updated_by_name).toBeNull();
    expect(seen.no_longer_needed?.has_reason).toBe(false);
    expect(seen.no_longer_needed?.reason).toBeNull();
    expect(JSON.stringify(seen)).not.toContain('the course ended');
    expect(JSON.stringify(seen)).not.toContain('my own words');
    // Found in the table, its counts, and search.
    const page = await ok<DocumentPage>(
      call('GET', '/api/v1/documents?sort=title&limit=200', undefined, sara),
    );
    const row = page.items.find((d) => d.id === blood.id);
    expect(row?.caregiver).toBe(true);
    // One Sara sees anyway is not marked.
    expect(page.items.find((d) => d.id === family.id)?.caregiver).toBeUndefined();
    const older = await ok<{ items: DocumentView[] }>(
      call('GET', '/api/v1/documents?limit=200', undefined, sara),
    );
    expect(older.items.map((d) => d.id)).toContain(blood.id);
    const hits = await ok<{ items: SearchHit[] }>(
      call('GET', `/api/v1/search?q=${BLOOD}`, undefined, sara),
    );
    expect(hits.items.map((x) => x.document_id)).toContain(blood.id);
    const counts = await ok<{ by_member: Array<{ member_id: string; count: number }> }>(
      call('GET', '/api/v1/documents/counts', undefined, sara),
    );
    const rafiCounts = await ok<{ by_member: Array<{ member_id: string; count: number }> }>(
      call('GET', '/api/v1/documents/counts', undefined, rafi),
    );
    const forZain = (c: { by_member: Array<{ member_id: string; count: number }> }) =>
      c.by_member.find((x) => x.member_id === zain.member_id)?.count ?? 0;
    expect(forZain(counts)).toBe(forZain(rafiCounts) + 1);
    // Its file, its versions, and Also in.
    await fresh(sara);
    const file = await call('GET', `/api/v1/versions/${bloodVersion}/content`, undefined, sara);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.rawPayload.toString('latin1')).toContain(blood.id);
    await ok(call('GET', `/api/v1/documents/${blood.id}/versions`, undefined, sara));
    await ok(call('GET', `/api/v1/documents/${blood.id}/also-in`, undefined, sara));
  });

  it('nothing else of Zain’s: not a paper that is not Medical, not one in the Trash', async () => {
    await refused(call('GET', `/api/v1/documents/${passport.id}`, undefined, sara), 'passport');
    await refused(call('GET', `/api/v1/documents/${trashed.id}`, undefined, sara), 'trash');
    expect(await titlesOf(sara)).not.toContain(PASSPORT);
    const trash = await ok<{ items: DocumentView[] }>(
      call('GET', '/api/v1/documents?deleted=true&limit=200', undefined, sara),
    );
    expect(trash.items.map((d) => d.id)).not.toContain(trashed.id);
  });

  it('nobody else gains anything: a third adult, a teen, the owner', async () => {
    for (const who of [rafi, tia, owner]) {
      await refused(call('GET', `/api/v1/documents/${blood.id}`, undefined, who), 'open');
      await refused(
        call('GET', `/api/v1/versions/${bloodVersion}/content`, undefined, who),
        'file',
      );
      expect(await titlesOf(who)).not.toContain(BLOOD);
      const hits = await ok<{ items: SearchHit[] }>(
        call('GET', `/api/v1/search?q=${BLOOD}`, undefined, who),
      );
      expect(hits.items).toEqual([]);
    }
    // Who looked: Zain's and the owners'; not another adult's, a teen's, nor
    // the caregiver's own.
    for (const who of [rafi, tia, sara]) {
      const r = await refused(
        call('GET', `/api/v1/members/${zain.member_id}/caregiver-views`, undefined, who),
        'looks',
      );
      expect(r.statusCode).toBe(403);
    }
    // Grants: the person, the caregiver and the owners; not Rafi, nor Tia.
    for (const who of [rafi, tia]) {
      expect(
        (await call('GET', `/api/v1/members/${zain.member_id}/caregivers`, undefined, who))
          .statusCode,
      ).toBe(403);
    }
    const asOwner = await ok<PersonCaregivers>(
      call('GET', `/api/v1/members/${zain.member_id}/caregivers`, undefined, owner),
    );
    expect(asOwner.items.map((g) => g.caregiver_name)).toEqual(['Sara']);
    expect(asOwner.may_add).toBe(false);
    expect(asOwner.items[0]?.may_revoke).toBe(false);
  });

  it('Sara may not change, remove, share, collect, remind of or add to the paper', async () => {
    await fresh(sara);
    await refused(
      call('PATCH', `/api/v1/documents/${blood.id}`, { title: 'changed' }, sara),
      'edit',
    );
    await refused(
      call('PATCH', `/api/v1/documents/${blood.id}`, { visibility: 'household' }, sara),
      'visibility',
    );
    await refused(call('DELETE', `/api/v1/documents/${blood.id}`, undefined, sara), 'delete');
    await refused(
      call(
        'POST',
        `/api/v1/documents/${blood.id}/share`,
        { expires_in_days: 7, confirm_sensitive: true },
        sara,
      ),
      'share',
    );
    await refused(
      call('POST', '/api/v1/reminders', { document_id: blood.id, fire_at: '2031-01-01' }, sara),
      'reminder',
    );
    const up = await upload(sara, blood);
    expect(up.statusCode, up.body).toBeGreaterThanOrEqual(400);
    const coll = await ok<{ id: string }>(
      call('POST', '/api/v1/collections', { name: 'Sara’s', audience: 'only_me' }, sara),
      201,
    );
    await refused(
      call(
        'POST',
        `/api/v1/collections/${coll.id}/items`,
        { document_ids: [blood.id], confirm_sensitive: true },
        sara,
      ),
      'collection',
    );
    // Nor renew it, mark it needed again, remove it for good, stop its links,
    // or rename or remove its tag.
    await refused(
      call(
        'POST',
        `/api/v1/documents/${blood.id}/renewal`,
        { version_id: bloodVersion, expires: { date: '2031-01-01', precision: 'day' } },
        sara,
      ),
      'renewal',
    );
    await refused(
      call('DELETE', `/api/v1/documents/${blood.id}/no-longer-needed`, undefined, sara),
      'needed again',
    );
    await refused(call('POST', `/api/v1/documents/${blood.id}/purge`, undefined, sara), 'purge');
    await refused(
      call('POST', `/api/v1/documents/${blood.id}/stop-sharing`, undefined, sara),
      'stop sharing',
    );
    await call('POST', '/api/v1/tags/rename', { from: 'h1btag', to: 'sara-renamed' }, sara);
    await call('POST', '/api/v1/tags/delete', { tag: 'h1btag' }, sara);
    const still = await ok<DocumentView>(
      call('GET', `/api/v1/documents/${blood.id}`, undefined, zain),
    );
    expect(still.tags).toEqual(['h1btag']);
    expect(still.no_longer_needed?.reason).toBe('the course ended');
    expect(still.title).toBe(BLOOD);
    expect(still.visibility).toBe('private');
    const links = await admin.query<{ n: number }>(
      'select count(*)::int as n from share_link where document_id = $1',
      [blood.id],
    );
    expect(links.rows[0]?.n).toBe(0);
  });

  it('Zain reads who looked and when; the activity log says who was named, never a paper', async () => {
    const looks = await ok<{ items: CaregiverLook[] }>(
      call('GET', `/api/v1/members/${zain.member_id}/caregiver-views`, undefined, zain),
    );
    const actions = looks.items.map((l) => l.action);
    expect(actions).toContain('opened');
    expect(actions).toContain('downloaded');
    expect(looks.items.every((l) => l.caregiver_name === 'Sara')).toBe(true);
    expect(looks.items.every((l) => l.document_id === blood.id)).toBe(true);
    // A sensitive paper is never named.
    for (const l of looks.items) {
      if (l.sensitive) expect(l.title).toBeNull();
    }
    // An owner is told who looked, and when — never which Only me paper.
    const told = await ok<{ items: CaregiverLook[] }>(
      call('GET', `/api/v1/members/${zain.member_id}/caregiver-views`, undefined, owner),
    );
    expect(told.items.length).toBe(looks.items.length);
    for (const l of told.items) {
      expect(l).toMatchObject({
        caregiver_name: 'Sara',
        document_id: null,
        title: null,
        only_me: true,
      });
    }
    expect(JSON.stringify(told)).not.toContain(BLOOD);
    expect(JSON.stringify(told)).not.toContain(blood.id);
    const said = (await audit(owner)).map((l) => JSON.stringify(l));
    expect(said.some((l) => l.includes('let Sara see their medical papers'))).toBe(true);
    for (const l of said) expect(l).not.toContain(BLOOD);
    expect((await audit(rafi)).some((l) => JSON.stringify(l).includes('medical papers'))).toBe(
      false,
    );
    expect((await audit(sara)).some((l) => JSON.stringify(l).includes('let Sara see'))).toBe(true);
  });

  it('revoked: at once, and Sara reads nothing more', async () => {
    const mine = await ok<MyCaregivers>(call('GET', '/api/v1/caregivers', undefined, sara));
    expect(mine.for_others.map((g) => g.person_name)).toEqual(['Zain']);
    expect(mine.for_others[0]?.may_give_up).toBe(true);
    // Rafi is not given the grant at all: there is none to revoke.
    expect((await revoke(zain.member_id, sara.member_id, rafi)).statusCode).toBe(404);
    expect((await revoke(zain.member_id, sara.member_id, owner)).statusCode).toBe(403);
    expect((await revoke(zain.member_id, sara.member_id, zain)).statusCode).toBe(204);
    await refused(call('GET', `/api/v1/documents/${blood.id}`, undefined, sara), 'after revoke');
    await refused(
      call('GET', `/api/v1/versions/${bloodVersion}/content`, undefined, sara),
      'file after revoke',
    );
    expect(await titlesOf(sara)).not.toContain(BLOOD);
    expect((await revoke(zain.member_id, sara.member_id, zain)).statusCode).toBe(404);
    const said = (await audit(owner)).map((l) => JSON.stringify(l));
    expect(said.some((l) => l.includes('stopped Sara seeing their medical papers'))).toBe(true);
  });

  it('a caregiver gives it up themselves', async () => {
    await ok(name(zain, sara.member_id), 201);
    expect((await revoke(zain.member_id, sara.member_id, sara)).statusCode).toBe(204);
    await refused(call('GET', `/api/v1/documents/${blood.id}`, undefined, sara), 'given up');
  });

  it('two namings at once make one grant', async () => {
    const all = await Promise.all([1, 2, 3, 4].map(() => name(zain, rafi.member_id)));
    expect(all.every((r) => r.statusCode === 201)).toBe(true);
    const live = await admin.query<{ n: number }>(
      `select count(*)::int as n from caregiver_grant
        where person_member_id = $1 and caregiver_member_id = $2 and revoked_at is null`,
      [zain.member_id, rafi.member_id],
    );
    expect(live.rows[0]?.n).toBe(1);
    await ok(revoke(zain.member_id, rafi.member_id, zain), 204);
  });

  it('an owner names a caregiver for Omar, with no sign-in: kept only once Omar says so', async () => {
    const g = await ok<CaregiverGrantView>(
      call('POST', `/api/v1/members/${omar}/caregivers`, { caregiver_member_id: sara.member_id }),
      201,
    );
    expect(g.confirmed).toBe(false);
    expect(g.may_revoke).toBe(true);
    expect(g.may_keep).toBe(false);
    // An Only me paper of Omar's (left so by a sign-in taken away): not given.
    const left = (
      await admin.query<{ id: string }>(
        `insert into document (household_id, owner_member_id, type_key, visibility, title, category)
         values ($1, $2, 'medical_record', 'private', 'OMAR-ONLY-ME-H1B', 'medical') returning id`,
        [owner.household_id, omar],
      )
    ).rows[0]?.id as string;
    await refused(call('GET', `/api/v1/documents/${left}`, undefined, sara), 'unkept');
    // Nor does an owner naming themselves reach it.
    await ok(
      call('POST', `/api/v1/members/${omar}/caregivers`, { caregiver_member_id: owner.member_id }),
      201,
    );
    await refused(call('GET', `/api/v1/documents/${left}`, undefined, owner), 'owner, unkept');
    // Rafi may not keep it for Omar; nobody but Omar may.
    expect(
      (
        await call(
          'POST',
          `/api/v1/members/${omar}/caregivers/${sara.member_id}/keep`,
          undefined,
          owner,
        )
      ).statusCode,
    ).toBe(403);
    expect((await revoke(omar, sara.member_id, owner)).statusCode).toBe(204);
    expect((await revoke(omar, owner.member_id, owner)).statusCode).toBe(204);
  });

  // --------------------------------------------------------- turning 18

  it('turning 18 with a sign-in: asked once, and Only me makes every Medical paper the family sees Only me', async () => {
    // Zain turns 18 today on the family's calendar, with a paper the family sees.
    const today = new Date();
    const dob = `${today.getUTCFullYear() - 18}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    await admin.query(
      "update member set date_of_birth = $1, created_at = '2020-01-01' where id = $2",
      [dob, zain.member_id],
    );
    await admin.query("update household set timezone = 'UTC' where id = $1", [owner.household_id]);
    await ok(name(zain, sara.member_id), 201);
    // One the family can see, in the Trash: the family could bring it back as it was.
    const binned = await make(zain, {
      type_key: 'prescription',
      title: 'Old inhaler H1B',
      owner_member_id: zain.member_id,
      visibility: 'household',
    });
    await ok(call('DELETE', `/api/v1/documents/${binned.id}`, undefined, zain), 204);
    await withSystem(h.db, owner.household_id, (trx) =>
      askGrownUps(trx, owner.household_id, 'UTC', new Date()),
    );
    const asked = await ok<{ items: GrownUpQuestionView[] }>(
      call('GET', '/api/v1/grown-up/questions', undefined, zain),
    );
    expect(asked.items).toMatchObject([
      { member_id: zain.member_id, asks: 'self', title: GROWN_UP_QUESTION, papers: 2 },
    ]);
    // Nobody else is asked about him.
    for (const who of [owner, rafi, sara, tia]) {
      const theirs = await ok<{ items: GrownUpQuestionView[] }>(
        call('GET', '/api/v1/grown-up/questions', undefined, who),
      );
      expect(theirs.items.map((i) => i.member_id)).not.toContain(zain.member_id);
    }
    // Nothing changed until he answers; the owner may not answer for him.
    expect(
      (await ok<DocumentView>(call('GET', `/api/v1/documents/${family.id}`, undefined, rafi)))
        .visibility,
    ).toBe('household');
    expect(
      (
        await call(
          'POST',
          `/api/v1/members/${zain.member_id}/grown-up-answer`,
          { answer: 'keep' },
          owner,
        )
      ).statusCode,
    ).toBe(403);
    // Two answers at once (two tabs): one is the answer, the other told so.
    const both = await Promise.all(
      ['only_me', 'only_me'].map((answer) =>
        call('POST', `/api/v1/members/${zain.member_id}/grown-up-answer`, { answer }, zain),
      ),
    );
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const answered = both.find((r) => r.statusCode === 200) as LightMyRequestResponse;
    expect(json<{ answer: string; made_private: number }>(answered)).toEqual({
      answer: 'only_me',
      made_private: 2,
    });
    // Owners included, nobody else opens it now; his caregiver still reads it.
    for (const who of [owner, rafi, tia]) {
      await refused(call('GET', `/api/v1/documents/${family.id}`, undefined, who), 'made Only me');
    }
    const mineNow = await ok<DocumentView>(
      call('GET', `/api/v1/documents/${family.id}`, undefined, zain),
    );
    expect(mineNow.visibility).toBe('private');
    // The one in the Trash too: out of the family's Trash, and brought back Only me.
    const trash = await ok<{ items: DocumentView[] }>(
      call('GET', '/api/v1/documents?deleted=true&limit=200', undefined, owner),
    );
    expect(trash.items.map((d) => d.id)).not.toContain(binned.id);
    const binnedNow = await admin.query<{ visibility: string }>(
      'select visibility from document where id = $1',
      [binned.id],
    );
    expect(binnedNow.rows[0]?.visibility).toBe('private');
    const carer = await ok<DocumentView>(
      call('GET', `/api/v1/documents/${family.id}`, undefined, sara),
    );
    expect(carer.caregiver).toBe(true);
    // Final: a later answer is refused.
    expect(
      (
        await call(
          'POST',
          `/api/v1/members/${zain.member_id}/grown-up-answer`,
          { answer: 'keep' },
          zain,
        )
      ).statusCode,
    ).toBe(409);
    const after = await ok<{ items: GrownUpQuestionView[] }>(
      call('GET', '/api/v1/grown-up/questions', undefined, zain),
    );
    expect(after.items).toEqual([]);
    // Asked once: the vault's next look asks nothing.
    await withSystem(h.db, owner.household_id, (trx) =>
      askGrownUps(trx, owner.household_id, 'UTC', new Date()),
    );
    expect(
      (
        await ok<{ items: GrownUpQuestionView[] }>(
          call('GET', '/api/v1/grown-up/questions', undefined, zain),
        )
      ).items,
    ).toEqual([]);
    const said = (await audit(owner)).map((l) => JSON.stringify(l));
    expect(said.some((l) => l.includes('medical papers'))).toBe(true);
  });

  it('18 and still signing in as a teen: the question waits for their role; the owners are told so, and may not answer', async () => {
    const today = new Date();
    const dob = `${today.getUTCFullYear() - 18}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    await admin.query(
      "update member set date_of_birth = $1, created_at = '2020-01-01' where id = $2",
      [dob, tia.member_id],
    );
    await admin.query(
      `insert into document (household_id, owner_member_id, type_key, visibility, title, category)
       values ($1, $2, 'prescription', 'adults', 'Tia inhaler H1B', 'medical')`,
      [owner.household_id, tia.member_id],
    );
    await withSystem(h.db, owner.household_id, (trx) =>
      askGrownUps(trx, owner.household_id, 'UTC', new Date()),
    );
    const card = (
      await ok<{ items: GrownUpQuestionView[] }>(
        call('GET', '/api/v1/grown-up/questions', undefined, owner),
      )
    ).items.find((i) => i.member_id === tia.member_id);
    expect(card).toMatchObject({ asks: 'role_first' });
    expect(card?.title).toMatch(/still signs in as a teen/);
    // Not hers to answer as a teen, nor an owner's for her.
    expect(
      (
        await ok<{ items: GrownUpQuestionView[] }>(
          call('GET', '/api/v1/grown-up/questions', undefined, tia),
        )
      ).items,
    ).toEqual([]);
    expect(
      (
        await call(
          'POST',
          `/api/v1/members/${tia.member_id}/grown-up-answer`,
          { answer: 'keep' },
          tia,
        )
      ).statusCode,
    ).toBe(404);
    const byOwner = await call('POST', `/api/v1/members/${tia.member_id}/grown-up-answer`, {
      answer: 'keep',
    });
    expect(byOwner.statusCode, byOwner.body).toBe(403);
    expect(json<{ error: { code: string } }>(byOwner).error.code).toBe('ask_them_themselves');
  });

  it('turning 18 without a sign-in: the owners ask in person, and may only keep', async () => {
    const today = new Date();
    const dob = `${today.getUTCFullYear() - 18}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    await admin.query('update member set date_of_birth = $1 where id = $2', [dob, omar]);
    await admin.query(
      `insert into document (household_id, owner_member_id, type_key, visibility, title, category)
       values ($1, $2, 'prescription', 'adults', 'Omar inhaler H1B', 'medical')`,
      [owner.household_id, omar],
    );
    await withSystem(h.db, owner.household_id, (trx) =>
      askGrownUps(trx, owner.household_id, 'UTC', new Date()),
    );
    const asked = await ok<{ items: GrownUpQuestionView[] }>(
      call('GET', '/api/v1/grown-up/questions', undefined, owner),
    );
    const card = asked.items.find((i) => i.member_id === omar);
    expect(card).toMatchObject({ asks: 'in_person', display_name: 'Omar' });
    expect(card?.title).toMatch(/Omar is 18 today|Omar turned 18/);
    // Not an adult's to answer, nor a teen's.
    for (const who of [rafi, tia]) {
      expect(
        (
          await ok<{ items: GrownUpQuestionView[] }>(
            call('GET', '/api/v1/grown-up/questions', undefined, who),
          )
        ).items.map((i) => i.member_id),
      ).not.toContain(omar);
      expect(
        (await call('POST', `/api/v1/members/${omar}/grown-up-answer`, { answer: 'keep' }, who))
          .statusCode,
      ).toBe(404);
    }
    const onlyMe = await call('POST', `/api/v1/members/${omar}/grown-up-answer`, {
      answer: 'only_me',
    });
    expect(onlyMe.statusCode, onlyMe.body).toBe(403);
    expect(json<{ error: { code: string } }>(onlyMe).error.code).toBe('only_the_person');
    await ok(call('POST', `/api/v1/members/${omar}/grown-up-answer`, { answer: 'keep' }));
    const reminders = await admin.query<{ status: string }>(
      "select status from reminder where member_id = $1 and kind = 'turned_18'",
      [omar],
    );
    expect(reminders.rows.map((r) => r.status)).toEqual(['resolved']);
    expect(
      (await call('POST', `/api/v1/members/${omar}/grown-up-answer`, { answer: 'keep' }))
        .statusCode,
    ).toBe(409);
  });

  it('the mark says what it is', () => {
    expect(CAREGIVER_MARK).toBe('Shared with you as caregiver');
  });
});
