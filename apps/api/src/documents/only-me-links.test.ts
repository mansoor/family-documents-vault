import { randomUUID } from 'node:crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  ONLY_ME_KEEP_REFUSED,
  ONLY_ME_NOT_SHARED,
  type DocumentView,
  type LinksChoiceNeeded,
  type OnlyMeSharing,
  type SharedSession,
  type VisibilityChange,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { codeFor } from '../auth/totp.js';
import { createHarness, type Harness } from '../test-harness.js';
import type { CreatedShare, ShareView } from './shares.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/**
 * Only me documents and links outside the family (5.41; the owner's
 * decision of 6 Oct 2026): a choice when a document is made Only me — its
 * person's own links end, or are kept — and the household's rule, an
 * owner's, "Only me documents can be shared outside the family". And a
 * viewer's status never asks for where the original is kept.
 */
describe.skipIf(!testAdminUrl())('Only me documents and links outside the family (5.41)', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let olivia: Tokens;
  let ahmed: Tokens;
  let tariq: Tokens;
  let vera: Tokens;
  /** Another owner, with a password alone. */
  let peter: Tokens;
  let secret = '';

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const errorOf = (r: LightMyRequestResponse) =>
    json<{ error: { code: string; message: string; detail?: string; action?: string } }>(r).error;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.8.${Math.floor(++nth / 200)}.${nth % 200}` });
  const call = (
    who: Tokens,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    url: string,
    payload?: unknown,
  ) =>
    h.app.inject({
      method,
      url,
      headers: h.as(who),
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
  /** Their sessions, as if they had just given a code (or a password). */
  const fresh = (who: Tokens) =>
    admin.query(
      `update session set verified_at = now(), factor_verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)
          and revoked_at is null`,
      [who.member_id],
    );
  const stale = (who: Tokens) =>
    admin.query(
      `update session set verified_at = now() - interval '10 minutes',
              factor_verified_at = now() - interval '10 minutes'
        where account_id = (select account_id from account_household where member_id = $1)`,
      [who.member_id],
    );
  const accountOf = async (who: Tokens) =>
    (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [who.member_id],
      )
    ).rows[0]?.account_id as string;

  const make = async (who: Tokens, title: string) => {
    const created = await call(who, 'POST', '/api/v1/documents', {
      title,
      type_key: 'utility_bill',
      visibility: 'household',
      owner_member_id: who.member_id,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = json<DocumentView>(created).id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(up.statusCode, up.body).toBe(201);
    return id;
  };
  const share = async (who: Tokens, documentId: string, body: Record<string, unknown> = {}) => {
    await fresh(who);
    return call(who, 'POST', `/api/v1/documents/${documentId}/share`, body);
  };
  const shared = async (who: Tokens, documentId: string, body: Record<string, unknown> = {}) => {
    const r = await share(who, documentId, body);
    expect(r.statusCode, r.body).toBe(201);
    return json<CreatedShare>(r);
  };
  const opened = async (token: string, secret?: string) => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: secret === undefined ? { token } : { token, secret },
      ...peer(),
    });
    return { res, cookie: res.cookies.find((c) => c.name === 'fdv_share')?.value };
  };
  /** What a recipient's session is given now: its documents, or null when it gives nothing. */
  const given = async (cookie: string | undefined) => {
    const r = await h.app.inject({
      url: '/api/v1/shared/items',
      cookies: { fdv_share: cookie ?? '' },
      ...peer(),
    });
    return r.statusCode === 200 ? json<SharedSession>(r).items.map((i) => i.id) : null;
  };
  const content = (cookie: string | undefined, documentId: string) =>
    h.app.inject({
      url: `/api/v1/shared/items/${documentId}/content`,
      cookies: { fdv_share: cookie ?? '' },
      ...peer(),
    });
  const onlyMe = async (who: Tokens, documentId: string, ownLinks?: 'end' | 'keep') => {
    await fresh(who);
    return call(who, 'POST', `/api/v1/documents/${documentId}/visibility`, {
      visibility: 'private',
      ...(ownLinks ? { own_links: ownLinks } : {}),
    });
  };
  const rule = (who: Tokens, shareable: boolean) =>
    call(who, 'PUT', '/api/v1/household/sharing', { only_me_shareable: shareable });
  const told = (since: number, account: string) =>
    h.jobs
      .slice(since)
      .filter(
        (j) =>
          j.name === 'alert.send' &&
          (j.data.account_ids as string[] | undefined)?.includes(account) === true,
      )
      .map((j) => `${String(j.data.subject)} / ${String(j.data.body)}`);
  const activity = async (who: Tokens) => (await call(who, 'GET', '/api/v1/audit?limit=100')).body;

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    olivia = await h.setup();
    ahmed = await h.join(olivia, { name: 'Ahmed', email: 'ahmed-om@example.test', role: 'adult' });
    tariq = await h.join(olivia, { name: 'Tariq', email: 'tariq-om@example.test', role: 'teen' });
    vera = await h.join(olivia, { name: 'Vera', email: 'vera-om@example.test', role: 'viewer' });
    peter = await h.join(olivia, { name: 'Peter', email: 'peter-om@example.test', role: 'owner' });
    // Olivia has two-step sign-in, as an owner power asks.
    const enrol = await call(olivia, 'POST', '/api/v1/auth/totp/enrol');
    secret = json<{ secret: string }>(enrol).secret;
    const confirmed = await call(olivia, 'POST', '/api/v1/auth/totp/confirm', {
      code: codeFor(secret),
    });
    expect(confirmed.statusCode, confirmed.body).toBeLessThan(300);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('made Only me with links of one’s own, it asks first — which, never a token — and End ends them, and the notice says so', async () => {
    const deed = await make(ahmed, 'Flat deed');
    const other = await make(ahmed, 'Flat survey');
    const mine = await shared(ahmed, deed, {
      recipient_label: 'the attorney',
      with_password: true,
    });
    const theirs = await shared(olivia, deed, { recipient_label: 'the bank' });
    // A collection's link that ticked it, beside another of its documents.
    await fresh(ahmed);
    const made = await call(ahmed, 'POST', '/api/v1/collections', {
      name: 'Flat papers',
      audience: 'everyone',
    });
    expect(made.statusCode, made.body).toBe(201);
    const papers = json<{ id: string }>(made).id;
    const put = await call(ahmed, 'POST', `/api/v1/collections/${papers}/items`, {
      document_ids: [deed, other],
    });
    expect(put.statusCode, put.body).toBe(200);
    await fresh(ahmed);
    const sharedPapers = await call(ahmed, 'POST', `/api/v1/collections/${papers}/shares`, {
      document_ids: [deed, other],
      recipient_label: 'the surveyor',
    });
    expect(sharedPapers.statusCode, sharedPapers.body).toBe(201);
    const papersLink = json<CreatedShare>(sharedPapers);
    const attorney = await opened(mine.link_token, mine.password);
    const bank = await opened(theirs.link_token);
    const surveyor = await opened(papersLink.link_token);
    expect(await given(attorney.cookie)).toEqual([deed]);
    expect((await given(surveyor.cookie))?.sort()).toEqual([deed, other].sort());

    // Asked first: nothing changes yet.
    const asked = await onlyMe(ahmed, deed);
    expect(asked.statusCode, asked.body).toBe(409);
    const error = errorOf(asked);
    expect(error.code).toBe('links_choice_needed');
    const detail = JSON.parse(error.detail ?? '') as LinksChoiceNeeded;
    expect(detail).toMatchObject({ keep_allowed: true, others: 1 });
    expect(detail.links.map((l) => [l.kind, l.recipient_label, l.collection_name])).toEqual(
      expect.arrayContaining([
        ['document', 'the attorney', null],
        ['collection', 'the surveyor', 'Flat papers'],
      ]),
    );
    expect(detail.links).toHaveLength(2);
    expect(detail.links.find((l) => l.kind === 'document')?.protection).toEqual(['password']);
    for (const token of [mine.link_token, theirs.link_token, papersLink.link_token]) {
      expect(asked.body).not.toContain(token);
    }
    expect(
      json<DocumentView>(await call(ahmed, 'GET', `/api/v1/documents/${deed}`)).visibility,
    ).toBe('household');

    // End: his links end; the one Olivia made stops with it.
    const ended = await onlyMe(ahmed, deed, 'end');
    expect(ended.statusCode, ended.body).toBe(200);
    expect(json<VisibilityChange>(ended)).toEqual({
      notice: {
        title: 'Only you can open this. Your 2 links to it have ended.',
        body: expect.stringContaining('The link someone else made to it has stopped.') as string,
      },
      links: { yours: 2, yours_now: 'ended', others: 1 },
    });
    expect(await given(attorney.cookie)).toBeNull();
    expect(await given(bank.cookie)).toBeNull();
    // The collection's link gives the rest, and never the deed.
    expect(await given(surveyor.cookie)).toEqual([other]);
    expect((await content(surveyor.cookie, deed)).statusCode).toBe(404);
    const row = await admin.query<{ revoked: boolean }>(
      'select revoked_at is not null as revoked from share_link where id = $1',
      [mine.share.id],
    );
    expect(row.rows[0]).toEqual({ revoked: true });
    // What happened, as counts: never whom they were for, nor a token.
    const audit = await admin.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_event where action = 'document.visibility_changed'
        and object_id = $1 order by id desc limit 1`,
      [deed],
    );
    expect(audit.rows[0]?.detail).toMatchObject({
      to: 'private',
      links_ended: 2,
      links_others_stopped: 1,
    });
    expect(JSON.stringify(audit.rows[0]?.detail)).not.toMatch(/attorney|surveyor|bank/);
  });

  it('Keep keeps them: the people they are for can still open it, and the notice says who can', async () => {
    const will = await make(ahmed, 'Ahmed will');
    const link = await shared(ahmed, will, { recipient_label: 'the executor' });
    const executor = await opened(link.link_token);
    const kept = await onlyMe(ahmed, will, 'keep');
    expect(kept.statusCode, kept.body).toBe(200);
    expect(json<VisibilityChange>(kept)).toMatchObject({
      notice: { title: 'Only you, and the people your 1 link is for, can open this.' },
      links: { yours: 1, yours_now: 'kept', others: 0 },
    });
    expect(await given(executor.cookie)).toEqual([will]);
    expect((await content(executor.cookie, will)).statusCode).toBe(200);
    // Nobody in the family but him sees it.
    expect((await call(olivia, 'GET', `/api/v1/documents/${will}`)).statusCode).toBe(404);
    // And with no links of one's own, nothing is asked: as before.
    const plain = await make(ahmed, 'Ahmed payslip');
    expect((await onlyMe(ahmed, plain)).statusCode).toBe(200);
  });

  it("the household's rule: owners and adults read it; only an owner changes it, with a code, never a password", async () => {
    expect(json<OnlyMeSharing>(await call(ahmed, 'GET', '/api/v1/household/sharing'))).toEqual({
      only_me_shareable: true,
      can_change: false,
    });
    expect((await call(tariq, 'GET', '/api/v1/household/sharing')).statusCode).toBe(403);
    expect((await call(vera, 'GET', '/api/v1/household/sharing')).statusCode).toBe(403);
    const adult = await rule(ahmed, false);
    expect([adult.statusCode, errorOf(adult).code]).toEqual([403, 'forbidden']);
    const passwordOnly = await rule(peter, false);
    expect([passwordOnly.statusCode, errorOf(passwordOnly).code]).toEqual([
      403,
      'totp_required_for_owner',
    ]);
    await stale(olivia);
    const asked = await rule(olivia, false);
    expect(asked.statusCode).toBe(403);
    expect(errorOf(asked)).toMatchObject({ code: 'step_up_required', action: 'only_me_sharing' });
    expect(json<OnlyMeSharing>(await call(olivia, 'GET', '/api/v1/household/sharing'))).toEqual({
      only_me_shareable: true,
      can_change: true,
    });
  });

  it('turned off: every link that sends an Only me document pauses, its maker is told, nothing serves one, and nothing new is made; turned on: back', async () => {
    const diary = await make(ahmed, 'Ahmed diary');
    const link = await shared(ahmed, diary, { recipient_label: 'the doctor' });
    const kept = await onlyMe(ahmed, diary, 'keep');
    expect(kept.statusCode, kept.body).toBe(200);
    const doctor = await opened(link.link_token);
    expect(await given(doctor.cookie)).toEqual([diary]);
    const ahmedAccount = await accountOf(ahmed);

    const since = h.jobs.length;
    await fresh(olivia);
    const off = await rule(olivia, false);
    expect(off.statusCode, off.body).toBe(200);
    const answer = json<OnlyMeSharing>(off);
    // That it is off, and nothing of Ahmed's links (F3): how many other
    // people's links sent their Only me documents is not the owner's to learn.
    expect(answer).toEqual({ only_me_shareable: false, can_change: true });
    const audited = await admin.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_event where action = 'household.only_me_sharing_changed'
        order by id desc limit 1`,
    );
    expect(audited.rows[0]?.detail).toEqual({ only_me_shareable: false });
    // Ahmed is told of his own: the will kept in the test before, and the diary.
    expect(told(since, ahmedAccount)).toEqual([
      expect.stringContaining('Your links to Only me documents are paused') as string,
    ]);
    expect(told(since, ahmedAccount)[0]).toContain('Your 2 links that send one are paused');
    expect(await given(doctor.cookie)).toBeNull();
    // Paused, and why, to its maker.
    const links = json<{ items: ShareView[] }>(await call(ahmed, 'GET', '/api/v1/shares')).items;
    expect(links.find((l) => l.id === link.share.id)).toMatchObject({
      state: 'paused',
      paused_reason: 'only_me_not_shared',
    });
    // Nothing serves one, even were a pause missed.
    await admin.query(
      'update share_link set paused_at = null, paused_reason = null where id = $1',
      [link.share.id],
    );
    expect(await given(doctor.cookie)).toBeNull();
    expect((await content(doctor.cookie, diary)).statusCode).not.toBe(200);
    const again = await opened(link.link_token);
    expect(again.res.statusCode).not.toBe(200);
    await admin.query(
      `update share_link set paused_at = now(), paused_reason = 'only_me_not_shared' where id = $1`,
      [link.share.id],
    );
    // Nobody makes a new one, its owner included.
    const refused = await share(ahmed, diary);
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused)).toEqual({
      code: 'only_me_not_shared',
      message: ONLY_ME_NOT_SHARED,
      retriable: false,
      request_id: expect.any(String) as string,
    });
    // Nor a collection's link that ticks one.
    await fresh(ahmed);
    const box = json<{ id: string }>(
      await call(ahmed, 'POST', '/api/v1/collections', {
        name: 'Private box',
        audience: 'everyone',
      }),
    ).id;
    await call(ahmed, 'POST', `/api/v1/collections/${box}/items`, { document_ids: [diary] });
    await fresh(ahmed);
    const boxed = await call(ahmed, 'POST', `/api/v1/collections/${box}/shares`, {
      document_ids: [diary],
    });
    expect([boxed.statusCode, errorOf(boxed).code]).toEqual([409, 'only_me_not_shared']);
    // Keep is not offered, and not taken.
    const letter = await make(ahmed, 'Ahmed letter');
    await shared(ahmed, letter, { recipient_label: 'the landlord' });
    const asked = await onlyMe(ahmed, letter);
    expect(asked.statusCode).toBe(409);
    expect(JSON.parse(errorOf(asked).detail ?? '')).toMatchObject({ keep_allowed: false });
    const keep = await onlyMe(ahmed, letter, 'keep');
    expect(keep.statusCode).toBe(409);
    expect(errorOf(keep)).toMatchObject({
      code: 'only_me_not_shared',
      message: ONLY_ME_KEEP_REFUSED,
    });
    // The line: for the owners and the adults, notable; never the teens.
    // (The harness's owner, Olivia here, is called Owner.)
    const line = 'Owner turned off sharing Only me documents outside the family';
    expect(await activity(olivia)).toContain(line);
    expect(await activity(ahmed)).toContain(line);
    expect(await activity(ahmed)).not.toMatch(/outside the family \(/);
    expect(await activity(tariq)).not.toContain(line);

    // On again: the paused links work again; their maker is told.
    const before = h.jobs.length;
    await fresh(olivia);
    const on = await rule(olivia, true);
    expect(on.statusCode, on.body).toBe(200);
    expect(json<OnlyMeSharing>(on)).toEqual({ only_me_shareable: true, can_change: true });
    expect(told(before, ahmedAccount)[0]).toContain('Your links to Only me documents work again');
    const back = await opened(link.link_token);
    expect(back.res.statusCode, back.res.body).toBe(200);
    expect(await given(back.cookie)).toEqual([diary]);
    expect(await activity(ahmed)).toContain(
      'Owner turned on sharing Only me documents outside the family',
    );
  });

  it("a collection's link that ticked an Only me document gives it no more while the rule is off — whatever its row says — and the rest as before", async () => {
    const medical = await make(ahmed, 'Ahmed medical');
    const gym = await make(ahmed, 'Ahmed gym');
    await fresh(ahmed);
    const box = json<{ id: string }>(
      await call(ahmed, 'POST', '/api/v1/collections', { name: 'Health', audience: 'everyone' }),
    ).id;
    await call(ahmed, 'POST', `/api/v1/collections/${box}/items`, { document_ids: [medical, gym] });
    await fresh(ahmed);
    const made = await call(ahmed, 'POST', `/api/v1/collections/${box}/shares`, {
      document_ids: [medical, gym],
    });
    expect(made.statusCode, made.body).toBe(201);
    const link = json<CreatedShare>(made);
    expect((await onlyMe(ahmed, medical, 'keep')).statusCode).toBe(200);
    const coach = await opened(link.link_token);
    expect((await given(coach.cookie))?.sort()).toEqual([gym, medical].sort());
    /** What the database gives the link, asking as itself. */
    const asTheLink = async () => {
      const pool = createPool(h.appUrl, 1);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'link', true),
                  set_config('app.share_id', $2, true)`,
          [olivia.household_id, link.share.id],
        );
        const { rows } = await client.query<{ id: string }>(
          'select id from document where id = any($1) order by id',
          [[medical, gym]],
        );
        return rows.map((r) => r.id);
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
        await pool.end();
      }
    };
    expect((await asTheLink()).sort()).toEqual([gym, medical].sort());

    await fresh(olivia);
    expect((await rule(olivia, false)).statusCode).toBe(200);
    expect(await given(coach.cookie)).toBeNull();
    // Were its pause missed, the rest is given, and the Only me one never.
    await admin.query(
      'update share_link set paused_at = null, paused_reason = null where id = $1',
      [link.share.id],
    );
    // (The page open while it was paused ended with it: opened again.)
    const again = await opened(link.link_token);
    expect(again.res.statusCode, again.res.body).toBe(200);
    expect(await given(again.cookie)).toEqual([gym]);
    expect((await content(again.cookie, medical)).statusCode).toBe(404);
    expect(await asTheLink()).toEqual([gym]);
    await admin.query(
      `update share_link set paused_at = now(), paused_reason = 'only_me_not_shared' where id = $1`,
      [link.share.id],
    );
    await fresh(olivia);
    expect((await rule(olivia, true)).statusCode).toBe(200);
    const back = await opened(link.link_token);
    expect((await given(back.cookie))?.sort()).toEqual([gym, medical].sort());
  });

  /** Ahmed's collection of `documents`, and his link to it with every one ticked. */
  const collectionLink = async (name: string, documents: string[]) => {
    await fresh(ahmed);
    const made = await call(ahmed, 'POST', '/api/v1/collections', { name, audience: 'everyone' });
    expect(made.statusCode, made.body).toBe(201);
    const id = json<{ id: string }>(made).id;
    const put = await call(ahmed, 'POST', `/api/v1/collections/${id}/items`, {
      document_ids: documents,
    });
    expect(put.statusCode, put.body).toBe(200);
    await fresh(ahmed);
    const shared = await call(ahmed, 'POST', `/api/v1/collections/${id}/shares`, {
      document_ids: documents,
      recipient_label: `the ${name.toLowerCase()} people`,
    });
    expect(shared.statusCode, shared.body).toBe(201);
    return { id, link: json<CreatedShare>(shared) };
  };

  it('a collection’s link whose ticked document is out of the collection now is named, and ended: put back, it is never sent (F2)', async () => {
    const letter = await make(ahmed, 'Ahmed tenancy letter');
    const rates = await make(ahmed, 'Ahmed council tax');
    const flat = await collectionLink('Flat', [letter, rates]);
    // Out of the collection for now.
    await fresh(ahmed);
    const out = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${flat.id}/items/${letter}`,
      headers: h.as(ahmed),
    });
    expect(out.statusCode, out.body).toBeLessThan(300);
    // Asked about all the same: put back, it would go again.
    const asked = await onlyMe(ahmed, letter);
    expect(asked.statusCode, asked.body).toBe(409);
    expect(
      (JSON.parse(errorOf(asked).detail ?? '') as LinksChoiceNeeded).links.map((l) => [
        l.kind,
        l.collection_name,
      ]),
    ).toEqual([['collection', 'Flat']]);
    const ended = await onlyMe(ahmed, letter, 'end');
    expect(ended.statusCode, ended.body).toBe(200);
    expect(json<VisibilityChange>(ended).links).toEqual({
      yours: 1,
      yours_now: 'ended',
      others: 0,
    });
    // Put back in the collection: the link never sends it.
    await fresh(ahmed);
    const back = await call(ahmed, 'POST', `/api/v1/collections/${flat.id}/items`, {
      document_ids: [letter],
    });
    expect(back.statusCode, back.body).toBe(200);
    const reader = await opened(flat.link.link_token);
    expect(reader.res.statusCode, reader.res.body).toBe(200);
    expect(await given(reader.cookie)).toEqual([rates]);
    expect((await content(reader.cookie, letter)).statusCode).toBe(404);
  });

  it('a link the rule paused is asked about, and Keep refused, as a live one is: turned back on, it never sends what was ended (F1)', async () => {
    const scan = await make(ahmed, 'Ahmed clinic scan');
    const pass = await make(ahmed, 'Ahmed gym pass');
    const clinic = await collectionLink('Clinic', [scan, pass]);
    expect((await onlyMe(ahmed, scan, 'keep')).statusCode).toBe(200);
    await fresh(olivia);
    expect((await rule(olivia, false)).statusCode).toBe(200);
    // The link is paused by the rule: asked about all the same.
    const asked = await onlyMe(ahmed, pass);
    expect(asked.statusCode, asked.body).toBe(409);
    const detail = JSON.parse(errorOf(asked).detail ?? '') as LinksChoiceNeeded;
    expect(detail.keep_allowed).toBe(false);
    expect(detail.links.map((l) => l.id)).toEqual([clinic.link.share.id]);
    const keep = await onlyMe(ahmed, pass, 'keep');
    expect([keep.statusCode, errorOf(keep).code]).toEqual([409, 'only_me_not_shared']);
    expect((await onlyMe(ahmed, pass, 'end')).statusCode).toBe(200);
    // Turned back on: the scan he kept goes; the pass he ended never does.
    await fresh(olivia);
    expect((await rule(olivia, true)).statusCode).toBe(200);
    const reader = await opened(clinic.link.link_token);
    expect(reader.res.statusCode, reader.res.body).toBe(200);
    expect(await given(reader.cookie)).toEqual([scan]);
  });

  it("nobody signed in but an owner changes the household's rule, whatever they write (0061)", async () => {
    const asMember = async (who: Tokens, role: string) => {
      const pool = createPool(h.appUrl, 1);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.role', $2, true), set_config('app.account_id', $3, true),
                  set_config('app.member_id', $4, true)`,
          [olivia.household_id, role, await accountOf(who), who.member_id],
        );
        return await client
          .query('update household set only_me_shareable = not only_me_shareable where id = $1', [
            olivia.household_id,
          ])
          .then(
            (r) => r.rowCount,
            (e: { code?: string }) => e.code,
          );
      } finally {
        await client.query('rollback').catch(() => undefined);
        client.release();
        await pool.end();
      }
    };
    expect(await asMember(ahmed, 'adult')).toBe('42501');
    expect(await asMember(olivia, 'owner')).toBe(1);
  });

  it('a viewer is never told a document needs where the original is kept; an owner is', async () => {
    await fresh(olivia);
    const required = await call(olivia, 'PATCH', '/api/v1/document-types/utility_bill', {
      core: { physical_location: { required: true } },
    });
    expect(required.statusCode, required.body).toBe(200);
    const bill = await make(olivia, 'Water bill');
    const ownerSees = json<DocumentView>(await call(olivia, 'GET', `/api/v1/documents/${bill}`));
    expect(ownerSees.status.label).toBe('Needs an expiry date and where the original is');
    const viewerSees = await call(vera, 'GET', `/api/v1/documents/${bill}`);
    expect(viewerSees.statusCode, viewerSees.body).toBe(200);
    expect(json<DocumentView>(viewerSees).status.label).toBe('Needs an expiry date');
    expect(viewerSees.body).not.toContain('where the original');
    // Nor in a search.
    const found = await call(vera, 'GET', '/api/v1/search?q=Water');
    expect(found.statusCode, found.body).toBe(200);
    expect(found.body).toContain(bill);
    expect(found.body).not.toContain('where the original');
  });
});
