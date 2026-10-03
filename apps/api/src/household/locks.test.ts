import { randomUUID } from 'node:crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  refusalFor,
  type ActivityLine,
  type DocumentView,
  type MemberAccount,
  type MemberSuspension,
  type PausedSignIn,
} from '@fdv/shared';
import FormData from 'form-data';
import type { LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SoftwareAuthenticator } from '../auth/passkey-test-authenticator.js';
import type { Tokens } from '../auth/service.js';
import { codeFor } from '../auth/totp.js';
import type { CreatedShare, ShareView } from '../documents/shares.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * Locking a sign-in (5.28, A50–A52, A54).
 *
 * An owner with two-step sign-in locks somebody else's sign-in, never an
 * owner's: their sessions end, their phone is told, what they lent outside
 * pauses (or ends for good), a waiting widening of who sees identity
 * details is withdrawn, and they cannot sign in — told so only once their
 * credentials are proven. A lock may end by itself.
 */

const json = <T>(r: { json: () => unknown }) => r.json() as T;
type Res = LightMyRequestResponse;
const error = (r: Res) =>
  json<{ error: { code: string; message: string; action?: string; reason?: string } }>(r).error;

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const PASSWORD = 'another correct horse';

describe.skipIf(!testAdminUrl())('locking a sign-in (5.28)', () => {
  let h: Harness;
  let owner: Tokens;
  let coOwner: Tokens & { email: string; name: string };
  let coOwnerAccount = '';
  let teen: Tokens;
  let viewer: Tokens;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.28.${Math.floor(++nth / 200)}.${nth % 200}` });

  const accountOf = async (t: Tokens) =>
    (
      await withSystem(h.db, t.household_id, (trx) =>
        trx
          .selectFrom('account_household')
          .select('account_id')
          .where('member_id', '=', t.member_id)
          .executeTakeFirstOrThrow(),
      )
    ).account_id;
  /** Their sessions just saw a passkey or a code: the owner powers ask no more for five minutes. */
  const fresh = async (t: Tokens) => {
    const account = await accountOf(t);
    await withSystem(h.db, t.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(), factor_verified_at: new Date() })
        .where('account_id', '=', account)
        .execute(),
    );
  };
  /** Their sessions saw nothing lately: asked again. */
  const stale = async (t: Tokens) => {
    const account = await accountOf(t);
    const then = new Date(Date.now() - 10 * 60 * 1000);
    await withSystem(h.db, t.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: then, factor_verified_at: then })
        .where('account_id', '=', account)
        .execute(),
    );
  };
  const person = async (role: 'adult' | 'teen' | 'viewer', name = `P${++nth}`) => {
    await fresh(owner);
    const email = `${name.toLowerCase().replace(/\W/g, '')}-${randomUUID().slice(0, 8)}@example.test`;
    const t = await h.join(owner, { name, email, role });
    return { ...t, email, name };
  };
  const lock = (who: Tokens, target: { member_id: string }, body: Record<string, unknown> = {}) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${target.member_id}/lock`,
      headers: h.as(who),
      payload: body,
    });
  const unlock = (who: Tokens, target: { member_id: string }) =>
    h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${target.member_id}/lock`,
      headers: h.as(who),
    });
  const resume = (who: Tokens, target: { member_id: string }) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${target.member_id}/resume`,
      headers: h.as(who),
    });
  const card = async (target: { member_id: string }) => {
    await fresh(owner);
    const r = await h.app.inject({
      url: `/api/v1/members/${target.member_id}/account`,
      headers: h.as(owner),
    });
    expect(r.statusCode, r.body).toBe(200);
    return json<MemberAccount>(r);
  };
  const signIn = (email: string, password = PASSWORD, installation?: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email, password },
      ...(installation ? { headers: { 'x-fdv-installation': installation } } : {}),
      ...peer(),
    });
  const members = (who: Tokens) => h.app.inject({ url: '/api/v1/members', headers: h.as(who) });
  const activity = async (who: Tokens) =>
    json<{ items: ActivityLine[] }>(
      await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(who) }),
    ).items;
  const stepUp = (who: Tokens, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url: '/api/v1/auth/step-up', headers: h.as(who), payload });
  const enrolTotp = async (t: Tokens) => {
    await fresh(t);
    const enrol = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enrol',
      headers: h.as(t),
    });
    const s = json<{ secret: string }>(enrol).secret;
    const confirm = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/confirm',
      headers: h.as(t),
      payload: { code: codeFor(s) },
    });
    expect(confirm.statusCode, confirm.body).toBe(204);
    return s;
  };
  /** A document of theirs, with a file, everybody's to see. */
  const document = async (who: Tokens, title: string) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(who),
      payload: { title, type_key: 'utility_bill', visibility: 'household' },
    });
    const id = json<DocumentView>(created).id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    const v = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(v.statusCode, v.body).toBeLessThan(300);
    return id;
  };
  const shareDoc = async (who: Tokens, documentId: string) => {
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/share`,
      headers: h.as(who),
      payload: {},
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<CreatedShare>(r);
  };
  const preview = (token: string) =>
    h.app.inject({ method: 'POST', url: '/api/v1/shared/preview', payload: { token }, ...peer() });
  const openLink = async (token: string) => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token },
      ...peer(),
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.cookies.find((c) => c.name === 'fdv_share')?.value as string;
  };
  const items = (cookie: string) =>
    h.app.inject({ url: '/api/v1/shared/items', cookies: { fdv_share: cookie }, ...peer() });
  const askFor = async (who: Tokens, review: 'me' | 'adults' = 'me') => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/upload-requests',
      headers: h.as(who),
      payload: {
        title: 'Your payslips',
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        review_by: review,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<{ request: { id: string }; link_token: string }>(r);
  };
  const dropPreview = (token: string) =>
    h.app.inject({ method: 'POST', url: '/api/v1/drop/preview', payload: { token }, ...peer() });
  const links = async (who: Tokens) =>
    json<{ items: ShareView[] }>(await h.app.inject({ url: '/api/v1/shares', headers: h.as(who) }))
      .items;
  const jobsNamed = (name: string) => h.jobs.filter((j) => j.name === name).map((j) => j.data);

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000 });
    owner = await h.setup();
    await enrolTotp(owner);
    teen = await person('teen', 'Tariq');
    viewer = await person('viewer', 'Accountant');
    // A second owner, with only a password.
    coOwner = await person('adult', 'Zainab');
    await fresh(owner);
    const promoted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${coOwner.member_id}/role`,
      headers: h.as(owner),
      payload: { role: 'owner' },
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    coOwnerAccount = await accountOf(coOwner);
  }, 120_000);
  afterAll(() => h.close());

  it("a locked adult's sessions end and their phone is told", async () => {
    const sara = await person('adult', 'Sara');
    // Her phone: a session of its own, and its UnifiedPush address.
    const installation = randomUUID();
    const phone = json<Tokens>(await signIn(sara.email, PASSWORD, installation));
    const endpoint = `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`;
    const registered = await h.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { ...h.as(phone), 'x-fdv-installation': installation },
      payload: { kind: 'unified_push', endpoint, keys: { p256dh: 'k', auth: 'a' } },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    expect((await members(sara)).statusCode).toBe(200);

    await fresh(owner);
    const locked = await lock(owner, sara, { note: 'Lost her phone on the train' });
    expect(locked.statusCode, locked.body).toBe(200);
    expect(json<{ member_id: string; suspension: MemberSuspension }>(locked)).toMatchObject({
      member_id: sara.member_id,
      suspension: {
        reason: 'locked',
        until: null,
        note: 'Lost her phone on the train',
        by: 'Owner',
      },
    });

    // Every session of hers: the next request, and the next refresh, say why.
    for (const t of [sara, phone]) {
      const r = await members(t);
      expect(r.statusCode).toBe(401);
      expect(error(r)).toMatchObject({ code: 'session_ended', reason: 'suspended' });
      const refreshed = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refresh_token: t.refresh_token },
        ...(t === phone ? { headers: { 'x-fdv-installation': installation } } : {}),
        ...peer(),
      });
      expect(refreshed.statusCode).toBe(401);
      expect(error(refreshed)).toMatchObject({ code: 'session_ended', reason: 'suspended' });
    }
    // Her phone is told, once it committed, and nothing more is pushed to it.
    const told = jobsNamed('push.send').filter((d) =>
      (d.targets as Array<{ endpoint: string }>).some((t) => t.endpoint === endpoint),
    );
    expect(told.map((d) => d.message)).toEqual([{ v: 1, type: 'session_ended' }]);
    const devices = await withSystem(h.db, owner.household_id, (trx) =>
      trx.selectFrom('device').select('id').where('endpoint', '=', endpoint).execute(),
    );
    expect(devices).toEqual([]);
    // She is emailed, as her sign-in is locked — never the note — and the
    // other owner is told.
    const saraAccount = await accountOf(sara);
    const alerts = jobsNamed('alert.send') as Array<{
      account_ids: string[];
      subject: string;
      body: string;
      email_only?: boolean;
      own_sign_in?: boolean;
    }>;
    const toHer = alerts.filter((a) => a.account_ids.includes(saraAccount));
    expect(toHer.at(-1)).toMatchObject({
      subject: 'Your sign-in to The Test family is locked',
      email_only: true,
      own_sign_in: true,
    });
    expect(toHer.at(-1)?.body).not.toContain('train');
    const toCoOwner = alerts.filter((a) => a.account_ids.includes(coOwnerAccount));
    expect(toCoOwner.at(-1)?.subject).toBe("Owner locked Sara's sign-in");
    // The card says so, to an owner.
    expect((await card(sara)).suspension).toMatchObject({
      reason: 'locked',
      note: 'Lost her phone on the train',
      by: 'Owner',
    });
    await fresh(owner);
    expect((await unlock(owner, sara)).statusCode).toBe(204);
    expect((await signIn(sara.email)).statusCode).toBe(200);
  });

  it("their links pause and come back on unlock; with end_links they don't", async () => {
    const amal = await person('adult', 'Amal');
    const doc = await document(amal, 'Gas bill');
    const link = await shareDoc(amal, doc);
    const asked = await askFor(amal, 'adults');
    expect((await preview(link.link_token)).statusCode).toBe(200);
    expect((await dropPreview(asked.link_token)).statusCode).toBe(200);

    await fresh(owner);
    expect((await lock(owner, amal)).statusCode).toBe(200);
    // Nobody outside is told why: a link that is not valid, as any other.
    for (const r of [await preview(link.link_token), await dropPreview(asked.link_token)]) {
      expect(r.statusCode).toBe(404);
      expect(error(r).code).toBe('link_not_valid');
    }
    // The family's list says it is paused, by the lock — not the restore's
    // to turn back on.
    const listed = (await links(owner)).find((l) => l.id === link.share.id);
    expect(listed).toMatchObject({ state: 'paused', paused_reason: 'locked' });
    expect(listed?.summary).toMatch(/Paused while the sign-in of whoever made it is locked/);
    const waiting = json<{ links: ShareView[]; upload_requests: Array<{ id: string }> }>(
      await h.app.inject({ url: '/api/v1/after-restore', headers: h.as(owner) }),
    );
    expect(waiting.links.map((l) => l.id)).not.toContain(link.share.id);
    expect(waiting.upload_requests.map((r) => r.id)).not.toContain(asked.request.id);
    // Nor is it an owner's to turn on: it comes back with the unlock.
    await fresh(owner);
    const resumed = await h.app.inject({
      method: 'POST',
      url: `/api/v1/shares/${link.share.id}/resume`,
      headers: h.as(owner),
    });
    expect(resumed.statusCode).toBe(404);
    const requests = json<{ items: Array<{ id: string; state: string; paused_reason: string }> }>(
      await h.app.inject({ url: '/api/v1/upload-requests', headers: h.as(owner) }),
    ).items;
    expect(requests.find((r) => r.id === asked.request.id)).toMatchObject({
      state: 'paused',
      paused_reason: 'locked',
    });

    await fresh(owner);
    expect((await unlock(owner, amal)).statusCode).toBe(204);
    expect((await preview(link.link_token)).statusCode).toBe(200);
    expect((await dropPreview(asked.link_token)).statusCode).toBe(200);
    expect((await links(owner)).find((l) => l.id === link.share.id)?.state).toBe('active');

    // For good, this time: taken back, and they stay so after the unlock.
    await fresh(owner);
    const ended = await lock(owner, amal, { end_links: true });
    expect(ended.statusCode, ended.body).toBe(200);
    expect((await links(owner)).find((l) => l.id === link.share.id)?.state).toBe('revoked');
    // Each written down as taken back, by the owner, for whoever knows of it.
    const takenBack = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action', 'detail'])
        .where('action', 'in', ['share.revoked', 'upload_request.revoked'])
        .execute(),
    );
    expect(takenBack.map((l) => l.action).sort()).toEqual([
      'share.revoked',
      'upload_request.revoked',
    ]);
    await fresh(owner);
    expect((await unlock(owner, amal)).statusCode).toBe(204);
    expect((await preview(link.link_token)).statusCode).toBe(404);
    expect((await dropPreview(asked.link_token)).statusCode).toBe(404);
    // Her own request, review-by-me, which no owner can see, ends too. (She
    // signs in again first: her old session ended with the lock.)
    const back = json<Tokens>(await signIn(amal.email));
    const own = await askFor(back, 'me');
    await fresh(owner);
    expect((await lock(owner, amal, { end_links: true })).statusCode).toBe(200);
    await fresh(owner);
    expect((await unlock(owner, amal)).statusCode).toBe(204);
    expect((await dropPreview(own.link_token)).statusCode).toBe(404);
    const again = json<Tokens>(await signIn(amal.email));
    const hers = json<{ items: Array<{ id: string; state: string }> }>(
      await h.app.inject({ url: '/api/v1/upload-requests', headers: h.as(again) }),
    ).items;
    expect(hers.find((r) => r.id === own.request.id)?.state).toBe('revoked');
  });

  it("locking the sharer ends a recipient's open session at its next request", async () => {
    const bilal = await person('adult', 'Bilal');
    const doc = await document(bilal, 'Water bill');
    const link = await shareDoc(bilal, doc);
    const cookie = await openLink(link.link_token);
    expect((await items(cookie)).statusCode).toBe(200);
    // And a collection of his, shared (5.19), open as well.
    const made = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(bilal),
      payload: { name: 'For the accountant', audience: 'adults' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const collection = json<{ id: string }>(made).id;
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${collection}/items`,
      headers: h.as(bilal),
      payload: { document_ids: [doc] },
    });
    await fresh(bilal);
    const shared = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${collection}/shares`,
      headers: h.as(bilal),
      payload: { document_ids: [doc] },
    });
    expect(shared.statusCode, shared.body).toBe(201);
    const listCookie = await openLink(json<CreatedShare>(shared).link_token);
    expect((await items(listCookie)).statusCode).toBe(200);

    await fresh(owner);
    expect((await lock(owner, bilal)).statusCode).toBe(200);
    for (const c of [cookie, listCookie]) {
      // Its next request: the link is gone, and the session with it.
      const next = await items(c);
      expect(next.statusCode).toBe(404);
      expect(error(next).code).toBe('link_not_valid');
      const after = await items(c);
      expect(after.statusCode).toBe(401);
      expect(error(after).code).toBe('share_session_ended');
    }
    // The database holds it too: as the link itself, nothing of its share.
    const asLink = await withSystem(h.db, owner.household_id, async (trx) => {
      await sql`select set_config('app.actor', 'link', true),
                       set_config('app.share_id', ${link.share.id}, true)`.execute(trx);
      return (await sql<{ id: string | null }>`select app_live_share() as id`.execute(trx)).rows[0]
        ?.id;
    });
    expect(asLink).toBeNull();
    await fresh(owner);
    expect((await unlock(owner, bilal)).statusCode).toBe(204);
    expect((await items(await openLink(link.link_token))).statusCode).toBe(200);
  });

  it("a locked requester's drop link answers 404, and their pending files move to the owners", async () => {
    const rana = await person('adult', 'Rana');
    const asked = await askFor(rana, 'me');
    // Somebody outside opens it, sends a file and presses Finish; and opens it
    // again, to send more.
    const open = async () => {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/v1/drop/unlock',
        payload: { token: asked.link_token },
        ...peer(),
      });
      expect(r.statusCode, r.body).toBe(200);
      const set = r.cookies.find((c) => c.name.startsWith('fdv_drop_s_'));
      return { [set?.name as string]: set?.value as string };
    };
    const cookie = await open();
    const form = new FormData();
    form.append('file', PDF, { filename: 'P60.pdf', contentType: 'application/pdf' });
    const sent = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/files',
      headers: form.getHeaders(),
      cookies: cookie,
      payload: form.getBuffer(),
      ...peer(),
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const finished = await h.app.inject({
      method: 'POST',
      url: '/api/v1/drop/finish',
      cookies: cookie,
      payload: {},
      ...peer(),
    });
    expect(finished.statusCode, finished.body).toBe(200);
    const again = await open();
    const moves = jobsNamed('incoming.move').length;

    await fresh(owner);
    expect((await lock(owner, rana)).statusCode).toBe(200);
    // The link answers as any that has stopped, and the page open with it
    // stops at its next request.
    const gone = await dropPreview(asked.link_token);
    expect(gone.statusCode).toBe(404);
    expect(error(gone).code).toBe('link_not_valid');
    const next = await h.app.inject({ url: '/api/v1/drop/session', cookies: again, ...peer() });
    expect(next.statusCode).toBeGreaterThanOrEqual(400);
    // What she alone was to review goes to the owners: the worker is asked,
    // once the lock has committed (jobs/incoming.ts moveIncoming does it).
    const queued = jobsNamed('incoming.move');
    expect(queued.length).toBe(moves + 1);
    expect(queued.at(-1)).toEqual({ household_id: owner.household_id });
    await fresh(owner);
    expect((await unlock(owner, rana)).statusCode).toBe(204);
  });

  it('locking anyone during a pending widening withdraws it, and a widening is refused while anyone is locked', async () => {
    const widen = async (audience: string) => {
      await fresh(owner);
      return h.app.inject({
        method: 'PUT',
        url: '/api/v1/household/identity-audience',
        headers: h.as(owner),
        payload: { audience },
      });
    };
    const pending = async () =>
      json<{ pending: { to: string } | null }>(
        await h.app.inject({ url: '/api/v1/household/identity-audience', headers: h.as(owner) }),
      ).pending;
    const omar = await person('adult', 'Omar');
    const yusuf = await person('teen', 'Yusuf');
    for (const target of [omar, yusuf]) {
      expect((await widen('adults')).statusCode).toBe(200);
      expect(await pending()).toMatchObject({ to: 'adults' });
      const withdrawnLines = async () =>
        (await activity(owner)).filter((l) =>
          l.text.startsWith('Owner withdrew letting all adults see identity details'),
        ).length;
      const before = await withdrawnLines();
      await fresh(owner);
      const locked = await lock(owner, target);
      expect(locked.statusCode, locked.body).toBe(200);
      // Withdrawn: they could neither be told nor mark anything Only me,
      // and everybody it told reads that it was.
      expect(await pending()).toBeNull();
      expect(await withdrawnLines()).toBe(before + 1);
      // And while they are locked, refused, naming them.
      const refused = await widen('family');
      expect(refused.statusCode).toBe(409);
      expect(error(refused).code).toBe('member_cannot_be_told');
      expect(error(refused).message).toContain(target.name);
      await fresh(owner);
      expect((await unlock(owner, target)).statusCode).toBe(204);
      expect((await widen('adults')).statusCode).toBe(200);
      expect(await pending()).toMatchObject({ to: 'adults' });
      expect((await widen('owners_and_self')).statusCode).toBe(200);
    }
  });

  it('a password-only owner is refused a lock, and step-up by password is refused', async () => {
    const hana = await person('adult', 'Hana');
    // A fresh session, just signed in with a password: refused all the same.
    const signedIn = json<Tokens>(await signIn(coOwner.email, PASSWORD));
    for (const r of [
      await lock(signedIn, hana),
      await unlock(signedIn, hana),
      await resume(signedIn, hana),
    ]) {
      expect(r.statusCode).toBe(403);
      expect(error(r)).toMatchObject({
        code: 'totp_required_for_owner',
        message: "Turn on two-step sign-in to manage other people's sign-ins.",
      });
    }
    // Two-step sign-in on: asked for a code, and a password does not do.
    const s = await enrolTotp(signedIn);
    await stale(signedIn);
    const asked = await lock(signedIn, hana);
    expect(error(asked)).toMatchObject({ code: 'step_up_required', action: 'manage_sign_ins' });
    expect((await stepUp(signedIn, { password: PASSWORD })).statusCode).toBe(200);
    expect(error(await lock(signedIn, hana))).toMatchObject({
      code: 'step_up_required',
      action: 'manage_sign_ins',
    });
    expect((await stepUp(signedIn, { code: codeFor(s) })).statusCode).toBe(200);
    expect((await lock(signedIn, hana)).statusCode).toBe(200);
    expect((await unlock(signedIn, hana)).statusCode).toBe(204);
  });

  it('locking an owner is refused, and only an owner locks, never themselves', async () => {
    await fresh(owner);
    const r = await lock(owner, coOwner);
    expect(r.statusCode).toBe(409);
    expect(error(r).code).toBe('owner_notice_required');
    expect(error(r).message).toMatch(/^Zainab is an owner/);
    const self = await lock(owner, owner);
    expect(self.statusCode).toBe(422);
    expect(error(self).message).toBe('You cannot lock your own sign-in.');
    // Anybody else is refused in the matrix's words.
    const adult = await person('adult', 'Imran');
    for (const who of [adult, teen, viewer]) {
      const refused = await lock(who, coOwner);
      expect(refused.statusCode).toBe(403);
      expect(error(refused)).toMatchObject({
        code: 'forbidden',
        message: refusalFor('member.suspend'),
      });
    }
    // Nobody with a sign-in, or nobody at all.
    const added = await h.app.inject({
      method: 'POST',
      url: '/api/v1/members',
      headers: h.as(owner),
      payload: { display_name: 'Baby Noor' },
    });
    for (const id of [json<{ id: string }>(added).id, randomUUID()]) {
      const none = await lock(owner, { member_id: id });
      expect(none.statusCode).toBe(404);
      expect(error(none).message).toBe('They have no sign-in to lock.');
    }
    // The database holds it too: an owner signed in, as the application
    // role, locks no owner (A50) and not themselves; an adult locks nobody.
    const asCaller = async (role: string, accountId: string, memberId: string, target: string) => {
      const pool = createPool(h.appUrl, 1);
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.role', $2, true), set_config('app.account_id', $3, true),
                  set_config('app.member_id', $4, true)`,
          [owner.household_id, role, accountId, memberId],
        );
        await c.query(
          `update account_household set suspended_at = now(), suspend_reason = 'locked'
            where member_id = $1`,
          [target],
        );
        await c.query('commit');
        return 'committed';
      } catch (err) {
        await c.query('rollback').catch(() => undefined);
        return (err as { code?: string }).code ?? 'error';
      } finally {
        c.release();
        await pool.end();
      }
    };
    const ownerAccount = await accountOf(owner);
    expect(await asCaller('owner', ownerAccount, owner.member_id, coOwner.member_id)).toBe('42501');
    expect(await asCaller('owner', ownerAccount, owner.member_id, owner.member_id)).toBe('42501');
    expect(await asCaller('adult', await accountOf(adult), adult.member_id, teen.member_id)).toBe(
      '42501',
    );
  });

  it("the last usable owner can't be locked by any path", async () => {
    // Through the API: never an owner (above). As the vault itself, or as the
    // owning role that a restore writes with, the floor judges at commit.
    const pool = createPool(h.adminUrl, 1);
    const asVault = async (actor: 'system' | null, sqlText: string, args: unknown[]) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        if (actor) {
          await c.query(
            `select set_config('app.household_id', $1, true), set_config('app.actor', $2, true)`,
            [owner.household_id, actor],
          );
        }
        await c.query(sqlText, args);
        await c.query('commit');
        return 'committed';
      } catch (err) {
        await c.query('rollback').catch(() => undefined);
        return (err as { code?: string }).code ?? 'error';
      } finally {
        c.release();
      }
    };
    const suspend = `update account_household set suspended_at = now(), suspend_reason = 'locked'
                      where member_id = $1`;
    const lift = `update account_household
                     set suspended_at = null, suspended_by = null, suspended_until = null,
                         suspend_reason = null, suspend_note = null
                   where member_id = $1`;
    try {
      // Both owners at once: refused, whoever asks.
      for (const actor of ['system', null] as const) {
        expect(
          await asVault(
            actor,
            `update account_household set suspended_at = now(), suspend_reason = 'locked'
              where role = 'owner'`,
            [],
          ),
        ).toBe('23514');
      }
      // One of two: the other can still sign in, so the floor lets it be…
      expect(await asVault('system', suspend, [coOwner.member_id])).toBe('committed');
      // … and then the other is the last: not suspended, by any path …
      expect(await asVault('system', suspend, [owner.member_id])).toBe('23514');
      expect(await asVault(null, suspend, [owner.member_id])).toBe('23514');
      // … nor stepped down to an adult, which would leave none who can sign in.
      expect(
        await asVault(
          'system',
          `update account_household set role = 'adult' where member_id = $1`,
          [owner.member_id],
        ),
      ).toBe('23514');
      // A lock past its end is over: the floor counts that owner again.
      expect(
        await asVault(
          'system',
          `update account_household set suspended_at = now() - interval '2 hours',
                  suspended_until = now() - interval '1 hour' where member_id = $1`,
          [coOwner.member_id],
        ),
      ).toBe('committed');
      expect(await asVault('system', suspend, [owner.member_id])).toBe('committed');
      expect(await asVault('system', lift, [owner.member_id])).toBe('committed');
    } finally {
      await asVault('system', lift, [coOwner.member_id]);
      await asVault('system', lift, [owner.member_id]);
      await pool.end();
    }
  });

  it("a locked person's passkey sign-in is refused after the passkey is proven; a password the same, and nothing is said before", async () => {
    const dina = await person('adult', 'Dina');
    const device = new SoftwareAuthenticator();
    await fresh(dina);
    const options = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/challenge',
      headers: h.as(dina),
    });
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys',
      headers: h.as(dina),
      payload: { response: device.register(options.json()), label: 'Phone' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const withPasskey = async (d: SoftwareAuthenticator) => {
      const challenge = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/challenge',
        payload: { email: dina.email },
        ...peer(),
      });
      return h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/verify',
        payload: { response: d.authenticate(challenge.json()) },
        ...peer(),
      });
    };
    expect((await withPasskey(device)).statusCode).toBe(200);

    await fresh(owner);
    const until = new Date(Date.now() + 3 * 864e5);
    expect((await lock(owner, dina, { until: until.toISOString() })).statusCode).toBe(200);
    // A passkey that is not hers proves nothing, and is told nothing of the lock.
    const stranger = await withPasskey(new SoftwareAuthenticator());
    expect(stranger.statusCode).toBe(401);
    expect(error(stranger).code).toBe('passkey_rejected');
    // Hers: proven, then refused, saying until when.
    const refused = await withPasskey(device);
    expect(refused.statusCode).toBe(403);
    expect(error(refused)).toMatchObject({ code: 'membership_suspended', reason: 'locked' });
    expect(error(refused).message).toMatch(/^An owner has locked your sign-in until /);
    // A wrong password is the ordinary refusal; the right one, this.
    const wrong = await signIn(dina.email, 'not her password at all');
    expect(wrong.statusCode).toBe(401);
    expect(error(wrong).code).toBe('invalid_credentials');
    const right = await signIn(dina.email);
    expect(right.statusCode).toBe(403);
    expect(error(right).code).toBe('membership_suspended');
    // With two-step sign-in: the password asks for the code as ever, and
    // the refusal comes once the code is right.
    await fresh(owner);
    expect((await unlock(owner, dina)).statusCode).toBe(204);
    const back = json<Tokens>(await signIn(dina.email));
    const s = await enrolTotp(back);
    await fresh(owner);
    expect((await lock(owner, dina)).statusCode).toBe(200);
    const first = await signIn(dina.email);
    expect(first.statusCode).toBe(200);
    const token = json<{ mfa_required: boolean; mfa_token: string }>(first);
    expect(token.mfa_required).toBe(true);
    const badCode = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa',
      payload: { mfa_token: token.mfa_token, code: '000000' },
      ...peer(),
    });
    expect(error(badCode).code).toBe('totp_invalid');
    const mfa = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa',
      payload: { mfa_token: token.mfa_token, code: codeFor(s) },
      ...peer(),
    });
    expect(mfa.statusCode).toBe(403);
    expect(error(mfa)).toMatchObject({
      code: 'membership_suspended',
      reason: 'locked',
      message: 'An owner has locked your sign-in. Ask one of them if you need to get in.',
    });
    // Nothing was opened, and nothing written of a sign-in.
    const sessions = await withSystem(h.db, owner.household_id, async (trx) =>
      trx
        .selectFrom('session')
        .select('id')
        .where('account_id', '=', await accountOf(dina))
        .where('revoked_at', 'is', null)
        .execute(),
    );
    expect(sessions).toEqual([]);
    await fresh(owner);
    expect((await unlock(owner, dina)).statusCode).toBe(204);
  });

  it("a disabled account's passkey sign-in is refused", async () => {
    const ezra = await person('adult', 'Ezra');
    const device = new SoftwareAuthenticator();
    await fresh(ezra);
    const options = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/challenge',
      headers: h.as(ezra),
    });
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/passkeys',
          headers: h.as(ezra),
          payload: { response: device.register(options.json()), label: 'Laptop' },
        })
      ).statusCode,
    ).toBe(201);
    const withPasskey = async () => {
      const challenge = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/challenge',
        payload: { email: ezra.email },
        ...peer(),
      });
      return h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/verify',
        payload: { response: device.authenticate(challenge.json()) },
        ...peer(),
      });
    };
    expect((await withPasskey()).statusCode).toBe(200);
    const account = await accountOf(ezra);
    const pool = createPool(h.adminUrl, 1);
    try {
      await pool.query('update account set disabled_at = now() where id = $1', [account]);
      const refused = await withPasskey();
      expect(refused.statusCode).toBe(401);
      expect(error(refused).code).toBe('passkey_rejected');
      // And by password, as before.
      expect(error(await signIn(ezra.email)).code).toBe('invalid_credentials');
    } finally {
      await pool.query('update account set disabled_at = null where id = $1', [account]);
      await pool.end();
    }
  });

  it('suspended_until unlocks by itself: reads take a lock past its date as over', async () => {
    const farah = await person('adult', 'Farah');
    const doc = await document(farah, 'Council tax');
    const link = await shareDoc(farah, doc);
    await fresh(owner);
    // An end that has passed, or more than a year away, is refused.
    for (const until of [
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 367 * 864e5).toISOString(),
    ]) {
      const r = await lock(owner, farah, { until });
      expect(r.statusCode).toBe(422);
      expect(error(r).code).toBe('validation_failed');
    }
    const until = new Date(Date.now() + 864e5);
    const locked = await lock(owner, farah, { until: until.toISOString() });
    expect(locked.statusCode, locked.body).toBe(200);
    expect(json<{ suspension: MemberSuspension }>(locked).suspension.until).toBe(
      until.toISOString(),
    );
    expect((await signIn(farah.email)).statusCode).toBe(403);
    expect((await preview(link.link_token)).statusCode).toBe(404);
    // Its day comes (moved into the past by hand): nothing has to run.
    const pool = createPool(h.adminUrl, 1);
    try {
      await pool.query(
        `update account_household set suspended_at = now() - interval '2 days',
                suspended_until = now() - interval '1 minute' where member_id = $1`,
        [farah.member_id],
      );
    } finally {
      await pool.end();
    }
    expect((await signIn(farah.email)).statusCode).toBe(200);
    expect((await preview(link.link_token)).statusCode).toBe(200);
    expect((await links(owner)).find((l) => l.id === link.share.id)?.state).toBe('active');
    expect((await card(farah)).suspension).toBeNull();
    // Nor does it hold a widening back.
    await fresh(owner);
    const widened = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/household/identity-audience',
      headers: h.as(owner),
      payload: { audience: 'adults' },
    });
    expect(widened.statusCode, widened.body).toBe(200);
    await fresh(owner);
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/household/identity-audience',
      headers: h.as(owner),
      payload: { audience: 'owners_and_self' },
    });
    // Over is over: nothing to unlock, and a new lock may be made.
    await fresh(owner);
    expect(error(await unlock(owner, farah)).code).toBe('not_locked');
    expect((await lock(owner, farah)).statusCode).toBe(200);
    await fresh(owner);
    expect((await unlock(owner, farah)).statusCode).toBe(204);
  });

  it('a teen and a second adult see no line about a lock', async () => {
    const gita = await person('adult', 'Gita');
    const other = await person('adult', 'Hamza');
    await fresh(owner);
    expect((await lock(owner, gita, { note: 'private reason' })).statusCode).toBe(200);
    await fresh(owner);
    expect((await unlock(owner, gita)).statusCode).toBe(204);
    const about = (lines: ActivityLine[]) =>
      lines.filter((l) => /Gita’s sign-in/.test(l.text)).map((l) => l.text);
    const seen = ['Owner unlocked Gita’s sign-in', 'Owner locked Gita’s sign-in'];
    expect(about(await activity(owner))).toEqual(seen);
    // The other owner, and the person themselves.
    expect(about(await activity(json<Tokens>(await signIn(gita.email))))).toEqual(seen);
    expect(about(await activity(coOwner))).toEqual(seen);
    // Nobody else: not another adult, not a teen.
    for (const who of [other, teen]) {
      const lines = await activity(who);
      expect(about(lines)).toEqual([]);
      expect(lines.some((l) => /lock/i.test(l.text))).toBe(false);
    }
    // And never the note, to anybody.
    for (const line of await activity(owner)) expect(line.text).not.toContain('private reason');
  });

  it('what 0051 defines keeps its rights and its search_path, pg_temp last', async () => {
    const defined = await withSystem(
      h.db,
      owner.household_id,
      async (trx) =>
        (
          await sql<{ name: string; definer: boolean; config: string[]; granted: boolean }>`
          select p.proname as name, p.prosecdef as definer, p.proconfig as config,
                 has_function_privilege('fdv_app', p.oid, 'execute') as granted
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('suspension_in_effect', 'assert_owner_remains',
                               'account_household_suspension', 'app_shared_document',
                               'app_live_share', 'app_live_upload_request',
                               'upload_requests_end_for_lock')
           order by 1`.execute(trx)
        ).rows,
    );
    const pinned = ['search_path=pg_catalog, public, pg_temp'];
    expect(defined).toEqual([
      { name: 'account_household_suspension', definer: false, config: pinned, granted: true },
      { name: 'app_live_share', definer: true, config: pinned, granted: true },
      { name: 'app_live_upload_request', definer: true, config: pinned, granted: true },
      { name: 'app_shared_document', definer: true, config: pinned, granted: true },
      { name: 'assert_owner_remains', definer: true, config: pinned, granted: true },
      { name: 'suspension_in_effect', definer: false, config: pinned, granted: true },
      { name: 'upload_requests_end_for_lock', definer: true, config: pinned, granted: true },
    ]);
  });

  it("a lock's own way to end requests ends nothing for anybody else, nor for somebody not locked", async () => {
    const sana = await person('adult', 'Sana');
    const asked = await askFor(sana, 'me');
    const endAs = async (role: string, who: Tokens) => {
      const pool = createPool(h.appUrl, 1);
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                  set_config('app.role', $2, true), set_config('app.account_id', $3, true),
                  set_config('app.member_id', $4, true)`,
          [owner.household_id, role, await accountOf(who), who.member_id],
        );
        const r = await c.query('select id from upload_requests_end_for_lock($1) as id', [
          await accountOf(sana),
        ]);
        await c.query('rollback');
        return r.rowCount;
      } finally {
        c.release();
        await pool.end();
      }
    };
    // Not locked: nothing, even for an owner.
    expect(await endAs('owner', owner)).toBe(0);
    await fresh(owner);
    expect((await lock(owner, sana)).statusCode).toBe(200);
    // Locked: an adult ends nothing; an owner, her request.
    expect(await endAs('adult', teen)).toBe(0);
    expect(await endAs('owner', owner)).toBe(1);
    expect((await dropPreview(asked.link_token)).statusCode).toBe(404);
    await fresh(owner);
    expect((await unlock(owner, sana)).statusCode).toBe(204);
    // Rolled back each time: it opens again with the unlock.
    expect((await dropPreview(asked.link_token)).statusCode).toBe(200);
  });

  it('a locked person is not made an owner, by the API or the database', async () => {
    const kamal = await person('adult', 'Kamal');
    await fresh(owner);
    expect((await lock(owner, kamal)).statusCode).toBe(200);
    await fresh(owner);
    const promoted = await h.app.inject({
      method: 'POST',
      url: `/api/v1/members/${kamal.member_id}/role`,
      headers: h.as(owner),
      payload: { role: 'owner' },
    });
    expect(promoted.statusCode).toBe(409);
    expect(error(promoted).code).toBe('locked');
    const pool = createPool(h.appUrl, 1);
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.role', 'owner', true), set_config('app.account_id', $2, true)`,
        [owner.household_id, await accountOf(owner)],
      );
      const err = await c
        .query(`update account_household set role = 'owner' where member_id = $1`, [
          kamal.member_id,
        ])
        .then(
          () => null,
          (e: { code?: string }) => e.code,
        );
      expect(err).toBe('23514');
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
      await pool.end();
    }
    await fresh(owner);
    expect((await unlock(owner, kamal)).statusCode).toBe(204);
  });

  it('what a lock takes: the invitations they sent, their reset links, their exports', async () => {
    const lena = await person('adult', 'Lena');
    await fresh(lena);
    const invited = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: h.as(lena),
      payload: {
        display_name: 'Lena’s nephew',
        email: `nephew-${randomUUID()}@example.test`,
        role: 'teen',
      },
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const invitation = json<{ link_token: string; code: string }>(invited);
    const account = await accountOf(lena);
    const pool = createPool(h.adminUrl, 1);
    try {
      await pool.query(
        `insert into password_reset (account_id, token_hash, expires_at, issued_by)
         values ($1, $2, now() + interval '1 hour', 'self')`,
        [account, Buffer.from(randomUUID())],
      );
      await pool.query(`insert into export (household_id, requested_by) values ($1, $2)`, [
        owner.household_id,
        account,
      ]);
      const before = await pool.query<{ live: number }>(
        `select count(*)::int as live from export
          where requested_by = $1 and (expires_at is null or expires_at > now())`,
        [account],
      );
      expect(before.rows[0]?.live).toBe(1);
      await fresh(owner);
      const locked = await lock(owner, lena);
      expect(locked.statusCode, locked.body).toBe(200);
      const left = await pool.query<{ live: number }>(
        `select count(*)::int as live from password_reset where account_id = $1 and used_at is null`,
        [account],
      );
      expect(left.rows[0]?.live).toBe(0);
      // Nor is she sent a new one while locked: the page answers as ever.
      const forgot = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/forgot',
        payload: { email: lena.email },
        ...peer(),
      });
      expect(forgot.statusCode).toBeLessThan(300);
      const after = await pool.query<{ live: number }>(
        `select count(*)::int as live from password_reset where account_id = $1 and used_at is null`,
        [account],
      );
      expect(after.rows[0]?.live).toBe(0);
      const exports = await pool.query<{ live: number }>(
        `select count(*)::int as live from export
          where requested_by = $1 and (expires_at is null or expires_at > now())`,
        [account],
      );
      expect(exports.rows[0]?.live).toBe(0);
      // The invitation she sent cannot be accepted.
      const accepted = await h.app.inject({
        method: 'POST',
        url: '/api/v1/invitations/accept',
        payload: { token: invitation.link_token, code: invitation.code, password: PASSWORD },
        ...peer(),
      });
      expect(accepted.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      await pool.end();
    }
    await fresh(owner);
    expect((await unlock(owner, lena)).statusCode).toBe(204);
  });

  it('after a restore, every sign-in but the owners’ waits for an owner: one tap each', async () => {
    const mina = await person('adult', 'Mina');
    const nadia = await person('viewer', 'Nadia');
    // What a restore does to a sign-in (restore.ts PAUSE_SIGN_INS), by hand.
    const pool = createPool(h.adminUrl, 1);
    try {
      await pool.query(
        `update account_household set suspended_at = now(), suspend_reason = 'restored'
          where member_id = any($1::uuid[])`,
        [[mina.member_id, nadia.member_id]],
      );
    } finally {
      await pool.end();
    }
    // A session the pause did not end (here, written by hand) answers
    // nothing all the same, and is given no new token.
    const open = await members(mina);
    expect(open.statusCode).toBe(401);
    expect(error(open)).toMatchObject({ code: 'session_ended', reason: 'suspended' });
    const renewed = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: mina.refresh_token },
      ...peer(),
    });
    expect(error(renewed)).toMatchObject({ code: 'session_ended', reason: 'suspended' });
    const refused = await signIn(mina.email);
    expect(refused.statusCode).toBe(403);
    expect(error(refused)).toMatchObject({ code: 'membership_suspended', reason: 'restored' });
    expect(error(refused).message).toMatch(/restored from a backup/);

    const waiting = async (who: Tokens) =>
      json<{ sign_ins: PausedSignIn[] }>(
        await h.app.inject({ url: '/api/v1/after-restore', headers: h.as(who) }),
      ).sign_ins;
    const listed = await waiting(owner);
    expect(listed.filter((s) => [mina.member_id, nadia.member_id].includes(s.member_id))).toEqual([
      expect.objectContaining({ member_id: mina.member_id, display_name: 'Mina', role: 'adult' }),
      expect.objectContaining({
        member_id: nadia.member_id,
        display_name: 'Nadia',
        role: 'viewer',
      }),
    ]);
    // Anybody else: nothing to decide.
    const someone = await person('adult', 'Rami');
    expect(await waiting(someone)).toEqual([]);
    expect((await card(mina)).suspension).toMatchObject({ reason: 'restored', by: null });
    // Not a lock: an unlock does not turn it on, nor does an adult.
    await fresh(owner);
    expect(error(await unlock(owner, mina)).code).toBe('not_locked');
    expect((await resume(someone, mina)).statusCode).toBe(403);
    // Asked as an unlock is.
    await stale(owner);
    expect(error(await resume(owner, mina))).toMatchObject({
      code: 'step_up_required',
      action: 'manage_sign_ins',
    });
    await fresh(owner);
    expect((await resume(owner, mina)).statusCode).toBe(204);
    expect((await signIn(mina.email)).statusCode).toBe(200);
    expect((await waiting(owner)).map((s) => s.member_id)).not.toContain(mina.member_id);
    expect(error(await resume(owner, mina)).code).toBe('not_paused');
    // A paused one may be locked instead.
    await fresh(owner);
    expect((await lock(owner, nadia)).statusCode).toBe(200);
    expect((await waiting(owner)).map((s) => s.member_id)).not.toContain(nadia.member_id);
    expect(error(await resume(owner, nadia)).code).toBe('not_paused');
    await fresh(owner);
    expect((await unlock(owner, nadia)).statusCode).toBe(204);
    const lines = (await activity(owner)).map((l) => l.text);
    expect(lines).toContain('Owner turned Mina’s sign-in back on after the restore');
  });

  describe('at the same moment as', () => {
    const deadlocks = async (admin: ReturnType<typeof createPool>) =>
      (
        await admin.query<{ n: number }>(
          'select deadlocks::int as n from pg_stat_database where datname = $1',
          [new URL(h.adminUrl).pathname.slice(1)],
        )
      ).rows[0]?.n as number;
    const waitingOn = async (admin: ReturnType<typeof createPool>, n: number) => {
      for (let i = 0; i < 200; i += 1) {
        const r = await admin.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where datname = $1 and wait_event_type = 'Lock'`,
          [new URL(h.adminUrl).pathname.slice(1)],
        );
        if ((r.rows[0]?.n ?? 0) >= n) return;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error(`fewer than ${n} statements waiting on a lock`);
    };
    /** Runs `first`, then `second`, both queued behind the person's membership held from outside. */
    const race = async <A, B>(
      memberId: string,
      first: () => Promise<A>,
      second: () => Promise<B>,
    ) => {
      const admin = createPool(h.adminUrl, 3);
      const holder = await admin.connect();
      const before = await deadlocks(admin);
      try {
        await holder.query('begin');
        await holder.query(
          'select account_id from account_household where member_id = $1 for update',
          [memberId],
        );
        const a = first();
        await waitingOn(admin, 1);
        const b = second();
        await waitingOn(admin, 2);
        await holder.query('rollback');
        const both = await Promise.all([a, b]);
        await new Promise((res) => setTimeout(res, 1500));
        expect(await deadlocks(admin)).toBe(before);
        return both;
      } finally {
        await holder.query('rollback').catch(() => undefined);
        holder.release();
        await admin.end();
      }
    };

    it('an unlock: whichever comes first, the other sees it', async () => {
      const ola = await person('adult', 'Ola');
      await fresh(owner);
      expect((await lock(owner, ola)).statusCode).toBe(200);
      await fresh(owner);
      await enrolTotp(coOwner).catch(() => undefined);
      await fresh(coOwner);
      // Unlocked first: the second lock lands on an unlocked person.
      const [unlocked, relocked] = await race(
        ola.member_id,
        () => unlock(owner, ola),
        () => lock(coOwner, ola),
      );
      expect(unlocked.statusCode, unlocked.body).toBe(204);
      expect(relocked.statusCode, relocked.body).toBe(200);
      expect((await card(ola)).suspension).toMatchObject({ reason: 'locked', by: 'Zainab' });
      // Locked again first: it finds the lock, and the unlock then ends it.
      await fresh(owner);
      await fresh(coOwner);
      const [again, freed] = await race(
        ola.member_id,
        () => lock(owner, ola),
        () => unlock(coOwner, ola),
      );
      expect(again.statusCode).toBe(409);
      expect(error(again).code).toBe('already_locked');
      expect(freed.statusCode).toBe(204);
      expect((await card(ola)).suspension).toBeNull();
    });

    it('a widening: never a widening waiting while somebody is locked', async () => {
      const widen = () =>
        h.app.inject({
          method: 'PUT',
          url: '/api/v1/household/identity-audience',
          headers: h.as(owner),
          payload: { audience: 'adults' },
        });
      const pending = async () =>
        json<{ pending: unknown }>(
          await h.app.inject({ url: '/api/v1/household/identity-audience', headers: h.as(owner) }),
        ).pending;
      const paul = await person('teen', 'Paul');
      // The lock first: the widening waits, then finds Paul locked.
      await fresh(owner);
      const [locked, widened] = await race(
        paul.member_id,
        () => lock(owner, paul),
        () => widen(),
      );
      expect(locked.statusCode, locked.body).toBe(200);
      expect(widened.statusCode).toBe(409);
      expect(error(widened).code).toBe('member_cannot_be_told');
      expect(await pending()).toBeNull();
      await fresh(owner);
      expect((await unlock(owner, paul)).statusCode).toBe(204);
      // The widening first: the lock waits, then withdraws it.
      await fresh(owner);
      const [widened2, locked2] = await race(
        paul.member_id,
        () => widen(),
        () => lock(owner, paul),
      );
      expect(widened2.statusCode, widened2.body).toBe(200);
      expect(locked2.statusCode, locked2.body).toBe(200);
      expect(await pending()).toBeNull();
      await fresh(owner);
      expect((await unlock(owner, paul)).statusCode).toBe(204);
    });

    it('their own sign-in: the session it opens ends with the lock, or it is refused', async () => {
      const queen = await person('adult', 'Queen');
      // Signing in first: the lock waits for its session, then ends it.
      await fresh(owner);
      const [opened, locked] = await race(
        queen.member_id,
        () => signIn(queen.email),
        () => lock(owner, queen),
      );
      expect(opened.statusCode, opened.body).toBe(200);
      expect(locked.statusCode, locked.body).toBe(200);
      const after = await members(json<Tokens>(opened));
      expect(after.statusCode).toBe(401);
      expect(error(after)).toMatchObject({ code: 'session_ended', reason: 'suspended' });
      await fresh(owner);
      expect((await unlock(owner, queen)).statusCode).toBe(204);
      // The lock first: the sign-in waits, then is refused.
      await fresh(owner);
      const [locked2, refused] = await race(
        queen.member_id,
        () => lock(owner, queen),
        () => signIn(queen.email),
      );
      expect(locked2.statusCode).toBe(200);
      expect(refused.statusCode).toBe(403);
      expect(error(refused).code).toBe('membership_suspended');
      await fresh(owner);
      expect((await unlock(owner, queen)).statusCode).toBe(204);
    });
  });
});
