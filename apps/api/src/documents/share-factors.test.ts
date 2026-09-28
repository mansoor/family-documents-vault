import { createHash, createHmac, randomUUID } from 'node:crypto';
import { deriveKey } from '@fdv/crypto';
import { withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  maskEmail,
  SHARE_CODE_UNAVAILABLE,
  type Capabilities,
  type CollectionDetail,
  type DocumentView,
  type ShareCodeSent,
  type ShareLinkPreview,
  type SharedSession,
} from '@fdv/shared';
import argon2 from 'argon2';
import type { LightMyRequestResponse } from 'fastify';
import FormData from 'form-data';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from '../auth/service.js';
import { createHarness, mailSent, TEST_MASTER, type Harness } from '../test-harness.js';
import { SHARE_CODE_KEY_PURPOSE, type CreatedShare, type ShareView } from './shares.js';

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

type Cookie = {
  name: string;
  value: string;
  path?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
};

/**
 * A second factor for someone with no account (5.20).
 *
 * A link can ask for a PIN or a password, a code emailed to an address its
 * sharer typed, and to open in one browser only, in any combination; for a
 * document's link and a collection's alike. What matters is what none of
 * it can be made to do: send a code anywhere but where the sharer said, or
 * through anything but the operator's mail server (A21); give more than ten
 * guesses in a link's life, however they are split between factors (A23);
 * say which of two factors was wrong; keep a code anyone could read back
 * from a dump; open in a second browser; or leave an address in the log.
 */
describe.skipIf(!testAdminUrl())('a second factor for someone with no account (5.20)', () => {
  let h: Harness;
  let owner: Tokens;
  let ownerAccount: string;
  let lease: string;
  let will: string;
  let broker: string;
  /** Everything the API wrote to its log, line by line. */
  const logged: string[] = [];

  const json = <T>(r: { json: () => unknown }) => r.json() as T;
  const errorOf = (r: LightMyRequestResponse) =>
    json<{ error: { code: string; message: string } }>(r).error;

  let nth = 0;
  const peer = () => ({ remoteAddress: `10.20.${Math.floor(++nth / 200)}.${nth % 200}` });

  /** An address nobody else's test sends to. */
  const address = (who = 'jane.smith') => `${who}+b520-${randomUUID().slice(0, 8)}@example.test`;

  const make = async (title: string) => {
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: h.as(owner),
      payload: { title, type_key: 'utility_bill', visibility: 'household' },
    });
    const id = json<DocumentView>(created).id;
    const form = new FormData();
    form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${id}/versions`,
      headers: { ...h.as(owner), ...form.getHeaders(), 'idempotency-key': randomUUID() },
      payload: form.getBuffer(),
    });
    return id;
  };

  const share = (documentId: string, body: Record<string, unknown>) =>
    h.app.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/share`,
      headers: h.as(owner),
      payload: body,
    });
  const made = async (documentId: string, body: Record<string, unknown>) => {
    const r = await share(documentId, body);
    expect(r.statusCode, r.body).toBe(201);
    return json<CreatedShare>(r);
  };
  /** A link to the broker's collection: always after confirming it's you (5.19). */
  const madeForCollection = async (body: Record<string, unknown>) => {
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('session')
        .set({ verified_at: new Date() })
        .where('account_id', '=', ownerAccount)
        .execute(),
    );
    const r = await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${broker}/shares`,
      headers: h.as(owner),
      payload: { document_ids: [lease, will], ...body },
    });
    expect(r.statusCode, r.body).toBe(201);
    return json<CreatedShare>(r);
  };

  // ------------------------------------------------- the recipient's calls

  const preview = (token: string, device?: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/preview',
      payload: { token },
      ...(device ? { cookies: { fdv_share_device: device } } : {}),
      ...peer(),
    });
  const sendCode = (token: string, extra: Record<string, unknown> = {}, device?: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/code',
      payload: { token, ...extra },
      ...(device ? { cookies: { fdv_share_device: device } } : {}),
      ...peer(),
    });
  const unlock = (token: string, given: { secret?: string; code?: string } = {}, device?: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token, ...given },
      ...(device ? { cookies: { fdv_share_device: device } } : {}),
      ...peer(),
    });
  const cookiesOf = (r: LightMyRequestResponse) => r.cookies as Cookie[];
  const cookie = (r: LightMyRequestResponse, name: string) =>
    cookiesOf(r).find((c) => c.name === name);
  const items = (session: string, device?: string) =>
    h.app.inject({
      url: '/api/v1/shared/items',
      cookies: { fdv_share: session, ...(device ? { fdv_share_device: device } : {}) },
      ...peer(),
    });

  /** The code the harness caught on its way to `to`, the newest. */
  const codeSentTo = (to: string) => {
    const mails = mailSent(h).filter((m) => m.to === to);
    const text = mails.at(-1)?.text ?? '';
    return /(\d{3}) (\d{3})/.exec(text)?.slice(1).join('') ?? '';
  };
  const sendAndRead = async (token: string, to: string) => {
    const r = await sendCode(token);
    expect(r.statusCode, r.body).toBe(200);
    return codeSentTo(to);
  };
  const another = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

  const linkRow = (id: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('share_link')
        .select([
          'attempts',
          'open_count',
          'code_email',
          'device_hash',
          'secret_kind',
          'pin_hash',
          'this_device_only',
        ])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
  const codesOf = (shareId: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('share_code')
        .selectAll()
        .where('share_id', '=', shareId)
        .orderBy('sent_at')
        .execute(),
    );
  const auditOf = (shareId: string) =>
    withSystem(h.db, owner.household_id, (trx) =>
      trx
        .selectFrom('audit_event')
        .select(['action', 'detail'])
        .where(sql<boolean>`detail->>'share_id' = ${shareId}`)
        .orderBy('id')
        .execute(),
    );

  beforeAll(async () => {
    h = await createHarness({
      logger: { level: 'info', stream: { write: (s: string) => void logged.push(s) } },
    });
    owner = await h.setup();
    ownerAccount = json<{ account_id: string }>(
      await h.app.inject({ url: '/api/v1/me', headers: h.as(owner) }),
    ).account_id;
    lease = await make('Flat 3 tenancy agreement');
    will = await make('Divorce settlement draft');
    const c = await h.app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: h.as(owner),
      payload: { name: 'For the broker', audience: 'everyone' },
    });
    broker = json<CollectionDetail>(c).id;
    await h.app.inject({
      method: 'POST',
      url: `/api/v1/collections/${broker}/items`,
      headers: h.as(owner),
      payload: { document_ids: [lease, will] },
    });
  }, 90_000);
  afterAll(() => h.close());

  // ------------------------------------------------------------ the code

  it('the code goes only to the address the sharer typed', async () => {
    for (const kind of ['document', 'collection'] as const) {
      const to = address();
      const created =
        kind === 'document'
          ? await made(lease, { code_email: to })
          : await madeForCollection({ code_email: to });
      // The page says which inbox, masked, and asks for nothing typed but the code.
      const p = json<ShareLinkPreview>(await preview(created.link_token));
      expect(p.protection, kind).toEqual(['code']);
      expect(p.code_to, kind).toBe(maskEmail(to));
      expect(p.document_title, kind).toBeNull();
      expect(p.collection_name ?? null, kind).toBeNull();
      expect(JSON.stringify(p)).not.toContain(to);

      // An address from the page is not taken: there is nowhere to say one.
      const elsewhere = await sendCode(created.link_token, { to: 'someone@else.test' });
      expect(elsewhere.statusCode, kind).toBe(422);
      const before = h.jobs.length;
      const sent = await sendCode(created.link_token);
      expect(sent.statusCode, sent.body).toBe(200);
      expect(json<ShareCodeSent>(sent).sent_to).toBe(maskEmail(to));
      // One email, to that address and nobody else, by the operator's mail
      // server alone: a `mail.to_address` job, never the household's alerts.
      const jobs = h.jobs.slice(before);
      expect(
        jobs.map((j) => j.name),
        kind,
      ).toEqual(['mail.to_address']);
      const mails = mailSent({ jobs });
      expect(
        mails.map((m) => m.to),
        kind,
      ).toEqual([to]);
      // And the queue holds no address and no code: they are sealed.
      const onQueue = JSON.stringify(jobs[0]?.data);
      expect(onQueue).not.toContain('@');
      expect(onQueue).not.toContain(codeSentTo(to));
      expect(codeSentTo(to)).toMatch(/^\d{6}$/);
    }
  });

  it('the fourth code in 15 minutes is refused', async () => {
    const to = address();
    const created = await made(lease, { code_email: to });
    for (let i = 0; i < 3; i++) {
      expect((await sendCode(created.link_token)).statusCode).toBe(200);
    }
    const fourth = await sendCode(created.link_token);
    expect(fourth.statusCode).toBe(429);
    expect(errorOf(fourth).code).toBe('code_limit');
    expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(0);
    expect(mailSent(h).filter((m) => m.to === to)).toHaveLength(3);
    // However many ask at once: three, and not one more.
    const racing = await made(lease, { code_email: address() });
    const answers = await Promise.all(Array.from({ length: 6 }, () => sendCode(racing.link_token)));
    expect(answers.filter((r) => r.statusCode === 200)).toHaveLength(3);
    expect(answers.filter((r) => r.statusCode === 429)).toHaveLength(3);
    expect(await codesOf(racing.share.id)).toHaveLength(3);
    // And ten in a day: nine sent earlier today, none in the last 15
    // minutes, leave one more.
    const daily = await made(lease, { code_email: address() });
    const earlier = (hoursAgo: number) => {
      const at = new Date(Date.now() - hoursAgo * 3_600_000);
      return {
        id: randomUUID(),
        household_id: owner.household_id,
        share_id: daily.share.id,
        code_hash: Buffer.alloc(32),
        sent_at: at,
        expires_at: at,
      };
    };
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .insertInto('share_code')
        .values([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => earlier(n * 2)))
        .execute(),
    );
    expect((await sendCode(daily.link_token)).statusCode).toBe(200);
    const eleventh = await sendCode(daily.link_token);
    expect(eleventh.statusCode, eleventh.body).toBe(429);
    expect(errorOf(eleventh).message).toMatch(/today/);
  });

  it('a code works once, for 10 minutes', async () => {
    const to = address();
    const created = await made(lease, { code_email: to });
    const first = await sendAndRead(created.link_token, to);
    const [row] = await codesOf(created.share.id);
    expect((row?.expires_at.getTime() ?? 0) - (row?.sent_at.getTime() ?? 0)).toBe(10 * 60_000);

    // It opens once ...
    expect((await unlock(created.link_token, { code: first })).statusCode).toBe(200);
    // ... and never again.
    const again = await unlock(created.link_token, { code: first });
    expect(again.statusCode).toBe(401);
    expect((await codesOf(created.share.id))[0]?.used_at).not.toBeNull();

    // Ten minutes on, a code opens nothing.
    const second = await sendAndRead(created.link_token, to);
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('share_code')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('share_id', '=', created.share.id)
        .where('used_at', 'is', null)
        .execute(),
    );
    expect((await unlock(created.link_token, { code: second })).statusCode).toBe(401);

    // A newer code ends the one before it (on a link of its own: three
    // sends in 15 minutes are a link's all).
    const other = address();
    const newer = await made(lease, { code_email: other });
    const third = await sendAndRead(newer.link_token, other);
    const fourth = await sendAndRead(newer.link_token, other);
    if (third !== fourth) {
      expect((await unlock(newer.link_token, { code: third })).statusCode).toBe(401);
    }
    expect((await unlock(newer.link_token, { code: fourth })).statusCode).toBe(200);
    // What a code is, once sent, stays: its tries only go up, it is used once.
    await expect(
      withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('share_code')
          .set({ used_at: null })
          .where('share_id', '=', created.share.id)
          .execute(),
      ),
    ).rejects.toThrow(/used once/);
  });

  it('a code has five tries, then it is spent', async () => {
    const to = address();
    const created = await made(lease, { code_email: to });
    const code = await sendAndRead(created.link_token, to);
    for (let i = 0; i < 5; i++) {
      expect((await unlock(created.link_token, { code: another(code) })).statusCode).toBe(401);
    }
    expect((await codesOf(created.share.id))[0]?.attempts).toBe(5);
    // Right, but spent.
    expect((await unlock(created.link_token, { code })).statusCode).toBe(401);
    expect((await linkRow(created.share.id)).attempts).toBe(6);
    // A new one works.
    const fresh = await sendAndRead(created.link_token, to);
    expect((await unlock(created.link_token, { code: fresh })).statusCode).toBe(200);
  });

  // ---------------------------------------------- one counter of ten (A23)

  it('wrong codes and wrong passwords share one counter of 10', async () => {
    const to = address();
    const created = await made(lease, {
      password: 'river otter lantern',
      code_email: to,
      recipient_label: 'the notary',
    });
    const before = h.jobs.length;
    const code = await sendAndRead(created.link_token, to);
    // Four wrong passwords, the code right ...
    for (let i = 0; i < 4; i++) {
      const r = await unlock(created.link_token, { secret: 'wrong password', code });
      expect(r.statusCode).toBe(401);
    }
    // ... and four wrong codes, the password right: eight of the link's ten.
    for (let i = 0; i < 4; i++) {
      const r = await unlock(created.link_token, {
        secret: 'river otter lantern',
        code: another(code),
      });
      expect(r.statusCode).toBe(401);
    }
    expect((await linkRow(created.share.id)).attempts).toBe(8);
    // Two more, of either, and it has stopped: the right password and the
    // right code open nothing after.
    await unlock(created.link_token, { secret: 'wrong again', code });
    const tenth = await unlock(created.link_token, {
      secret: 'river otter lantern',
      code: '000000',
    });
    expect(tenth.statusCode).toBe(401);
    expect(tenth.body).toMatch(/stopped working/);
    expect((await linkRow(created.share.id)).attempts).toBe(10);
    const after = await unlock(created.link_token, { secret: 'river otter lantern', code });
    expect(after.statusCode).toBe(404);

    // Written down once, as locked; the sharer told once; and the address
    // its code went to cleared, as the link has ended.
    expect((await auditOf(created.share.id)).map((a) => a.action)).toEqual([
      'share.created',
      'share.code_sent',
      'share.locked',
    ]);
    const told = h.jobs
      .slice(before)
      .filter((j) => j.name === 'alert.send' && /stopped working/.test(String(j.data.subject)));
    expect(told).toHaveLength(1);
    expect(JSON.stringify(told[0]?.data)).not.toMatch(/notary|tenancy|@/);
    expect((await linkRow(created.share.id)).code_email).toBeNull();

    // Codes alone count as well, however many arrive at once: ten, no more.
    const racing = await made(lease, { code_email: address() });
    const tries = await Promise.all(
      Array.from({ length: 20 }, () => unlock(racing.link_token, { code: '123456' })),
    );
    expect(tries.filter((r) => r.statusCode === 401)).toHaveLength(10);
    expect(tries.filter((r) => r.statusCode === 404)).toHaveLength(10);
    expect((await linkRow(racing.share.id)).attempts).toBe(10);
  }, 60_000);

  it('with a password and a code, a wrong password and a wrong code get the same answer', async () => {
    for (const kind of ['document', 'collection'] as const) {
      const to = address();
      const body = { password: 'correct pony staple', code_email: to };
      const created = kind === 'document' ? await made(lease, body) : await madeForCollection(body);
      const p = json<ShareLinkPreview>(await preview(created.link_token));
      expect(p.protection, kind).toEqual(['password', 'code']);
      const code = await sendAndRead(created.link_token, to);

      const wrongPassword = await unlock(created.link_token, { secret: 'not it at all', code });
      const wrongCode = await unlock(created.link_token, {
        secret: 'correct pony staple',
        code: another(code),
      });
      const wrongBoth = await unlock(created.link_token, {
        secret: 'not it at all',
        code: another(code),
      });
      const noCode = await unlock(created.link_token, { secret: 'correct pony staple' });
      const answer = (r: LightMyRequestResponse) => ({
        status: r.statusCode,
        ...errorOf(r),
        request_id: undefined,
      });
      // The same status, the same code and the same words, every time.
      expect(answer(wrongPassword), kind).toEqual(answer(wrongCode));
      expect(answer(wrongBoth), kind).toEqual(answer(wrongCode));
      expect(answer(noCode), kind).toEqual(answer(wrongCode));
      expect(answer(wrongCode)).toMatchObject({ status: 401, code: 'secret_wrong' });
      // The code was tried only once the password was right.
      const [row] = await codesOf(created.share.id);
      expect(row?.attempts, kind).toBe(2);
      // And both right open it, once.
      const right = await unlock(created.link_token, { secret: 'correct pony staple', code });
      expect(right.statusCode, right.body).toBe(200);
      expect(json<SharedSession>(right).items.length).toBeGreaterThan(0);
      const sessions = await withSystem(h.db, owner.household_id, (trx) =>
        trx
          .selectFrom('share_session')
          .select('verified_by')
          .where('share_id', '=', created.share.id)
          .execute(),
      );
      expect(sessions.map((s) => s.verified_by)).toEqual(['password+code']);
    }
  });

  it('the stored code cannot be checked without the server key', async () => {
    const to = address();
    const created = await made(lease, { code_email: to });
    const code = await sendAndRead(created.link_token, to);
    const [row] = await codesOf(created.share.id);
    if (!row) throw new Error('no code was kept');
    // Not the code, not its plain hash, and not the hash of what it is
    // HMACed over: a dump of every six-digit code is searched in a moment,
    // and none of them is it.
    const stored = row.code_hash.toString('hex');
    expect(row.code_hash).toHaveLength(32);
    for (let n = 0; n < 1_000_000; n++) {
      const guess = String(n).padStart(6, '0');
      const plain = createHash('sha256').update(guess).digest('hex');
      const bare = createHash('sha256')
        .update(`${created.share.id}:${row.id}:${guess}`)
        .digest('hex');
      if (plain === stored || bare === stored) throw new Error(`found by a plain hash: ${guess}`);
    }
    // It is an HMAC under the key the server derives from its master key:
    // with that key it checks, with any other it does not.
    const hmac = (key: Buffer, guess: string) =>
      createHmac('sha256', key).update(`${created.share.id}:${row.id}:${guess}`).digest('hex');
    expect(hmac(deriveKey(TEST_MASTER, SHARE_CODE_KEY_PURPOSE), code)).toBe(stored);
    expect(hmac(deriveKey(`${TEST_MASTER}-another-one`, SHARE_CODE_KEY_PURPOSE), code)).not.toBe(
      stored,
    );
    expect(hmac(deriveKey(TEST_MASTER, 'smtp-credentials'), code)).not.toBe(stored);
    // And the line saying it was sent does not hold it either.
    const sent = (await auditOf(created.share.id)).find((a) => a.action === 'share.code_sent');
    expect(sent).toBeDefined();
    expect(JSON.stringify(sent?.detail)).not.toContain(code);
  }, 60_000);

  it('the email has no link and no title', async () => {
    for (const kind of ['document', 'collection'] as const) {
      const to = address();
      const created =
        kind === 'document'
          ? await made(will, { code_email: to, recipient_label: 'Jane at Smith & Co' })
          : await madeForCollection({ code_email: to, recipient_label: 'Jane at Smith & Co' });
      await sendAndRead(created.link_token, to);
      const mail = mailSent(h).filter((m) => m.to === to);
      expect(mail, kind).toHaveLength(1);
      const all = `${mail[0]?.subject}\n${mail[0]?.text}`;
      // The code, to type where they asked for it ...
      expect(all).toMatch(/\d{3} \d{3}/);
      // ... and no link, no title, no collection, no family, nobody's name.
      expect(all, kind).not.toMatch(/https?:|www\.|\/s#|localhost|<a\b|href/i);
      for (const said of [
        'Divorce settlement draft',
        'Flat 3 tenancy agreement',
        'For the broker',
        'The Test family',
        'Owner',
        'Jane at Smith',
        created.link_token,
      ]) {
        expect(all, `${kind}: ${said}`).not.toContain(said);
      }
    }
  });

  it('without operator mail the option is absent and refused', async () => {
    const without = await createHarness({ operatorMail: false });
    try {
      const o = await without.setup();
      const caps = json<Capabilities>(await without.app.inject({ url: '/api/v1/capabilities' }));
      expect(caps.features.share_email_code).toBe(false);
      // A password and one browser only are there all the same.
      expect(caps.features.share_second_factor).toBe(true);
      const doc = json<DocumentView>(
        await without.app.inject({
          method: 'POST',
          url: '/api/v1/documents',
          headers: without.as(o),
          payload: { title: 'Lease', type_key: 'utility_bill', visibility: 'household' },
        }),
      ).id;
      const form = new FormData();
      form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
      await without.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc}/versions`,
        headers: { ...without.as(o), ...form.getHeaders(), 'idempotency-key': randomUUID() },
        payload: form.getBuffer(),
      });
      const refused = await without.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc}/share`,
        headers: without.as(o),
        payload: { code_email: address() },
      });
      expect(refused.statusCode).toBe(422);
      expect(errorOf(refused)).toMatchObject({
        code: 'email_code_unavailable',
        message: SHARE_CODE_UNAVAILABLE,
      });
      // Nothing was made, and nothing sent.
      const listed = json<{ items: ShareView[] }>(
        await without.app.inject({ url: '/api/v1/shares', headers: without.as(o) }),
      );
      expect(listed.items).toHaveLength(0);
      expect(mailSent(without)).toHaveLength(0);
      // The rest is there.
      const pw = await without.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc}/share`,
        headers: without.as(o),
        payload: { with_password: true, this_device_only: true },
      });
      expect(pw.statusCode, pw.body).toBe(201);
    } finally {
      await without.close();
    }
    // And with it, the option is there.
    const caps = json<Capabilities>(await h.app.inject({ url: '/api/v1/capabilities' }));
    expect(caps.features.share_email_code).toBe(true);
  }, 90_000);

  // ------------------------------------------------- a password, and a PIN

  it('a password is made up or typed, shown once, and asked for instead of a PIN', async () => {
    const madeUp = await made(lease, { with_password: true });
    expect(madeUp.password).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(madeUp.pin).toBeUndefined();
    expect(madeUp.share).toMatchObject({ protection: ['password'], has_pin: false });
    const p = json<ShareLinkPreview>(await preview(madeUp.link_token));
    expect(p).toMatchObject({ protection: ['password'], document_title: null });
    expect((await unlock(madeUp.link_token, { secret: 'nope nope' })).statusCode).toBe(401);
    expect(
      (await unlock(madeUp.link_token, { secret: madeUp.password as string })).statusCode,
    ).toBe(200);
    // Shown once: nowhere in the list, and kept only as an argon2 hash.
    const listed = await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) });
    expect(listed.body).not.toContain(madeUp.password);
    const row = await linkRow(madeUp.share.id);
    expect(row.secret_kind).toBe('password');
    expect(await argon2.verify(row.pin_hash as string, madeUp.password as string)).toBe(true);

    const typed = await made(lease, { password: '  horse battery  ' });
    expect(typed.password).toBeUndefined();
    expect((await unlock(typed.link_token, { secret: 'horse battery' })).statusCode).toBe(200);
    // At least 8 characters; one secret at most.
    expect((await share(lease, { password: 'short' })).statusCode).toBe(422);
    expect((await share(lease, { with_pin: true, password: 'long enough' })).statusCode).toBe(422);
    expect((await share(lease, { with_pin: true, with_password: true })).statusCode).toBe(422);
    // A PIN is as it was.
    const pin = await made(lease, { with_pin: true });
    expect(pin.share).toMatchObject({ protection: ['pin'], has_pin: true });
    // What protects a link stays as it was made, whoever asks.
    await expect(
      withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('share_link')
          .set({ this_device_only: true } as never)
          .where('id', '=', pin.share.id)
          .execute(),
      ),
    ).rejects.toThrow(/keeps the protection/);
    // And a legacy link has none of the new ones (0037's rule).
    const options: Array<[Record<string, unknown>, RegExp]> = [
      [{ secret_kind: 'password', pin_hash: 'x' }, /share_link_password_v2/],
      [{ code_email: 'a@b.test' }, /share_link_code_email_v2/],
      [{ this_device_only: true }, /share_link_this_device_v2/],
    ];
    for (const [values, rule] of options) {
      await expect(
        withSystem(h.db, owner.household_id, (trx) =>
          trx
            .insertInto('share_link')
            .values({
              household_id: owner.household_id,
              document_id: lease,
              token_hash: createHash('sha256').update(randomUUID()).digest(),
              created_by: ownerAccount,
              expires_at: new Date(Date.now() + 864e5),
              flow: 'legacy',
              ...(values as object),
            })
            .execute(),
        ),
      ).rejects.toThrow(rule);
    }
  });

  // --------------------------------------------------- this device only

  it('a second browser is refused', async () => {
    for (const kind of ['document', 'collection'] as const) {
      const created =
        kind === 'document'
          ? await made(lease, { this_device_only: true, with_pin: true })
          : await madeForCollection({ this_device_only: true, with_pin: true });
      const pin = created.pin as string;
      expect(json<ShareLinkPreview>(await preview(created.link_token))).toMatchObject({
        this_device_only: true,
        other_device: false,
      });

      // The first browser: opened, and bound by a cookie of its own.
      const first = await unlock(created.link_token, { secret: pin });
      expect(first.statusCode, first.body).toBe(200);
      const device = cookie(first, 'fdv_share_device');
      expect(device, kind).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
        path: '/api/v1/shared',
      });
      const session = cookie(first, 'fdv_share')?.value as string;
      // Kept as a hash, with the link's id: neither the cookie nor its plain hash.
      const row = await linkRow(created.share.id);
      expect(row.device_hash).not.toBeNull();
      const bare = createHash('sha256')
        .update(device?.value ?? '')
        .digest();
      expect(row.device_hash?.equals(bare)).toBe(false);

      // Another browser: told before it tries, refused if it does, and
      // nothing tried, counted or given away.
      const elsewhere = json<ShareLinkPreview>(await preview(created.link_token));
      expect(elsewhere).toMatchObject({ other_device: true, document_title: null });
      const refused = await unlock(created.link_token, { secret: pin });
      expect(refused.statusCode, kind).toBe(403);
      expect(errorOf(refused).code).toBe('other_device');
      const forged = await unlock(created.link_token, { secret: pin }, 'a-cookie-of-its-own');
      expect(forged.statusCode, kind).toBe(403);
      expect(await linkRow(created.share.id)).toMatchObject({ attempts: 0, open_count: 1 });
      // Nor can it be sent codes, or use the first browser's session.
      expect((await items(session)).statusCode).toBe(403);
      expect((await items(session, 'a-cookie-of-its-own')).statusCode).toBe(403);

      // The first browser opens it again, and its session goes on.
      expect((await items(session, device?.value)).statusCode).toBe(200);
      const again = await unlock(created.link_token, { secret: pin }, device?.value);
      expect(again.statusCode, again.body).toBe(200);
      expect(cookie(again, 'fdv_share_device')?.value).toBe(device?.value);
    }

    // Two browsers pressing Open at once on a link never opened: one.
    const racing = await made(lease, { this_device_only: true });
    const answers = await Promise.all(Array.from({ length: 5 }, () => unlock(racing.link_token)));
    expect(answers.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(answers.filter((r) => r.statusCode === 403)).toHaveLength(4);
    expect((await linkRow(racing.share.id)).open_count).toBe(1);
    // A code is not sent for a browser the link will not open in.
    const to = address();
    const coded = await made(lease, { this_device_only: true, code_email: to });
    const code = await sendAndRead(coded.link_token, to);
    const bound = await unlock(coded.link_token, { code });
    expect(bound.statusCode).toBe(200);
    expect((await sendCode(coded.link_token)).statusCode).toBe(403);
    expect(
      (await sendCode(coded.link_token, {}, cookie(bound, 'fdv_share_device')?.value)).statusCode,
    ).toBe(200);
  }, 60_000);

  // ------------------------------------------------------ the address

  it('the address is masked in the audit', async () => {
    const to = address('robert.brown');
    const created = await made(lease, { code_email: to, recipient_label: 'Robert' });
    await sendAndRead(created.link_token, to);
    const rows = await auditOf(created.share.id);
    expect(rows.map((r) => r.action)).toEqual(['share.created', 'share.code_sent']);
    const masked = maskEmail(to);
    expect(masked).toBe('r•••@e•••.test');
    expect(rows[0]?.detail).toMatchObject({ code_to: masked });
    expect(rows[1]?.detail).toMatchObject({ to: masked });
    // Not the address, nor its name, anywhere in the log; nor in what the
    // family reads of it, nor in the list of links.
    const everything = await withSystem(h.db, owner.household_id, (trx) =>
      trx.selectFrom('audit_event').select(['detail', 'actor_label']).execute(),
    );
    expect(JSON.stringify(everything)).not.toContain('robert.brown');
    const activity = await h.app.inject({ url: '/api/v1/audit', headers: h.as(owner) });
    expect(activity.body).toContain(`was emailed to ${masked}`);
    expect(activity.body).not.toContain('robert.brown');
    const listed = json<{ items: ShareView[] }>(
      await h.app.inject({ url: '/api/v1/shares', headers: h.as(owner) }),
    ).items.find((s) => s.id === created.share.id);
    expect(listed).toMatchObject({ protection: ['code'], code_to: masked });
    expect(JSON.stringify(listed)).not.toContain('robert.brown');
  });

  it('the email address is cleared when the link ends', async () => {
    // Taken back.
    const revoked = await made(lease, { code_email: address() });
    await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/shares/${revoked.share.id}`,
      headers: h.as(owner),
    });
    expect((await linkRow(revoked.share.id)).code_email).toBeNull();
    // Opened as often as it allows.
    const to = address();
    const once = await made(lease, { code_email: to, max_opens: 1 });
    const code = await sendAndRead(once.link_token, to);
    expect((await unlock(once.link_token, { code })).statusCode).toBe(200);
    expect((await linkRow(once.share.id)).code_email).toBeNull();
    // A live link keeps it, whoever asks to clear it.
    const live = await made(lease, { code_email: address() });
    await expect(
      withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('share_link')
          .set({ code_email: null })
          .where('id', '=', live.share.id)
          .execute(),
      ),
    ).rejects.toThrow(/only when the link has ended/);
  });

  // ------------------------------------------------------------ the log

  it('no code, password, PIN, email address or cookie appears in the request log', async () => {
    logged.length = 0;
    const to = address('logged.person');
    const created = await made(lease, {
      password: 'lantern fjord cobalt',
      code_email: to,
      this_device_only: true,
    });
    const pin = await made(lease, { with_pin: true, this_device_only: true });
    const madeUp = await made(lease, { with_password: true, code_email: to });
    await preview(created.link_token);
    const code = await sendAndRead(created.link_token, to);
    await unlock(created.link_token, { secret: 'lantern fjord wrong', code });
    await unlock(created.link_token, { secret: 'lantern fjord cobalt', code: another(code) });
    const opened = await unlock(created.link_token, { secret: 'lantern fjord cobalt', code });
    expect(opened.statusCode, opened.body).toBe(200);
    const session = cookie(opened, 'fdv_share')?.value as string;
    const device = cookie(opened, 'fdv_share_device')?.value as string;
    await items(session, device);
    await items(session);
    await unlock(created.link_token, { secret: 'lantern fjord cobalt', code }, 'forged-device');
    await sendCode(created.link_token, {}, device);
    const pinOpened = await unlock(pin.link_token, { secret: pin.pin as string });
    await unlock(madeUp.link_token, { secret: madeUp.password as string });
    await sendCode(madeUp.link_token);
    // And an address refused on its way in.
    await share(lease, { code_email: 'not-an-address@' });

    const text = logged.join('\n');
    expect(text).toContain('/api/v1/shared/code');
    expect(text).toContain('/api/v1/shared/unlock');
    const secrets = [
      created.link_token,
      madeUp.link_token,
      'lantern fjord cobalt',
      'lantern fjord wrong',
      madeUp.password as string,
      code,
      to,
      'logged.person',
      session,
      device,
      cookie(pinOpened, 'fdv_share')?.value as string,
      cookie(pinOpened, 'fdv_share_device')?.value as string,
      'forged-device',
    ];
    for (const s of secrets) expect(text, 'a secret in the log').not.toContain(s);
    expect(text).not.toContain(`"${pin.pin}"`);
    expect(text).not.toMatch(/secret|"pin"|pin=|fdv_share|code_email|"code"|@example\.test/);
  });
});
