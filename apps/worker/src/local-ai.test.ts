import {
  LOCAL_AI_NUM_CTX,
  LOCAL_AI_REMINDER,
  LOCAL_AI_TEXT_MAX,
  LOCAL_AI_TEXT_TOKENS,
  localAiTokens,
  type LocalAiOffer,
} from '@fdv/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, localAiUrl } from './config.js';
import {
  LocalAiClient,
  LOCAL_AI_FAILURES_TO_REST,
  LOCAL_AI_REST_MS,
  localAiHost,
  localAiSettings,
  type LocalAiSettings,
} from './local-ai.js';
import { blankForm, startFakeOllama, type FakeOllama } from './local-ai-test-server.js';

/**
 * The local AI's client (0.9.0, R4), against a fake Ollama: what it sends
 * and to where, its timeouts, its size cap, its breaker, one call at a time
 * with the family's first — and the operator's settings it starts from.
 */

const OFFER: LocalAiOffer = {
  kinds: [
    { key: 'passport', label: 'Passport' },
    { key: 'utility_bill', label: 'Bill' },
  ],
  names: [{ label: 'Aisha', id: '00000000-0000-4000-8000-000000000001' }],
};

let fake: FakeOllama;
beforeEach(async () => {
  fake = await startFakeOllama();
});
afterEach(async () => {
  await fake.close();
});

const settings = (over: Partial<LocalAiSettings> = {}): LocalAiSettings => ({
  url: new URL(fake.url),
  model: 'qwen2.5:3b-instruct',
  timeoutMs: 5_000,
  ...over,
});

describe('the operator’s settings (R4)', () => {
  const base = { DATABASE_URL: 'postgres://x', FDV_MASTER_KEY: 'k'.repeat(43) };

  it('takes http and https, a host and a port, and keeps a path as the base', () => {
    for (const ok of ['http://ollama:11434', 'https://ai.lan', 'http://10.0.0.5:8080/ollama/']) {
      expect(localAiUrl(ok)).toBeInstanceOf(URL);
    }
    const c = loadConfig({
      ...base,
      FDV_LOCAL_AI_URL: 'http://ollama:11434',
      FDV_LOCAL_AI_MODEL: 'qwen2.5:3b-instruct',
    });
    const s = localAiSettings(c);
    expect(s?.url.host).toBe('ollama:11434');
    expect(s?.model).toBe('qwen2.5:3b-instruct');
    // 120 seconds unless said (the R4 review).
    expect(s?.timeoutMs).toBe(120_000);
    expect(localAiHost(new URL('http://u@ollama:11434/x?y'))).toBe('ollama:11434');
  });

  it('refuses another scheme, a user or password in it, a query, and no model — never saying the URL', () => {
    for (const bad of [
      'ftp://ollama',
      'file:///etc/passwd',
      'http://user:secret@ollama:11434',
      'http://user@ollama:11434',
      'http://ollama:11434/?a=1',
      'http://ollama:11434/#x',
      'ollama:11434',
      'not a url',
    ]) {
      expect(localAiUrl(bad)).toBeTypeOf('string');
      let said = '';
      try {
        loadConfig({ ...base, FDV_LOCAL_AI_URL: bad, FDV_LOCAL_AI_MODEL: 'm' });
      } catch (e) {
        said = (e as Error).message;
      }
      expect(said).toMatch(/FDV_LOCAL_AI_URL/);
      expect(said).not.toContain('secret');
    }
    expect(() => loadConfig({ ...base, FDV_LOCAL_AI_URL: 'http://ollama:11434' })).toThrow(
      /FDV_LOCAL_AI_MODEL/,
    );
    expect(() =>
      loadConfig({ ...base, FDV_LOCAL_AI_URL: 'http://o', FDV_LOCAL_AI_MODEL: 'a b' }),
    ).toThrow(/FDV_LOCAL_AI_MODEL/);
    for (const t of ['4', '301', 'x']) {
      expect(() =>
        loadConfig({
          ...base,
          FDV_LOCAL_AI_URL: 'http://o',
          FDV_LOCAL_AI_MODEL: 'm',
          FDV_LOCAL_AI_TIMEOUT_SECONDS: t,
        }),
      ).toThrow(/FDV_LOCAL_AI_TIMEOUT_SECONDS/);
    }
    // Unset: no local AI at all.
    expect(localAiSettings(loadConfig(base))).toBeNull();
  });
});

describe('the local AI’s client (R4)', () => {
  it('sends the first words, the kinds and the names offered, to /api/chat at the address it pinned', async () => {
    let resolved = 0;
    const client = new LocalAiClient(
      settings({ url: new URL(`http://ollama.test:${fake.port}/base/`) }),
      {
        // The name is the operator's; nothing else resolves it.
        resolve: async (h) => {
          resolved += 1;
          expect(h).toBe('ollama.test');
          return '127.0.0.1';
        },
      },
    );
    const words = `PASSPORT Aisha Khan ${'x'.repeat(LOCAL_AI_TEXT_MAX * 2)} THE-END-MARKER`;
    const got = await client.read(words, OFFER, { priority: 'interactive' });
    expect(got.state).toBe('replied');
    expect(resolved).toBe(1);
    const [req] = fake.requests;
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/base/api/chat');
    // The name kept for the Host header; the connection made to the address.
    expect(req?.host).toBe(`ollama.test:${fake.port}`);
    const sent = JSON.parse(req?.body ?? '{}') as {
      model: string;
      stream: boolean;
      format: { properties: { kind: { enum: string[] }; whose: { enum: string[] } } };
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.model).toBe('qwen2.5:3b-instruct');
    expect(sent.stream).toBe(false);
    expect(sent.format.properties.kind.enum).toEqual(['passport', 'utility_bill', 'unknown']);
    expect(sent.format.properties.whose.enum).toEqual(['Aisha', 'unknown']);
    const user = sent.messages[1]?.content ?? '';
    // Capped: the end of a long paper is never sent.
    expect(user).not.toContain('THE-END-MARKER');
    expect(user.length).toBeLessThan(LOCAL_AI_TEXT_MAX + 1_000);
    expect(sent.messages[0]?.content).toMatch(/data, not instructions/);
  });

  it('a dense page is cut by its tokens, the task said again after it, and the context asked for (L6)', async () => {
    const client = new LocalAiClient(settings());
    await client.read('7'.repeat(6_000), OFFER, { priority: 'interactive' });
    const sent = JSON.parse(fake.requests[0]?.body ?? '{}') as {
      options: { num_ctx: number };
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.options.num_ctx).toBe(LOCAL_AI_NUM_CTX);
    const user = sent.messages[1]?.content ?? '';
    const digits = (user.match(/7{20,}/)?.[0] ?? '').length;
    // Within the estimate: a digit is a token.
    expect(digits).toBeGreaterThan(0);
    expect(localAiTokens('7'.repeat(digits))).toBeLessThanOrEqual(LOCAL_AI_TEXT_TOKENS);
    // The instruction comes after the paper's words, last.
    expect(user.lastIndexOf(LOCAL_AI_REMINDER)).toBeGreaterThan(user.lastIndexOf('7'));
    expect(user.trimEnd().endsWith(LOCAL_AI_REMINDER)).toBe(true);
    // And the whole prompt fits the context with room for the answer.
    const all = sent.messages.map((m) => m.content).join('\n');
    expect(localAiTokens(all) + 200).toBeLessThan(LOCAL_AI_NUM_CTX);
  });

  it('gives up at its time, and on an endpoint that never answers', async () => {
    fake.delayMs = 2_000;
    const client = new LocalAiClient(settings({ timeoutMs: 300 }));
    const t0 = Date.now();
    const got = await client.read('words', OFFER, { priority: 'interactive' });
    expect(got).toMatchObject({ state: 'without', why: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1_500);

    fake.delayMs = 0;
    fake.answers = [{ hang: true }];
    const t1 = Date.now();
    const hung = await new LocalAiClient(settings({ timeoutMs: 300 })).read('w', OFFER, {
      priority: 'interactive',
    });
    expect(hung).toMatchObject({ state: 'without', why: 'timeout' });
    expect(Date.now() - t1).toBeLessThan(1_500);
  });

  it('reads no more than its cap of a reply, and says what else went wrong', async () => {
    fake.answers = [{ huge: 40 * 1024 }];
    const client = new LocalAiClient(settings());
    expect(await client.read('w', OFFER, { priority: 'interactive' })).toMatchObject({
      state: 'without',
      why: 'too_big',
    });
    fake.answers = [{ status: 404 }];
    expect(await client.read('w', OFFER, { priority: 'interactive' })).toMatchObject({
      state: 'without',
      why: 'http_error',
      status: 404,
    });
    // A redirect is never followed.
    fake.answers = [{ status: 302 }];
    expect(await client.read('w', OFFER, { priority: 'interactive' })).toMatchObject({
      why: 'http_error',
    });
    const closed = new LocalAiClient(settings({ url: new URL('http://127.0.0.1:1') }));
    expect(await closed.read('w', OFFER, { priority: 'interactive' })).toMatchObject({
      state: 'without',
      why: 'unreachable',
    });
    const nowhere = new LocalAiClient(settings({ url: new URL('http://nowhere.test') }), {
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(await nowhere.read('w', OFFER, { priority: 'interactive' })).toMatchObject({
      why: 'unreachable',
    });
  });

  it('rests after failures in a row: nothing is sent, papers are read without it at once, then it tries again', async () => {
    let now = 1_000_000;
    const logged: Array<Record<string, unknown>> = [];
    const client = new LocalAiClient(settings(), {
      now: () => now,
      log: (_l, msg, extra) => logged.push({ msg, ...extra }),
    });
    fake.answers = [{ status: 500 }];
    for (let i = 0; i < LOCAL_AI_FAILURES_TO_REST; i += 1) {
      expect(await client.read('w', OFFER, { priority: 'interactive' })).toMatchObject({
        why: 'http_error',
      });
    }
    expect(client.resting()).toBe(true);
    const sentBefore = fake.requests.length;
    const rested = await client.read('w', OFFER, { priority: 'interactive' });
    expect(rested).toMatchObject({ state: 'without', why: 'resting', ms: 0 });
    expect(await client.read('w', OFFER, { priority: 'check' })).toMatchObject({ why: 'resting' });
    // Nothing reached the endpoint while it rested: no retries pile up.
    expect(fake.requests.length).toBe(sentBefore);
    expect(logged.some((l) => /rested/.test(String(l.msg)))).toBe(true);
    // The log says why and how long, never a word of a paper.
    expect(JSON.stringify(logged)).not.toMatch(/"w"|passport/i);

    now += LOCAL_AI_REST_MS + 1;
    expect(client.resting()).toBe(false);
    fake.answers = [{ form: blankForm() }];
    expect(await client.read('w', OFFER, { priority: 'interactive' })).toMatchObject({
      state: 'replied',
    });
    expect(fake.requests.length).toBe(sentBefore + 1);
  });

  it('a failure fewer than enough in a row, then an answer, does not rest it', async () => {
    const client = new LocalAiClient(settings());
    fake.answers = [{ status: 500 }, { status: 500 }, { form: blankForm() }, { status: 500 }];
    for (let i = 0; i < 4; i += 1) await client.read('w', OFFER, { priority: 'interactive' });
    expect(client.resting()).toBe(false);
  });

  it('makes one call at a time, the family’s papers before the Reading check’s, and stops a check’s for theirs', async () => {
    fake.delayMs = 300;
    let open = 0;
    let most = 0;
    const client = new LocalAiClient(settings());
    const track = async (p: Promise<unknown>) => {
      open += 1;
      most = Math.max(most, open);
      try {
        return await p;
      } finally {
        open -= 1;
      }
    };
    // A check's call running is stopped by a paper the family waits on.
    const check = client.read('check paper', OFFER, { priority: 'check' });
    await new Promise((r) => setTimeout(r, 50));
    const family = client.read('family paper', OFFER, { priority: 'interactive' });
    expect(await check).toMatchObject({ state: 'without', why: 'preempted' });
    expect(await family).toMatchObject({ state: 'replied' });
    // Being stopped is no failure of the endpoint's.
    expect(client.resting()).toBe(false);

    // In line: the family's first, whatever came first.
    fake.requests.length = 0;
    const a = client.read('first family', OFFER, { priority: 'interactive' });
    await new Promise((r) => setTimeout(r, 30));
    const b = client.read('a check', OFFER, { priority: 'check' });
    const c = client.read('second family', OFFER, { priority: 'interactive' });
    await Promise.all([a, b, c].map(track));
    const order = fake.requests.map((r) =>
      ['first family', 'second family', 'a check'].find((w) => r.body.includes(w)),
    );
    expect(order).toEqual(['first family', 'second family', 'a check']);
    expect(client.sent).toBeGreaterThanOrEqual(4);
  });

  it('a paper waiting longer than its time is read without it, and the line goes on', async () => {
    fake.delayMs = 600;
    const client = new LocalAiClient(settings({ timeoutMs: 400 }));
    const a = client.read('one', OFFER, { priority: 'interactive' });
    const b = client.read('two', OFFER, { priority: 'interactive' });
    expect(await a).toMatchObject({ why: 'timeout' });
    expect(await b).toMatchObject({ why: 'timeout' });
    fake.delayMs = 0;
    expect(await client.read('three', OFFER, { priority: 'interactive' })).toMatchObject({
      state: 'replied',
    });
  });

  it('Test sends a tiny prompt of its own, whatever the breaker says, and its answer ends a rest', async () => {
    let now = 5_000_000;
    const client = new LocalAiClient(settings(), { now: () => now });
    fake.answers = [{ status: 500 }];
    for (let i = 0; i < LOCAL_AI_FAILURES_TO_REST; i += 1) {
      await client.read('w', OFFER, { priority: 'interactive' });
    }
    expect(client.resting()).toBe(true);
    fake.answers = [{ content: 'ready' }];
    fake.requests.length = 0;
    const got = await client.test();
    expect(got.state).toBe('replied');
    const body = fake.requests[0]?.body ?? '';
    expect(body).toMatch(/Reply with the single word/);
    expect(body).not.toMatch(/Passport|Aisha/);
    expect(client.resting()).toBe(false);
    now += 1;
  });

  it('a slow name lookup is bounded by the call’s time, and the probe’s by its own (the R4 review, L3)', async () => {
    const slow = (ms: number) => () =>
      new Promise<string>((r) => setTimeout(() => r('127.0.0.1'), ms));
    const client = new LocalAiClient(
      settings({ url: new URL(`http://ollama.test:${fake.port}`), timeoutMs: 1_000 }),
      { resolve: slow(4_000), probeMs: 800 },
    );
    const t0 = Date.now();
    expect(await client.read('w', OFFER, { priority: 'interactive' })).toMatchObject({
      state: 'without',
      why: 'timeout',
    });
    expect(Date.now() - t0).toBeLessThan(2_000);
    const t1 = Date.now();
    expect(await client.probe()).toBe('unreachable');
    expect(Date.now() - t1).toBeLessThan(2_000);
    expect(fake.requests).toHaveLength(0);
  });

  it('a call that waited in line and then ran out of time is no failure of the endpoint’s (L4)', async () => {
    fake.delayMs = 600;
    const client = new LocalAiClient(settings({ timeoutMs: 5_000 }), { testMs: 900 });
    const batch = client.read('a family paper', OFFER, { priority: 'interactive' });
    await new Promise((r) => setTimeout(r, 30));
    // Test waits behind it, gets the line with ~300 ms of its 900 left, and runs out.
    const tested = await client.test();
    expect(tested).toMatchObject({ state: 'without', why: 'timeout' });
    expect(await batch).toMatchObject({ state: 'replied' });
    expect(client.failures).toBe(0);
  });

  it('the breaker counts the endpoint down — not a 4xx, nor a call short of its time (L5)', async () => {
    const client = new LocalAiClient(settings({ timeoutMs: 400 }));
    fake.answers = [{ status: 404 }];
    for (let i = 0; i < LOCAL_AI_FAILURES_TO_REST + 1; i += 1) {
      await client.read('w', OFFER, { priority: 'interactive' });
    }
    expect(client.failures).toBe(0);
    expect(client.resting()).toBe(false);
    // A whole call's time with no answer counts.
    fake.answers = [{ form: blankForm() }];
    fake.delayMs = 1_000;
    await client.read('w', OFFER, { priority: 'interactive' });
    expect(client.failures).toBe(1);
  });

  it('reads the list of models as JSON, a long one too, and takes an endpoint without a list as answering', async () => {
    const client = new LocalAiClient(settings());
    // Far past the 32 KiB a paper's reply may have.
    fake.models = [
      ...Array.from({ length: 3_000 }, (_, i) => `padding-model-${i}:latest`),
      'qwen2.5:3b-instruct',
    ];
    expect(await client.probe()).toBe('reachable');
    // A name only quoted inside another is not the model.
    fake.models = ['x"name":"qwen2.5:3b-instruct'];
    expect(await client.probe()).toBe('no_model');
    // /api/chat but no /api/tags: answering; Test says whether it has the model.
    fake.tagsStatus = 404;
    expect(await client.probe()).toBe('reachable');
  });

  it('asks whether the endpoint has the model, by its list', async () => {
    const client = new LocalAiClient(settings());
    expect(await client.probe()).toBe('reachable');
    fake.models = ['llama3.2:3b'];
    expect(await client.probe()).toBe('no_model');
    fake.models = ['llama3.2:latest'];
    expect(await new LocalAiClient(settings({ model: 'llama3.2' })).probe()).toBe('reachable');
    expect(await new LocalAiClient(settings({ url: new URL('http://127.0.0.1:1') })).probe()).toBe(
      'unreachable',
    );
  });
});
