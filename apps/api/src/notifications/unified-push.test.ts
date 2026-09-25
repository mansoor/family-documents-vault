import { randomUUID } from 'node:crypto';
import { testAdminUrl } from '@fdv/db/testing';
import { createDb, createPool, type Db } from '@fdv/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, type Harness } from '../test-harness.js';

/**
 * UnifiedPush in the API (4.13): registering the phone app's push address,
 * the rules on where it may point, and every way a session ends taking its
 * devices with it — the phones among them told "you were signed out".
 */
describe.skipIf(!testAdminUrl())('UnifiedPush in the API', () => {
  let h: Harness;
  let owner: Tokens;
  // The table as it is, past the household wall: a row gone is gone.
  let admin: Db;
  beforeAll(async () => {
    h = await createHarness();
    admin = createDb(createPool(h.adminUrl, 1));
    owner = await h.setup();
    h.dns.set('ntfy.example.test', ['93.184.216.34']);
    h.dns.set('inside.example.test', ['10.0.0.5']);
    h.dns.set('metadata.example.test', ['169.254.169.254']);
  });
  afterAll(async () => {
    await admin.destroy();
    await h.close();
  });

  // Each request from its own address: the sign-in rate limit is not what is under test.
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.9.${Math.floor(++nth / 200)}.${nth % 200}` });

  const signIn = async (
    installation: string | null = randomUUID(),
    who = { email: 'owner@example.test', password: 'correct horse battery' },
  ) => {
    const res = await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: installation ? { 'x-fdv-installation': installation } : {},
      payload: who,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Tokens>();
  };
  const register = (t: Tokens, endpoint: string, installation?: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: { ...h.as(t), ...(installation ? { 'x-fdv-installation': installation } : {}) },
      payload: {
        kind: 'unified_push',
        endpoint,
        keys: { p256dh: 'phone-p256dh', auth: 'phone-auth' },
      },
    });
  const phoneWith = async (
    endpoint = `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`,
  ) => {
    const installation = randomUUID();
    const t = await signIn(installation);
    const res = await register(t, endpoint, installation);
    expect(res.statusCode, res.body).toBe(201);
    return { t, endpoint, installation, id: res.json<{ id: string }>().id };
  };
  const rows = (endpoint: string) =>
    admin
      .selectFrom('device')
      .select(['id', 'kind', 'session_id', 'installation_id'])
      .where('endpoint', '=', endpoint)
      .execute();
  const pushesTo = (endpoint: string) =>
    h.jobs
      .filter((j) => j.name === 'push.send')
      .map((j) => j.data as { message: { type: string }; targets: { endpoint: string }[] })
      .filter((d) => d.targets.some((t) => t.endpoint === endpoint))
      .map((d) => d.message);
  const errorOf = (res: { json: <T>() => T }) =>
    res.json<{ error: { message: string } }>().error.message;

  it('the phone app registers its distributor address, as the session that asked', async () => {
    const phone = await phoneWith();
    expect(await rows(phone.endpoint)).toEqual([
      {
        id: phone.id,
        kind: 'unified_push',
        session_id: expect.any(String) as unknown,
        installation_id: phone.installation,
      },
    ]);
    const list = await h.app.inject({ url: '/api/v1/devices', headers: h.as(phone.t) });
    const mine = list.json<{ items: { id: string; kind: string; this_session: boolean }[] }>()
      .items;
    expect(mine.find((d) => d.id === phone.id)).toMatchObject({
      kind: 'unified_push',
      this_session: true,
    });
    // From another session it is not this one's.
    const other = await h.app.inject({ url: '/api/v1/devices', headers: h.as(owner) });
    expect(
      other
        .json<{ items: { id: string; this_session: boolean }[] }>()
        .items.find((d) => d.id === phone.id),
    ).toMatchObject({
      this_session: false,
    });
  });

  it('http endpoints are refused', async () => {
    const res = await register(owner, 'http://ntfy.example.test/upplain');
    expect(res.statusCode).toBe(422);
    expect(errorOf(res)).toBe('Push addresses must start with https://.');
  });

  it('an address inside the vault’s own network is refused, by name or written out', async () => {
    for (const endpoint of [
      'https://inside.example.test/up1',
      'https://metadata.example.test/up2',
      'https://127.0.0.1/up3',
      'https://[::1]/up4',
      'https://10.0.0.5:8443/up5',
      // IPv4 inside IPv6: `new URL` writes these in hex.
      'https://[::ffff:127.0.0.1]/up6',
      'https://[::ffff:a9fe:a9fe]/up7',
      'https://[64:ff9b::10.0.0.5]/up8',
    ]) {
      const res = await register(owner, endpoint);
      expect(res.statusCode, endpoint).toBe(422);
      expect(errorOf(res)).toBe(
        "That push address points inside the vault's own network, which isn't allowed.",
      );
    }
  });

  it('the upsert moves a device to the new session', async () => {
    const installation = randomUUID();
    const endpoint = `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`;
    const first = await signIn(installation);
    expect((await register(first, endpoint, installation)).statusCode).toBe(201);
    const before = (await rows(endpoint))[0]?.session_id;
    const second = await signIn(installation);
    expect((await register(second, endpoint, installation)).statusCode).toBe(201);
    const after = await rows(endpoint);
    expect(after).toHaveLength(1);
    expect(after[0]?.session_id).not.toBe(before);
    // A phone that comes back with a new address leaves no old one behind.
    const fresh = `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`;
    expect((await register(second, fresh, installation)).statusCode).toBe(201);
    expect(await rows(endpoint)).toEqual([]);
    expect(await rows(fresh)).toHaveLength(1);
  });

  it("signing out stops that phone's push", async () => {
    const phone = await phoneWith();
    const out = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: h.as(phone.t),
    });
    expect(out.statusCode).toBe(204);
    expect(await rows(phone.endpoint)).toEqual([]);
    expect(pushesTo(phone.endpoint)).toEqual([{ v: 1, type: 'session_ended' }]);
  });

  it('revoking a session from another device stops its push and sends session_ended', async () => {
    const phone = await phoneWith();
    const sessions = await h.app.inject({ url: '/api/v1/auth/sessions', headers: h.as(owner) });
    const theirs = sessions.json<{ items: { id: string }[] }>().items.map((s) => s.id);
    const phoneSession = (await rows(phone.endpoint))[0]?.session_id as string;
    expect(theirs).toContain(phoneSession);
    const revoked = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${phoneSession}`,
      headers: h.as(owner),
    });
    expect(revoked.statusCode).toBe(204);
    expect(await rows(phone.endpoint)).toEqual([]);
    expect(pushesTo(phone.endpoint)).toEqual([{ v: 1, type: 'session_ended' }]);
  });

  it('reuse revocation and a password reset remove devices', async () => {
    // Reuse: a refresh token presented twice ends its session.
    const t = await signIn(null);
    const endpoint = `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`;
    expect((await register(t, endpoint)).statusCode).toBe(201);
    const rotated = await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: t.refresh_token },
    });
    expect(rotated.statusCode).toBe(200);
    const replay = await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: t.refresh_token },
    });
    expect(replay.statusCode).toBe(401);
    expect(await rows(endpoint)).toEqual([]);
    expect(pushesTo(endpoint)).toEqual([{ v: 1, type: 'session_ended' }]);

    // A reset: everything signs out, every device goes.
    await h.join(owner, {
      name: 'Sam',
      email: 'sam-up@example.test',
      role: 'adult',
      password: 'sam correct horse battery',
    });
    const sam = await signIn(randomUUID(), {
      email: 'sam-up@example.test',
      password: 'sam correct horse battery',
    });
    const samPhone = `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`;
    expect((await register(sam, samPhone)).statusCode).toBe(201);
    await h.app.inject({
      ...peer(),
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      payload: { email: 'sam-up@example.test' },
    });
    const link = h.jobs
      .filter((j) => j.name === 'alert.send')
      .map((j) => (j.data as { url?: string }).url)
      .filter(Boolean)
      .at(-1) as string;
    const reset = await h.app.inject({
      ...peer(),
      method: 'POST',
      url: `/api/v1/password-resets/${link.slice(link.lastIndexOf('/') + 1)}`,
      payload: { password: 'sam has a new password now' },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(await rows(samPhone)).toEqual([]);
    expect(pushesTo(samPhone)).toEqual([{ v: 1, type: 'session_ended' }]);
  });

  it('a removed sign-in takes its phone with it', async () => {
    await h.join(owner, {
      name: 'Kit',
      email: 'kit-up@example.test',
      role: 'adult',
      password: 'kit correct horse battery',
    });
    const kit = await signIn(randomUUID(), {
      email: 'kit-up@example.test',
      password: 'kit correct horse battery',
    });
    const kitPhone = `https://ntfy.example.test/up${randomUUID().slice(0, 8)}`;
    expect((await register(kit, kitPhone)).statusCode).toBe(201);
    const members = await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) });
    const kitMember = members
      .json<{ items: { id: string; display_name: string }[] }>()
      .items.find((m) => m.display_name === 'Kit');
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/members/${kitMember?.id}/sign-in`,
      headers: h.as(owner),
    });
    expect(removed.statusCode, removed.body).toBeLessThan(300);
    expect(await rows(kitPhone)).toEqual([]);
    expect(pushesTo(kitPhone)).toEqual([{ v: 1, type: 'session_ended' }]);
  });

  it('a test push reaches only your own device', async () => {
    const phone = await phoneWith();
    const mine = await h.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${phone.id}/test`,
      headers: h.as(phone.t),
    });
    expect(mine.statusCode).toBe(202);
    expect(pushesTo(phone.endpoint)).toEqual([{ v: 1, type: 'test' }]);
    // Somebody else's: as if it did not exist.
    await h.join(owner, {
      name: 'Lee',
      email: 'lee-up@example.test',
      role: 'adult',
      password: 'lee correct horse battery',
    });
    const lee = await signIn(randomUUID(), {
      email: 'lee-up@example.test',
      password: 'lee correct horse battery',
    });
    const theirs = await h.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${phone.id}/test`,
      headers: h.as(lee),
    });
    expect(theirs.statusCode).toBe(404);
    expect(pushesTo(phone.endpoint)).toHaveLength(1);
  });

  it('a device whose session expired says so, and is not sent a test', async () => {
    const phone = await phoneWith();
    await admin
      .updateTable('session')
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where('id', '=', (await rows(phone.endpoint))[0]?.session_id as string)
      .execute();
    const list = await h.app.inject({ url: '/api/v1/devices', headers: h.as(owner) });
    expect(
      list
        .json<{ items: { id: string; working: boolean; signed_out: boolean }[] }>()
        .items.find((d) => d.id === phone.id),
    ).toMatchObject({ working: false, signed_out: true });
    const test = await h.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${phone.id}/test`,
      headers: h.as(owner),
    });
    expect(test.statusCode).toBe(409);
    expect(errorOf(test)).toBe(
      'That device is signed out. Sign in on it again and it will hear from the vault.',
    );
    expect(pushesTo(phone.endpoint)).toHaveLength(0);
  });

  it('the capability says so, exactly when push is set up', async () => {
    const caps = await h.app.inject('/api/v1/capabilities');
    const features = caps.json<{ features: { unified_push: boolean; push: boolean } }>().features;
    expect(typeof features.unified_push).toBe('boolean');
    expect(features.unified_push).toBe(features.push);
  });
});
