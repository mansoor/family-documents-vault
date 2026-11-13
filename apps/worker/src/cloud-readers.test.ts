import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { AI_READER_KEY_PURPOSE, deriveKey } from '@fdv/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HouseholdAiReaders, type SavedAiReader } from './ai-reader.js';
import { AnthropicReader, OpenAiCompatibleReader } from './cloud-readers.js';
import { OllamaReader } from './ollama-reader.js';

/**
 * The readers AIR3 adds, against a server of the test's own: what each
 * sends — its path, its headers, a key only where one is set — what it does
 * with a reply not in its API's shape (`bad_reply`, its body never handed
 * on), and an OpenAI-compatible server that refuses `json_schema`.
 */

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Fake {
  url: string;
  seen: Seen[];
  /** What each request is answered: by its path, a status and a body. */
  answer: (s: Seen) => { status: number; body: string };
  close(): Promise<void>;
}

async function startFake(): Promise<Fake> {
  const sockets = new Set<Socket>();
  const fake = {
    seen: [] as Seen[],
    answer: (_s: Seen) => ({ status: 200, body: '{}' }),
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s: Seen = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      fake.seen.push(s);
      const a = fake.answer(s);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(a.body);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
      }),
  });
}

const OFFER = {
  kinds: [{ key: 'passport', label: 'Passport' }],
  names: [{ id: 'x', label: 'Sara' }],
};
const PAPER = 'HM Passport Office\nPassport No. 533401872';
const SECRET_REPLY = 'the reader said something private here';

describe('the cloud readers’ requests (AIR3)', () => {
  let fake: Fake;
  beforeAll(async () => {
    fake = await startFake();
  });
  afterEach(() => {
    fake.seen.length = 0;
    fake.answer = () => ({ status: 200, body: '{}' });
  });
  afterAll(async () => {
    await fake.close();
  });

  const anthropic = (apiKey: string | null) =>
    new AnthropicReader(
      { url: new URL(fake.url), model: 'claude-haiku-4-5', timeoutMs: 3_000 },
      { apiKey, testMs: 3_000, probeMs: 3_000 },
    );
  const openai = (apiKey: string | null, ownNetwork = false) =>
    new OpenAiCompatibleReader(
      { url: new URL(fake.url), model: 'gpt-4o-mini', timeoutMs: 3_000 },
      { apiKey, testMs: 3_000, probeMs: 3_000, ownNetwork },
    );

  it('Anthropic: POST /v1/messages with x-api-key and anthropic-version, never Authorization, the form a tool it must call', async () => {
    fake.answer = () => ({
      status: 200,
      body: JSON.stringify({
        type: 'message',
        content: [{ type: 'tool_use', name: 'fill_in_form', input: {} }],
      }),
    });
    const r = anthropic('sk-ant-test-key-0000');
    const got = await r.read(PAPER, OFFER, { priority: 'interactive' });
    expect(got).toMatchObject({ state: 'replied', shape: 'anthropic' });
    const [s] = fake.seen;
    expect(s?.method).toBe('POST');
    expect(s?.path).toBe('/v1/messages');
    expect(s?.headers['x-api-key']).toBe('sk-ant-test-key-0000');
    expect(s?.headers['anthropic-version']).toBe('2023-06-01');
    expect(s?.headers.authorization).toBeUndefined();
    const body = JSON.parse(s?.body ?? '{}') as { tool_choice: unknown; tools: unknown[] };
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'fill_in_form' });
    expect(body.tools).toHaveLength(1);
    // Always a cloud service, wherever its address resolves.
    expect(r.runsAt).toBe('cloud');
    expect(r.lastRunsAt).toBe('cloud');
  });

  it('Anthropic: no key set, no x-api-key sent; its models from GET /v1/models', async () => {
    fake.answer = (s) =>
      s.path.startsWith('/v1/models')
        ? {
            status: 200,
            body: JSON.stringify({
              data: [
                { id: 'claude-haiku-4-5', type: 'model' },
                { id: 'not a model name!', type: 'model' },
              ],
              has_more: false,
            }),
          }
        : { status: 200, body: '{}' };
    const r = anthropic(null);
    expect(await r.models()).toMatchObject({ state: 'listed', names: ['claude-haiku-4-5'] });
    expect(fake.seen[0]?.path).toBe('/v1/models?limit=1000');
    expect(fake.seen[0]?.headers['x-api-key']).toBeUndefined();
    expect(await r.probe()).toBe('reachable');
  });

  it('OpenAI-compatible: POST /v1/chat/completions with json_schema; Bearer only where a key is set', async () => {
    fake.answer = () => ({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
    });
    await openai('sk-test-0000').read(PAPER, OFFER, { priority: 'interactive' });
    await openai(null).read(PAPER, OFFER, { priority: 'interactive' });
    expect(fake.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /v1/chat/completions',
      'POST /v1/chat/completions',
    ]);
    expect(fake.seen[0]?.headers.authorization).toBe('Bearer sk-test-0000');
    expect(fake.seen[1]?.headers.authorization).toBeUndefined();
    const body = JSON.parse(fake.seen[0]?.body ?? '{}') as { response_format: { type: string } };
    expect(body.response_format.type).toBe('json_schema');
  });

  it('OpenAI-compatible: json_schema refused, json_object asked, and remembered once it answers', async () => {
    fake.answer = (s) =>
      (JSON.parse(s.body) as { response_format: { type: string } }).response_format.type ===
      'json_schema'
        ? {
            status: 400,
            body: JSON.stringify({
              error: { message: `${SECRET_REPLY}: response_format json_schema not supported` },
            }),
          }
        : { status: 200, body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }) };
    const r = openai(null);
    let resent = 0;
    const got = await r.read(PAPER, OFFER, {
      priority: 'interactive',
      // The second send asked for first, as the cap counts it (the review, M2).
      again: async () => {
        resent += 1;
        return true;
      },
    });
    expect(got).toMatchObject({ state: 'replied', shape: 'openai_compatible' });
    expect(resent).toBe(1);
    expect(r.format).toBe('json_object');
    await r.read(PAPER, OFFER, { priority: 'interactive' });
    const formats = fake.seen.map(
      (s) => (JSON.parse(s.body) as { response_format: { type: string } }).response_format.type,
    );
    expect(formats).toEqual(['json_schema', 'json_object', 'json_object']);
    // A refusal is no failure of the reader: the breaker counts nothing.
    expect(r.failures).toBe(0);
  });

  it('OpenAI-compatible: a refusal about anything but the format is not sent again, nor said', async () => {
    fake.answer = () => ({ status: 400, body: `${SECRET_REPLY}: unknown model` });
    const r = openai(null);
    const got = await r.read(PAPER, OFFER, {
      priority: 'interactive',
      again: async () => true,
    });
    expect(got).toEqual({
      state: 'without',
      why: 'http_error',
      status: 400,
      ms: expect.any(Number) as unknown,
    });
    expect(JSON.stringify(got)).not.toContain(SECRET_REPLY);
    expect(fake.seen).toHaveLength(1);
    expect(r.format).toBe('json_schema');
  });

  it('OpenAI-compatible: about the format, but this month’s papers all sent — not sent again (M2)', async () => {
    fake.answer = () => ({ status: 422, body: 'json_schema is not supported here' });
    const r = openai(null);
    const got = await r.read(PAPER, OFFER, { priority: 'interactive', again: async () => false });
    expect(got).toMatchObject({ state: 'without', why: 'http_error', status: 422 });
    expect(got).not.toHaveProperty('aboutFormat');
    expect(fake.seen).toHaveLength(1);
  });

  it('asked again right before the words go: a paper the rule now holds back is never sent (S2)', async () => {
    fake.answer = () => ({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
    });
    const got = await openai(null).read(PAPER, OFFER, {
      priority: 'interactive',
      stillMay: async () => false,
    });
    expect(got).toMatchObject({ state: 'without', why: 'held' });
    expect(fake.seen).toEqual([]);
  });

  it('the place the rule assumed holds: on your own network, a public address is sent nothing — .env’s reader too (M5)', async () => {
    const envReader = new OllamaReader(
      { url: new URL('http://ollama.example:11434'), model: 'm', timeoutMs: 3_000 },
      { resolve: async () => '8.8.8.8' },
    );
    const got = await envReader.read(PAPER, OFFER, {
      priority: 'interactive',
      assumed: 'own_network',
    });
    expect(got).toMatchObject({ state: 'without', why: 'refused' });
    // Said by its kind and host, for the sensitive switch (S3).
    expect(envReader.identity).toBe('env:ollama:ollama.example:11434');
  });

  it('a stored own_network goes through the owner’s word: unticked, it is a cloud service (S1)', () => {
    const r = new OpenAiCompatibleReader(
      { url: new URL(fake.url), model: 'm', timeoutMs: 3_000 },
      { ownNetwork: false, guard: { publicOnly: false, runsAt: 'own_network' } },
    );
    expect(r.runsAt).toBe('cloud');
    const said = new OpenAiCompatibleReader(
      { url: new URL(fake.url), model: 'm', timeoutMs: 3_000 },
      { ownNetwork: true, guard: { publicOnly: false, runsAt: 'own_network' } },
    );
    expect(said.runsAt).toBe('own_network');
  });

  it('a reply not in its API’s shape is bad_reply at Test, its words never handed on', async () => {
    fake.answer = () => ({ status: 200, body: JSON.stringify({ message: SECRET_REPLY }) });
    for (const r of [anthropic('k'), openai('k')]) {
      const got = await r.test({ findWhere: true });
      expect(got).toEqual({
        state: 'without',
        why: 'bad_reply',
        ms: expect.any(Number) as unknown,
      });
      expect(JSON.stringify(got)).not.toContain(SECRET_REPLY);
    }
    fake.answer = () => ({ status: 200, body: '<html>' + SECRET_REPLY });
    for (const r of [anthropic('k'), openai('k')]) {
      expect(await r.models()).toMatchObject({ state: 'without', why: 'bad_reply' });
    }
  });

  it('Test passes with a reply in its API’s shape, and says where it runs', async () => {
    fake.answer = (s) =>
      s.path === '/v1/messages'
        ? { status: 200, body: JSON.stringify({ type: 'message', content: [] }) }
        : {
            status: 200,
            body: JSON.stringify({ choices: [{ message: { content: 'ready' } }] }),
          };
    expect((await anthropic('k').test()).state).toBe('replied');
    const local = openai(null, true);
    expect((await local.test({ findWhere: true })).state).toBe('replied');
    // Said to be on the owner's network, and found at a private address.
    expect(local.lastRunsAt).toBe('own_network');
    const unsaid = openai(null, false);
    await unsaid.test({ findWhere: true });
    // Not said: a cloud service, though its address is private.
    expect(unsaid.lastRunsAt).toBe('cloud');
  });

  it('built from a saved row: each kind its own reader; the hosted edition only the providers it names', () => {
    const row = (o: Partial<SavedAiReader>): SavedAiReader => ({
      kind: 'openai_compatible',
      base_url: 'https://reader.example.com',
      model: 'm-1',
      timeout_seconds: 60,
      runs_at: 'cloud',
      api_key_encrypted: null,
      status: 'ok',
      updated_at: new Date(),
      https_only: false,
      address_proven: true,
      own_network: false,
      ...o,
    });
    const key = deriveKey('cloud-readers-test-master-key-with-32-bytes', AI_READER_KEY_PURPOSE);
    const self = new HouseholdAiReaders({ key, publicOnly: false });
    const hosted = new HouseholdAiReaders({ key, publicOnly: true });
    const hh = '00000000-0000-4000-8000-000000000001';
    const built = (r: ReturnType<typeof self.build>) => ('reader' in r ? r.reader : r.not);
    expect(built(self.build(hh, row({})))).toBeInstanceOf(OpenAiCompatibleReader);
    expect(built(self.build(hh, row({ kind: 'anthropic', base_url: null })))).toBeInstanceOf(
      AnthropicReader,
    );
    // Anthropic's fixed address, whatever ports a typed one may be on.
    expect(
      built(
        new HouseholdAiReaders({ key, publicOnly: false, ports: [11434] }).build(
          hh,
          row({ kind: 'anthropic', base_url: null }),
        ),
      ),
    ).toBeInstanceOf(AnthropicReader);
    // Hosted: another OpenAI-compatible server refused, OpenAI's own and Anthropic not.
    expect(built(hosted.build(hh, row({})))).toBe('refused');
    // The rule saved with the reader holds a worker without FDV_EDITION to it too.
    expect(built(self.build(hh, row({ https_only: true })))).toBe('refused');
    expect(built(hosted.build(hh, row({ base_url: 'https://api.openai.com' })))).toBeInstanceOf(
      OpenAiCompatibleReader,
    );
    expect(built(hosted.build(hh, row({ kind: 'anthropic', base_url: null })))).toBeInstanceOf(
      AnthropicReader,
    );
  });

  it('calls only its own paths: a redirect is never followed', async () => {
    fake.answer = () => ({ status: 302, body: '' });
    const got = await openai(null).read(PAPER, OFFER, { priority: 'interactive' });
    expect(got).toMatchObject({ state: 'without', why: 'http_error', status: 302 });
    expect(fake.seen).toHaveLength(1);
  });
});
