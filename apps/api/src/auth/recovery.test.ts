import { createPool } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type {
  MfaChallenge,
  RecoveryCodesMade,
  RecoveryCodesState,
  SecurityQuestionsState,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertsSent, createHarness, type Harness } from '../test-harness.js';
import type { Tokens } from './service.js';
import { codeFor } from './totp.js';

/**
 * Getting back in when the second step is lost (0.9.0-dev.104), end to end:
 * recovery codes made beside a second step and shown once, counted, a new
 * set replacing the old, kept only as hashes, nobody's to read; security
 * questions set and never their answers; either standing in for the second
 * step with the password — and then every second step taken away, every
 * other device signed out, the person told and the owners too, and the
 * session only setting one up again until new codes are made beside it.
 * Wrong ones are counted as failed sign-ins; questions answered wrong five
 * times are refused for a day; an owner may turn questions off.
 */

describe.skipIf(!testAdminUrl())('getting back in (0.9.0-dev.104)', () => {
  let h: Harness;
  let owner: Tokens;
  let admin: ReturnType<typeof createPool>;
  let nth = 0;

  const peer = () => ({ remoteAddress: `10.89.${++nth >> 8}.${nth & 0xff}` });
  const call = (
    who: Tokens | null,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    h.app.inject({
      method,
      url,
      ...(who ? { headers: h.as(who) } : {}),
      ...(payload ? { payload } : {}),
      ...peer(),
    });
  const errorOf = (r: LightMyRequestResponse) =>
    r.json<{ error?: { code: string; message: string } }>().error ?? { code: 'ok', message: '' };
  const accountOf = async (t: Tokens) =>
    (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [t.member_id],
      )
    ).rows[0]?.account_id as string;
  /** Their sessions just confirmed it's them, with a factor too. */
  const fresh = (t: Tokens) =>
    admin.query(
      `update session set verified_at = now(), factor_verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)
          and revoked_at is null`,
      [t.member_id],
    );
  const signIn = (email: string, password: string) =>
    call(null, 'POST', '/api/v1/auth/password', { email, password });
  const challengeOf = async (email: string, password: string) => {
    const r = await signIn(email, password);
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json<MfaChallenge>();
    expect(c.mfa_required).toBe(true);
    return c;
  };
  /** Somebody with two-step sign-in (an authenticator app) and ten recovery codes. */
  const withCodes = async (name: string, role: 'adult' | 'owner' | 'teen' = 'adult') => {
    const email = `${name.toLowerCase()}-recovery@example.test`;
    const password = `${name} has a long password`;
    const t = await h.join(owner, { name, email, role, password });
    await h.decider(t);
    const made = await call(t, 'POST', '/api/v1/auth/recovery-codes');
    expect(made.statusCode, made.body).toBe(201);
    return { t, email, password, codes: made.json<RecoveryCodesMade>().codes };
  };
  const PET = { key: 'first_pet', answer: 'Biscuit' };
  const JOB = { key: 'first_job', answer: 'Paper round' };
  const BIKE = { key: 'own', text: 'What was my first bike called?', answer: 'Red Racer' };

  beforeAll(async () => {
    h = await createHarness({ rateLimitPerMinute: 100_000, signInGuard: true });
    owner = await h.setup();
    admin = createPool(h.adminUrl, 2);
    await h.decider(owner);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });

  it('the capability document says both are here', async () => {
    const caps = await call(null, 'GET', '/api/v1/capabilities');
    expect(caps.json<{ features: Record<string, unknown> }>().features).toMatchObject({
      recovery_codes: true,
      security_questions: true,
    });
  });

  it('makes ten beside a second step, shown once and kept only as hashes nobody reads; a new set replaces the old', async () => {
    const email = 'noor-recovery@example.test';
    const t = await h.join(owner, {
      name: 'Noor',
      email,
      role: 'adult',
      password: 'noor long pass',
    });
    expect(
      (await call(t, 'GET', '/api/v1/auth/recovery-codes')).json<RecoveryCodesState>(),
    ).toEqual({ remaining: 0, made_at: null, low: false, second_step: false });
    const none = await call(t, 'POST', '/api/v1/auth/recovery-codes');
    expect(none.statusCode).toBe(409);
    expect(errorOf(none).code).toBe('recovery_codes_need_second_step');
    await h.decider(t);
    const made = await call(t, 'POST', '/api/v1/auth/recovery-codes');
    expect(made.statusCode, made.body).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    const body = made.json<RecoveryCodesMade>();
    expect(body).toMatchObject({ remaining: 10, low: false, second_step: true });
    expect(body.codes).toHaveLength(10);
    for (const c of body.codes) expect(c).toMatch(/^[2-9a-hjkmnp-z]{5}-[2-9a-hjkmnp-z]{5}$/);
    const kept = await admin.query<{ code_hash: string }>(
      'select code_hash from recovery_code where account_id = $1',
      [await accountOf(t)],
    );
    expect(kept.rowCount).toBe(10);
    for (const r of kept.rows) {
      expect(r.code_hash.startsWith('$argon2id$')).toBe(true);
      for (const c of body.codes) expect(r.code_hash).not.toContain(c.replace('-', ''));
    }
    // Nobody signed in is given a row, an owner included: the vault's alone.
    const app = createPool(h.appUrl, 1);
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.household_id', $1, true), set_config('app.actor', 'account', true),
                set_config('app.account_id', $2, true), set_config('app.member_id', $3, true),
                set_config('app.role', 'owner', true)`,
        [owner.household_id, await accountOf(owner), owner.member_id],
      );
      expect((await c.query('select * from recovery_code')).rowCount).toBe(0);
      expect((await c.query('select * from security_answer')).rowCount).toBe(0);
      // And nobody signed in marks a sign-in as recovered.
      await expect(
        c.query('update account set recovered_at = now() where id = $1', [await accountOf(t)]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.query('rollback');
      c.release();
      await app.end();
    }
    // A new set: the old ones stop working.
    await h.decider(t);
    const again = (await call(t, 'POST', '/api/v1/auth/recovery-codes')).json<RecoveryCodesMade>();
    expect(again.codes.some((x) => body.codes.includes(x))).toBe(false);
    const line = await admin.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_event where action = 'auth.recovery_codes_made'
        order by id desc limit 1`,
    );
    expect(line.rows[0]?.detail).toEqual({ count: 10, replaced: true });
    // Eight used of ten: few left, and said so.
    await admin.query(
      `update recovery_code set used_at = now()
        where id in (select id from recovery_code where account_id = $1 limit 8)`,
      [await accountOf(t)],
    );
    expect(
      (await call(t, 'GET', '/api/v1/auth/recovery-codes')).json<RecoveryCodesState>(),
    ).toMatchObject({ remaining: 2, low: true });
  });

  it('stands in for a lost second step with the password: every second step taken away, every other device signed out, the person told, and only setting one up until new codes are made', async () => {
    const { t, email, password, codes } = await withCodes('Lena');
    const account = await accountOf(t);
    // A passkey too, which goes with the rest.
    await admin.query(
      `insert into credential (account_id, kind, credential_id, public_key, sign_count, user_verified)
       values ($1, 'passkey', $2, $3, 0, true)`,
      [account, Buffer.from(`lena-${Date.now()}`), Buffer.from('key')],
    );
    const challenge = await challengeOf(email, password);
    expect(challenge.recovery).toEqual(['recovery_code']);
    // Wrong: counted, as a code that didn't match is.
    const wrong = await call(null, 'POST', '/api/v1/auth/mfa/recovery-code', {
      mfa_token: challenge.mfa_token,
      code: 'aaaaa-aaaaa',
    });
    expect(wrong.statusCode).toBe(401);
    expect(errorOf(wrong)).toMatchObject({
      code: 'recovery_code_wrong',
      message: 'That recovery code isn’t right, or it was used already.',
    });
    await h.guard.settled();
    const failed = await admin.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_event where action = 'auth.sign_in_failed' and object_id = $1
        order by id desc limit 1`,
      [t.member_id],
    );
    expect(failed.rows[0]?.detail).toMatchObject({ step: 'recovery_code' });

    const before = h.jobs.length;
    const typed = ` ${(codes[4] as string).toUpperCase().replace('-', ' ')} `;
    const ok = await call(null, 'POST', '/api/v1/auth/mfa/recovery-code', {
      mfa_token: challenge.mfa_token,
      code: typed,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const tokens = ok.json<Tokens>();
    expect(tokens.two_step_setup_required).toBe(true);
    // Their second steps are gone, and the rest of their codes.
    const after = await admin.query<{
      totp: boolean;
      recovered: boolean;
      passkeys: number;
      codes: number;
    }>(
      `select totp_confirmed_at is not null as totp, recovered_at is not null as recovered,
              (select count(*)::int from credential where account_id = $1 and kind = 'passkey') as passkeys,
              (select count(*)::int from recovery_code where account_id = $1) as codes
         from account where id = $1`,
      [account],
    );
    expect(after.rows[0]).toEqual({ totp: false, recovered: true, passkeys: 0, codes: 0 });
    // Every other session ended: the one they joined with too.
    expect((await call(t, 'GET', '/api/v1/me')).statusCode).toBe(401);
    // The new one only sets a second step up.
    const me = (await call(tokens, 'GET', '/api/v1/me')).json<{
      two_step_setup_required: boolean;
      two_step_reason: string;
    }>();
    expect(me).toMatchObject({ two_step_setup_required: true, two_step_reason: 'recovered' });
    const docs = await call(tokens, 'GET', '/api/v1/documents');
    expect(docs.statusCode).toBe(403);
    expect(errorOf(docs).code).toBe('two_step_setup_required');
    // Told, by email, and in Activity.
    const told = alertsSent({ jobs: h.jobs.slice(before) }).filter(
      (a) => a.subject === 'A recovery code was used for your vault',
    );
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      account_ids: [account],
      email_only: true,
      text_kind: 'signed_out',
    });
    expect(JSON.stringify(told[0])).not.toContain((codes[4] as string).slice(0, 5));
    const used = await admin.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_event where action = 'auth.recovery_code_used' and object_id = $1`,
      [t.member_id],
    );
    expect(used.rows[0]?.detail).toMatchObject({ at: 'sign_in', passkeys_removed: 1 });
    // The same code never works again; with no second step, the password
    // alone signs them in — still only to set one up.
    const second = await signIn(email, password);
    expect(second.json<Tokens>().two_step_setup_required).toBe(true);

    // An authenticator set up again, and new codes beside it: on they go.
    await fresh(tokens);
    const enrol = await call(tokens, 'POST', '/api/v1/auth/totp/enrol');
    expect(enrol.statusCode, enrol.body).toBe(200);
    const confirmed = await call(tokens, 'POST', '/api/v1/auth/totp/confirm', {
      code: codeFor(enrol.json<{ secret: string }>().secret),
    });
    expect(confirmed.statusCode, confirmed.body).toBe(204);
    expect((await call(tokens, 'GET', '/api/v1/documents')).statusCode).toBe(403);
    const fresher = await call(tokens, 'POST', '/api/v1/auth/recovery-codes');
    expect(fresher.statusCode, fresher.body).toBe(201);
    expect((await call(tokens, 'GET', '/api/v1/documents')).statusCode).toBe(200);
    expect(
      (await admin.query('select 1 from account where id = $1 and recovered_at is null', [account]))
        .rowCount,
    ).toBe(1);
  });

  it('an owner’s recovery tells the other owners too', async () => {
    const { email, password, codes } = await withCodes('Omid', 'owner');
    const challenge = await challengeOf(email, password);
    const before = h.jobs.length;
    const ok = await call(null, 'POST', '/api/v1/auth/mfa/recovery-code', {
      mfa_token: challenge.mfa_token,
      code: codes[0],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const told = alertsSent({ jobs: h.jobs.slice(before) }).filter(
      (a) => a.subject === 'Omid got back into their sign-in',
    );
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      account_ids: [await accountOf(owner)],
      email_only: true,
      no_text: true,
    });
  });

  it('security questions: three set, never their answers, standing in once all three are right; refused for a day after five wrong', async () => {
    const { t, email, password } = await withCodes('Sana');
    const bad = async (questions: unknown[]) => {
      await fresh(t);
      const r = await call(t, 'PUT', '/api/v1/auth/security-questions', { questions });
      expect(r.statusCode, r.body).toBe(422);
      return errorOf(r).message;
    };
    expect(await bad([PET, JOB, { key: 'first_school', answer: 'a.b' }])).toBe(
      'Each answer needs at least 4 letters or numbers.',
    );
    expect(await bad([PET, JOB, { key: 'first_pet', answer: 'Something' }])).toBe(
      'Choose a different question each time.',
    );
    expect(await bad([PET, JOB, { key: 'own', text: 'Hm?', answer: 'Something' }])).toBe(
      'Write your own question in a few words.',
    );
    expect(await bad([PET, JOB, { key: 'nope', answer: 'Something' }])).toBe(
      'Choose each question from the list, or write your own.',
    );
    expect(await bad([PET, JOB, { key: 'first_school', answer: 'BISCUIT!' }])).toBe(
      'Give a different answer to each question.',
    );
    await fresh(t);
    const set = await call(t, 'PUT', '/api/v1/auth/security-questions', {
      questions: [PET, JOB, BIKE],
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json<SecurityQuestionsState>()).toMatchObject({
      set: true,
      offered: true,
      questions: [
        { key: 'first_pet', text: 'What was the name of your first pet?' },
        { key: 'first_job', text: 'What was your first job?' },
        { key: 'own', text: 'What was my first bike called?' },
      ],
    });
    const read = await call(t, 'GET', '/api/v1/auth/security-questions');
    expect(read.body).not.toMatch(/biscuit|paper|racer/i);
    const kept = await admin.query<{ answer_hashes: string[] }>(
      'select answer_hashes from security_answer where account_id = $1',
      [await accountOf(t)],
    );
    expect(kept.rows[0]?.answer_hashes.every((x) => x.startsWith('$argon2id$'))).toBe(true);

    const challenge = await challengeOf(email, password);
    expect(challenge.recovery).toEqual(['recovery_code', 'security_questions']);
    const asked = await call(null, 'POST', '/api/v1/auth/mfa/questions', {
      mfa_token: challenge.mfa_token,
    });
    expect(asked.json()).toEqual({
      questions: [
        'What was the name of your first pet?',
        'What was your first job?',
        'What was my first bike called?',
      ],
    });
    const answer = (answers: string[]) =>
      call(null, 'POST', '/api/v1/auth/mfa/answers', { mfa_token: challenge.mfa_token, answers });
    const wrong = await answer(['Biscuit', 'Milk round', 'Red Racer']);
    expect(wrong.statusCode).toBe(401);
    expect(errorOf(wrong)).toMatchObject({
      code: 'security_answers_wrong',
      message:
        'Those answers aren’t all right. 4 tries left before your security questions are refused for a day.',
    });
    // Case, spaces and punctuation are not what makes an answer right.
    const ok = await answer(['biscuit!', '  PAPER-ROUND ', 'red racer.']);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<Tokens>().two_step_setup_required).toBe(true);
    const used = await admin.query(
      `select 1 from audit_event where action = 'auth.security_questions_used' and object_id = $1`,
      [t.member_id],
    );
    expect(used.rowCount).toBe(1);

    // Five wrong within a day, and the questions are refused, right ones too.
    await h.decider(ok.json<Tokens>());
    const again = await challengeOf(email, password);
    for (let i = 0; i < 5; i++) {
      await h.guard.clear(h.guard.subjectOfAccount(await accountOf(t)));
      const r = await call(null, 'POST', '/api/v1/auth/mfa/answers', {
        mfa_token: again.mfa_token,
        answers: ['nope nope', 'nope nope', 'nope nope'],
      });
      expect(r.statusCode).toBe(401);
    }
    await h.guard.clear(h.guard.subjectOfAccount(await accountOf(t)));
    const refused = await call(null, 'POST', '/api/v1/auth/mfa/answers', {
      mfa_token: again.mfa_token,
      answers: ['Biscuit', 'Paper round', 'Red Racer'],
    });
    expect(refused.statusCode).toBe(429);
    expect(errorOf(refused).code).toBe('security_questions_refused');
    expect(errorOf(refused).message).toMatch(
      /^Your security questions were answered wrong 5 times, so they can’t be used until /,
    );
  });

  it('an owner may turn questions off for the household, and then they are never asked', async () => {
    const { t, email, password } = await withCodes('Tomas');
    await fresh(t);
    expect(
      (await call(t, 'PUT', '/api/v1/auth/security-questions', { questions: [PET, JOB, BIKE] }))
        .statusCode,
    ).toBe(200);
    const notOwner = await call(t, 'PUT', '/api/v1/household/security-questions', { on: false });
    expect(notOwner.statusCode).toBe(403);
    await h.decider(owner);
    const off = await call(owner, 'PUT', '/api/v1/household/security-questions', { on: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toEqual({ on: false, can_change: true });
    try {
      const challenge = await challengeOf(email, password);
      expect(challenge.recovery).toEqual(['recovery_code']);
      const asked = await call(null, 'POST', '/api/v1/auth/mfa/questions', {
        mfa_token: challenge.mfa_token,
      });
      expect(errorOf(asked).code).toBe('security_questions_not_offered');
      await fresh(t);
      const set = await call(t, 'PUT', '/api/v1/auth/security-questions', {
        questions: [PET, JOB, BIKE],
      });
      expect(errorOf(set).code).toBe('security_questions_off');
      expect((await call(t, 'GET', '/api/v1/auth/security-questions')).json()).toMatchObject({
        set: true,
        offered: false,
      });
    } finally {
      await h.decider(owner);
      await call(owner, 'PUT', '/api/v1/household/security-questions', { on: true });
    }
    const line = await admin.query(
      `select 1 from audit_event where action = 'household.security_questions_changed'`,
    );
    expect(line.rowCount).toBe(2);
    // Removed: gone, and said so.
    await fresh(t);
    const removed = await call(t, 'DELETE', '/api/v1/auth/security-questions');
    expect(removed.json<SecurityQuestionsState>().set).toBe(false);
  });

  it('wrong codes count towards the account’s wait, as a code that didn’t match does', async () => {
    const { email, password } = await withCodes('Uma');
    const challenge = await challengeOf(email, password);
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (
        await call(null, 'POST', '/api/v1/auth/mfa/recovery-code', {
          mfa_token: challenge.mfa_token,
          code: 'bbbbb-bbbbb',
        })
      ).statusCode;
    }
    expect(last).toBe(429);
  });
});
