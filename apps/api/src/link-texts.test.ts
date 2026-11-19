import { randomUUID } from 'node:crypto';
import { createPool, SmsProviderError, withSystem, type SmsProviderFactory } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import type {
  CreatedUploadRequest,
  DocumentView,
  LinkTexted,
  RevealedUploadRequest,
  UploadRequestView,
} from '@fdv/shared';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tokens } from './auth/service.js';
import type { CreatedShare, ShareView } from './documents/shares.js';
import { createHarness, mailSent, type Harness } from './test-harness.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
const PUBLIC_URL = 'https://share.example.test';
const TITLE = 'Flat 3 tenancy agreement';

/**
 * Sharing and Ask for documents alike (0.9.0-dev.69; the owner's feedback
 * of 18 Nov 2026): a share link, or a request to send documents, texted to
 * whoever it is for by the vault, through the household's own text
 * messages; and a request that asks for a PIN, shown again and made new.
 *
 * What matters is what a text never carries — what the link is to or what
 * the request asks for, its PIN or password — that only its maker sends it,
 * that the number is kept and shown masked alone, that a household without
 * texts set up sends none, that the day's counts and the month's cap hold,
 * and that each text is written to the activity log without the link.
 */
describe.skipIf(!testAdminUrl())('a link or a request texted, and a request’s PIN', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let adult: Tokens;
  let ownerAccount: string;
  let lease: string;

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const errorOf = (r: LightMyRequestResponse) =>
    json<{ error: { code: string; message: string; action?: string } }>(r).error;
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.95.${Math.floor(++nth / 200)}.${nth % 200}` });
  /** A number of its own for each test, so one test's texts are not another's. */
  const number = () => `07400 1${String(10000 + Math.floor(Math.random() * 89999)).slice(0, 5)}`;

  const accountOf = async (t: Tokens) =>
    json<{ account_id: string }>(await h.app.inject({ url: '/api/v1/me', headers: h.as(t) }))
      .account_id;
  const confirmed = (account: string, yes: boolean) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({
          verified_at: new Date(Date.now() - (yes ? 0 : 10 * 60_000)),
          factor_verified_at: new Date(Date.now() - (yes ? 0 : 10 * 60_000)),
        })
        .where('account_id', '=', account)
        .execute(),
    );

  const share = async (body: Record<string, unknown> = {}) => {
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${lease}/share`,
      headers: h.as(owner),
      payload: body,
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<CreatedShare>(r);
  };
  const ask = async (who: Tokens, body: Record<string, unknown> = {}) => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/api/v1/upload-requests',
      headers: h.as(who),
      payload: {
        title: 'Secret tax title',
        message: 'private words',
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        ...body,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<CreatedUploadRequest>(r);
  };
  const text = (who: Tokens, url: string, to: string) =>
    h.app.inject({ method: 'POST', url, headers: h.as(who), payload: { to }, ...peer() });
  const links = async () =>
    json<{ items: ShareView[] }>(
      await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
    ).items;
  const requests = async (who: Tokens) =>
    json<{ items: UploadRequestView[] }>(
      await h.app.inject({ url: '/api/v1/upload-requests', headers: h.as(who) }),
    ).items;
  const lines = (action: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['object_type', 'object_id', 'detail', 'actor_account_id'])
        .where('action', '=', action)
        .execute(),
    );
  const textsTo = (e164: string) => h.texts.filter((t) => t.to === e164);
  const e164 = (typed: string) => `+44${typed.replace(/\s+/g, '').slice(1)}`;

  beforeAll(async () => {
    h = await createHarness({ publicUrl: PUBLIC_URL, rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    adult = await h.join(owner, { name: 'Sana', email: 'sana-lt@example.test', role: 'adult' });
    ownerAccount = await accountOf(owner);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title: TITLE, type_key: 'utility_bill', visibility: 'household' },
    });
    lease = json<DocumentView>(created).id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${lease}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    // The household's text messages, set up and tested, as an owner does in Settings.
    await confirmed(ownerAccount, true);
    const saved = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/sms/settings',
      headers: h.as(owner),
      payload: {
        mode: 'local',
        base_url: 'http://192.168.1.20:8080',
        username: 'sms',
        password: 'sms-gate-password',
        country: 'GB',
        monthly_cap: 1000,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const tested = await h.app.inject({
      method: 'POST',
      url: '/api/v1/sms/settings/test',
      headers: h.as(owner),
      payload: { number: '07700 900999' },
    });
    expect(json<{ ok: boolean }>(tested).ok, tested.body).toBe(true);
  }, 120_000);
  afterAll(async () => {
    await admin.end();
    await h.close();
  });
  beforeEach(async () => {
    await admin.query("update sms_settings set status = 'ok', monthly_cap = 1000");
    await confirmed(ownerAccount, true);
  });

  it('texts a share link for its maker, in neutral words, never its PIN or title; counted, masked and written down', async () => {
    const made = await share({ with_pin: true, recipient_label: 'the letting agent' });
    expect(made.share).toMatchObject({ textable: true, texted_to: null });
    const to = number();
    const sent = await text(owner, `/api/v1/shares/${made.share.id}/text`, to);
    expect(sent.statusCode, sent.body).toBe(200);
    const answer = json<LinkTexted>(sent);
    expect(answer).toMatchObject({ sends_left: 2 });
    expect(answer.sent_to).toMatch(/^•+ •+\d{3}$/);
    const [one, ...more] = textsTo(e164(to));
    expect(more).toEqual([]);
    expect(one?.text).toContain(`${PUBLIC_URL}/s#${made.link_token}`);
    expect(one?.text).toContain('has shared a document with you');
    expect(one?.text).toContain('stops working on');
    for (const kept of [made.pin as string, TITLE, 'letting agent']) {
      expect(one?.text).not.toContain(kept);
    }
    // Listed with where it went, masked; never the number.
    const listed = (await links()).find((s) => s.id === made.share.id);
    expect(listed?.texted_to).toBe(answer.sent_to);
    expect(listed?.emailed_to).toBeNull();
    const all = await lines('share_link.texted');
    expect(all.find((l) => l.object_id === lease)).toMatchObject({
      actor_account_id: ownerAccount,
      detail: { share_id: made.share.id, to: answer.sent_to },
    });
    const logged = JSON.stringify(all);
    expect(logged).not.toContain(made.link_token);
    expect(logged).not.toContain(e164(to));
    // One row of the household's texts, of its own kind; counted to the cap.
    const kinds = await admin.query<{ kind: string }>(
      "select kind from sms_message where kind = 'share_link'",
    );
    expect(kinds.rows.length).toBeGreaterThanOrEqual(1);
    // Three a link in a day.
    for (let i = 0; i < 2; i++) {
      expect((await text(owner, `/api/v1/shares/${made.share.id}/text`, to)).statusCode).toBe(200);
    }
    const fourth = await text(owner, `/api/v1/shares/${made.share.id}/text`, to);
    expect(fourth.statusCode, fourth.body).toBe(429);
    expect(errorOf(fourth).code).toBe('text_link_limit');
    // Emails are counted on their own: texts use none of them up.
    const [{ n } = { n: 0 }] = (
      await admin.query<{ n: number }>(
        "select count(*)::int as n from share_link_email where share_id = $1 and way = 'email'",
        [made.share.id],
      )
    ).rows;
    expect(n).toBe(0);
  });

  it('refuses a number that cannot be one, somebody else’s link, and any text while texts are not set up', async () => {
    const made = await share();
    const bad = await text(owner, `/api/v1/shares/${made.share.id}/text`, '12');
    expect(bad.statusCode, bad.body).toBe(422);
    expect(errorOf(bad).code).toBe('phone_number_invalid');
    const theirs = await text(adult, `/api/v1/shares/${made.share.id}/text`, number());
    expect(theirs.statusCode, theirs.body).toBe(404);
    // Untested since: not offered, and refused.
    await admin.query("update sms_settings set status = 'untested'");
    expect((await links()).find((s) => s.id === made.share.id)?.textable).toBe(false);
    const off = await text(owner, `/api/v1/shares/${made.share.id}/text`, number());
    expect(off.statusCode, off.body).toBe(409);
    expect(errorOf(off).code).toBe('sms_not_set_up');
    // This month's texts all sent: said so, and nothing counted against the link.
    await admin.query("update sms_settings set status = 'ok', monthly_cap = 1");
    const capped = await text(owner, `/api/v1/shares/${made.share.id}/text`, number());
    expect(capped.statusCode, capped.body).toBe(409);
    expect(errorOf(capped).code).toBe('sms_cap_reached');
    const rows = await admin.query(
      "select 1 from share_link_email where share_id = $1 and way = 'sms'",
      [made.share.id],
    );
    expect(rows.rows).toEqual([]);
  });

  it('texts a request for whoever asked, never what it asks for or its PIN; later it asks who is asking', async () => {
    const made = await ask(owner, { with_pin: true });
    expect(made.request).toMatchObject({ textable: true, texted_to: null });
    const to = number();
    const sent = await text(owner, `/api/v1/upload-requests/${made.request.id}/text`, to);
    expect(sent.statusCode, sent.body).toBe(200);
    const [one] = textsTo(e164(to));
    expect(one?.text).toContain(`${PUBLIC_URL}/drop#${made.link_token}`);
    expect(one?.text).toContain('has asked you to send some documents');
    for (const kept of [made.pin as string, 'Secret tax title', 'private words']) {
      expect(one?.text).not.toContain(kept);
    }
    expect((await requests(owner)).find((r) => r.id === made.request.id)?.texted_to).toBe(
      json<LinkTexted>(sent).sent_to,
    );
    const all = await lines('upload_request.texted');
    expect(all.find((l) => l.object_id === made.request.id)).toMatchObject({
      object_type: 'upload_request',
      detail: { to: json<LinkTexted>(sent).sent_to },
    });
    // Somebody else's is not there.
    const hers = await ask(adult, { review_by: 'adults' });
    expect(
      (await text(owner, `/api/v1/upload-requests/${hers.request.id}/text`, number())).statusCode,
    ).toBe(404);
    // A quarter of an hour on, it asks who is asking.
    await admin.query(
      `update upload_request set created_at = now() - interval '20 minutes' where id = $1`,
      [made.request.id],
    );
    await confirmed(ownerAccount, false);
    const later = await text(owner, `/api/v1/upload-requests/${made.request.id}/text`, number());
    expect(errorOf(later)).toMatchObject({ code: 'step_up_required', action: 'email_share' });
  });

  it('a request’s PIN is kept with its link, shown again, made new, and said in its email — never the PIN', async () => {
    const made = await ask(owner, { with_pin: true });
    expect(made.pin).toMatch(/^\d{4}$/);
    const reveal = await h.app.inject({
      method: 'POST',
      url: `/api/v1/upload-requests/${made.request.id}/reveal`,
      headers: h.as(owner),
    });
    expect(reveal.statusCode, reveal.body).toBe(200);
    expect(json<RevealedUploadRequest>(reveal)).toMatchObject({
      link_token: made.link_token,
      pin: made.pin,
    });
    const renewed = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/upload-requests/${made.request.id}`,
      headers: h.as(owner),
      payload: { secret: 'pin' },
      ...peer(),
    });
    expect(renewed.statusCode, renewed.body).toBe(200);
    const pin = json<{ pin?: string; request: UploadRequestView }>(renewed);
    expect(pin.pin).toMatch(/^\d{4}$/);
    expect(pin.request.protection).toEqual(['pin']);
    const again = await h.app.inject({
      method: 'POST',
      url: `/api/v1/upload-requests/${made.request.id}/reveal`,
      headers: h.as(owner),
    });
    expect(json<RevealedUploadRequest>(again).pin).toBe(pin.pin);
    // Written down as changed, never with the PIN.
    const changed = await lines('upload_request.changed');
    const line = changed.find((l) => l.object_id === made.request.id);
    expect(line?.detail).toMatchObject({ changed: ['secret'], protection: 'pin' });
    expect(JSON.stringify(changed)).not.toContain(pin.pin as string);
    // Taking the PIN away reaches further: it asks who is asking.
    await confirmed(ownerAccount, false);
    const away = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/upload-requests/${made.request.id}`,
      headers: h.as(owner),
      payload: { secret: 'none' },
      ...peer(),
    });
    expect(errorOf(away)).toMatchObject({ code: 'step_up_required', action: 'change_share' });
    // Emailed, where the vault can send mail: it says a PIN is asked for, never which.
    if (made.request.emailable) {
      await confirmed(ownerAccount, true);
      const before = mailSent(h).length;
      const mailed = await h.app.inject({
        method: 'POST',
        url: `/api/v1/upload-requests/${made.request.id}/email`,
        headers: h.as(owner),
        payload: { to: 'jane.pin@example.com' },
        ...peer(),
      });
      expect(mailed.statusCode, mailed.body).toBe(200);
      const mail = mailSent(h).slice(before)[0];
      expect(mail?.text).toContain('It asks for a PIN');
      expect(mail?.text).not.toContain(pin.pin as string);
    }
  });

  it('texts mobile numbers in the household’s country alone: never a landline, premium-rate, freephone, VoIP or one abroad', async () => {
    const made = await share();
    const url = `/api/v1/shares/${made.share.id}/text`;
    const refused = async (typed: string, words: RegExp) => {
      const r = await text(owner, url, typed);
      expect(r.statusCode, `${typed}: ${r.body}`).toBe(422);
      expect(errorOf(r).code).toBe('phone_number_invalid');
      expect(errorOf(r).message).toMatch(words);
    };
    await refused('0909 879 0000', /premium-rate/);
    await refused('0870 123 4567', /premium-rate/);
    await refused('0800 123 4567', /freephone/);
    await refused('0303 123 4567', /isn’t a mobile one/);
    await refused('0560 123 4567', /isn’t a mobile one/);
    await refused('020 7946 0000', /isn’t a mobile one/);
    await refused('+33 6 12 34 56 78', /Only numbers in the United Kingdom/);
    await refused('07700 900123', /doesn’t look like a mobile number/);
    expect(textsTo('+33612345678')).toEqual([]);
    expect((await text(owner, url, '+44 7400 123456')).statusCode).toBe(200);
  });

  it('links and requests take half the month’s texts at most, so codes keep room', async () => {
    await admin.query('delete from sms_message');
    await admin.query(
      `insert into sms_message (household_id, number_tail, kind, provider_id, state)
       select $1, '123', 'share_link', 'gate-x', 'delivered' from generate_series(1, 2)`,
      [owner.household_id],
    );
    await admin.query('update sms_settings set monthly_cap = 4');
    const made = await share();
    const capped = await text(owner, `/api/v1/shares/${made.share.id}/text`, number());
    expect(capped.statusCode, capped.body).toBe(409);
    expect(errorOf(capped)).toMatchObject({ code: 'sms_cap_reached' });
    expect(errorOf(capped).message).toMatch(/texts for sending links/);
    // Nothing kept of it but its line, saying why.
    const kept = await admin.query('select way from share_link_email where share_id = $1', [
      made.share.id,
    ]);
    expect(kept.rows).toEqual([]);
    const why = (await lines('share_link.text_not_sent')).find(
      (l) => (l.detail as { share_id?: string }).share_id === made.share.id,
    );
    expect(why?.detail).toMatchObject({ reason: 'cap_reached' });
    // A request's text shares the same half.
    const asked = await ask(owner);
    const alsoCapped = await text(
      owner,
      `/api/v1/upload-requests/${asked.request.id}/text`,
      number(),
    );
    expect(errorOf(alsoCapped).code).toBe('sms_cap_reached');
    // Any other text still has room: the owner's test goes.
    const tested = await h.app.inject({
      method: 'POST',
      url: '/api/v1/sms/settings/test',
      headers: h.as(owner),
      payload: { number: '07400 100999' },
    });
    expect(json<{ ok: boolean }>(tested).ok, tested.body).toBe(true);
  });

  it('counts a person’s texts of links and requests together: twenty a day in all', async () => {
    // Nineteen today, with what the tests before sent: the next is the twentieth.
    const counted = async (table: string) =>
      (
        await admin.query<{ n: number }>(
          `select count(*)::int as n from ${table}
            where sent_by = $1 and way in ('sms', 'sms_not_sent')
              and sent_at > now() - interval '1 day'`,
          [ownerAccount],
        )
      ).rows[0]?.n ?? 0;
    const already = (await counted('share_link_email')) + (await counted('upload_request_email'));
    expect(already).toBeLessThan(19);
    await admin.query(
      `insert into share_link_email (household_id, share_id, sent_by, to_masked, way, sent_at)
       select $1, null, $2, '•••• •••000', 'sms', now() - interval '1 hour'
         from generate_series(1, $3::int)`,
      [owner.household_id, ownerAccount, 19 - already],
    );
    try {
      const asked = await ask(owner);
      const twentieth = await text(
        owner,
        `/api/v1/upload-requests/${asked.request.id}/text`,
        number(),
      );
      expect(twentieth.statusCode, twentieth.body).toBe(200);
      const made = await share();
      const more = await text(owner, `/api/v1/shares/${made.share.id}/text`, number());
      expect(more.statusCode, more.body).toBe(429);
      expect(errorOf(more)).toMatchObject({ code: 'text_link_limit' });
      expect(errorOf(more).message).toMatch(/20 links and requests today/);
    } finally {
      await admin.query("delete from share_link_email where sent_by = $1 and way = 'sms'", [
        ownerAccount,
      ]);
      await admin.query("delete from upload_request_email where sent_by = $1 and way = 'sms'", [
        ownerAccount,
      ]);
    }
  });

  it('a paused or ended link is neither texted nor emailed', async () => {
    const paused = await share();
    await admin.query(
      "update share_link set paused_at = now(), paused_reason = 'restored' where id = $1",
      [paused.share.id],
    );
    const ended = await share();
    await admin.query(
      "update share_link set expires_at = now() - interval '1 minute' where id = $1",
      [ended.share.id],
    );
    for (const id of [paused.share.id, ended.share.id]) {
      const to = number();
      const texted = await text(owner, `/api/v1/shares/${id}/text`, to);
      expect([409, 410], texted.body).toContain(texted.statusCode);
      expect(textsTo(e164(to))).toEqual([]);
      const emailed = await h.app.inject({
        method: 'POST',
        url: `/api/v1/shares/${id}/email`,
        headers: h.as(owner),
        payload: { to: 'jane.paused@example.com' },
        ...peer(),
      });
      expect([409, 410, 503], emailed.body).toContain(emailed.statusCode);
    }
    expect(mailSent(h).filter((m) => m.to === 'jane.paused@example.com')).toEqual([]);
  });
});

/**
 * The texts go outside any transaction (the dev.69 review): a dozen at once,
 * with an SMS Gate that takes its time, all finish — and the API answers
 * everybody else meanwhile — on the harness's pool of four. Held open across
 * the call to the phone, four were enough to stop it.
 */
describe.skipIf(!testAdminUrl())('link texts at once, and a text SMS Gate did not take', () => {
  let h: Harness;
  let admin: ReturnType<typeof createPool>;
  let owner: Tokens;
  let ownerAccount: string;
  let lease: string;
  const slow: SmsProviderFactory = () => ({
    send: async (to) => {
      await new Promise((r) => setTimeout(r, 300));
      if (to.endsWith('99')) throw new SmsProviderError('timeout', 'no answer');
      return { id: `slow-${randomUUID()}`, state: 'delivered' };
    },
    state: async () => ({ state: 'delivered' }),
  });
  let nth = 0;
  const peer = () => ({ remoteAddress: `10.96.${Math.floor(++nth / 200)}.${nth % 200}` });
  const json = <T>(r: { json: () => unknown }) => r.json() as T;

  beforeAll(async () => {
    h = await createHarness({ smsProvider: slow, rateLimitPerMinute: 100_000 });
    admin = createPool(h.adminUrl, 2);
    owner = await h.setup();
    ownerAccount = json<{ account_id: string }>(
      await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) }),
    ).account_id;
    await admin.query(
      'update session set verified_at = now(), factor_verified_at = now() where account_id = $1',
      [ownerAccount],
    );
    lease = json<DocumentView>(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/documents',
        headers: h.as(owner),
        payload: { title: TITLE, type_key: 'utility_bill', visibility: 'household' },
      }),
    ).id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${lease}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    expect(
      (
        await h.app.inject({
          method: 'PUT',
          url: '/api/v1/sms/settings',
          headers: h.as(owner),
          payload: {
            mode: 'local',
            base_url: 'http://192.168.1.20:8080',
            username: 'sms',
            password: 'sms-gate-password',
            country: 'GB',
            monthly_cap: 1000,
          },
        })
      ).statusCode,
    ).toBe(200);
    await admin.query("update sms_settings set status = 'ok'");
  }, 120_000);
  afterAll(async () => {
    await admin.end();
    await h.close();
  });

  const share = async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${lease}/share`,
      headers: h.as(owner),
      payload: {},
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<CreatedShare>(r);
  };
  const text = (id: string, to: string) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/shares/${id}/text`,
      headers: h.as(owner),
      payload: { to },
      ...peer(),
    });

  it('a dozen texts at once all finish, and the API answers meanwhile', async () => {
    const links = [await share(), await share(), await share(), await share()];
    const started = Date.now();
    const all = Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        text(links[i % 4]?.share.id as string, `07400 2${String(10000 + i)}`),
      ),
    );
    await new Promise((r) => setTimeout(r, 50));
    const meanwhile = await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) });
    expect(meanwhile.statusCode).toBe(200);
    const answers = (await all).map((r) => r.statusCode);
    expect(answers).toEqual(Array.from({ length: 12 }, () => 200));
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('a text SMS Gate did not take is said so, still counted for the day, and never shown as sent', async () => {
    const made = await share();
    const failed = await text(made.share.id, '07400 300099');
    expect(failed.statusCode, failed.body).toBe(503);
    expect(json<{ error: { code: string } }>(failed).error.code).toBe('sms_not_sent');
    const rows = await admin.query<{ way: string }>(
      'select way from share_link_email where share_id = $1',
      [made.share.id],
    );
    expect(rows.rows.map((r) => r.way)).toEqual(['sms_not_sent']);
    const listed = json<{ items: ShareView[] }>(
      await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
    ).items.find((s) => s.id === made.share.id);
    expect(listed?.texted_to).toBeNull();
    const said = await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['detail'])
        .where('action', '=', 'share_link.text_not_sent')
        .execute(),
    );
    expect(said.map((l) => l.detail)).toContainEqual(
      expect.objectContaining({ share_id: made.share.id, reason: 'not_sent' }),
    );
    // Counted: two more, then the day's three for the link are used.
    for (let i = 0; i < 2; i++) await text(made.share.id, '07400 300099');
    const fourth = await text(made.share.id, '07400 300123');
    expect(fourth.statusCode, fourth.body).toBe(429);
  }, 60_000);
});
