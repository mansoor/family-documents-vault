import { randomUUID } from 'node:crypto';
import { createPool, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  refusalFor,
  type ActivityLine,
  type DocumentView,
  type OfflineSet,
  type RoleChangeResult,
  type SignedOutEverywhere,
} from '@fdv/shared';
import FormData from 'form-data';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { codeFor } from '../auth/totp.js';
import { createHarness, type Harness } from '../test-harness.js';
import { INCOMING_MOVE_JOB } from '../uploads/incoming.js';

/**
 * Role changes reach every device; sign out everywhere (5.30, A53, A54).
 *
 * An owner with two-step sign-in signs somebody out everywhere — a co-owner
 * too, who is told — and their phones are pushed `session_ended`. A role
 * change that takes sight away ends the Essentials on that person's phones,
 * one that takes asking away closes their requests, and the answer says
 * what it did. The lines about these are the owners', the person's and
 * whoever did it's, never another adult's or a teen's.
 */

const json = <T>(r: { json: () => unknown }) => r.json() as T;
type Res = LightMyRequestResponse;
const error = (r: Res) =>
  json<{ error: { code: string; message: string; action?: string; reason?: string } }>(r).error;
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const PASSWORD = 'another correct horse';
const APP_AGENT = 'FamilyDocumentVault/0.2.1 (Android 15; Google Pixel 8a)';

describe.skipIf(!testAdminUrl())(
  'role changes reach every device; sign out everywhere (5.30)',
  () => {
    let h: Harness;
    let owner: Tokens;
    let ownerSecret = '';
    /** A teen and a second adult: they read the log, and see nothing of these. */
    let teen: Tokens;
    let adult: Tokens;
    let nth = 0;
    const peer = () => ({ remoteAddress: `10.30.${Math.floor(++nth / 200)}.${nth % 200}` });

    const accountOf = async (t: { member_id: string; household_id: string }) =>
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
    const signIn = async (email: string, installation?: string) => {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email, password: PASSWORD },
        headers: installation
          ? { 'x-fdv-installation': installation, 'user-agent': APP_AGENT }
          : { 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/19.0' },
        ...peer(),
      });
      expect(r.statusCode, r.body).toBe(200);
      return json<Tokens>(r);
    };
    const signOut = (who: Tokens, target: { member_id: string }) =>
      h.app.inject({
        method: 'DELETE',
        url: `/api/v1/members/${target.member_id}/sessions`,
        headers: h.as(who),
      });
    const setRole = (who: Tokens, target: { member_id: string }, role: string) =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${target.member_id}/role`,
        headers: h.as(who),
        payload: { role },
      });
    const members = (who: Tokens) => h.app.inject({ url: '/api/v1/members', headers: h.as(who) });
    const refresh = (t: Tokens, installation?: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refresh_token: t.refresh_token },
        ...(installation ? { headers: { 'x-fdv-installation': installation } } : {}),
        ...peer(),
      });
    const activity = async (who: Tokens) =>
      json<{ items: ActivityLine[] }>(
        await h.app.inject({ url: '/api/v1/audit?limit=100', headers: h.as(who) }),
      ).items.map((l) => l.text);
    const jobsNamed = (name: string) => h.jobs.filter((j) => j.name === name).map((j) => j.data);
    const alertsTo = async (t: { member_id: string; household_id: string }) => {
      const account = await accountOf(t);
      return (
        jobsNamed('alert.send') as Array<{
          account_ids: string[];
          subject: string;
          body: string;
          email_only?: boolean;
        }>
      ).filter((a) => a.account_ids.includes(account));
    };
    /** A phone of theirs: a session with an installation, and its UnifiedPush address. */
    const phoneOf = async (who: { email: string }) => {
      const installation = randomUUID();
      const t = await signIn(who.email, installation);
      const endpoint = `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`;
      const registered = await h.app.inject({
        method: 'POST',
        url: '/api/v1/devices',
        headers: { ...h.as(t), 'x-fdv-installation': installation },
        payload: { kind: 'unified_push', endpoint, keys: { p256dh: 'k', auth: 'a' } },
      });
      expect(registered.statusCode, registered.body).toBe(201);
      return { ...t, installation, endpoint };
    };
    /** An Essential of theirs, everybody's to see, with a file. */
    const essential = async (who: Tokens, title: string) => {
      const created = await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(who),
        payload: {
          title,
          type_key: 'passport',
          owner_member_id: who.member_id,
          is_essential: true,
          visibility: 'household',
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = json<DocumentView>(created).id;
      const form = new FormData();
      form.append('file', PDF, { filename: 'f.pdf', contentType: 'application/pdf' });
      const v = await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${id}/versions`,
        headers: { ...h.as(who), ...form.getHeaders(), 'idempotency-key': randomUUID() },
        payload: form.getBuffer(),
      });
      expect(v.statusCode, v.body).toBe(201);
      return id;
    };
    const grant = (t: Tokens) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/offline/grant',
        headers: h.as(t),
        payload: { password: PASSWORD },
        ...peer(),
      });
    const setOf = async (t: Tokens) => {
      const r = await h.app.inject({ url: '/api/v1/offline/essentials', headers: h.as(t) });
      expect(r.statusCode, r.body).toBe(200);
      return json<OfflineSet>(r);
    };
    const askFor = async (who: Tokens) => {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/v1/upload-requests',
        headers: h.as(who),
        payload: {
          title: 'Your payslips',
          expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
          review_by: 'me',
        },
      });
      expect(r.statusCode, r.body).toBe(201);
      return json<{ request: { id: string }; link_token: string }>(r);
    };
    const auditRows = (action: string, objectId: string) =>
      withSystem(h.db, owner.household_id, (trx) =>
        trx
          .selectFrom('audit_event')
          .select(['detail', 'actor_account_id'])
          .where('action', '=', action)
          .where('object_id', '=', objectId)
          .orderBy('id')
          .execute(),
      );

    beforeAll(async () => {
      h = await createHarness({ rateLimitPerMinute: 100_000 });
      owner = await h.setup();
      // Two-step sign-in for the owner, as the owner powers ask (A54).
      await fresh(owner);
      const enrol = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/totp/enrol',
        headers: h.as(owner),
      });
      ownerSecret = json<{ secret: string }>(enrol).secret;
      const confirm = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/totp/confirm',
        headers: h.as(owner),
        payload: { code: codeFor(ownerSecret) },
      });
      expect(confirm.statusCode, confirm.body).toBe(204);
      teen = await person('teen', 'Tariq');
      adult = await person('adult', 'Ada');
    }, 120_000);
    afterAll(() => h.close());

    it('sign out everywhere ends every session and pushes', async () => {
      const sara = await person('adult', 'Sara');
      const phone = await phoneOf(sara);
      expect((await members(phone)).statusCode).toBe(200);

      await fresh(owner);
      const done = await signOut(owner, sara);
      expect(done.statusCode, done.body).toBe(200);
      expect(json<SignedOutEverywhere>(done)).toEqual({
        member_id: sara.member_id,
        sessions_ended: 2,
      });

      // Every session of hers: the next request, and the next refresh, say why.
      for (const [t, installation] of [
        [sara, undefined],
        [phone, phone.installation],
      ] as const) {
        const r = await members(t);
        expect(r.statusCode).toBe(401);
        expect(error(r)).toMatchObject({ code: 'session_ended', reason: 'revoked' });
        expect(error(await refresh(t, installation))).toMatchObject({
          code: 'session_ended',
          reason: 'revoked',
        });
      }
      // Her phone is told, once it committed, and nothing more is pushed to it.
      const told = jobsNamed('push.send').filter((d) =>
        (d.targets as Array<{ endpoint: string }>).some((t) => t.endpoint === phone.endpoint),
      );
      expect(told.map((d) => d.message)).toEqual([{ v: 1, type: 'session_ended' }]);
      const devices = await withSystem(h.db, owner.household_id, (trx) =>
        trx.selectFrom('device').select('id').where('endpoint', '=', phone.endpoint).execute(),
      );
      expect(devices).toEqual([]);
      // She is emailed — no push: her phone has gone with her sessions.
      expect((await alertsTo(sara)).at(-1)).toMatchObject({
        subject: 'Owner signed you out of The Test family everywhere',
        email_only: true,
      });
      // One line, for the record.
      expect(
        (await auditRows('member.signed_out_everywhere', sara.member_id)).at(-1)?.detail,
      ).toEqual({ sessions: 2 });
      // Her sign-in is as it was: she signs in again with her own password.
      expect((await members(await signIn(sara.email))).statusCode).toBe(200);
    });

    it('signing out a co-owner tells them', async () => {
      // A co-owner (A53): an owner may sign another out everywhere.
      const zainab = await person('adult', 'Zainab');
      await fresh(owner);
      expect((await setRole(owner, zainab, 'owner')).statusCode).toBe(200);
      const laptop = await signIn(zainab.email);
      await fresh(owner);
      const done = await signOut(owner, zainab);
      expect(done.statusCode, done.body).toBe(200);
      expect(json<SignedOutEverywhere>(done).sessions_ended).toBe(2);
      for (const t of [zainab, laptop]) {
        expect(error(await members(t))).toMatchObject({ code: 'session_ended', reason: 'revoked' });
      }
      const told = (await alertsTo(zainab)).at(-1);
      expect(told).toMatchObject({
        subject: 'Owner signed you out of The Test family everywhere',
        email_only: true,
      });
      expect(told?.body).toContain('look at the activity log');
      // Still an owner, and signs in as before.
      const back = await signIn(zainab.email);
      expect(
        json<{ role: string }>(await h.app.inject({ url: '/api/v1/me', headers: h.as(back) })).role,
      ).toBe('owner');
    });

    it('an adult cannot sign out someone else', async () => {
      const notAnOwner = { code: 'forbidden', message: refusalFor('member.sign_out') };
      const viewer = await person('viewer', 'Accountant');
      for (const [who, target] of [
        [adult, teen],
        [adult, owner],
        [teen, adult],
        [viewer, teen],
        // Nor themselves, by this: owners only. Devices in Settings is theirs.
        [adult, adult],
      ] as const) {
        const r = await signOut(who, target);
        expect(r.statusCode).toBe(403);
        expect(error(r)).toMatchObject(notAnOwner);
      }
      // Nothing ended.
      for (const t of [teen, adult, owner]) expect((await members(t)).statusCode).toBe(200);
    });

    it('a password-only owner is refused sign out everywhere, and step-up by password is refused', async () => {
      const victim = await person('teen', 'Vera');
      // An owner with only a password (A54): refused outright.
      const paula = await person('adult', 'Paula');
      await fresh(owner);
      expect((await setRole(owner, paula, 'owner')).statusCode).toBe(200);
      await fresh(paula);
      const bare = await signOut(paula, victim);
      expect(bare.statusCode).toBe(403);
      expect(error(bare)).toMatchObject({
        code: 'totp_required_for_owner',
        message: "Turn on two-step sign-in to manage other people's sign-ins.",
      });
      // An owner with two-step sign-in who confirmed it is them with the
      // password: not that. Asked for a passkey or a code.
      await stale(owner);
      const byPassword = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/step-up',
        headers: h.as(owner),
        payload: { password: 'correct horse battery' },
      });
      expect(byPassword.statusCode, byPassword.body).toBe(200);
      const asked = await signOut(owner, victim);
      expect(asked.statusCode).toBe(403);
      expect(error(asked)).toMatchObject({ code: 'step_up_required', action: 'manage_sign_ins' });
      expect((await members(victim)).statusCode).toBe(200);
      // With a code, it goes ahead.
      const byCode = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/step-up',
        headers: h.as(owner),
        payload: { code: codeFor(ownerSecret) },
      });
      expect(byCode.statusCode, byCode.body).toBe(200);
      expect((await signOut(owner, victim)).statusCode).toBe(200);
      expect((await members(victim)).statusCode).toBe(401);
    });

    it('nobody with a sign-in is 404; an owner signing out everywhere themselves keeps the device asking', async () => {
      await fresh(owner);
      const nobody = await signOut(owner, { member_id: randomUUID() });
      expect(nobody.statusCode).toBe(404);
      expect(error(nobody).message).toBe('They have no sign-in to sign out.');
      // A second session of the owner's: password, then the code.
      const first = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: 'owner@example.test', password: 'correct horse battery' },
        ...peer(),
      });
      const mfa = json<{ mfa_token: string }>(first).mfa_token;
      const other = json<Tokens>(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/mfa',
          payload: { mfa_token: mfa, code: codeFor(ownerSecret) },
          ...peer(),
        }),
      );
      expect((await members(other)).statusCode).toBe(200);
      await fresh(owner);
      const mine = await signOut(owner, owner);
      expect(mine.statusCode, mine.body).toBe(200);
      expect(json<SignedOutEverywhere>(mine).sessions_ended).toBeGreaterThanOrEqual(1);
      expect((await members(other)).statusCode).toBe(401);
      expect((await members(owner)).statusCode).toBe(200);
      expect(
        (await auditRows('member.signed_out_everywhere', owner.member_id)).at(-1)?.detail,
      ).toMatchObject({ self: true });
    });

    it('a locked sign-in has nothing to sign out of, and is not emailed to sign in again', async () => {
      const lou = await person('adult', 'Lou');
      await fresh(owner);
      const locked = await h.app.inject({
        method: 'POST',
        url: `/api/v1/members/${lou.member_id}/lock`,
        headers: h.as(owner),
        payload: {},
      });
      expect(locked.statusCode, locked.body).toBe(200);
      const before = (await alertsTo(lou)).length;
      await fresh(owner);
      const done = await signOut(owner, lou);
      expect(done.statusCode, done.body).toBe(200);
      expect(json<SignedOutEverywhere>(done).sessions_ended).toBe(0);
      expect((await alertsTo(lou)).length).toBe(before);
    });

    it("a demoted adult's phone gets an empty set at its next sync", async () => {
      const wes = await person('adult', 'Wes');
      const phone = await phoneOf(wes);
      await essential(wes, 'Wes passport');
      expect((await grant(phone)).statusCode).toBe(200);
      const before = await setOf(phone);
      expect(before.grant).not.toBeNull();
      expect(before.items.map((i) => i.document.title)).toContain('Wes passport');

      await fresh(owner);
      const changed = await setRole(owner, wes, 'teen');
      expect(changed.statusCode, changed.body).toBe(200);
      const result = json<RoleChangeResult>(changed);
      expect(result.effects).toEqual([{ effect: 'offline_ended', count: 1 }]);
      expect(result.message).toBe(
        'Wes is now a teen. Their phone removes the Essentials it keeps at its next sync.',
      );
      // The next sync: nothing to keep, and no grant — the phone removes what it has.
      const after = await setOf(phone);
      expect(after).toMatchObject({ items: [], grant: null });
      expect((await auditRows('member.offline_ended', wes.member_id)).at(-1)?.detail).toEqual({
        sessions: 1,
      });
      // It was the grant that ended: given again, with the password, a teen's own come back.
      expect((await grant(phone)).statusCode).toBe(200);
      expect((await setOf(phone)).items.map((i) => i.document.title)).toEqual(['Wes passport']);

      // Anybody made a viewer: the same, and a viewer is given no grant again.
      const xan = await person('adult', 'Xan');
      const xansPhone = await phoneOf(xan);
      expect((await grant(xansPhone)).statusCode).toBe(200);
      await fresh(owner);
      const viewed = json<RoleChangeResult>(await setRole(owner, xan, 'viewer'));
      expect((viewed.effects ?? []).map((e) => e.effect)).toContain('offline_ended');
      expect(await setOf(xansPhone)).toMatchObject({ items: [], grant: null });
      expect((await grant(xansPhone)).statusCode).toBe(403);
      // An owner made an adult, or a teen an adult, sees no less: nothing ends.
      const yan = await person('teen', 'Yan');
      const yansPhone = await phoneOf(yan);
      expect((await grant(yansPhone)).statusCode).toBe(200);
      await fresh(owner);
      const up = json<RoleChangeResult>(await setRole(owner, yan, 'adult'));
      expect(up.effects).toEqual([]);
      expect(up.message).toBe('Yan is now an adult.');
      expect((await setOf(yansPhone)).grant).not.toBeNull();
    });

    it('a viewer keeps nothing on a phone, whatever its session was granted', async () => {
      // A grant written onto a viewer's session — made a viewer at the moment
      // of the grant, say: the set is asked as the person is now.
      const vi = await person('viewer', 'Vi');
      const phone = await phoneOf(vi);
      await withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('session')
          .set({
            offline_granted_at: new Date(),
            offline_expires_at: new Date(Date.now() + 864e5),
          })
          .where('installation_id', '=', phone.installation)
          .execute(),
      );
      expect(await setOf(phone)).toMatchObject({ items: [], grant: null });
    });

    it("a demoted requester's requests close", async () => {
      const yara = await person('adult', 'Yara');
      const asked = await askFor(yara);
      const moves = jobsNamed(INCOMING_MOVE_JOB).length;
      await fresh(owner);
      const changed = await setRole(owner, yara, 'teen');
      expect(changed.statusCode, changed.body).toBe(200);
      const result = json<RoleChangeResult>(changed);
      expect(result.effects).toEqual([{ effect: 'requests_closed', count: 1 }]);
      expect(result.message).toBe('Yara is now a teen. Their request to send documents closed.');
      const row = await withSystem(h.db, owner.household_id, (trx) =>
        trx
          .selectFrom('upload_request')
          .select(['closed_at', 'closed_reason'])
          .where('id', '=', asked.request.id)
          .executeTakeFirstOrThrow(),
      );
      expect(row).toMatchObject({ closed_reason: 'requester_lost_right' });
      expect(row.closed_at).not.toBeNull();
      // What was sent for her alone goes to the owners, once it committed.
      expect(jobsNamed(INCOMING_MOVE_JOB).length).toBe(moves + 1);
      expect((await auditRows('member.requests_closed', yara.member_id)).at(-1)?.detail).toEqual({
        requests: 1,
      });
      // Its link answers nothing.
      const preview = await h.app.inject({
        method: 'POST',
        url: '/api/v1/drop/preview',
        payload: { token: asked.link_token },
        ...peer(),
      });
      expect(preview.statusCode).toBe(404);
    });

    it('only live requests are counted as closed: one run out or locked is closed, unsaid (the 5.30 review, S530-2)', async () => {
      const zed = await person('adult', 'Zed');
      const live = await askFor(zed);
      const ranOut = await askFor(zed);
      const lockedOut = await askFor(zed);
      await withSystem(h.db, owner.household_id, async (trx) => {
        await trx
          .updateTable('upload_request')
          .set({ expires_at: new Date(Date.now() - 7 * 864e5) })
          .where('id', '=', ranOut.request.id)
          .execute();
        await trx
          .updateTable('upload_request')
          .set({ attempts: 10 })
          .where('id', '=', lockedOut.request.id)
          .execute();
      });
      await fresh(owner);
      const changed = await setRole(owner, zed, 'teen');
      expect(changed.statusCode, changed.body).toBe(200);
      const result = json<RoleChangeResult>(changed);
      expect(result.effects).toEqual([{ effect: 'requests_closed', count: 1 }]);
      expect(result.message).toBe('Zed is now a teen. Their request to send documents closed.');
      expect((await auditRows('member.requests_closed', zed.member_id)).at(-1)?.detail).toEqual({
        requests: 1,
      });
      // All three are closed, as before; only the live one has a line.
      const ids = [live, ranOut, lockedOut].map((r) => r.request.id);
      const rows = await withSystem(h.db, owner.household_id, (trx) =>
        trx
          .selectFrom('upload_request')
          .select(['id', 'closed_reason'])
          .where('id', 'in', ids)
          .execute(),
      );
      expect(rows.map((r) => r.closed_reason)).toEqual([
        'requester_lost_right',
        'requester_lost_right',
        'requester_lost_right',
      ]);
      const lines = await withSystem(h.db, owner.household_id, (trx) =>
        trx
          .selectFrom('audit_event')
          .select('object_id')
          .where('action', '=', 'upload_request.closed')
          .where('object_id', 'in', ids)
          .execute(),
      );
      expect(lines.map((l) => l.object_id)).toEqual([live.request.id]);
    });

    it("a teen and a second adult see no line about a sign-out-everywhere, nor about a role change's effects", async () => {
      const uma = await person('adult', 'Uma');
      const vic = await person('adult', 'Vic');
      const phone = await phoneOf(vic);
      expect((await grant(phone)).statusCode).toBe(200);
      await askFor(vic);
      await fresh(owner);
      expect((await signOut(owner, uma)).statusCode).toBe(200);
      await fresh(owner);
      const changed = json<RoleChangeResult>(await setRole(owner, vic, 'teen'));
      expect((changed.effects ?? []).map((e) => e.effect).sort()).toEqual([
        'offline_ended',
        'requests_closed',
      ]);

      const SIGNED_OUT = 'Owner signed Uma out everywhere';
      const OFFLINE = 'Owner changed Vic’s role, so their phone stops keeping Essentials';
      const CLOSED = 'Owner changed Vic’s role, so their request to send documents closed';
      const ROLE = 'Owner changed what Vic can do: a teen';
      // The owners — whoever did it is one — see each.
      const owners = await activity(owner);
      for (const line of [SIGNED_OUT, OFFLINE, CLOSED]) expect(owners).toContain(line);
      expect(owners.some((l) => l.startsWith(ROLE))).toBe(true);
      // The person each is about sees theirs.
      expect(await activity(await signIn(uma.email))).toContain(SIGNED_OUT);
      const vics = await activity(await signIn(vic.email));
      expect(vics).toEqual(expect.arrayContaining([OFFLINE, CLOSED]));
      // A teen and a second adult: none of them — but the change of role, as ever.
      for (const reader of [teen, adult]) {
        const lines = await activity(reader);
        for (const hidden of [SIGNED_OUT, OFFLINE, CLOSED]) expect(lines).not.toContain(hidden);
        expect(
          lines.some((l) => /out everywhere|stops keeping Essentials|documents closed/.test(l)),
        ).toBe(false);
        expect(lines.some((l) => l.startsWith(ROLE))).toBe(true);
      }
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
      /** Runs `first`, then `second`, both queued behind a row held from outside. */
      const race = async <A, B>(
        hold: { sql: string; id: string },
        first: () => Promise<A>,
        second: () => Promise<B>,
      ) => {
        const admin = createPool(h.adminUrl, 3);
        const holder = await admin.connect();
        const before = await deadlocks(admin);
        try {
          await holder.query('begin');
          await holder.query(hold.sql, [hold.id]);
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
      const sessionOf = (t: Tokens) =>
        (
          JSON.parse(Buffer.from(t.access_token.split('.')[1] ?? '', 'base64url').toString()) as {
            sid: string;
          }
        ).sid;
      const holdSession = (t: Tokens) => ({
        sql: 'select id from session where id = $1 for update',
        id: sessionOf(t),
      });

      it('a refresh: whichever comes first, the session ends', async () => {
        // The refresh first: its new token belongs to a session the sign-out then ends.
        const quinn = await person('adult', 'Quinn');
        await fresh(owner);
        const [refreshed, out] = await race(
          holdSession(quinn),
          () => refresh(quinn),
          () => signOut(owner, quinn),
        );
        expect(refreshed.statusCode, refreshed.body).toBe(200);
        expect(out.statusCode, out.body).toBe(200);
        expect(json<SignedOutEverywhere>(out).sessions_ended).toBe(1);
        const next = json<Tokens>(refreshed);
        expect(error(await members(next))).toMatchObject({ reason: 'revoked' });
        expect(error(await refresh(next))).toMatchObject({ reason: 'revoked' });

        // The sign-out first: the refresh waits, then finds its session ended.
        const rhea = await person('adult', 'Rhea');
        await fresh(owner);
        const [out2, refreshed2] = await race(
          holdSession(rhea),
          () => signOut(owner, rhea),
          () => refresh(rhea),
        );
        expect(out2.statusCode, out2.body).toBe(200);
        expect(refreshed2.statusCode).toBe(401);
        expect(error(refreshed2)).toMatchObject({ code: 'session_ended', reason: 'revoked' });
      });

      it('a private document of theirs, written as their sessions end: refused as that session’s end (5.29’s FDV01, reason revoked)', async () => {
        // Something private, written by a session that sign out everywhere
        // ended while it waited for the person's membership, gains nothing:
        // the database refuses it (0052), and the answer says the session
        // ended, and why — signed out, `revoked`.
        const rae = await person('adult', 'Rae');
        await fresh(owner);
        const [out, wrote] = await race(
          {
            sql: 'select account_id from account_household where member_id = $1 for update',
            id: rae.member_id,
          },
          () => signOut(owner, rae),
          () =>
            h.app.inject({
              method: 'POST',
              url: '/api/v1/documents',
              headers: h.as(rae),
              payload: {
                title: 'Diary',
                type_key: 'utility_bill',
                owner_member_id: rae.member_id,
                visibility: 'private',
              },
            }),
        );
        expect(out.statusCode, out.body).toBe(200);
        expect(wrote.statusCode, wrote.body).toBe(401);
        expect(error(wrote)).toMatchObject({ code: 'session_ended', reason: 'revoked' });
      });

      it('a lock: a role change and a lock each see the other', async () => {
        const holdMember = (m: { member_id: string }) => ({
          sql: 'select account_id from account_household where member_id = $1 for update',
          id: m.member_id,
        });
        const lock = (m: { member_id: string }) =>
          h.app.inject({
            method: 'POST',
            url: `/api/v1/members/${m.member_id}/lock`,
            headers: h.as(owner),
            payload: {},
          });
        // The lock first: making them an owner then is refused.
        const sol = await person('adult', 'Sol');
        await fresh(owner);
        const [locked, promoted] = await race(
          holdMember(sol),
          () => lock(sol),
          () => setRole(owner, sol, 'owner'),
        );
        expect(locked.statusCode, locked.body).toBe(200);
        expect(promoted.statusCode).toBe(409);
        expect(error(promoted).code).toBe('locked');
        // Made an owner first: the lock then finds an owner, and is refused (A50).
        const tam = await person('adult', 'Tam');
        await fresh(owner);
        const [promoted2, locked2] = await race(
          holdMember(tam),
          () => setRole(owner, tam, 'owner'),
          () => lock(tam),
        );
        expect(promoted2.statusCode, promoted2.body).toBe(200);
        expect(locked2.statusCode).toBe(409);
        expect(error(locked2).code).toBe('owner_notice_required');
        // Made a teen while being locked: both land, and her phone keeps nothing.
        const ula = await person('adult', 'Ula');
        const phone = await phoneOf(ula);
        expect((await grant(phone)).statusCode).toBe(200);
        await fresh(owner);
        const [demoted, locked3] = await race(
          holdMember(ula),
          () => setRole(owner, ula, 'teen'),
          () => lock(ula),
        );
        expect(demoted.statusCode, demoted.body).toBe(200);
        expect(json<RoleChangeResult>(demoted).effects).toEqual([
          { effect: 'offline_ended', count: 1 },
        ]);
        expect(locked3.statusCode, locked3.body).toBe(200);
        expect(error(await members(phone))).toMatchObject({ reason: 'suspended' });
      });
    });
  },
);
