import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmsProviderError, type TwilioConnection } from './sms-gate.js';
import { smsProblemWords } from './sms-send.js';
import {
  smsProviders,
  TwilioProvider,
  twilioErrorWords,
  twilioStateOf,
  TWILIO_RETRIES,
} from './sms-twilio.js';

/**
 * Twilio's Messages API, as the vault speaks it (0.9.0-dev.71): against a
 * fake Twilio on this machine, never a real send — the request's shape and
 * Basic sign-in, a From number or a Messaging Service, the status lifecycle
 * asked of a message's own resource, failed and undelivered with their
 * codes, a refused token, a 429 then success, 5xx tried again and given up
 * on, an answer that never comes, a redirect never followed — and nothing
 * secret in what it throws.
 */
describe('Twilio, as the vault speaks to it', () => {
  let server: Server;
  let base: string;
  const seen: Array<{
    method: string;
    url: string;
    auth: string;
    type: string;
    body: string;
  }> = [];
  let answers: Array<(req: IncomingMessage, res: ServerResponse) => void> = [];

  const SID = `AC${'0123456789abcdef'.repeat(2)}`;
  const TOKEN = 'twilio-secret-token-9f8e7d';
  const MG = `MG${'fedcba9876543210'.repeat(2)}`;
  const TO = '+447700900123';
  const BODY = 'Family Vault code: 123456.';
  /** A message id as Twilio gives one. */
  const M = (n: number) => `SM${String(n).padStart(32, '0')}`;

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
        const answer = answers.length > 1 ? answers.shift() : answers[0];
        answer?.(req, res);
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
    answers = [];
  });

  const conn = (over: Partial<TwilioConnection> = {}): TwilioConnection => ({
    provider: 'twilio',
    accountSid: SID,
    authToken: TOKEN,
    from: '+447700900999',
    messagingServiceSid: null,
    ...over,
  });
  const twilio = (over: Partial<TwilioConnection> = {}, timeoutMs = 300) =>
    new TwilioProvider(conn(over), { baseUrl: base, timeoutMs, retryMs: 5 });
  const json =
    (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (_: IncomingMessage, res: ServerResponse) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
  /** What the provider threw, whatever it was. */
  const thrown = async (p: Promise<unknown>) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmsProviderError);
    return err as SmsProviderError;
  };
  /** Nothing secret in an error: never the token, the words or the whole number. */
  const nothingSecret = (err: SmsProviderError) => {
    const all = `${err.message} ${JSON.stringify(err)} ${String(err.stack)}`;
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(BODY);
    expect(all).not.toContain(TO);
  };

  it('sends one text from a number, form-encoded, signed in with Basic SID:token', async () => {
    answers = [json(201, { sid: M(1), status: 'queued', error_code: null })];
    const sent = await twilio().send(TO, BODY);
    expect(sent).toEqual({ id: M(1), state: 'pending' });
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe(`/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(req?.type).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(req?.body ?? ''))).toEqual({
      To: TO,
      Body: BODY,
      From: '+447700900999',
    });
    expect(req?.auth).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
  });

  it('sends through a Messaging Service instead of a number, never both', async () => {
    answers = [json(201, { sid: M(2), status: 'accepted' })];
    const sent = await twilio({ from: null, messagingServiceSid: MG }).send(TO, BODY);
    expect(sent).toEqual({ id: M(2), state: 'pending' });
    const form = Object.fromEntries(new URLSearchParams(seen[0]?.body ?? ''));
    expect(form).toEqual({ To: TO, Body: BODY, MessagingServiceSid: MG });
    // With neither, nothing is asked of Twilio.
    seen.length = 0;
    const err = await thrown(twilio({ from: null, messagingServiceSid: null }).send(TO, BODY));
    expect(err.problem).toBe('refused');
    expect(seen).toHaveLength(0);
  });

  it('follows a text through its statuses on its own resource, as SMS Gate is followed', async () => {
    const lifecycle = ['queued', 'sending', 'sent', 'delivered'];
    answers = lifecycle.map((status) => json(200, { sid: M(3), status, error_code: null }));
    const p = twilio();
    const states = [];
    for (let i = 0; i < lifecycle.length; i += 1) states.push(await p.state(M(3)));
    expect(states).toEqual([
      { state: 'pending' },
      { state: 'processed' },
      { state: 'sent' },
      { state: 'delivered' },
    ]);
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual(
      lifecycle.map(() => ['GET', `/2010-04-01/Accounts/${SID}/Messages/${M(3)}.json`, '']),
    );
  });

  it('says failed and undelivered with Twilio’s code in plain words, never its message', async () => {
    answers = [
      json(200, {
        sid: M(4),
        status: 'undelivered',
        error_code: 30003,
        error_message: `Unreachable destination handset ${TO}`,
      }),
      json(200, { sid: M(5), status: 'failed', error_code: 30034, error_message: null }),
      json(200, { sid: M(6), status: 'failed', error_code: 39999 }),
      json(200, { sid: M(7), status: 'failed' }),
    ];
    const p = twilio();
    expect(await p.state(M(4))).toEqual({
      state: 'failed',
      error: 'Twilio error 30003: the phone was switched off or out of reach',
    });
    expect(await p.state(M(5))).toEqual({
      state: 'failed',
      error: 'Twilio error 30034: the sender isn’t registered for texting in the US (A2P 10DLC)',
    });
    expect(await p.state(M(6))).toEqual({ state: 'failed', error: 'Twilio error 39999' });
    expect(await p.state(M(7))).toEqual({ state: 'failed' });
  });

  it('says a refused Account SID or Auth Token, and a text Twilio does not know', async () => {
    answers = [
      json(401, { code: 20003, message: 'Authenticate', status: 401 }),
      json(404, { code: 20404, message: 'The requested resource was not found', status: 404 }),
    ];
    const refused = await thrown(twilio().send(TO, BODY));
    expect(refused).toMatchObject({ problem: 'unauthorised', status: 401, code: 20003 });
    nothingSecret(refused);
    expect(smsProblemWords(refused.problem, 'twilio', refused.status, refused.code)).toBe(
      'Twilio refused the Account SID or Auth Token. Check them in the Twilio Console, and type the Auth Token again.',
    );
    expect(await thrown(twilio().state(M(99)))).toMatchObject({ problem: 'not_found' });
  });

  it('a text Twilio will not take is said by its code, and its message (which holds the number) is dropped', async () => {
    answers = [
      json(400, {
        code: 21211,
        message: `The 'To' number ${TO} is not a valid phone number.`,
        status: 400,
      }),
    ];
    const err = await thrown(twilio().send(TO, BODY));
    expect(err).toMatchObject({ problem: 'refused', status: 400, code: 21211 });
    nothingSecret(err);
    expect(smsProblemWords(err.problem, 'twilio', err.status, err.code)).toBe(
      'Twilio didn’t take the text (it answered 400). Twilio error 21211: the number isn’t a valid phone number.',
    );
  });

  it('tries a 429 again after Twilio’s Retry-After, then sends', async () => {
    answers = [
      json(429, { code: 20429, message: 'Too Many Requests', status: 429 }, { 'retry-after': '0' }),
      json(201, { sid: M(8), status: 'queued' }),
    ];
    expect(await twilio().send(TO, BODY)).toEqual({ id: M(8), state: 'pending' });
    expect(seen.map((s) => s.method)).toEqual(['POST', 'POST']);
    // The same text both times.
    expect(seen[0]?.body).toBe(seen[1]?.body);
  });

  it('tries a 5xx again with a wait that doubles, and gives up after two more tries', async () => {
    answers = [json(503, { message: 'Service Unavailable' })];
    const started = Date.now();
    const err = await thrown(twilio().state(M(9)));
    expect(err).toMatchObject({ problem: 'refused', status: 503 });
    expect(seen).toHaveLength(1 + TWILIO_RETRIES);
    expect(Date.now() - started).toBeLessThan(2000);
    // A 429 that never stops is said in words of its own.
    seen.length = 0;
    answers = [json(429, { code: 20429 })];
    const busy = await thrown(twilio().send(TO, BODY));
    expect(seen).toHaveLength(1 + TWILIO_RETRIES);
    expect(smsProblemWords(busy.problem, 'twilio', busy.status, busy.code)).toMatch(
      /^Twilio asked the vault to slow down/,
    );
  });

  it('waits no longer than it was told for an answer; a send with none may have gone, and is not sent again', async () => {
    answers = [() => undefined]; // never answers
    let started = Date.now();
    const err = await thrown(twilio().send(TO, BODY));
    expect(err.problem).toBe('unconfirmed');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(seen).toHaveLength(1);
    nothingSecret(err);
    // Asking after a text: a timeout, said as one.
    seen.length = 0;
    started = Date.now();
    expect((await thrown(twilio().state(M(1)))).problem).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('never sends again after a 5xx to the send, which may have made the message', async () => {
    answers = [json(500, { code: 20500, message: 'Internal Server Error' })];
    const err = await thrown(twilio().send(TO, BODY));
    expect(err).toMatchObject({ problem: 'unconfirmed', status: 500 });
    expect(seen).toHaveLength(1);
    nothingSecret(err);
    expect(smsProblemWords(err.problem, 'twilio', err.status)).toMatch(
      /^Twilio didn’t say whether it took the text\. It may still arrive: the vault won’t send it again by itself\./,
    );
    seen.length = 0;
    answers = [json(503, {})];
    expect((await thrown(twilio().send(TO, BODY))).problem).toBe('unconfirmed');
    expect(seen).toHaveLength(1);
  });

  it('asks after a text within the time it is given, and not again when told not to', async () => {
    answers = [() => undefined]; // never answers
    const started = Date.now();
    const p = new TwilioProvider(conn(), { baseUrl: base, timeoutMs: 5000, retryMs: 5 });
    const err = await thrown(p.state(M(2), { timeoutMs: 150, retry: false }));
    expect(err.problem).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(seen).toHaveLength(1);
    seen.length = 0;
    answers = [json(503, {})];
    expect((await thrown(p.state(M(2), { retry: false }))).status).toBe(503);
    expect(seen).toHaveLength(1);
  });

  it('keeps only an id shaped as Twilio’s, and asks after nothing else', async () => {
    for (const sid of ['SM../../Accounts', 'SM0001', `XX${'0'.repeat(32)}`, '']) {
      answers = [json(201, { sid, status: 'queued' })];
      expect(await thrown(twilio().send(TO, BODY)), sid).toMatchObject({ problem: 'refused' });
    }
    answers = [json(201, { sid: `MM${'a'.repeat(32)}`, status: 'queued' })];
    expect((await twilio().send(TO, BODY)).id).toBe(`MM${'a'.repeat(32)}`);
    seen.length = 0;
    expect(await thrown(twilio().state('SM/../../x'))).toMatchObject({ problem: 'not_found' });
    expect(seen).toHaveLength(0);
  });

  it('says a Twilio that is not there, and follows no redirect', async () => {
    // A port nothing listens on: refused before anything was sent, so certainly not sent.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const gone = new TwilioProvider(conn(), {
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 300,
    });
    const err = await thrown(gone.send(TO, BODY));
    expect(err.problem).toBe('unreachable');
    nothingSecret(err);
    answers = [
      (_, res) => {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        res.end();
      },
    ];
    expect(await thrown(twilio().send(TO, BODY))).toMatchObject({
      problem: 'refused',
      status: 302,
    });
    expect(seen).toHaveLength(1);
  });

  it('refuses an answer with no id, or that is not JSON', async () => {
    answers = [json(201, { status: 'queued' })];
    expect(await thrown(twilio().send(TO, BODY))).toMatchObject({ problem: 'refused' });
    answers = [
      (_, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>hello</html>');
      },
    ];
    expect(await thrown(twilio().state(M(1)))).toMatchObject({ problem: 'refused' });
  });

  it('reads Twilio’s statuses whatever their case, and anything else as still pending', () => {
    expect(
      [
        'accepted',
        'scheduled',
        'Queued',
        'sending',
        'sent',
        'delivered',
        'undelivered',
        'failed',
        'canceled',
        'odd',
        null,
      ].map(twilioStateOf),
    ).toEqual([
      'pending',
      'pending',
      'pending',
      'processed',
      'sent',
      'delivered',
      'failed',
      'failed',
      'failed',
      'pending',
      'pending',
    ]);
    expect(twilioErrorWords(null)).toBeUndefined();
    expect(twilioErrorWords('30005')).toBe(
      'Twilio error 30005: the number is unknown or no longer in service',
    );
    expect(twilioErrorWords(-1)).toBeUndefined();
  });

  it('the production factory picks the provider the household chose', () => {
    expect(smsProviders(conn())).toBeInstanceOf(TwilioProvider);
    expect(
      smsProviders({ mode: 'local', baseUrl: base, username: 'u', password: 'p' }),
    ).not.toBeInstanceOf(TwilioProvider);
  });
});
