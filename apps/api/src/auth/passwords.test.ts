import { randomUUID } from 'node:crypto';
import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { deriveKey, EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import type { DocumentView } from '@fdv/shared';
import FormData from 'form-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from '../test-harness.js';
import { SoftwareAuthenticator } from './passkey-test-authenticator.js';
import { PasswordService } from './passwords.js';
import type { Tokens } from './service.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
const FIRST = 'correct horse battery';

/**
 * Passwords: changing one, and forgetting one.
 *
 * The password itself is the easy half. The half worth testing is the
 * member scope key that has to travel with it — the one that opens the
 * person's *Only me* documents — and the doors that must stay shut.
 */
describe.skipIf(!testAdminUrl())('changing a password', () => {
  let h: Harness;
  let owner: Tokens;
  let secretId: string;
  let secretVersionId: string;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  const change = (body: Record<string, unknown>, t: Tokens = owner) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: h.as(t),
      payload: body,
    });

  const signIn = (password: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'owner@example.test', password },
    });

  /** The member key, opened with what the person knows and nothing else. */
  const unwrapWithPassword = (password: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      new ScopeKeys(new EnvKeyProvider(TEST_MASTER)).unwrapWithCredential(
        trx,
        { householdId: owner.household_id, kind: 'member', memberId: owner.member_id },
        password,
      ),
    );

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: {
        title: 'Counselling notes',
        type_key: 'medical_record',
        owner_member_id: owner.member_id,
      },
    });
    secretId = json<DocumentView>(created).id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'notes.pdf', contentType: 'application/pdf' });
    const up = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${secretId}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    secretVersionId = json<{ id: string }>(up).id;
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${secretId}/visibility`,
      headers: h.as(owner),
      payload: { visibility: 'private' },
    });
  }, 90_000);
  afterAll(() => h.close());

  it('refuses a wrong current password, and says which one was wrong', async () => {
    const res = await change({ current_password: 'nope', new_password: 'a whole new password' });
    expect(res.statusCode).toBe(401);
    expect(json<{ error: { message: string } }>(res).error.message).toMatch(/current password/);
  });

  it('refuses the password you already have', async () => {
    const res = await change({ current_password: FIRST, new_password: FIRST });
    expect(res.statusCode).toBe(422);
  });

  it('refuses a new password that is too short to be worth having', async () => {
    const res = await change({ current_password: FIRST, new_password: 'short' });
    expect(res.statusCode).toBe(422);
    expect(json<{ error: { message: string } }>(res).error.message).toMatch(/10 characters/);
  });

  it('changes it, and the private documents come with it', async () => {
    // Before: the old password opens the member key.
    await expect(unwrapWithPassword(FIRST)).resolves.toBeInstanceOf(Buffer);

    const res = await change({ current_password: FIRST, new_password: 'a whole new password' });
    expect(res.statusCode).toBe(204);

    // After: the new one does, and the old one does not. This is the test
    // that matters — a password change that left the key behind would
    // keep the documents and lose the way into them.
    await expect(unwrapWithPassword('a whole new password')).resolves.toBeInstanceOf(Buffer);
    await expect(unwrapWithPassword(FIRST)).rejects.toThrow();

    expect((await signIn('a whole new password')).statusCode).toBe(200);
    expect((await signIn(FIRST)).statusCode).toBe(401);

    // And the document still opens, through the app, as it always did.
    const file = await h.app.inject({
      url: `/api/v1/versions/${secretVersionId}/content`,
      headers: h.as(owner),
    });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PDF)).toBe(true);
  });

  it('signs the other devices out, and leaves this one alone', async () => {
    const elsewhere = json<Tokens>(await signIn('a whole new password'));
    expect((await h.app.inject({ url: '/api/v1/me', headers: h.as(elsewhere) })).statusCode).toBe(
      200,
    );
    // Both sign-ins have turned notifications on.
    for (const [t, name] of [
      [owner, 'old-laptop'],
      [elsewhere, 'this-phone'],
    ] as const) {
      const registered = await h.app.inject({
        method: 'POST',
        url: '/api/v1/devices',
        headers: h.as(t),
        payload: {
          endpoint: `https://push.example.test/${name}`,
          keys: { p256dh: 'k', auth: 'a' },
        },
      });
      expect(registered.statusCode, registered.body).toBe(201);
    }

    const res = await change(
      { current_password: 'a whole new password', new_password: 'a third password entirely' },
      elsewhere,
    );
    expect(res.statusCode).toBe(204);

    // The session that did it still works; the one that did not is gone.
    expect((await h.app.inject({ url: '/api/v1/me', headers: h.as(elsewhere) })).statusCode).toBe(
      200,
    );
    expect((await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) })).statusCode).toBe(401);
    // And the signed-out one stops being told things: its device is gone.
    const devices = json<{ items: Array<{ endpoint: string }> }>(
      await h.app.inject({ url: '/api/v1/devices', headers: h.as(elsewhere) }),
    ).items.map((d) => d.endpoint);
    expect(devices).toEqual(['https://push.example.test/this-phone']);
    owner = elsewhere;
  });

  it('tells the person it happened, by email and not by push', async () => {
    const alerts = h.jobs.filter((j) => j.name === 'alert.send').map((j) => j.data);
    const last = alerts[alerts.length - 1] as { subject: string; email_only?: boolean };
    expect(last.subject).toMatch(/password was changed/);
    expect(last.email_only).toBe(true);
  });

  it('without the current password, a session that has gone cold is asked to prove it is you', async () => {
    // Signing in *is* presenting a credential, so a session minutes old
    // may set a password without the old one — the same five-minute
    // window as exporting everything or changing where files are kept.
    // The case that matters is the session left open on a desk.
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - 10 * 60 * 1000) })
        .execute(),
    );
    const res = await change({ new_password: 'yet another password' });
    expect(res.statusCode).toBe(403);
    const body = json<{ error: { code: string; action: string } }>(res);
    expect(body.error.code).toBe('step_up_required');
    expect(body.error.action).toBe('change_password');
  });

  it('a passkey is that proof, so somebody who never knew a password can set one', async () => {
    const device = new SoftwareAuthenticator();
    // Adding a passkey asks for a fresh credential too (0.4.2), and the
    // test before this one left the session cold. Warm it, as a step-up
    // with the password would.
    await withSystem(h.db, owner.household_id, (trx) =>
      trx.updateTable('session').set({ verified_at: new Date() }).execute(),
    );
    const options = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/challenge',
      headers: h.as(owner),
    });
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/passkeys',
          headers: h.as(owner),
          payload: { response: device.register(options.json()), label: 'Laptop' },
        })
      ).statusCode,
    ).toBe(201);

    // Age the session past the step-up window, then present the passkey.
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date(Date.now() - 10 * 60 * 1000) })
        .execute(),
    );
    expect((await change({ new_password: 'set by the passkey path' })).statusCode).toBe(403);

    const challenge = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/challenge',
      payload: { email: 'owner@example.test' },
    });
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/auth/step-up',
          headers: h.as(owner),
          payload: { passkey: device.authenticate(challenge.json()) },
        })
      ).statusCode,
    ).toBe(200);

    expect((await change({ new_password: 'set by the passkey path' })).statusCode).toBe(204);
    // The key came back through the master key and was rewrapped, so the
    // new password opens it even though no old one was given.
    await expect(unwrapWithPassword('set by the passkey path')).resolves.toBeInstanceOf(Buffer);
  });
});

describe.skipIf(!testAdminUrl())('forgetting a password', () => {
  let h: Harness;
  let owner: Tokens;
  let sam: Tokens;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  let nth = 0;
  const peer = () => ({ remoteAddress: `10.6.${Math.floor(++nth / 200)}.${nth % 200}` });

  const forgot = (email: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      payload: { email },
      ...peer(),
    });

  /** The link the worker was asked to email, as the person would receive it. */
  const lastLink = (): string | undefined => {
    const alerts = h.jobs.filter((j) => j.name === 'alert.send').map((j) => j.data);
    for (let i = alerts.length - 1; i >= 0; i--) {
      const url = (alerts[i] as { url?: string }).url;
      if (url) return url;
    }
    return undefined;
  };

  const tokenOf = (link: string) => link.slice(link.lastIndexOf('/') + 1);

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    sam = await h.join(owner, { name: 'Sam', email: 'sam@example.test', role: 'adult' });
  }, 90_000);
  afterAll(() => h.close());

  it('answers an unknown address exactly as it answers a known one', async () => {
    const unknown = await forgot('nobody@example.test');
    const known = await forgot('sam@example.test');
    expect(unknown.statusCode).toBe(202);
    expect(known.statusCode).toBe(202);
    expect(unknown.body).toBe(known.body);
    expect(json<{ message: string }>(known).message).toMatch(/If that address/);
  });

  it('sends a link by email only, never as a push to a lock screen', async () => {
    await forgot('sam@example.test');
    const alerts = h.jobs.filter((j) => j.name === 'alert.send').map((j) => j.data);
    const last = alerts[alerts.length - 1] as {
      email_only?: boolean;
      url?: string;
      url_label?: string;
      account_ids: string[];
    };
    expect(last.email_only).toBe(true);
    // By the operator's mail server, never the household's: an owner can
    // point the household's at themselves and read the link.
    expect((last as { via?: string }).via).toBe('operator');
    expect(last.url_label).toBe('Set a new password');
    expect(last.url).toMatch(/\/reset\/[A-Za-z0-9_-]{20,}$/);
  });

  it('shows whose account it is before anything is typed', async () => {
    await forgot('sam@example.test');
    const res = await h.app.inject({
      url: `/api/v1/password-resets/${tokenOf(lastLink() as string)}`,
      ...peer(),
    });
    expect(res.statusCode).toBe(200);
    expect(
      json<{ email: string; household_name: string; issued_by_operator: boolean }>(res),
    ).toMatchObject({
      email: 'sam@example.test',
      household_name: 'The Test family',
      issued_by_operator: false,
    });
  });

  it('asking again retires the first link: nobody holds two', async () => {
    await forgot('sam@example.test');
    const first = tokenOf(lastLink() as string);
    await forgot('sam@example.test');
    const second = tokenOf(lastLink() as string);
    expect(second).not.toBe(first);
    expect(
      (await h.app.inject({ url: `/api/v1/password-resets/${first}`, ...peer() })).statusCode,
    ).toBe(404);
    expect(
      (await h.app.inject({ url: `/api/v1/password-resets/${second}`, ...peer() })).statusCode,
    ).toBe(200);
  });

  it('sets the new password, signs every device out, and does not sign anyone in', async () => {
    await forgot('sam@example.test');
    const token = tokenOf(lastLink() as string);

    // Sam is signed in somewhere at this moment.
    expect((await h.app.inject({ url: '/api/v1/me', headers: h.as(sam) })).statusCode).toBe(200);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/password-resets/${token}`,
      payload: { password: 'sam has a new password' },
      ...peer(),
    });
    expect(res.statusCode).toBe(200);
    // No tokens in the answer: two-step sign-in must still be asked for.
    expect(Object.keys(json<Record<string, unknown>>(res))).toEqual(['email']);

    expect((await h.app.inject({ url: '/api/v1/me', headers: h.as(sam) })).statusCode).toBe(401);
    const back = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      payload: { email: 'sam@example.test', password: 'sam has a new password' },
    });
    expect(back.statusCode).toBe(200);
  });

  it("and Sam's own private documents open with the password they just chose", async () => {
    const fresh = json<Tokens>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: 'sam@example.test', password: 'sam has a new password' },
      }),
    );
    const key = await withSystem(h.db, owner.household_id, (trx) =>
      new ScopeKeys(new EnvKeyProvider(TEST_MASTER)).unwrapWithCredential(
        trx,
        { householdId: fresh.household_id, kind: 'member', memberId: fresh.member_id },
        'sam has a new password',
      ),
    );
    expect(key).toBeInstanceOf(Buffer);
  });

  it('a reset removes every passkey, and nothing else', async () => {
    // A passkey planted from a borrowed session must not outlast the reset
    // its owner does to get their account back.
    const account = await h.db
      .selectFrom('account')
      .select('id')
      .where('email', '=', 'sam@example.test')
      .executeTakeFirstOrThrow();
    await h.db
      .insertInto('credential')
      .values([
        { account_id: account.id, kind: 'passkey', label: 'Planted' },
        { account_id: account.id, kind: 'recovery_share', label: 'Kept' },
      ])
      .execute();
    await forgot('sam@example.test');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/password-resets/' + tokenOf(lastLink() as string),
      payload: { password: 'after the passkey went' },
      ...peer(),
    });
    expect(res.statusCode).toBe(200);
    const left = await h.db
      .selectFrom('credential')
      .select('kind')
      .where('account_id', '=', account.id)
      .execute();
    expect(left.map((c) => c.kind)).toEqual(['recovery_share']);
  });

  it('a link is good once', async () => {
    await forgot('sam@example.test');
    const token = tokenOf(lastLink() as string);
    const spend = () =>
      h.app.inject({
        method: 'POST',
        url: `/api/v1/password-resets/${token}`,
        payload: { password: 'one more new password' },
        ...peer(),
      });
    expect((await spend()).statusCode).toBe(200);
    expect((await spend()).statusCode).toBe(404);
  });

  it('an expired link is refused, in the same words as every other dead one', async () => {
    await forgot('sam@example.test');
    const token = tokenOf(lastLink() as string);
    await h.db
      .updateTable('password_reset')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('used_at', 'is', null)
      .execute();
    const res = await h.app.inject({ url: `/api/v1/password-resets/${token}`, ...peer() });
    expect(res.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('reset_not_valid');
  });

  it('a link nobody issued is refused the same way', async () => {
    const res = await h.app.inject({ url: `/api/v1/password-resets/${'a'.repeat(43)}`, ...peer() });
    expect(res.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('reset_not_valid');
  });

  /**
   * The rule the whole privacy wall rests on. An owner who could reset
   * another adult's password could sign in as them and read their private
   * documents, so there is no endpoint that lets them — not under members,
   * not under accounts, not anywhere.
   */
  it('an owner has no way to reset anybody else’s password', async () => {
    const members = json<{ items: Array<{ id: string; display_name: string }> }>(
      await h.app.inject({ url: '/api/v1/members', headers: h.as(owner) }),
    ).items;
    const samMember = members.find((m) => m.display_name === 'Sam') as { id: string };

    for (const url of [
      `/api/v1/members/${samMember.id}/reset-password`,
      `/api/v1/members/${samMember.id}/password`,
      '/api/v1/auth/password/reset',
      `/api/v1/accounts/${samMember.id}/password`,
    ]) {
      const res = await h.app.inject({ method: 'POST', url, headers: h.as(owner), payload: {} });
      expect(res.statusCode, url).toBe(404);
    }

    // Nor by asking for Sam's reset to be emailed and reading it: the
    // link goes to Sam's own address, which is the point.
    await forgot('sam@example.test');
    const alerts = h.jobs.filter((j) => j.name === 'alert.send').map((j) => j.data);
    const last = alerts[alerts.length - 1] as { account_ids: string[] };
    const ownerAccount = json<{ account_id: string }>(
      await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) }),
    ).account_id;
    expect(last.account_ids).not.toContain(ownerAccount);
  });

  it('every one of these is in the audit chain', async () => {
    const rows = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action', 'detail'])
        .where('action', 'like', 'auth.password_%')
        .orderBy('id')
        .execute(),
    );
    expect(rows.map((r) => r.action)).toContain('auth.password_reset');
    // And no password, hash or token is written into it.
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/\$argon2|new password/);
  });

  it('the key material is never the thing that was emailed', async () => {
    const alerts = h.jobs.filter((j) => j.name === 'alert.send').map((j) => j.data);
    const text = JSON.stringify(alerts);
    expect(text).not.toMatch(/\$argon2/);
    expect(text).not.toMatch(/password: /);
  });

  it('the vault key is unused here: deriveKey is for storage, not for people', () => {
    // Guard against somebody reaching for the wrong key next time.
    expect(deriveKey(TEST_MASTER, 'vault-credentials')).not.toEqual(
      deriveKey(TEST_MASTER, 'totp-secrets'),
    );
  });
});

/**
 * Where a reset link may travel when whoever runs the server has not set
 * FDV_SMTP_URL. The household's own mail server is one an owner controls —
 * point it at a mail catcher, press "forgotten password" for another adult,
 * and the link arrives in the owner's hands. So without the operator's
 * server, a link goes by email only to the one person who controls the
 * household's: its only owner. Everybody else asks whoever runs the vault.
 */
describe.skipIf(!testAdminUrl())('reset links and whose mail server carries them', () => {
  let h: Harness;
  let owner: Tokens;
  const sent: Array<{ accountIds: string[]; operatorMail?: boolean }> = [];
  let passwords: PasswordService;

  beforeAll(async () => {
    h = await createHarness();
    owner = await h.setup();
    await h.join(owner, { name: 'Sam', email: 'sam-mail@example.test', role: 'adult' });
    passwords = new PasswordService(
      h.db,
      new ScopeKeys(new EnvKeyProvider(TEST_MASTER)),
      null,
      'http://localhost:8080',
      async (a) => {
        sent.push(a);
      },
      false,
    );
  }, 90_000);
  afterAll(() => h.close());

  const resetsFor = (email: string) =>
    h.db
      .selectFrom('password_reset')
      .innerJoin('account', 'account.id', 'password_reset.account_id')
      .select('password_reset.id')
      .where('account.email', '=', email)
      .execute();

  it('another adult is sent nothing, and no link is made that could be caught', async () => {
    await passwords.forgot('sam-mail@example.test', {});
    expect(sent).toEqual([]);
    expect(await resetsFor('sam-mail@example.test')).toEqual([]);
  });

  it('the only owner is sent theirs through the mail server they control', async () => {
    await passwords.forgot('owner@example.test', {});
    expect(sent).toHaveLength(1);
    expect(sent[0]?.operatorMail).toBeUndefined();
  });

  it('once there is a second owner, not even an owner is', async () => {
    const co = await h.join(owner, {
      name: 'Co',
      email: 'co-owner@example.test',
      role: 'owner',
    });
    expect(co.role).toBe('owner');
    sent.length = 0;
    await passwords.forgot('owner@example.test', {});
    expect(sent).toEqual([]);
  });
});
