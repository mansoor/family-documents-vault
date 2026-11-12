import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmsGateProvider, SmsProviderError, stateOf, type SmsConnection } from './sms-gate.js';

/**
 * SMS Gate for Android's API, as the vault speaks it (0.9.0, SMS1): against
 * a server on this machine that answers as SMS Gate does — the request's
 * shape, its Basic sign-in, a refused password, an answer that never comes,
 * a redirect never followed, and an address inside the vault's own network
 * refused for the cloud and a private server.
 */
describe('SMS Gate, as the vault speaks to it', () => {
  let server: Server;
  let base: string;
  const seen: Array<{ method: string; url: string; auth: string; type: string; body: string }> = [];
  let answer: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          url: req.url ?? '',
          auth: req.headers.authorization ?? '',
          type: req.headers['content-type'] ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        answer(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    seen.length = 0;
  });

  const local = (over: Partial<SmsConnection> = {}) =>
    new SmsGateProvider(
      { mode: 'local', baseUrl: base, username: 'sms', password: 'pa:ss wörd', ...over },
      { timeoutMs: 300 },
    );
  const json = (status: number, body: unknown) => (_: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  it('sends one text to one number, with a delivery report, signed in with Basic', async () => {
    answer = json(202, { id: 'Qw3rty', state: 'Pending', recipients: [] });
    const sent = await local().send('+447700900123', 'Family Vault: this is a test.');
    expect(sent).toEqual({ id: 'Qw3rty', state: 'pending' });
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/messages');
    expect(req?.type).toBe('application/json');
    expect(JSON.parse(req?.body ?? '')).toEqual({
      textMessage: { text: 'Family Vault: this is a test.' },
      phoneNumbers: ['+447700900123'],
      withDeliveryReport: true,
    });
    expect(req?.auth).toBe(`Basic ${Buffer.from('sms:pa:ss wörd', 'utf8').toString('base64')}`);
  });

  it('keeps the path of a base address, and asks after a text by its id', async () => {
    answer = json(200, {
      id: 'a/b',
      state: 'Processed',
      recipients: [{ phoneNumber: '+447700900123', state: 'Failed', error: 'No\nservice' }],
    });
    const now = await local({ baseUrl: `${base}/3rdparty/v1/` }).state('a/b');
    expect(now).toEqual({ state: 'failed', error: 'No service' });
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/3rdparty/v1/messages/a%2Fb', body: '' });
  });

  it('says a refused password, a missing text and any other answer, and follows no redirect', async () => {
    answer = json(401, { message: 'Unauthorized' });
    await expect(local().send('+447700900123', 'x')).rejects.toMatchObject({
      problem: 'unauthorised',
      status: 401,
    });
    answer = json(404, { message: 'not found' });
    await expect(local().state('gone')).rejects.toMatchObject({ problem: 'not_found' });
    answer = (_, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    };
    await expect(local().send('+447700900123', 'x')).rejects.toMatchObject({
      problem: 'refused',
      status: 302,
    });
    expect(seen.map((s) => s.url)).toEqual(['/messages', '/messages/gone', '/messages']);
    answer = json(202, { state: 'Pending' });
    await expect(local().send('+447700900123', 'x')).rejects.toMatchObject({ problem: 'refused' });
  });

  it('waits no longer than it was told for an answer', async () => {
    answer = () => undefined; // never answers
    const started = Date.now();
    const err = await local()
      .send('+447700900123', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsProviderError);
    expect((err as SmsProviderError).problem).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('says a server that is not there', async () => {
    const err = await local({ baseUrl: 'http://127.0.0.1:1' })
      .send('+447700900123', 'x')
      .catch((e: unknown) => e);
    expect((err as SmsProviderError).problem).toBe('unreachable');
  });

  it('never reaches inside the vault’s own network but for the local server', async () => {
    answer = json(202, { id: 'x', state: 'Pending' });
    for (const baseUrl of [base, 'https://localhost:8443', 'https://10.1.2.3/3rdparty/v1']) {
      const p = new SmsGateProvider(
        { mode: 'private', baseUrl, username: 'u', password: 'p' },
        { timeoutMs: 300 },
      );
      await expect(p.send('+447700900123', 'x'), baseUrl).rejects.toMatchObject({
        problem: 'address_refused',
      });
    }
    // A name that resolves inside it is refused when the connection is made.
    const named = new SmsGateProvider(
      {
        mode: 'cloud',
        baseUrl: 'https://sms.example.test/3rdparty/v1',
        username: 'u',
        password: 'p',
      },
      {
        timeoutMs: 300,
        lookup: ((_host: string, _opts: unknown, cb: (...a: unknown[]) => void) =>
          cb(null, [{ address: '192.168.0.4', family: 4 }])) as never,
      },
    );
    await expect(named.send('+447700900123', 'x')).rejects.toMatchObject({
      problem: 'address_refused',
    });
    expect(seen).toHaveLength(0);
  });

  it('reads SMS Gate’s states whatever their case, and anything else as still pending', () => {
    expect(
      ['Pending', 'Processed', 'Sent', 'Delivered', 'Failed', 'odd', null].map(stateOf),
    ).toEqual(['pending', 'processed', 'sent', 'delivered', 'failed', 'pending', 'pending']);
  });
});
