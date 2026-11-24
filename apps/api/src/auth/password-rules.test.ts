import { EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import { PASSWORD_RULES_DEFAULT, type PasswordRules, type PasswordRulesView } from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, TEST_SETUP_TOKEN, type Harness } from '../test-harness.js';
import { isCommonPassword } from './password-rules.js';
import { PasswordService } from './passwords.js';
import type { Tokens } from './service.js';

let peers = 0;
const peer = () => `10.91.${(peers >> 8) & 0xff}.${peers++ & 0xff}`;
const errorOf = (r: LightMyRequestResponse) =>
  r.json<{ error?: { code?: string; message?: string; detail?: string; action?: string } }>()
    .error ?? {};

/** The session an access token names. */
const sidOf = (t: Tokens) =>
  (
    JSON.parse(Buffer.from(t.access_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      sid: string;
    }
  ).sid;

describe('the list of common passwords kept in the vault', () => {
  it('knows the common ones, however they are cased or dressed up, and not a sentence', async () => {
    expect(await isCommonPassword('password')).toBe(true);
    expect(await isCommonPassword('Password1234!')).toBe(true);
    expect(await isCommonPassword('QWERTYUIOP')).toBe(true);
    expect(await isCommonPassword('1234567890')).toBe(true);
    expect(await isCommonPassword('correct horse battery')).toBe(false);
    expect(await isCommonPassword('pelican crossing at noon')).toBe(false);
  });
});

/**
 * Password rules an owner sets (Settings → Security): read by everybody
 * signed in, changed by an owner, and held to wherever a sign-in password is
 * set — a change, a reset link, an invitation accepted, and setup — with a
 * `400 password_rules` that says everything missing.
 */
describe.skipIf(!testAdminUrl())('password rules', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let adult: Tokens;
  let passwords: PasswordService;

  const ADULT = { email: 'ada-rules@example.test', password: 'another correct horse' };

  const get = (url: string, t: Tokens) =>
    h.app.inject({ url, headers: h.as(t), remoteAddress: peer() });
  const put = (t: Tokens, rules: PasswordRules) =>
    h.app.inject({
      method: 'PUT',
      url: '/api/v1/household/password-rules',
      headers: h.as(t),
      payload: rules,
      remoteAddress: peer(),
    });
  /** The owner's rules set directly by the owner, with a credential just given. */
  const setRules = async (rules: Partial<PasswordRules>) => {
    await fresh(owner);
    const res = await put(owner, { ...PASSWORD_RULES_DEFAULT, ...rules });
    expect(res.statusCode, res.body).toBe(200);
  };
  /** A credential given just now, or long enough ago to be asked again. */
  const fresh = (t: Tokens) =>
    admin.query('update session set verified_at = now() where id = $1', [sidOf(t)]);
  const stale = (t: Tokens) =>
    admin.query(`update session set verified_at = now() - interval '1 hour' where id = $1`, [
      sidOf(t),
    ]);
  const lines = async () =>
    (
      await admin.query<{ detail: Record<string, unknown> }>(
        `select detail from audit_event where action = 'household.password_rules_changed' order by id`,
      )
    ).rows.map((r) => r.detail);

  const change = (t: Tokens, current: string, next: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: h.as(t),
      payload: { current_password: current, new_password: next },
      remoteAddress: peer(),
    });

  /** An invitation for somebody new, ready to accept: its link and its code. */
  const invite = async (name: string, email: string) => {
    await fresh(owner);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: h.as(owner),
      payload: { display_name: name, email, role: 'adult' },
      remoteAddress: peer(),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ link_token: string; code: string }>();
  };
  const accept = (link: { link_token: string; code: string }, password: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token: link.link_token, code: link.code, password },
      remoteAddress: peer(),
    });

  /** A reset link for somebody, as whoever runs the server makes one. */
  const resetLink = async (email: string) => {
    const account = await h.db
      .selectFrom('account')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    return (await passwords.issue(account.id, 'operator')).token;
  };
  const completeReset = (token: string, password: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/password-resets/complete',
      payload: { token, password },
      remoteAddress: peer(),
    });

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 20_000 });
    admin = createPool(h.adminUrl, 1);
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Ada Lovelace', role: 'adult', ...ADULT });
    passwords = new PasswordService(
      h.db,
      new ScopeKeys(new EnvKeyProvider(TEST_MASTER)),
      null,
      'http://localhost:8080',
    );
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('the capability document says so', async () => {
    const caps = await h.app.inject({ url: '/api/v1/capabilities' });
    expect(caps.json<{ features: { password_rules?: boolean } }>().features.password_rules).toBe(
      true,
    );
  });

  it('every household starts with 10 characters and common passwords refused, read by everybody signed in', async () => {
    expect((await get('/api/v1/household/password-rules', owner)).json()).toEqual({
      ...PASSWORD_RULES_DEFAULT,
      can_change: true,
    });
    expect((await get('/api/v1/household/password-rules', adult)).json()).toEqual({
      ...PASSWORD_RULES_DEFAULT,
      can_change: false,
    });
  });

  it('only an owner changes them, the database too', async () => {
    const res = await put(adult, { ...PASSWORD_RULES_DEFAULT, min_length: 20 });
    expect([res.statusCode, errorOf(res).code]).toEqual([403, 'forbidden']);
    // Round the API: the household's own rule refuses an adult as well.
    await expect(
      admin.query(
        `select set_config('app.actor', 'account', true), set_config('app.role', 'adult', true);
         update household set password_min_length = 30`,
      ),
    ).rejects.toThrow(/only an owner sets/);
    expect((await get('/api/v1/household/password-rules', owner)).json()).toMatchObject({
      min_length: 10,
    });
  });

  it('refuses a least length outside 10 to 64, or a body missing a switch', async () => {
    for (const min_length of [9, 65, 12.5]) {
      const res = await put(owner, { ...PASSWORD_RULES_DEFAULT, min_length });
      expect([res.statusCode, errorOf(res).code]).toEqual([422, 'validation_failed']);
    }
    const partial = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/household/password-rules',
      headers: h.as(owner),
      payload: { min_length: 12 },
      remoteAddress: peer(),
    });
    expect(partial.statusCode).toBe(422);
  });

  it('stricter asks nothing; looser asks to confirm it’s you; each change is in the activity log', async () => {
    await stale(owner);
    const stricter = { ...PASSWORD_RULES_DEFAULT, min_length: 14, needs_symbol: true };
    const res = await put(owner, stricter);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<PasswordRulesView>()).toEqual({ ...stricter, can_change: true });
    // The same again changes nothing, and writes nothing.
    expect((await put(owner, stricter)).statusCode).toBe(200);
    const looser = await put(owner, { ...stricter, needs_symbol: false });
    expect([looser.statusCode, errorOf(looser).code, errorOf(looser).action]).toEqual([
      403,
      'step_up_required',
      'weaken_password_rules',
    ]);
    const shorter = await put(owner, { ...stricter, min_length: 12 });
    expect(errorOf(shorter).code).toBe('step_up_required');
    expect((await get('/api/v1/household/password-rules', owner)).json()).toMatchObject(stricter);
    await fresh(owner);
    expect((await put(owner, PASSWORD_RULES_DEFAULT)).statusCode).toBe(200);
    expect(await lines()).toEqual([
      { ...stricter, was: PASSWORD_RULES_DEFAULT },
      { ...PASSWORD_RULES_DEFAULT, was: stricter },
    ]);
    const activity = (await get('/api/v1/audit', adult))
      .json<{ items: Array<{ text: string }> }>()
      .items.map((l) => l.text);
    expect(activity).toContainEqual(
      expect.stringContaining(
        'changed the password rules: at least 14 characters, with a symbol; common passwords refused',
      ),
    );
  });

  describe('changing your own password', () => {
    it('lets in 10 characters that are not common, by the rules every household starts with', async () => {
      const res = await change(adult, ADULT.password, 'pelican at 9');
      expect(res.statusCode, res.body).toBe(204);
      ADULT.password = 'pelican at 9';
    });

    it('refuses fewer characters, a common password, and your own email or name', async () => {
      for (const [next, message, detail] of [
        ['Xq7 vvz', 'Use at least 10 characters.', 'length'],
        ['Password1234', 'That password is too common: choose another.', 'common'],
        ['qwertyuiop', 'That password is too common: choose another.', 'common'],
        [
          ADULT.email,
          'That password is your own email address or name: choose another.',
          'personal',
        ],
        [
          'Lovelace2024!',
          'That password is your own email address or name: choose another.',
          'personal',
        ],
      ] as const) {
        const res = await change(adult, ADULT.password, next);
        expect([res.statusCode, errorOf(res).code, errorOf(res).message], next).toEqual([
          400,
          'password_rules',
          message,
        ]);
        expect(errorOf(res).detail).toBe(detail);
      }
    });

    it('each switch refuses what it should, and the refusal says everything missing', async () => {
      await setRules({
        min_length: 16,
        needs_upper: true,
        needs_lower: true,
        needs_number: true,
        needs_symbol: true,
      });
      for (const [next, message] of [
        ['xqvvz', 'Use at least 16 characters, with an uppercase letter, a number and a symbol.'],
        ['all lower case words here', 'Add an uppercase letter and a number.'],
        ['ALL UPPER CASE WORDS 4', 'Add a lowercase letter.'],
        ['NoNumbersOrSymbolsHere', 'Add a number and a symbol.'],
        ['NoSymbolsHere1234567', 'Add a symbol.'],
      ] as const) {
        const res = await change(adult, ADULT.password, next);
        expect([res.statusCode, errorOf(res).code, errorOf(res).message], next).toEqual([
          400,
          'password_rules',
          message,
        ]);
      }
      // Nothing was changed by any of them.
      const ok = await change(adult, ADULT.password, 'Pelican crossing #9');
      expect(ok.statusCode, ok.body).toBe(204);
      ADULT.password = 'Pelican crossing #9';
      await setRules(PASSWORD_RULES_DEFAULT);
    });

    it('with the common switch off, a common password of the length is let in', async () => {
      await setRules({ refuse_common: false });
      const res = await change(adult, ADULT.password, 'password1234');
      expect(res.statusCode, res.body).toBe(204);
      ADULT.password = 'password1234';
      await setRules(PASSWORD_RULES_DEFAULT);
    });

    it('a password set before stronger rules still signs in', async () => {
      await setRules({ min_length: 30 });
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { email: ADULT.email, password: ADULT.password },
        remoteAddress: peer(),
      });
      expect(res.statusCode, res.body).toBe(200);
      await setRules(PASSWORD_RULES_DEFAULT);
    });
  });

  describe('a reset link', () => {
    it('shows the rules before anything is typed, and holds the new password to them', async () => {
      await setRules({ min_length: 12, needs_number: true });
      const token = await resetLink(ADULT.email);
      const preview = await h.app.inject({
        method: 'POST',
        url: '/api/v1/password-resets/lookup',
        payload: { token },
        remoteAddress: peer(),
      });
      expect(preview.json<{ password_rules: PasswordRules }>().password_rules).toEqual({
        ...PASSWORD_RULES_DEFAULT,
        min_length: 12,
        needs_number: true,
      });
      const weak = await completeReset(token, 'no numbers in this');
      expect([weak.statusCode, errorOf(weak).code, errorOf(weak).message]).toEqual([
        400,
        'password_rules',
        'Add a number.',
      ]);
      const common = await completeReset(token, 'password12345');
      expect(errorOf(common).message).toBe('That password is too common: choose another.');
      // The link was not spent by either.
      const done = await completeReset(token, 'a reset with 1 number');
      expect(done.statusCode, done.body).toBe(200);
      ADULT.password = 'a reset with 1 number';
      await setRules(PASSWORD_RULES_DEFAULT);
    });

    it('the path form is held to them too', async () => {
      const token = await resetLink(ADULT.email);
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/v1/password-resets/${token}`,
        payload: { password: 'iloveyou' },
        remoteAddress: peer(),
      });
      expect([res.statusCode, errorOf(res).code]).toEqual([400, 'password_rules']);
    });
  });

  describe('an invitation', () => {
    it('shows the rules, and holds the chosen password to them', async () => {
      await setRules({ needs_upper: true });
      const link = await invite('Grace Hopper', 'grace-rules@example.test');
      const preview = await h.app.inject({
        method: 'POST',
        url: '/api/v1/invitations/lookup',
        payload: { token: link.link_token },
        remoteAddress: peer(),
      });
      expect(preview.json<{ password_rules: PasswordRules }>().password_rules).toEqual({
        ...PASSWORD_RULES_DEFAULT,
        needs_upper: true,
      });
      for (const [password, message] of [
        ['all lower case', 'Add an uppercase letter.'],
        ['Football2024', 'That password is too common: choose another.'],
        ['GraceHopper99', 'That password is your own email address or name: choose another.'],
        ['Kz8 Qp', 'Use at least 10 characters.'],
      ] as const) {
        const res = await accept(link, password);
        expect([res.statusCode, errorOf(res).code, errorOf(res).message], password).toEqual([
          400,
          'password_rules',
          message,
        ]);
      }
      // None of those used a try of its code.
      const tries = await admin.query<{ attempts: number }>(
        'select attempts from invitation where email = $1',
        ['grace-rules@example.test'],
      );
      expect(tries.rows).toEqual([{ attempts: 0 }]);
      const ok = await accept(link, 'Navy compilers rock');
      expect(ok.statusCode, ok.body).toBe(201);
      await setRules(PASSWORD_RULES_DEFAULT);
    });

    it('by the rules every household starts with, 10 characters that are not common are let in', async () => {
      const link = await invite('Alan Turing', 'alan-rules@example.test');
      expect((await accept(link, 'enigma1234')).statusCode).toBe(400);
      const ok = await accept(link, 'bombe at bletchley');
      expect(ok.statusCode, ok.body).toBe(201);
    });
  });

  describe('setup', () => {
    it('holds the first owner’s password to the rules every household starts with', async () => {
      const fresh = await createHarness();
      try {
        const setup = (password: string) =>
          fresh.app.inject({
            method: 'POST',
            url: '/api/v1/setup',
            payload: {
              setup_token: TEST_SETUP_TOKEN,
              household_name: 'The Rules family',
              display_name: 'Rosalind Franklin',
              email: 'rosalind@example.test',
              password,
            },
          });
        for (const [password, detail] of [
          ['xq7 vvz', 'length'],
          ['letmein123', 'common'],
          ['rosalind@example.test', 'personal'],
        ] as const) {
          const res = await setup(password);
          expect([res.statusCode, errorOf(res).code, errorOf(res).detail], password).toEqual([
            400,
            'password_rules',
            detail,
          ]);
        }
        expect((await setup('double helix photo 51')).statusCode).toBe(201);
      } finally {
        await fresh.close();
      }
    });
  });
});
