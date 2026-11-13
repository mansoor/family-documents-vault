import { randomUUID } from 'node:crypto';
import { createPool, SmsProviderError, type SmsProviderFactory } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  inviteCodeText,
  shareCodeText,
  SMS_OWNER_NEEDS_FACTOR,
  textCodeText,
  type Capabilities,
  type CreatedInvitation,
  type DocumentView,
  type MfaChallenge,
  type ResetPreview,
  type ShareCodeSent,
  type ShareLinkPreview,
  type StepUpState,
  type TextCodeSent,
  type TextCodeSettings,
} from '@fdv/shared';
import FormData from 'form-data';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import type { CreatedShare } from '../documents/shares.js';
import { SHARE_TEXT_CANNOT_SEND } from '../documents/shares.js';
import { alertsSent, createHarness, type Harness } from '../test-harness.js';

/**
 * Codes by text (0.9.0, SMS3), end to end: a share link's code texted to the
 * number its sharer typed; an invitation's code texted by an owner; and a
 * code to somebody's own confirmed number at a reset, at sign-in and to
 * confirm it's them — each sent, wrong, ended, tried too often, held to its
 * limits, refused past the month's cap, and said plainly when the
 * household's texts don't work. A text is only ever in addition: never an
 * owner's only second step, never what an owner's powers ask, and a reset
 * that cannot ask for its code goes on, and its owners are told. SMS Gate
 * is a fake here, told what to do.
 */

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

describe.skipIf(!testAdminUrl())('codes by text (SMS3)', () => {
  let h: Harness;
  let owner: Tokens;
  let adult: Tokens;
  let teen: Tokens;
  let admin: ReturnType<typeof createPool>;
  let nth = 0;
  /** What SMS Gate does with the next text. */
  let gate: 'accept' | 'refuse' = 'accept';
  const sent: Array<{ to: string; text: string }> = [];
  /** Every text, never cleared: what the log is held to at the end. */
  const everySent: Array<{ to: string; text: string }> = [];
  /** Everything the API logged. */
  const logged: string[] = [];

  const fake: SmsProviderFactory = () => ({
    send: async (to, text) => {
      if (gate === 'refuse') throw new SmsProviderError('timeout', 'no answer');
      sent.push({ to, text });
      everySent.push({ to, text });
      return { id: `gate-${sent.length}`, state: 'delivered' };
    },
    state: async () => ({ state: 'delivered' }),
  });

  const peer = () => ({ remoteAddress: `10.88.${++nth >> 8}.${nth & 0xff}` });
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
  /** The newest code texted to a number. */
  const codeTo = (number: string) =>
    /(\d{6})/.exec(sent.filter((t) => t.to === number).at(-1)?.text ?? '')?.[1] ?? '';
  const another = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

  /** Their sessions just confirmed it's them, with a factor too. */
  const fresh = (t: Tokens) =>
    admin.query(
      `update session set verified_at = now(), factor_verified_at = now()
        where account_id = (select account_id from account_household where member_id = $1)
          and revoked_at is null`,
      [t.member_id],
    );
  const accountOf = async (t: Tokens) =>
    (
      await admin.query<{ account_id: string }>(
        'select account_id from account_household where member_id = $1',
        [t.member_id],
      )
    ).rows[0]?.account_id as string;
  const confirmed = (t: Tokens, number: string) =>
    admin.query(
      `insert into member_phone (member_id, household_id, number, confirmed_at)
       values ($1, $2, $3, now())
       on conflict (member_id) do update set number = excluded.number, confirmed_at = now()`,
      [t.member_id, t.household_id, number],
    );
  const smsStatus = (status: 'ok' | 'untested') =>
    admin.query('update sms_settings set status = $1', [status]);
  const textCodes = async (who: Tokens, body: Record<string, unknown>) => {
    await fresh(who);
    return call(who, 'PUT', '/api/v1/auth/text-codes', body);
  };

  const OWNER_PHONE = '+447700900101';
  const ADULT_PHONE = '+447700900202';
  const TEEN_PHONE = '+447700900303';

  beforeAll(async () => {
    h = await createHarness({
      rateLimitPerMinute: 100_000,
      smsProvider: fake,
      logger: {
        level: 'trace',
        stream: { write: (line: string) => void logged.push(line) },
      },
    });
    owner = await h.setup();
    adult = await h.join(owner, {
      name: 'Ahmed Khan',
      email: 'ahmed-c@example.test',
      role: 'adult',
    });
    teen = await h.join(owner, { name: 'Tia Khan', email: 'tia-c@example.test', role: 'teen' });
    admin = createPool(h.adminUrl, 2);
    await fresh(owner);
    const saved = await call(owner, 'PUT', '/api/v1/sms/settings', {
      mode: 'local',
      base_url: 'http://192.168.1.20:8080',
      username: 'sms',
      password: 'sms-gate-password',
      country: 'GB',
      monthly_cap: 1000,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const tested = await call(owner, 'POST', '/api/v1/sms/settings/test', {
      number: '07700 900999',
    });
    expect(tested.json<{ ok: boolean }>().ok, tested.body).toBe(true);
  }, 120_000);
  afterAll(async () => {
    await admin?.end();
    await h?.close();
  });
  beforeEach(async () => {
    await admin.query('delete from sms_code');
    await admin.query('delete from share_code');
    await admin.query('delete from sms_message');
    await admin.query("update sms_settings set status = 'ok', monthly_cap = 1000");
    await admin.query('update account set sign_in_text = false, reset_text = false');
    await confirmed(owner, OWNER_PHONE);
    await confirmed(adult, ADULT_PHONE);
    await confirmed(teen, TEEN_PHONE);
    gate = 'accept';
    sent.length = 0;
  });

  it('the capability document says codes by text are here', async () => {
    const caps = (await call(null, 'GET', '/api/v1/capabilities')).json<Capabilities>();
    expect(caps.features.sms_codes).toBe(true);
  });

  // ------------------------------------------------------------ a link

  describe("a share link's code, by text", () => {
    const RECIPIENT = '+447700900456';
    let doc: string;

    beforeAll(async () => {
      const made = await call(owner, 'POST', '/api/v1/documents', {
        title: 'Divorce settlement',
        type_key: 'utility_bill',
        visibility: 'household',
      });
      doc = made.json<DocumentView>().id;
      const form = new FormData();
      form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
      await h.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc}/versions`,
        headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
        payload: form.getBuffer(),
      });
    });

    const share = (body: Record<string, unknown>) =>
      call(owner, 'POST', `/api/v1/documents/${doc}/share`, body);
    const byText = async () => {
      const r = await share({ second_factor: 'sms', recipient_phone: '07700 900456' });
      expect(r.statusCode, r.body).toBe(201);
      return r.json<CreatedShare>();
    };
    const sendCode = (token: string) => call(null, 'POST', '/api/v1/shared/code', { token });
    const unlock = (token: string, code: string) =>
      call(null, 'POST', '/api/v1/shared/unlock', { token, code });

    it('is made with the number masked, and the number never shown back', async () => {
      const made = await byText();
      expect(made.share.second_factor).toBe('sms');
      expect(made.share.code_to).toBe('•••• •••456');
      expect(made.share.protection).toEqual(['code']);
      expect(made.share.summary).toContain('a code texted to •••• •••456');
      const list = await call(owner, 'GET', '/api/v1/shares');
      expect(list.body).not.toContain('7700900456');
      const row = await admin.query<{ code_phone: string; code_email: string | null }>(
        'select code_phone, code_email from share_link where id = $1',
        [made.share.id],
      );
      expect(row.rows[0]).toEqual({ code_phone: RECIPIENT, code_email: null });
      // The page says how the code comes, masked, and nothing of the document.
      const preview = await call(null, 'POST', '/api/v1/shared/preview', {
        token: made.link_token,
      });
      const p = preview.json<ShareLinkPreview>();
      expect(p.code_by).toBe('sms');
      expect(p.code_to).toBe('•••• •••456');
      expect(p.document_title).toBeNull();
    });

    it('texts the code — no link, no title — and opens with it, once', async () => {
      const made = await byText();
      const r = await sendCode(made.link_token);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json<ShareCodeSent>()).toMatchObject({ sent_to: '•••• •••456', by: 'sms' });
      const text = sent.at(-1);
      expect(text?.to).toBe(RECIPIENT);
      const code = codeTo(RECIPIENT);
      expect(text?.text).toBe(shareCodeText(code));
      expect(text?.text).not.toContain('Divorce');
      expect(text?.text).not.toContain(made.link_token);
      const kinds = await admin.query<{ kind: string; number_tail: string }>(
        'select kind, number_tail from sms_message',
      );
      expect(kinds.rows).toEqual([{ kind: 'share_code', number_tail: '456' }]);
      // Wrong first: one of its five tries, and one of the link's ten.
      expect(errorOf(await unlock(made.link_token, another(code))).code).toBe('secret_wrong');
      expect((await unlock(made.link_token, code)).statusCode).toBe(200);
      // Used once.
      expect(errorOf(await unlock(made.link_token, code)).code).toBe('secret_wrong');
      // Logged as texted, masked.
      const lines = await admin.query<{ detail: Record<string, string> }>(
        "select detail from audit_event where action = 'share.code_sent' order by id desc limit 1",
      );
      expect(lines.rows[0]?.detail).toMatchObject({ to: '•••• •••456', by: 'sms' });
    });

    it('an ended code opens nothing', async () => {
      const made = await byText();
      await sendCode(made.link_token);
      const code = codeTo(RECIPIENT);
      await admin.query("update share_code set expires_at = now() - interval '1 second'");
      expect(errorOf(await unlock(made.link_token, code)).code).toBe('secret_wrong');
    });

    it('texts at most 3 codes a link in 15 minutes', async () => {
      const made = await byText();
      for (let i = 0; i < 3; i++) {
        expect((await sendCode(made.link_token)).statusCode).toBe(200);
      }
      const fourth = await sendCode(made.link_token);
      expect(fourth.statusCode).toBe(429);
      expect(errorOf(fourth).code).toBe('code_limit');
      expect(sent.filter((t) => t.to === RECIPIENT)).toHaveLength(3);
    });

    it('says plainly when texts are not set up, writes nothing that counts, and logs it', async () => {
      const made = await byText();
      await smsStatus('untested');
      const r = await sendCode(made.link_token);
      expect(r.statusCode).toBe(503);
      expect(errorOf(r)).toMatchObject({
        code: 'sms_code_unavailable',
        message: SHARE_TEXT_CANNOT_SEND,
      });
      expect(sent).toHaveLength(0);
      expect((await admin.query('select 1 from share_code')).rowCount).toBe(0);
      const lines = await admin.query<{ detail: Record<string, string> }>(
        "select detail from audit_event where action = 'share.code_not_sent' order by id desc limit 1",
      );
      expect(lines.rows[0]?.detail).toMatchObject({ to: '•••• •••456', reason: 'not_set_up' });
    });

    it("says the same when this month's texts are all sent", async () => {
      const made = await byText();
      await admin.query('update sms_settings set monthly_cap = 1');
      await admin.query(
        `insert into sms_message (household_id, number_tail, kind, state)
         values ($1, '999', 'test', 'delivered')`,
        [owner.household_id],
      );
      const r = await sendCode(made.link_token);
      expect(errorOf(r).code).toBe('sms_code_unavailable');
      const lines = await admin.query<{ detail: Record<string, string> }>(
        "select detail from audit_event where action = 'share.code_not_sent' order by id desc limit 1",
      );
      expect(lines.rows[0]?.detail.reason).toBe('cap_reached');
    });

    it('a text SMS Gate never took ends its code, and asks to try again', async () => {
      const made = await byText();
      gate = 'refuse';
      const r = await sendCode(made.link_token);
      expect(r.statusCode).toBe(503);
      expect(errorOf(r).code).toBe('code_not_sent');
      const live = await admin.query('select 1 from share_code where expires_at > now()');
      expect(live.rowCount).toBe(0);
    });

    it('is refused while texts are not set up, and asks for one way only', async () => {
      await smsStatus('untested');
      expect(errorOf(await share({ second_factor: 'sms', recipient_phone: RECIPIENT })).code).toBe(
        'sms_not_set_up',
      );
      await smsStatus('ok');
      const both = await share({
        second_factor: 'sms',
        recipient_phone: RECIPIENT,
        code_email: 'jane@example.test',
      });
      expect(both.statusCode).toBe(422);
      expect(errorOf(await share({ second_factor: 'sms' })).code).toBe('validation_failed');
      expect(errorOf(await share({ recipient_phone: 'not a number' })).code).toBe(
        'phone_number_invalid',
      );
      // Absent, an emailed code is as it was.
      const email = await share({ code_email: 'jane@example.test' });
      expect(email.statusCode, email.body).toBe(201);
      expect(email.json<CreatedShare>().share.second_factor).toBe('email');
    });

    it('a link taken back forgets the number', async () => {
      const made = await byText();
      expect((await call(owner, 'DELETE', `/api/v1/shares/${made.share.id}`)).statusCode).toBe(204);
      const row = await admin.query<{ code_phone: string | null }>(
        'select code_phone from share_link where id = $1',
        [made.share.id],
      );
      expect(row.rows[0]?.code_phone).toBeNull();
    });
  });

  // ------------------------------------------------------- an invitation

  describe("an invitation's code, by text", () => {
    const invite = (who: Tokens, body: Record<string, unknown>) =>
      call(who, 'POST', '/api/v1/invitations', {
        display_name: 'Nana',
        email: `nana-${randomUUID().slice(0, 8)}@example.test`,
        role: 'adult',
        ...body,
      });

    it('an owner texts the code alone, never the link, and keeps nothing of the number', async () => {
      await fresh(owner);
      const r = await invite(owner, { invitee_phone: '07700 900777' });
      expect(r.statusCode, r.body).toBe(201);
      const created = r.json<CreatedInvitation>();
      expect(created.code_texted_to).toBe('•••• •••777');
      const text = sent.at(-1);
      expect(text?.to).toBe('+447700900777');
      expect(text?.text).toBe(inviteCodeText(created.code, 'Owner'));
      expect(text?.text).not.toContain(created.link_token);
      const kept = await admin.query<{ kind: string; number_tail: string }>(
        "select kind, number_tail from sms_message where kind = 'invite_code'",
      );
      expect(kept.rows).toEqual([{ kind: 'invite_code', number_tail: '777' }]);
      const audit = await admin.query(
        "select 1 from audit_event where detail::text like '%7700900777%'",
      );
      expect(audit.rowCount).toBe(0);
    });

    it('is an owner’s alone, and refused before anything is made when texts are off', async () => {
      await fresh(adult);
      const byAdult = await invite(adult, { invitee_phone: '07700 900777', role: 'teen' });
      expect(byAdult.statusCode).toBe(403);
      await smsStatus('untested');
      await fresh(owner);
      const before = await admin.query('select count(*)::int as n from invitation');
      expect(errorOf(await invite(owner, { invitee_phone: '07700 900777' })).code).toBe(
        'sms_not_set_up',
      );
      const after = await admin.query('select count(*)::int as n from invitation');
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it('a text that fails leaves the invitation, and says why', async () => {
      gate = 'refuse';
      await fresh(owner);
      const r = await invite(owner, { invitee_phone: '07700 900778' });
      expect(r.statusCode).toBe(201);
      const created = r.json<CreatedInvitation>();
      expect(created.code_texted_to).toBeUndefined();
      expect(created.code_text_problem).toMatch(/couldn’t be texted/);
      expect(created.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    });
  });

  // ----------------------------------------------------------- a reset

  describe('a reset finished with a code by text', () => {
    // Somebody of their own: every reset here signs them out everywhere, so
    // each test signs them in again first.
    let rafi: Tokens;
    const RAFI = 'rafi-c@example.test';
    const RAFI_PHONE = '+447700900606';
    const NEW_PASSWORD = 'rafi set this one himself';
    let rafiPassword = 'another correct horse';
    beforeAll(async () => {
      rafi = await h.join(owner, { name: 'Rafi Khan', email: RAFI, role: 'adult' });
    });
    beforeEach(async () => {
      await confirmed(rafi, RAFI_PHONE);
      const r = await call(null, 'POST', '/api/v1/auth/password', {
        email: RAFI,
        password: rafiPassword,
      });
      expect(r.statusCode, r.body).toBe(200);
      rafi = r.json<Tokens>();
    });
    const forgot = async (email = RAFI) => {
      const before = h.jobs.length;
      await call(null, 'POST', '/api/v1/auth/password/forgot', { email });
      const url = alertsSent({ jobs: h.jobs.slice(before) })
        .map((a) => (a as { url?: string }).url)
        .find((u) => u) as string;
      return url.slice(url.lastIndexOf('#') + 1);
    };
    const complete = async (token: string, code?: string) => {
      const r = await call(null, 'POST', '/api/v1/password-resets/complete', {
        token,
        password: NEW_PASSWORD,
        ...(code ? { code } : {}),
      });
      if (r.statusCode === 200 && r.json<{ email: string }>().email === RAFI) {
        rafiPassword = NEW_PASSWORD;
      }
      return r;
    };
    const sendCode = (token: string) =>
      call(null, 'POST', '/api/v1/password-resets/code', { token });

    it('is the person’s own to turn on, and only with a confirmed number', async () => {
      await admin.query('update member_phone set confirmed_at = null where member_id = $1', [
        rafi.member_id,
      ]);
      const no = await textCodes(rafi, { reset: true });
      expect(errorOf(no).code).toBe('sms_code_unavailable');
      await confirmed(rafi, RAFI_PHONE);
      const yes = await textCodes(rafi, { reset: true });
      expect(yes.statusCode, yes.body).toBe(200);
      expect(yes.json<TextCodeSettings>()).toMatchObject({
        reset: true,
        sign_in: false,
        phone: '•••• •••606',
        phone_confirmed: true,
        can_turn_on: true,
      });
      // Nobody changes another's: the database refuses it too, an owner's
      // own transaction included.
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
        await expect(
          c.query('update account set reset_text = false where id = $1', [await accountOf(rafi)]),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await c.query('rollback');
        c.release();
        await app.end();
      }
    });

    it('asks for the code, texts it, refuses a wrong one and takes the right one', async () => {
      expect((await textCodes(rafi, { reset: true })).statusCode).toBe(200);
      const token = await forgot();
      const preview = (
        await call(null, 'POST', '/api/v1/password-resets/lookup', { token })
      ).json<ResetPreview>();
      expect(preview.text_code_to).toBe('•••• •••606');
      expect(errorOf(await complete(token)).code).toBe('sms_code_required');
      const r = await sendCode(token);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json<TextCodeSent>().sent_to).toBe('•••• •••606');
      const code = codeTo(RAFI_PHONE);
      expect(sent.at(-1)?.text).toBe(textCodeText('reset', code));
      const wrong = await complete(token, another(code));
      expect(wrong.statusCode).toBe(422);
      expect(errorOf(wrong)).toMatchObject({
        code: 'sms_code_wrong',
        message: 'That code isn’t right. 4 tries left.',
      });
      const done = await complete(token, code);
      expect(done.statusCode, done.body).toBe(200);
      const kinds = await admin.query<{ kind: string }>(
        "select kind from sms_message where kind = 'reset_code'",
      );
      expect(kinds.rowCount).toBe(1);
      // The code itself is kept nowhere: only its HMAC.
      const rows = await admin.query<{ code_hash: Buffer }>('select code_hash from sms_code');
      expect(rows.rows.every((x) => !x.code_hash.toString('latin1').includes(code))).toBe(true);
    });

    it('an ended code, and one tried too often, finish nothing', async () => {
      expect((await textCodes(rafi, { reset: true })).statusCode).toBe(200);
      const token = await forgot();
      await sendCode(token);
      const code = codeTo(RAFI_PHONE);
      await admin.query("update sms_code set expires_at = now() - interval '1 second'");
      expect(errorOf(await complete(token, code)).code).toBe('sms_code_expired');
      await sendCode(token);
      const next = codeTo(RAFI_PHONE);
      for (let i = 0; i < 4; i++) await complete(token, another(next));
      expect(errorOf(await complete(token, another(next))).code).toBe('sms_code_too_many');
      expect(errorOf(await complete(token, next)).code).toBe('sms_code_too_many');
    });

    it('texts at most 3 codes in 15 minutes', async () => {
      expect((await textCodes(rafi, { reset: true })).statusCode).toBe(200);
      const token = await forgot();
      for (let i = 0; i < 3; i++) {
        const r = await sendCode(token);
        expect(r.statusCode, r.body).toBe(200);
      }
      const fourth = await sendCode(token);
      expect(fourth.statusCode).toBe(429);
      expect(errorOf(fourth).code).toBe('sms_code_limit');
    });

    it('past the month’s cap, says so', async () => {
      expect((await textCodes(rafi, { reset: true })).statusCode).toBe(200);
      const token = await forgot();
      await admin.query('update sms_settings set monthly_cap = 1');
      await admin.query(
        `insert into sms_message (household_id, number_tail, kind, state)
         values ($1, '999', 'test', 'delivered')`,
        [owner.household_id],
      );
      const r = await sendCode(token);
      expect(errorOf(r).code).toBe('sms_cap_reached');
    });

    it('goes on without the code when texts are not working, and tells the owners', async () => {
      expect((await textCodes(rafi, { reset: true })).statusCode).toBe(200);
      const token = await forgot();
      await smsStatus('untested');
      const preview = (
        await call(null, 'POST', '/api/v1/password-resets/lookup', { token })
      ).json<ResetPreview>();
      expect(preview.text_code_to).toBeNull();
      const before = h.jobs.length;
      const done = await complete(token);
      expect(done.statusCode, done.body).toBe(200);
      const told = alertsSent({ jobs: h.jobs.slice(before) }).filter(
        (a) => a.subject === 'A password was reset without its code by text',
      );
      expect(told).toHaveLength(1);
      expect(told[0]?.account_ids).toEqual([await accountOf(owner)]);
      // By email and push, never by text, which is what failed; and with no
      // number or code in it (the owner's decision of 12 Nov 2026).
      expect(told[0]).toMatchObject({ no_text: true });
      expect(told[0]).not.toHaveProperty('email_only');
      expect(told[0]?.body).toMatch(
        /Rafi Khan’s password was reset on .+ because the household’s text messages aren’t set up and working now\./,
      );
      expect(JSON.stringify(told[0])).not.toContain('606');
      const skipped = await admin.query<{ detail: Record<string, string>; object_id: string }>(
        "select detail, object_id from audit_event where action = 'auth.text_code_skipped' order by id desc limit 1",
      );
      expect(skipped.rows[0]).toEqual({
        detail: { at: 'reset', why: 'not_ready' },
        object_id: rafi.member_id,
      });
    });

    it('a person who did not ask is reset as before', async () => {
      const email = 'nadia-c@example.test';
      await h.join(owner, { name: 'Nadia', email, role: 'adult' });
      const token = await forgot(email);
      const preview = (
        await call(null, 'POST', '/api/v1/password-resets/lookup', { token })
      ).json<ResetPreview>();
      expect(preview.text_code_to).toBeNull();
      expect(errorOf(await sendCode(token)).code).toBe('sms_code_not_offered');
      expect((await complete(token)).statusCode).toBe(200);
      expect(errorOf(await sendCode(token)).code).toBe('reset_not_valid');
    });
  });

  // ---------------------------------------------------------- signing in

  describe('a sign-in with a code by text', () => {
    const signIn = (email: string, password: string) =>
      call(null, 'POST', '/api/v1/auth/password', { email, password });

    it('as the only second step: texted as the password is right, and the one code box takes it', async () => {
      const email = 'sign-in-text@example.test';
      const password = 'a long teen password';
      const t = await h.join(owner, { name: 'Sami', email, role: 'teen', password });
      await confirmed(t, '+447700900404');
      expect((await textCodes(t, { sign_in: true })).statusCode).toBe(200);
      const first = await signIn(email, password);
      const challenge = first.json<MfaChallenge>();
      expect(challenge).toMatchObject({
        mfa_required: true,
        methods: ['text'],
        text_to: '•••• •••404',
        text_sent: true,
      });
      const code = codeTo('+447700900404');
      expect(sent.at(-1)?.text).toBe(textCodeText('sign_in', code));
      // Wrong, then right — as an older client sends it, with no method.
      const wrong = await call(null, 'POST', '/api/v1/auth/mfa', {
        mfa_token: challenge.mfa_token,
        code: another(code),
      });
      expect(errorOf(wrong).code).toBe('sms_code_wrong');
      const ok = await call(null, 'POST', '/api/v1/auth/mfa', {
        mfa_token: challenge.mfa_token,
        code,
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const session = await admin.query<{ factor_verified_at: Date | null }>(
        `select factor_verified_at from session
          where account_id = (select account_id from account_household where member_id = $1)
          order by created_at desc limit 1`,
        [t.member_id],
      );
      // A text is not a factor an owner's powers take (A54).
      expect(session.rows[0]?.factor_verified_at).toBeNull();
      // Another, asked for: within its limits.
      const again = await call(null, 'POST', '/api/v1/auth/mfa/text', {
        mfa_token: challenge.mfa_token,
      });
      expect(again.statusCode, again.body).toBe(200);
      expect(
        (await call(null, 'POST', '/api/v1/auth/mfa/text', { mfa_token: 'x' })).statusCode,
      ).toBe(401);
    });

    it('is never an owner’s only second step', async () => {
      const refused = await textCodes(owner, { sign_in: true });
      expect(refused.statusCode).toBe(409);
      expect(errorOf(refused)).toMatchObject({
        code: 'sms_code_needs_factor',
        message: SMS_OWNER_NEEDS_FACTOR,
      });
      // A reset's code is an owner's to ask for, as anybody's.
      expect((await textCodes(owner, { reset: true })).statusCode).toBe(200);
      await h.decider(owner);
      const now = await textCodes(owner, { sign_in: true });
      expect(now.statusCode, now.body).toBe(200);
      const first = await signIn('owner@example.test', 'correct horse battery');
      const challenge = first.json<MfaChallenge>();
      // Beside the authenticator: offered, never sent unasked.
      expect(challenge.methods).toEqual(['totp', 'text']);
      expect(challenge.text_sent).toBe(false);
      expect(sent).toHaveLength(0);
      await call(null, 'POST', '/api/v1/auth/mfa/text', { mfa_token: challenge.mfa_token });
      const ok = await call(null, 'POST', '/api/v1/auth/mfa', {
        mfa_token: challenge.mfa_token,
        code: codeTo(OWNER_PHONE),
        method: 'text',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      // And a TOTP's code box is still the authenticator's when no method is said.
      const totp = await call(null, 'POST', '/api/v1/auth/mfa', {
        mfa_token: challenge.mfa_token,
        code: '000000',
      });
      expect(errorOf(totp).code).toBe('totp_invalid');
    });

    /** Somebody whose only second step is a text, signed in by password. */
    const textOnly = async (name: string, phone: string) => {
      const email = `${name.toLowerCase()}-skip@example.test`;
      const password = 'another long password';
      const t = await h.join(owner, { name, email, role: 'adult', password });
      await confirmed(t, phone);
      expect((await textCodes(t, { sign_in: true })).statusCode).toBe(200);
      return { t, go: () => signIn(email, password) };
    };
    /** What the owners were told of a sign-in that skipped its text, and its line in the log. */
    const toldOf = async (since: number, t: Tokens) => {
      const told = alertsSent({ jobs: h.jobs.slice(since) }).filter(
        (a) => a.subject === 'A sign-in went ahead without its code by text',
      );
      const line = await admin.query<{ detail: Record<string, string> }>(
        `select detail from audit_event
          where action = 'auth.text_code_skipped' and object_id = $1 order by id desc limit 1`,
        [t.member_id],
      );
      return { told, why: line.rows[0]?.detail };
    };

    it('lets them in with the password when the household’s texts are off, and tells the owners', async () => {
      const { t, go } = await textOnly('Omar', '+447700900505');
      await smsStatus('untested');
      const before = h.jobs.length;
      const r = await go();
      expect(r.json<{ access_token?: string }>().access_token).toBeTruthy();
      const { told, why } = await toldOf(before, t);
      expect(why).toEqual({ at: 'sign_in', why: 'not_ready' });
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ account_ids: [await accountOf(owner)], no_text: true });
      expect(told[0]?.body).toMatch(
        /^Omar signed in on .+ with their password alone, without the code by text they asked for, because the household’s text messages aren’t set up and working now\. If it wasn’t them/,
      );
      // Ids stripped first: a random UUID may hold "505" (the dev.36 flake).
      expect(
        JSON.stringify(told[0]).replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          '<id>',
        ),
      ).not.toMatch(/505|\+44/);
      expect(sent).toHaveLength(0);
    });

    it('and when SMS Gate does not take the code', async () => {
      const { t, go } = await textOnly('Priya', '+447700900515');
      gate = 'refuse';
      const before = h.jobs.length;
      const r = await go();
      expect(r.json<{ access_token?: string }>().access_token).toBeTruthy();
      const { told, why } = await toldOf(before, t);
      expect(why).toEqual({ at: 'sign_in', why: 'not_sent' });
      expect(told[0]?.body).toMatch(/the phone that sends the household’s texts didn’t take it/);
    });

    it("and when this month's texts are all sent", async () => {
      const { t, go } = await textOnly('Quentin', '+447700900525');
      await admin.query('update sms_settings set monthly_cap = 1');
      await admin.query(
        `insert into sms_message (household_id, number_tail, kind, state)
         values ($1, '999', 'test', 'delivered')`,
        [owner.household_id],
      );
      const before = h.jobs.length;
      const r = await go();
      expect(r.json<{ access_token?: string }>().access_token).toBeTruthy();
      expect((await toldOf(before, t)).why).toEqual({ at: 'sign_in', why: 'cap_reached' });
    });

    it('but never past the limit on codes: that waits, and nobody is told', async () => {
      const { t, go } = await textOnly('Rosa', '+447700900535');
      for (let i = 0; i < 3; i++) {
        expect((await go()).json<MfaChallenge>().text_sent).toBe(true);
      }
      const before = h.jobs.length;
      const fourth = (await go()).json<MfaChallenge & { access_token?: string }>();
      expect(fourth.access_token).toBeUndefined();
      expect(fourth).toMatchObject({ mfa_required: true, methods: ['text'], text_sent: false });
      expect((await toldOf(before, t)).told).toHaveLength(0);
    });
  });

  // ------------------------------------------------------- confirming it's you

  describe("confirming it's you with a code by text", () => {
    it('an adult or a teen who asked may, and it is never a factor', async () => {
      expect((await textCodes(teen, { sign_in: true })).statusCode).toBe(200);
      await admin.query(
        `update session set verified_at = null, factor_verified_at = null
          where account_id = $1`,
        [await accountOf(teen)],
      );
      const state = (await call(teen, 'GET', '/api/v1/auth/step-up')).json<StepUpState>();
      expect(state.text_to).toBe('•••• •••303');
      const r = await call(teen, 'POST', '/api/v1/auth/step-up/text');
      expect(r.statusCode, r.body).toBe(200);
      const code = codeTo(TEEN_PHONE);
      expect(sent.at(-1)?.text).toBe(textCodeText('step_up', code));
      expect(
        errorOf(await call(teen, 'POST', '/api/v1/auth/step-up', { text_code: another(code) }))
          .code,
      ).toBe('sms_code_wrong');
      const ok = await call(teen, 'POST', '/api/v1/auth/step-up', { text_code: code });
      expect(ok.statusCode, ok.body).toBe(200);
      const s = await admin.query<{ verified_at: Date | null; factor_verified_at: Date | null }>(
        `select verified_at, factor_verified_at from session
          where account_id = $1 and revoked_at is null order by created_at desc limit 1`,
        [await accountOf(teen)],
      );
      expect(s.rows[0]?.verified_at).not.toBeNull();
      expect(s.rows[0]?.factor_verified_at).toBeNull();
    });

    it('an owner never may', async () => {
      await h.decider(owner);
      expect((await textCodes(owner, { sign_in: true })).statusCode).toBe(200);
      const state = (await call(owner, 'GET', '/api/v1/auth/step-up')).json<StepUpState>();
      expect(state.text_to).toBeNull();
      expect(errorOf(await call(owner, 'POST', '/api/v1/auth/step-up/text')).code).toBe(
        'sms_code_not_offered',
      );
      expect(
        errorOf(await call(owner, 'POST', '/api/v1/auth/step-up', { text_code: '123456' })).code,
      ).toBe('sms_code_not_offered');
      expect(sent).toHaveLength(0);
    });

    it('nobody who did not ask is offered one', async () => {
      const state = (await call(adult, 'GET', '/api/v1/auth/step-up')).json<StepUpState>();
      expect(state.text_to).toBeNull();
      expect(errorOf(await call(adult, 'POST', '/api/v1/auth/step-up/text')).code).toBe(
        'sms_code_not_offered',
      );
    });
  });

  it('no code and no number reaches the log', () => {
    const all = logged.join('\n');
    for (const t of everySent) {
      const code = /(\d{6})/.exec(t.text)?.[1];
      if (code) expect(all).not.toContain(code);
      expect(all).not.toContain(t.to);
      expect(all).not.toContain(t.to.slice(1));
    }
    expect(everySent.length).toBeGreaterThan(5);
  });
});
