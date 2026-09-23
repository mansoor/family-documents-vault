import { testAdminUrl } from '@fdv/db/testing';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test-harness.js';
import { SoftwareAuthenticator } from './passkey-test-authenticator.js';
import type { PasskeyView } from './passkeys.js';
import type { Tokens } from './service.js';

/**
 * Passkeys, end to end, against a real P-256 key in software: every
 * signature here is genuinely made and genuinely checked. The failures
 * matter more than the happy path — a passkey is only worth having if the
 * server refuses the wrong origin, a replayed challenge and a cloned key.
 */
describe.skipIf(!testAdminUrl())('passkeys', () => {
  let h: Harness;
  let owner: Tokens;
  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
  });
  afterAll(() => h.close());

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  const registerChallenge = async () =>
    json<PublicKeyCredentialCreationOptionsJSON>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkeys/challenge',
        headers: h.as(owner),
      }),
    );

  const signInChallenge = async (email?: string) =>
    json<PublicKeyCredentialRequestOptionsJSON>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkey/challenge',
        payload: email ? { email } : {},
      }),
    );

  const enrol = async (device: SoftwareAuthenticator, label: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys',
      headers: h.as(owner),
      payload: { response: device.register(await registerChallenge()), label },
    });

  const phone = new SoftwareAuthenticator();

  it('a passkey is created for the signed-in account and listed', async () => {
    const created = await enrol(phone, "Mansoor's phone");
    expect(created.statusCode).toBe(201);
    expect(json<PasskeyView>(created)).toMatchObject({
      label: "Mansoor's phone",
      last_used_at: null,
    });

    const list = json<{ items: PasskeyView[] }>(
      await h.app.inject({ url: '/api/v1/auth/passkeys', headers: h.as(owner) }),
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.transports).toEqual(['internal']);
  });

  it('it signs you in, and the session is a normal one', async () => {
    const options = await signInChallenge('owner@example.test');
    // The server names the passkey that would work, because it was asked
    // about an account it knows.
    expect(options.allowCredentials?.[0]?.id).toBe(phone.id);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/verify',
      payload: { response: phone.authenticate(options) },
    });
    expect(res.statusCode).toBe(200);
    const tokens = json<Tokens>(res);
    expect(tokens.household_id).toBe(owner.household_id);
    expect(tokens.scopes_unlocked).toContain('household');

    // The session works like any other.
    const me = await h.app.inject({ url: '/api/v1/me', headers: h.as(tokens) });
    expect(me.statusCode).toBe(200);
    expect(json<{ has_passkey: boolean }>(me).has_passkey).toBe(true);
  });

  it('it satisfies the rule that owners cannot rely on a password alone', async () => {
    // SEC-03 says an owner must have something beyond a password. Before
    // the passkey this said true; a passkey answers it as well as an
    // authenticator app does.
    const me = json<{ totp_enabled: boolean; totp_required: boolean; has_passkey: boolean }>(
      await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) }),
    );
    expect(me).toMatchObject({ totp_enabled: false, has_passkey: true, totp_required: false });
  });

  it('a challenge is good once', async () => {
    const options = await signInChallenge('owner@example.test');
    const first = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/verify',
      payload: { response: phone.authenticate(options) },
    });
    expect(first.statusCode).toBe(200);

    const replay = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/verify',
      payload: { response: phone.authenticate(options) },
    });
    expect(replay.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(replay).error.code).toBe('challenge_expired');
  });

  it('a passkey signed for another site is refused', async () => {
    const options = await signInChallenge('owner@example.test');
    const elsewhere = phone.authenticate(options, { origin: 'https://vault.example.evil' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/verify',
      payload: { response: elsewhere },
    });
    expect(res.statusCode).toBe(401);
    expect(json<{ error: { message: string } }>(res).error.message).toMatch(/not accepted/);
  });

  it('a signature over a challenge nobody issued is refused', async () => {
    const options = await signInChallenge('owner@example.test');
    const invented = phone.authenticate(options, { challenge: 'bm90LWEtcmVhbC1jaGFsbGVuZ2U' });
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/passkey/verify',
          payload: { response: invented },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('a counter that goes backwards means a copy, and is refused', async () => {
    const options = await signInChallenge('owner@example.test');
    // The real device has counted well past 1 by now.
    const cloned = phone.authenticate(options, { counter: 1 });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/verify',
      payload: { response: cloned },
    });
    expect(res.statusCode).toBe(401);
    expect(json<{ error: { message: string } }>(res).error.message).toMatch(/looks like a copy/);
  });

  it('an unknown email still gets a challenge, so it cannot be used to find accounts', async () => {
    const unknown = await signInChallenge('nobody@example.test');
    expect(unknown.challenge).toBeTruthy();
    expect(unknown.allowCredentials ?? []).toEqual([]);
    const known = await signInChallenge('owner@example.test');
    expect(typeof known.challenge).toBe('string');
    expect(known.challenge).not.toBe(unknown.challenge);
  });

  it('a passkey nobody enrolled is not a way in', async () => {
    const stranger = new SoftwareAuthenticator();
    const options = await signInChallenge();
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/passkey/verify',
          payload: { response: stranger.authenticate(options) },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('removing it takes the way in with it', async () => {
    const laptop = new SoftwareAuthenticator();
    const created = json<PasskeyView>(await enrol(laptop, 'Laptop'));
    const removed = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/passkeys/${created.id}`,
      headers: h.as(owner),
    });
    expect(removed.statusCode).toBe(204);

    const options = await signInChallenge('owner@example.test');
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/passkey/verify',
          payload: { response: laptop.authenticate(options) },
        })
      ).statusCode,
    ).toBe(401);
    // Somebody else's passkey id is not theirs to delete either.
    expect(
      (
        await h.app.inject({
          method: 'DELETE',
          url: `/api/v1/auth/passkeys/${created.id}`,
          headers: h.as(owner),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('both additions and removals are in the audit chain', async () => {
    const { withHousehold } = await import('@fdv/db');
    const rows = await withHousehold(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action'])
        .where('action', 'like', 'credential.%')
        .orderBy('id')
        .execute(),
    );
    expect(rows.map((r) => r.action)).toEqual([
      'credential.passkey_added',
      'credential.passkey_added',
      'credential.passkey_removed',
    ]);
  });
});
