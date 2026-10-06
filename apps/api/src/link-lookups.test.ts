import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tokens } from './auth/service.js';
import type { CreatedInvitation } from './household/invitations.js';
import { alertsSent, createHarness, type Harness } from './test-harness.js';

/**
 * Invitation and reset links the same way (5.17). A new link reads
 * /join#<token> or /reset#<token>; the page posts what it read to a lookup,
 * and the token never travels in a path. What the request log keeps of
 * those calls, and how often an address may make them.
 */
describe.skipIf(!testAdminUrl())('invitation and reset links the same way', () => {
  let h: Harness;
  let owner: Tokens;
  const logged: string[] = [];

  let nth = 0;
  const peer = () => ({ remoteAddress: `10.17.${Math.floor(++nth / 200)}.${nth % 200}` });

  beforeAll(async () => {
    h = await createHarness({
      // Every level, the chattiest an operator could choose: nothing secret at any.
      logger: { level: 'trace', stream: { write: (s: string) => void logged.push(s) } },
    });
    owner = await h.setup();
  }, 90_000);
  afterAll(() => h.close());

  const invitation = async (name: string) => {
    // A viewer who sees every family document: an owner's decision (5.34).
    await h.decider(owner);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: h.as(owner),
      payload: { display_name: name, email: `${name.toLowerCase()}@example.test`, role: 'viewer' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<CreatedInvitation>();
  };

  /** A reset link for the owner, as the email carries it: the token after the #. */
  const resetToken = async () => {
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      payload: { email: 'owner@example.test' },
      ...peer(),
    });
    const url = alertsSent(h)
      .map((a) => a.url as string | undefined)
      .filter(Boolean)
      .at(-1) as string;
    expect(url).toMatch(/\/reset#/);
    return url.slice(url.lastIndexOf('#') + 1);
  };

  const post = (url: string, payload: unknown, from = peer()) =>
    h.app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, ...from });

  /** A body that is not JSON, with a whole token inside it. */
  const broken = (url: string, token: string) =>
    h.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: `{"token":"${token}"`,
      ...peer(),
    });

  /** What the log said each request was, and how it was answered, by request id. */
  const answered = () => {
    const lines = logged.map((l) => JSON.parse(l) as Record<string, unknown>);
    const urls = new Map<string, string>();
    for (const l of lines) {
      const req = l.req as { url?: string } | undefined;
      if (req?.url) urls.set(l.reqId as string, req.url);
    }
    return lines
      .filter((l) => (l.res as { statusCode?: number } | undefined)?.statusCode !== undefined)
      .map((l) => ({
        url: urls.get(l.reqId as string),
        status: (l.res as { statusCode: number }).statusCode,
      }));
  };

  it('pino capture for both lookups, including their 400 and 404 log lines', async () => {
    const reset = await resetToken();
    const invited = await invitation('Logan');
    const nobody = `NoSuchLink${'q'.repeat(33)}`;
    logged.length = 0;

    for (const [url, token] of [
      ['/api/v1/password-resets/lookup', reset],
      ['/api/v1/invitations/lookup', invited.link_token],
    ] as const) {
      expect((await post(url, { token })).statusCode).toBe(200);
      expect((await post(url, { token: nobody })).statusCode).toBe(404);
      expect((await broken(url, token)).statusCode).toBe(400);
      // Too short to be a token, but still a piece of one.
      expect((await post(url, { token: token.slice(0, 12) })).statusCode).toBe(422);
    }
    // And spending them, with the passwords and the code in the body.
    const wrongCode = await post('/api/v1/invitations/accept', {
      token: invited.link_token,
      code: 'WXYZ-WXYZ',
      password: 'logan typed this password',
    });
    expect(wrongCode.statusCode).toBe(401);
    const joined = await post('/api/v1/invitations/accept', {
      token: invited.link_token,
      code: invited.code,
      password: 'logan typed this password',
    });
    expect(joined.statusCode).toBe(201);
    const spent = await post('/api/v1/password-resets/complete', {
      token: reset,
      password: 'the owner chose a new one',
    });
    expect(spent.statusCode).toBe(200);
    expect((await broken('/api/v1/password-resets/complete', reset)).statusCode).toBe(400);

    // The log was written, and says which route each line is and how it
    // was answered: a 400 and a 404 for each lookup among them.
    const seen = answered();
    for (const url of ['/api/v1/password-resets/lookup', '/api/v1/invitations/lookup']) {
      expect(seen.filter((s) => s.url === url).map((s) => s.status)).toEqual([200, 404, 400, 422]);
    }
    expect(seen.filter((s) => s.url === '/api/v1/invitations/accept').map((s) => s.status)).toEqual(
      [401, 201],
    );
    expect(
      seen.filter((s) => s.url === '/api/v1/password-resets/complete').map((s) => s.status),
    ).toEqual([200, 400]);

    // ... and nothing that opens anything, or would help to.
    const text = logged.join('\n');
    for (const secret of [
      reset,
      invited.link_token,
      nobody,
      reset.slice(0, 12),
      invited.link_token.slice(0, 12),
      invited.code,
      'WXYZ-WXYZ',
      'logan typed this password',
      'the owner chose a new one',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/"token"|"password"|"code"|access_token|refresh_token/);
  });

  it('the body forms are limited as the path forms are: ten a minute from one address', async () => {
    const nobody = 'r'.repeat(43);
    for (const [url, send] of [
      [
        'GET /api/v1/password-resets/{token}',
        (from: { remoteAddress: string }) =>
          h.app.inject({ url: `/api/v1/password-resets/${nobody}`, ...from }),
      ],
      [
        'POST /api/v1/password-resets/lookup',
        (from: { remoteAddress: string }) =>
          post('/api/v1/password-resets/lookup', { token: nobody }, from),
      ],
      [
        'POST /api/v1/password-resets/complete',
        (from: { remoteAddress: string }) =>
          post(
            '/api/v1/password-resets/complete',
            { token: nobody, password: 'long enough!' },
            from,
          ),
      ],
      [
        'GET /api/v1/invitations/{token}',
        (from: { remoteAddress: string }) =>
          h.app.inject({ url: `/api/v1/invitations/${nobody}`, ...from }),
      ],
      [
        'POST /api/v1/invitations/lookup',
        (from: { remoteAddress: string }) =>
          post('/api/v1/invitations/lookup', { token: nobody }, from),
      ],
      [
        'POST /api/v1/invitations/accept',
        (from: { remoteAddress: string }) =>
          post(
            '/api/v1/invitations/accept',
            { token: nobody, code: 'ABCD-EFGH', password: 'long enough!' },
            from,
          ),
      ],
    ] as const) {
      const from = peer();
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await send(from)).statusCode);
      expect(statuses, url).toEqual([...Array<number>(10).fill(404), 429]);
      // Another address is not held back by this one.
      expect((await send(peer())).statusCode, url).toBe(404);
    }
  });
});
