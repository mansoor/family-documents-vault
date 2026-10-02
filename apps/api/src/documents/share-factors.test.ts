import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { deriveKey } from '@fdv/crypto';
import { verifyAuditChain, withSystem } from '@fdv/db';
import { testAdminUrl } from '@fdv/db/testing';
import {
  maskEmail,
  SHARE_CODE_CANNOT_SEND,
  SHARE_CODE_UNAVAILABLE,
  SHARE_NEWEST_CODE_ONLY,
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
import type { MailRequest } from '../mail-job.js';
import {
  deviceCookieKey,
  mintDeviceCookie,
  verifiedDeviceCookie,
} from '../public/device-cookie.js';
import { createHarness, mailSent, TEST_MASTER, type Harness } from '../test-harness.js';
import { SHARE_CODE_KEY_PURPOSE, type CreatedShare, type ShareView } from './shares.js';

/** What "this device only" cookies are made with (shares.ts SHARE_DEVICE_KEY_PURPOSE). */
const SHARE_DEVICE_KEY_PURPOSE = 'share-device';
/** The key a test vault makes them under, and the name it gives them (ROT-C-03). */
const NOW_KEY = deviceCookieKey(TEST_MASTER, SHARE_DEVICE_KEY_PURPOSE);
const nameOf = (key: Buffer) =>
  `fdv_share_device_${createHmac('sha256', key).update('kid').digest('hex').slice(0, 8)}`;
const NOW_NAME = nameOf(NOW_KEY);

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

  /**
   * A browser's "this device only" cookies, as it sends them: a value alone
   * goes under the name the vault gives its cookies now (`fdv_share_device_<kid>`
   * of the key in use) — where a cookie planted to be bound would be put —
   * and a jar is sent as it is (ROT-C-03: a browser may hold one a key).
   */
  type Jar = Record<string, string>;
  const jarOf = (device?: string | Jar): Jar | undefined =>
    device === undefined ? undefined : typeof device === 'string' ? { [NOW_NAME]: device } : device;
  const preview = (token: string, device?: string | Jar) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/preview',
      payload: { token },
      ...(device ? { cookies: jarOf(device) as Jar } : {}),
      ...peer(),
    });
  const sendCode = (token: string, extra: Record<string, unknown> = {}, device?: string | Jar) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/code',
      payload: { token, ...extra },
      ...(device ? { cookies: jarOf(device) as Jar } : {}),
      ...peer(),
    });
  const unlock = (
    token: string,
    given: { secret?: string; code?: string } = {},
    device?: string | Jar,
  ) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/shared/unlock',
      payload: { token, ...given },
      ...(device ? { cookies: jarOf(device) as Jar } : {}),
      ...peer(),
    });
  const cookiesOf = (r: LightMyRequestResponse) => r.cookies as Cookie[];
  /** A cookie the answer set: by name, or `fdv_share_device` for its device cookie, whatever its key id. */
  const cookie = (r: LightMyRequestResponse, name: string) =>
    cookiesOf(r).find((c) =>
      name === 'fdv_share_device' ? /^fdv_share_device_[0-9a-f]{8}$/.test(c.name) : c.name === name,
    );
  const items = (session: string, device?: string | Jar) =>
    h.app.inject({
      url: '/api/v1/shared/items',
      cookies: { fdv_share: session, ...(jarOf(device) ?? {}) },
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

  it('only the newest code works, also once the newest is spent, and the email and the answer say so (W520-7, F520-03)', async () => {
    const to = address();
    const created = await made(lease, { code_email: to });
    const older = await sendAndRead(created.link_token, to);
    const newer = await sendAndRead(created.link_token, to);
    // Said in the email (F520-03).
    const mail = mailSent(h)
      .filter((m) => m.to === to)
      .at(-1);
    expect(mail?.text).toContain(SHARE_NEWEST_CODE_ONLY);
    // The older one ended as the newer was sent.
    const [a, b] = await codesOf(created.share.id);
    expect(a?.expires_at.getTime()).toBeLessThanOrEqual(b?.sent_at.getTime() ?? 0);
    // The newer spent by five wrong tries: the older, still inside its ten
    // minutes, does not come back (W520-7).
    for (let i = 0; i < 5; i++) {
      expect((await unlock(created.link_token, { code: another(newer) })).statusCode).toBe(401);
    }
    const refused = await unlock(created.link_token, { code: older });
    expect(refused.statusCode).toBe(401);
    // And said in the answer (F520-03).
    expect(errorOf(refused).message).toContain(SHARE_NEWEST_CODE_ONLY);
    expect((await linkRow(created.share.id)).open_count).toBe(0);
  });

  it('a code whose email cannot be queued is not kept, counted or written down, and the log says why (M520-02)', async () => {
    const logs: string[] = [];
    let failing = false;
    const queued: MailRequest[] = [];
    const flaky = await createHarness({
      logger: { level: 'info', stream: { write: (s: string) => void logs.push(s) } },
      mail: async (m) => {
        if (failing) throw new Error('Queue mail.to_address does not exist');
        queued.push(m);
      },
    });
    try {
      const o = await flaky.setup();
      const doc = json<DocumentView>(
        await flaky.app.inject({
          method: 'POST',
          url: '/api/v1/documents',
          headers: flaky.as(o),
          payload: { title: 'Lease', type_key: 'utility_bill', visibility: 'household' },
        }),
      ).id;
      const form = new FormData();
      form.append('file', PDF, { filename: 'scan.pdf', contentType: 'application/pdf' });
      await flaky.app.inject({
        method: 'POST',
        url: `/api/v1/documents/${doc}/versions`,
        headers: { ...flaky.as(o), ...form.getHeaders(), 'idempotency-key': randomUUID() },
        payload: form.getBuffer(),
      });
      const to = address('queue.test');
      const link = json<CreatedShare>(
        await flaky.app.inject({
          method: 'POST',
          url: `/api/v1/documents/${doc}/share`,
          headers: flaky.as(o),
          payload: { code_email: to },
        }),
      );
      const send = () =>
        flaky.app.inject({
          method: 'POST',
          url: '/api/v1/shared/code',
          payload: { token: link.link_token },
          ...peer(),
        });
      const codeOf = (m: MailRequest | undefined) =>
        /(\d{3}) (\d{3})/
          .exec(m?.text ?? '')
          ?.slice(1)
          .join('') ?? '';
      expect((await send()).statusCode).toBe(200);
      const first = codeOf(queued.at(-1));

      failing = true;
      for (let i = 0; i < 3; i++) {
        const r = await send();
        expect(r.statusCode).toBe(503);
        expect(errorOf(r).code).toBe('code_not_sent');
        expect(r.headers['retry-after']).toBe('60');
      }
      // Nothing of them was kept: one code, one line in the log.
      const kept = await withSystem(flaky.db, o.household_id, async (trx) => ({
        codes: await trx
          .selectFrom('share_code')
          .select('id')
          .where('share_id', '=', link.share.id)
          .execute(),
        lines: await trx
          .selectFrom('audit_event')
          .select('action')
          .where('action', '=', 'share.code_sent')
          .execute(),
      }));
      expect(kept.codes).toHaveLength(1);
      expect(kept.lines).toHaveLength(1);
      // The operator is told why, with no address or code in it.
      const said = logs.join('\n');
      expect(said).toContain('could not be queued');
      expect(said).toContain('Queue mail.to_address does not exist');
      expect(said).not.toContain('queue.test');

      // The code already sent still works …
      failing = false;
      const opened = await flaky.app.inject({
        method: 'POST',
        url: '/api/v1/shared/unlock',
        payload: { token: link.link_token, code: first },
        ...peer(),
      });
      expect(opened.statusCode, opened.body).toBe(200);
      // … and the failed sends took none of the three in 15 minutes.
      expect((await send()).statusCode).toBe(200);
      expect((await send()).statusCode).toBe(200);
      expect((await send()).statusCode).toBe(429);
    } finally {
      await flaky.close();
    }
  }, 90_000);

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
      // A link that asks for a code on a vault that can no longer send one
      // (its operator has taken the mail server away since): the person it
      // is for is told what they can do, not the sharer's reason (W520-14).
      const token = randomUUID() + randomUUID();
      const account = json<{ account_id: string }>(
        await without.app.inject({ url: '/api/v1/me', headers: without.as(o) }),
      ).account_id;
      await withSystem(without.db, o.household_id, (trx) =>
        trx
          .insertInto('share_link')
          .values({
            household_id: o.household_id,
            document_id: doc,
            token_hash: createHash('sha256').update(token, 'utf8').digest(),
            created_by: account,
            expires_at: new Date(Date.now() + 864e5),
            code_email: address(),
          })
          .execute(),
      );
      const cannot = await without.app.inject({
        method: 'POST',
        url: '/api/v1/shared/code',
        payload: { token },
        ...peer(),
      });
      expect(cannot.statusCode).toBe(503);
      expect(errorOf(cannot)).toMatchObject({
        code: 'email_code_unavailable',
        message: SHARE_CODE_CANNOT_SEND,
      });
      expect(errorOf(cannot).message).not.toBe(SHARE_CODE_UNAVAILABLE);
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
    expect(row.secret_kind).toBe('generated');
    expect(
      await argon2.verify(row.pin_hash as string, (madeUp.password as string).replace(/-/g, '')),
    ).toBe(true);

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

  it('a made-up password is taken without regard to capitals, dashes or spaces; a typed one as typed (F520-06)', async () => {
    const madeUp = await made(lease, { with_password: true });
    const pw = madeUp.password as string;
    // Read out over the phone and typed unseen: every one of these is it,
    // and none uses up a try.
    for (const typed of [
      pw.toUpperCase(),
      pw.replace(/-/g, ''),
      pw.replace(/-/g, ' '),
      ` ${pw.toUpperCase().replace(/-/g, ' - ')} `,
    ]) {
      const r = await unlock(madeUp.link_token, { secret: typed });
      expect(r.statusCode, `${typed}: ${r.body}`).toBe(200);
    }
    expect(await linkRow(madeUp.share.id)).toMatchObject({ attempts: 0, secret_kind: 'generated' });
    // Nor does it make another password right.
    const wrong = `${pw.slice(0, -1)}${pw.endsWith('a') ? 'b' : 'a'}`;
    expect((await unlock(madeUp.link_token, { secret: wrong })).statusCode).toBe(401);
    // A password the sharer typed is theirs, checked exactly as typed.
    const typed = await made(lease, { password: 'River Otter Lantern' });
    expect((await linkRow(typed.share.id)).secret_kind).toBe('password');
    expect((await unlock(typed.link_token, { secret: 'river otter lantern' })).statusCode).toBe(
      401,
    );
    expect((await unlock(typed.link_token, { secret: 'River Otter Lantern' })).statusCode).toBe(
      200,
    );
  });

  // --------------------------------------------------- this device only

  it('a device cookie the vault did not make is never bound, and one it made is kept (F520-04)', async () => {
    // Planted in the browser before its first open by somebody who holds the
    // link: whatever its shape, it is replaced, and opens nothing after.
    for (const planted of [
      'planted-by-somebody-else',
      randomBytes(64).toString('base64url'),
      mintDeviceCookie(deviceCookieKey(`${TEST_MASTER}-not-this-vault`, SHARE_DEVICE_KEY_PURPOSE)),
      mintDeviceCookie(deviceCookieKey(TEST_MASTER, 'drop-device')),
    ]) {
      const created = await made(lease, { this_device_only: true });
      const first = await unlock(created.link_token, {}, planted);
      expect(first.statusCode, first.body).toBe(200);
      const bound = cookie(first, 'fdv_share_device')?.value as string;
      expect(bound).not.toBe(planted);
      expect(
        verifiedDeviceCookie(deviceCookieKey(TEST_MASTER, SHARE_DEVICE_KEY_PURPOSE), bound),
      ).toBe(bound);
      const attacker = await unlock(created.link_token, {}, planted);
      expect(attacker.statusCode, planted).toBe(403);
      expect((await unlock(created.link_token, {}, bound)).statusCode).toBe(200);
    }
    // One the vault made is kept: the same browser, another link.
    const one = await made(lease, { this_device_only: true });
    const theirs = cookie(await unlock(one.link_token), 'fdv_share_device')?.value as string;
    const two = await made(lease, { this_device_only: true });
    const again = await unlock(two.link_token, {}, theirs);
    expect(again.statusCode).toBe(200);
    expect(cookie(again, 'fdv_share_device')?.value).toBe(theirs);
  }, 60_000);

  it('a browser bound under a master key since rotated keeps its cookie, and its links (N520F-01)', async () => {
    // Two links bound to one browser's cookie, made before the master key
    // was rotated (`cli rotate-master-key`): it no longer verifies under the
    // key the vault derives now, but it is what they are bound to.
    const oldKey = deviceCookieKey(`${TEST_MASTER}-before-rotation`, SHARE_DEVICE_KEY_PURPOSE);
    const before = mintDeviceCookie(oldKey);
    expect(
      verifiedDeviceCookie(deviceCookieKey(TEST_MASTER, SHARE_DEVICE_KEY_PURPOSE), before),
    ).toBeNull();
    // Under the name that key gave it (ROT-C-03).
    const jar = { [nameOf(oldKey)]: before };
    const links = [
      await made(lease, { this_device_only: true }),
      await made(lease, { this_device_only: true }),
    ];
    for (const l of links) {
      await withSystem(h.db, owner.household_id, (trx) =>
        trx
          .updateTable('share_link')
          .set({ device_hash: createHash('sha256').update(`${l.share.id}:${before}`).digest() })
          .where('id', '=', l.share.id)
          .execute(),
      );
    }
    const [first, second] = links as [CreatedShare, CreatedShare];
    // Reopened twice in that browser: opened, and its cookie left as it is.
    for (let i = 0; i < 2; i++) {
      const again = await unlock(first.link_token, {}, jar);
      expect(again.statusCode, again.body).toBe(200);
      expect(cookie(again, nameOf(oldKey))?.value).toBe(before);
    }
    // So its other link still opens there too, and nowhere else.
    const other = await unlock(second.link_token, {}, jar);
    expect(other.statusCode, other.body).toBe(200);
    expect(cookie(other, nameOf(oldKey))?.value).toBe(before);
    expect((await unlock(second.link_token)).statusCode).toBe(403);
    expect(await linkRow(first.share.id)).toMatchObject({ open_count: 2, attempts: 0 });
  });

  it('after a rotation a new link gives a new cookie beside the old, and the old links still open (ROT-C-03)', async () => {
    // A link bound before the master key was rotated, to the cookie that key
    // made, under that key's name.
    const oldKey = deviceCookieKey(`${TEST_MASTER}-before-rotation`, SHARE_DEVICE_KEY_PURPOSE);
    const oldName = nameOf(oldKey);
    expect(oldName).not.toBe(NOW_NAME);
    const before = mintDeviceCookie(oldKey);
    const l1 = await made(lease, { this_device_only: true });
    await withSystem(h.db, owner.household_id, (trx) =>
      trx
        .updateTable('share_link')
        .set({ device_hash: createHash('sha256').update(`${l1.share.id}:${before}`).digest() })
        .where('id', '=', l1.share.id)
        .execute(),
    );
    // A new link, opened in that browser: a new cookie, under the name of
    // the key in use now — beside the old one, not over it.
    const l2 = await made(lease, { this_device_only: true });
    const opened2 = await unlock(l2.link_token, {}, { [oldName]: before });
    expect(opened2.statusCode, opened2.body).toBe(200);
    const now = cookie(opened2, 'fdv_share_device');
    expect(now?.name).toBe(NOW_NAME);
    expect(now?.value).not.toBe(before);
    expect(verifiedDeviceCookie(NOW_KEY, now?.value)).toBe(now?.value);
    expect(now).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/api/v1/shared',
    });
    // The browser holds both now, and each link opens with its own.
    const jar = { [oldName]: before, [NOW_NAME]: now?.value as string };
    const opened1 = await unlock(l1.link_token, {}, jar);
    expect(opened1.statusCode, opened1.body).toBe(200);
    expect(cookie(opened1, 'fdv_share_device')).toMatchObject({ name: oldName, value: before });
    const session1 = cookie(opened1, 'fdv_share')?.value as string;
    expect((await items(session1, jar)).statusCode).toBe(200);
    expect((await unlock(l2.link_token, {}, jar)).statusCode).toBe(200);
    // Neither opens with the other's alone.
    expect((await unlock(l1.link_token, {}, { [NOW_NAME]: now?.value as string })).statusCode).toBe(
      403,
    );
    expect((await unlock(l2.link_token, {}, { [oldName]: before })).statusCode).toBe(403);
    // And a cookie the vault did not make is still never bound (F520-04),
    // whatever the browser holds besides.
    const l3 = await made(lease, { this_device_only: true });
    const opened3 = await unlock(
      l3.link_token,
      {},
      {
        [oldName]: before,
        [NOW_NAME]: 'planted-by-somebody-else',
      },
    );
    expect(opened3.statusCode, opened3.body).toBe(200);
    const bound3 = cookie(opened3, 'fdv_share_device');
    expect(bound3?.name).toBe(NOW_NAME);
    expect(bound3?.value).not.toBe('planted-by-somebody-else');
    expect(verifiedDeviceCookie(NOW_KEY, bound3?.value)).toBe(bound3?.value);
    expect((await unlock(l3.link_token, {}, 'planted-by-somebody-else')).statusCode).toBe(403);
  }, 60_000);

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
      // One browser, not the device (F520-05).
      expect(errorOf(refused).message).toMatch(/opened in another browser already/);
      expect(errorOf(refused).message).not.toMatch(/device/);
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
    // Written as the link, past 0042's rule and its line trigger as 0043
    // redefines what they ask (F520-01): the chain is whole after it.
    expect(
      await withSystem(h.db, owner.household_id, (trx) =>
        verifyAuditChain(trx, owner.household_id),
      ),
    ).toMatchObject({ ok: true });
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
