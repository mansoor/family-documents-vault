import { randomUUID } from 'node:crypto';
import { AI_READER_KEY_PURPOSE, deriveKey, sealAiReaderKey } from '@fdv/crypto';
import { createDb, createPool, withSystem, type Db } from '@fdv/db';
import { createTestDatabase, testAdminUrl, type TestDatabase } from '@fdv/db/testing';
import type { AiReaderModelsFound, LocalAiTestFound } from '@fdv/shared';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HouseholdAiReaders, type AiReader } from './ai-reader.js';
import { loadConfig } from './config.js';
import { startFakeOllama, type FakeOllama } from './local-ai-test-server.js';
import { ollamaModelNames, OllamaReader } from './ollama-reader.js';
import { runSettingsCheck, type SettingsCheckDeps } from './jobs/settings-check.js';
import { readerFor } from './jobs/read-item.js';

/**
 * The AI reader set in Settings (0.9.0, AIR1), in the worker: the guards on
 * an address an owner typed (decision 9) — resolved once a call and checked
 * before a byte is sent, only the reader's own paths, no redirect followed,
 * a reply not in the API's shape a failure — the key sent only where it was
 * saved for, a Test that never hands on what the reader said, and .env's
 * reader winning over the one saved (decision 8).
 */

const MASTER = 'ai-reader-test-master-key-with-32-bytes-or-more';
const KEY = deriveKey(MASTER, AI_READER_KEY_PURPOSE);
const MODEL = 'qwen2.5:3b-instruct';

/** A reader at the fake, its name resolved to `address` by a resolver of the test's own. */
function guarded(
  fake: FakeOllama,
  address: string,
  guard: { publicOnly: boolean; runsAt: 'own_network' | 'cloud' | null },
  extra: { apiKey?: string; secure?: boolean } = {},
) {
  const url = new URL(`${extra.secure ? 'https' : 'http'}://reader.test:${fake.port}`);
  return new OllamaReader(
    { url, model: MODEL, timeoutMs: 3_000 },
    {
      resolve: async () => address,
      guard,
      apiKey: extra.apiKey ?? null,
      ownAddresses: () => new Set(),
      testMs: 3_000,
      probeMs: 3_000,
    },
  );
}

describe('the guards on a reader saved in Settings (AIR1, decision 9)', () => {
  let fake: FakeOllama;
  beforeAll(async () => {
    fake = await startFakeOllama();
  });
  afterEach(() => {
    fake.requests.length = 0;
    fake.answers = [{ form: {} }];
    fake.tagsStatus = 200;
    fake.models = [MODEL];
  });
  afterAll(async () => {
    await fake.close();
  });

  it('connects to the address it resolved, and says where it runs', async () => {
    const r = guarded(fake, '127.0.0.1', { publicOnly: false, runsAt: null });
    expect((await r.test()).state).toBe('replied');
    expect(r.lastRunsAt).toBe('own_network');
    expect(fake.requests.map((q) => `${q.method} ${q.path}`)).toEqual(['POST /api/chat']);
    // The name kept for the Host header; the address pinned.
    expect(fake.requests[0]?.host).toBe(`reader.test:${fake.port}`);
  });

  it('never sends to link-local (cloud metadata), "this network" or multicast', async () => {
    for (const a of [
      '169.254.169.254',
      '0.0.0.0',
      '224.0.0.1',
      'fe80::1',
      '::ffff:169.254.169.254',
    ]) {
      const r = guarded(fake, a, { publicOnly: false, runsAt: null });
      expect(await r.test(), a).toMatchObject({ state: 'without', why: 'refused' });
      expect(await r.models(), a).toMatchObject({ state: 'without', why: 'refused' });
    }
    expect(fake.requests).toEqual([]);
  });

  it('on the hosted edition, never inside a network, nor over http', async () => {
    const inside = guarded(fake, '127.0.0.1', { publicOnly: true, runsAt: null }, { secure: true });
    expect(await inside.test()).toMatchObject({ why: 'refused' });
    const plain = guarded(fake, '8.8.8.8', { publicOnly: true, runsAt: null });
    expect(await plain.test()).toMatchObject({ why: 'refused' });
    const own = new OllamaReader(
      { url: new URL(`https://reader.test:${fake.port}`), model: MODEL, timeoutMs: 3_000 },
      {
        resolve: async () => '203.0.113.7',
        guard: { publicOnly: true, runsAt: null },
        // One of the worker's own addresses: a Docker network's.
        ownAddresses: () => new Set(['203.0.113.7']),
      },
    );
    expect(await own.test()).toMatchObject({ why: 'refused' });
    expect(fake.requests).toEqual([]);
  });

  it('a reader said to be on your own network is sent nothing at a public address', async () => {
    const moved = guarded(fake, '8.8.8.8', { publicOnly: false, runsAt: 'own_network' });
    const offer = { kinds: [{ key: 'passport', label: 'Passport' }], names: [] };
    expect(await moved.read('words of a paper', offer, { priority: 'interactive' })).toMatchObject({
      state: 'without',
      why: 'refused',
    });
    // Refused is not the reader being down: the breaker counts nothing.
    expect(moved.failures).toBe(0);
    expect(fake.requests).toEqual([]);
  });

  it('follows no redirect: anything but 200 is no answer', async () => {
    fake.answers = [{ status: 302 }];
    const r = guarded(fake, '127.0.0.1', { publicOnly: false, runsAt: null });
    expect(await r.test()).toMatchObject({ state: 'without', why: 'http_error', status: 302 });
    expect(fake.requests).toHaveLength(1);
  });

  it('a reply not in Ollama’s shape is a failure, and its words are kept nowhere', async () => {
    fake.answers = [{ raw: '<html>router admin: secret-on-the-network</html>' }];
    const r = guarded(fake, '127.0.0.1', { publicOnly: false, runsAt: null });
    const got = await r.test();
    expect(got).toMatchObject({ state: 'without', why: 'bad_reply' });
    expect(JSON.stringify(got)).not.toContain('secret-on-the-network');
    // The list of models: the same.
    expect(ollamaModelNames('{"models": "secret-on-the-network"}')).toBeNull();
    expect(ollamaModelNames('not json')).toBeNull();
    expect(
      ollamaModelNames(
        JSON.stringify({
          models: [{ name: 'llama3.2' }, { name: '<script>' }, { model: 'qwen2.5:3b' }, 7],
        }),
      ),
    ).toEqual(['llama3.2', 'qwen2.5:3b']);
  });

  it('sends the key as Authorization: Bearer only when one is set', async () => {
    await guarded(
      fake,
      '127.0.0.1',
      { publicOnly: false, runsAt: null },
      { apiKey: 'k-123' },
    ).test();
    await guarded(fake, '127.0.0.1', { publicOnly: false, runsAt: null }).test();
    expect(fake.requests.map((q) => q.authorization)).toEqual(['Bearer k-123', undefined]);
  });

  it('lists the models by name alone', async () => {
    fake.models = ['llama3.2:3b', 'qwen2.5:3b-instruct'];
    const r = guarded(fake, '127.0.0.1', { publicOnly: false, runsAt: null });
    expect(await r.models()).toMatchObject({
      state: 'listed',
      names: ['llama3.2:3b', 'qwen2.5:3b-instruct'],
    });
    expect(fake.requests.map((q) => `${q.method} ${q.path}`)).toEqual(['GET /api/tags']);
  });
});

describe('FDV_AI_READER_SETTINGS and FDV_EDITION, in the worker’s configuration', () => {
  const base = { DATABASE_URL: 'postgres://x', FDV_MASTER_KEY: MASTER };
  it('is on unless set off; the edition self-hosted unless said', () => {
    expect(loadConfig(base).FDV_AI_READER_SETTINGS).toBe('on');
    expect(loadConfig({ ...base, FDV_AI_READER_SETTINGS: 'off' }).FDV_AI_READER_SETTINGS).toBe(
      'off',
    );
    expect(loadConfig(base).FDV_EDITION).toBe('self_hosted');
    expect(() => loadConfig({ ...base, FDV_AI_READER_SETTINGS: 'maybe' })).toThrow();
  });
});

describe.skipIf(!testAdminUrl())('a reader saved in Settings, as the worker uses it (AIR1)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let fake: FakeOllama;
  let hh: string;
  let owner: string;
  /** What names resolve to here: 127.0.0.1, unless a test says. */
  let resolveTo = '127.0.0.1';
  const readers = (
    publicOnly = false,
    o: {
      ports?: number[];
      services?: Readonly<Record<string, readonly string[]>>;
      own?: readonly string[];
    } = {},
  ) =>
    new HouseholdAiReaders({
      key: KEY,
      publicOnly,
      // The fake listens on a port of its own: allowed, unless a test says.
      ports: o.ports ?? [fake.port],
      resolveAll: async (name) => {
        const got = o.services?.[name];
        if (!got) throw new Error('not found');
        return [...got];
      },
      client: {
        resolve: async () => resolveTo,
        ownAddresses: () => new Set(o.own ?? []),
        testMs: 3_000,
        probeMs: 3_000,
      },
    });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    db = createDb(createPool(tdb.appUrl, 3));
    admin = new pg.Pool({ connectionString: tdb.adminUrl, max: 2 });
    fake = await startFakeOllama();
    hh = randomUUID();
    await admin.query("insert into household (id, name) values ($1, 'Home')", [hh]);
    owner = (
      await admin.query<{ id: string }>(
        "insert into account (email) values ('owner@ai.test') returning id",
      )
    ).rows[0]?.id as string;
  }, 60_000);
  afterEach(async () => {
    fake.requests.length = 0;
    fake.answers = [{ form: {} }];
    fake.tagsStatus = 200;
    resolveTo = '127.0.0.1';
    await admin.query('delete from settings_check');
    await admin.query('delete from ai_reader');
  });
  afterAll(async () => {
    await fake.close();
    await db?.destroy();
    await admin?.end();
    await tdb?.drop();
  });

  const save = async (
    o: {
      status?: string;
      key?: string;
      runsAt?: string;
      httpsOnly?: boolean;
      proven?: boolean;
      base?: string;
    } = {},
  ) => {
    const base = o.base ?? `http://reader.test:${fake.port}`;
    await admin.query(
      `insert into ai_reader (household_id, kind, base_url, model, runs_at, status,
                              api_key_encrypted, api_key_last4, https_only, address_proven)
       values ($1, 'ollama', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        hh,
        base,
        MODEL,
        o.runsAt ?? 'cloud',
        o.status ?? 'untested',
        o.key ? sealAiReaderKey(KEY, o.key, hh, { kind: 'ollama', baseUrl: base }) : null,
        o.key ? o.key.slice(-4) : null,
        o.httpsOnly ?? false,
        o.proven ?? false,
      ],
    );
  };
  const ask = async (kind: 'local_ai' | 'ai_reader' | 'ai_models') =>
    (
      await admin.query<{ id: string }>(
        `insert into settings_check (household_id, kind, path, requested_by)
         values ($1, $2, null, $3) returning id`,
        [hh, kind, owner],
      )
    ).rows[0]?.id as string;
  const answer = async (id: string) =>
    (
      await admin.query<{ result: unknown }>('select result from settings_check where id = $1', [
        id,
      ])
    ).rows[0]?.result;
  const deps = (over: Partial<SettingsCheckDeps> = {}): SettingsCheckDeps => ({
    db,
    log: () => undefined,
    watch: { roots: [], ownDirs: [] },
    mail: { env: null, mailKey: KEY, reader: { close: async () => undefined } as never },
    aiReaders: readers(),
    ...over,
  });
  const row = async () =>
    (
      await admin.query<{ status: string; runs_at: string; last_problem: string | null }>(
        'select status, runs_at, last_problem from ai_reader where household_id = $1',
        [hh],
      )
    ).rows[0];

  it('is used only once a Test passed: Test marks it ok, with where it runs, as the vault', async () => {
    await save({ key: 'sk-test-9876' });
    const r = readers();
    expect(await withSystem(db, hh, (trx) => r.readerFor(trx, hh))).toBeNull();
    const id = await ask('ai_reader');
    await runSettingsCheck(deps(), { household_id: hh, check_id: id });
    const got = (await answer(id)) as LocalAiTestFound;
    expect(got).toMatchObject({
      problem: null,
      model: MODEL,
      host: `reader.test:${fake.port}`,
      runs_at: 'own_network',
    });
    expect(await row()).toEqual({ status: 'ok', runs_at: 'own_network', last_problem: null });
    // The key went with it, to the address it was saved for.
    expect(fake.requests[0]?.authorization).toBe('Bearer sk-test-9876');
    // No paper's words: one fixed line.
    expect(fake.requests[0]?.body).toMatch(/Reply with the single word/);
    // Now it is used.
    const reader = await withSystem(db, hh, (trx) => r.readerFor(trx, hh));
    expect(reader?.kind).toBe('ollama');
    // In the activity log, as the owner who asked: never what it said.
    const audit = await admin.query<{ action: string; actor: string; detail: unknown }>(
      `select action, actor_account_id as actor, detail from audit_event
        where household_id = $1 and action = 'ai_reader.tested'`,
      [hh],
    );
    expect(audit.rows).toEqual([
      {
        action: 'ai_reader.tested',
        actor: owner,
        detail: { ok: true, kind: 'ollama', runs_at: 'own_network' },
      },
    ]);
  });

  it('a Test never hands on what the reader said: a reply not in its shape fails, in the vault’s words', async () => {
    await save();
    fake.answers = [{ raw: '{"secret":"from-a-machine-on-the-network"}' }];
    const id = await ask('ai_reader');
    await runSettingsCheck(deps(), { household_id: hh, check_id: id });
    const got = await answer(id);
    expect(got).toMatchObject({ problem: 'bad_reply', latency_ms: null });
    expect(JSON.stringify(got)).not.toContain('from-a-machine-on-the-network');
    expect(await row()).toMatchObject({ status: 'failed', last_problem: 'bad_reply' });
    const audit = await admin.query<{ detail: unknown }>(
      "select detail from audit_event where household_id = $1 and action = 'ai_reader.tested' order by id desc limit 1",
      [hh],
    );
    expect(JSON.stringify(audit.rows)).not.toContain('from-a-machine-on-the-network');
  });

  it('lists the saved reader’s models, names alone', async () => {
    await save();
    fake.models = ['llama3.2:3b', MODEL];
    const id = await ask('ai_models');
    await runSettingsCheck(deps(), { household_id: hh, check_id: id });
    expect((await answer(id)) as AiReaderModelsFound).toEqual({
      problem: null,
      models: ['llama3.2:3b', MODEL],
    });
  });

  it('a reader changed while it was tested waits for a Test of its own', async () => {
    await save();
    const real = readers();
    // The model changed by an owner while the Test was on its way.
    const racing: Pick<HouseholdAiReaders, 'build' | 'keptFor'> = {
      keptFor: () => null,
      build: (h, saved, runsAt) => {
        const built = real.build(h, saved, runsAt);
        if (!('reader' in built)) return built;
        const reader = built.reader;
        return {
          reader: Object.assign(Object.create(reader) as typeof reader, {
            test: async () => {
              await admin.query("update ai_reader set model = 'llama3.2' where household_id = $1", [
                hh,
              ]);
              return reader.test();
            },
          }),
        };
      },
    };
    const id = await ask('ai_reader');
    await runSettingsCheck(deps({ aiReaders: racing }), { household_id: hh, check_id: id });
    expect(await answer(id)).toMatchObject({ problem: null, model: MODEL });
    // The reader saved now is not the one tested: still untested.
    expect(await row()).toMatchObject({ status: 'untested' });
  });

  it('a Test in flight as the owner unticks "on my own network" never marks it there (the AIR3 review, S1)', async () => {
    await admin.query(
      `insert into ai_reader (household_id, kind, base_url, model, runs_at, own_network, status)
       values ($1, 'openai_compatible', $2, $3, 'own_network', true, 'untested')`,
      [hh, `http://reader.test:${fake.port}`, MODEL],
    );
    // The Test answers, found on the household's own network — and the owner
    // unticks the box while it was on its way.
    const racing: Pick<HouseholdAiReaders, 'build' | 'keptFor'> = {
      keptFor: () => null,
      build: () => ({
        reader: {
          lastRunsAt: 'own_network',
          test: async () => {
            await admin.query('update ai_reader set own_network = false where household_id = $1', [
              hh,
            ]);
            return { state: 'replied', body: '{}', ms: 5 };
          },
        } as unknown as AiReader,
      }),
    };
    const id = await ask('ai_reader');
    await runSettingsCheck(deps({ aiReaders: racing }), { household_id: hh, check_id: id });
    expect(await answer(id)).toMatchObject({ problem: null });
    // The reader saved now is not the one tested: still untested, never ok on your network.
    expect(await row()).toMatchObject({ status: 'untested' });
  });

  it('.env wins: with its reader set, the one saved is not tried, nor used (decision 8)', async () => {
    await save({ status: 'ok', runsAt: 'own_network' });
    const env = new OllamaReader({ url: new URL(fake.url), model: 'env-model', timeoutMs: 3_000 });
    const id = await ask('ai_reader');
    await runSettingsCheck(deps({ localAi: env }), { household_id: hh, check_id: id });
    expect(await answer(id)).toMatchObject({ problem: 'not_set_up' });
    expect(fake.requests).toEqual([]);
    // Reading: .env's, whatever is saved.
    const r = readers();
    expect(
      await withSystem(db, hh, (trx) => readerFor(trx, hh, { localAi: env, aiReaders: r })),
    ).toBe(env);
    // And the Test of the local AI is .env's own.
    const local = await ask('local_ai');
    await runSettingsCheck(deps({ localAi: env }), { household_id: hh, check_id: local });
    expect(await answer(local)).toMatchObject({ problem: null, model: 'env-model' });
  });

  it('FDV_AI_READER_SETTINGS=off: no reader saved in Settings is tried or used', async () => {
    await save({ status: 'ok', runsAt: 'own_network' });
    const id = await ask('ai_reader');
    await runSettingsCheck(deps({ aiReaders: null }), { household_id: hh, check_id: id });
    expect(await answer(id)).toMatchObject({ problem: 'not_set_up' });
    expect(await withSystem(db, hh, (trx) => readerFor(trx, hh, { aiReaders: null }))).toBeNull();
    expect(fake.requests).toEqual([]);
  });

  it('a key that does not open is never sent, and the reader is not used', async () => {
    await save({ status: 'ok', runsAt: 'own_network', key: 'sk-test-1111' });
    const other = new HouseholdAiReaders({
      key: deriveKey('another-master-key-with-at-least-32-bytes!!', AI_READER_KEY_PURPOSE),
      publicOnly: false,
    });
    expect(await withSystem(db, hh, (trx) => other.readerFor(trx, hh))).toBeNull();
  });

  it('on the hosted edition, a saved reader inside a network is refused, and nothing is sent', async () => {
    await save();
    const id = await ask('ai_reader');
    await runSettingsCheck(deps({ aiReaders: readers(true) }), { household_id: hh, check_id: id });
    // http is refused before it is built; nothing reaches the fake. Never
    // passed a Test there, it is said as not reached (S2b).
    expect(await answer(id)).toMatchObject({ problem: 'unreachable' });
    expect(fake.requests).toEqual([]);
  });

  it('a reader the API saved as https-only is held to it by a worker without FDV_EDITION (the review, S1)', async () => {
    // Saved on the hosted edition: https, at a name that now resolves inside a network.
    await save({ httpsOnly: true, proven: true, base: `https://reader.test:${fake.port}` });
    resolveTo = '10.0.0.5';
    const id = await ask('ai_reader');
    // The worker's own FDV_EDITION is self_hosted (publicOnly false).
    await runSettingsCheck(deps({ aiReaders: readers(false) }), { household_id: hh, check_id: id });
    expect(await answer(id)).toMatchObject({ problem: 'refused' });
    // And http under that rule is never built at all.
    await admin.query('delete from ai_reader');
    await save({ httpsOnly: true, proven: true });
    const plain = await ask('ai_reader');
    await runSettingsCheck(deps({ aiReaders: readers(false) }), {
      household_id: hh,
      check_id: plain,
    });
    expect(await answer(plain)).toMatchObject({ problem: 'refused' });
    expect(fake.requests).toEqual([]);
  });

  it('only the ports the operator allows (the review, S2a): any other is refused, nothing sent', async () => {
    await save({ proven: true });
    const id = await ask('ai_reader');
    await runSettingsCheck(deps({ aiReaders: readers(false, { ports: [11434, 443] }) }), {
      household_id: hh,
      check_id: id,
    });
    expect(await answer(id)).toMatchObject({ problem: 'refused' });
    const models = await ask('ai_models');
    await runSettingsCheck(deps({ aiReaders: readers(false, { ports: [11434, 443] }) }), {
      household_id: hh,
      check_id: models,
    });
    expect(await answer(models)).toMatchObject({ problem: 'refused', models: [] });
    expect(fake.requests).toEqual([]);
  });

  it('never the vault’s own services or the worker’s own addresses; loopback stays allowed (S2c)', async () => {
    await save({ proven: true });
    for (const [resolveAt, o] of [
      ['10.9.9.9', { services: { api: ['10.9.9.9'] } }],
      ['10.9.9.8', { services: { postgres: ['10.9.9.8', '127.0.0.1'] } }],
      ['192.168.50.5', { own: ['192.168.50.5', '127.0.0.1'] }],
    ] as const) {
      resolveTo = resolveAt;
      const id = await ask('ai_reader');
      await runSettingsCheck(deps({ aiReaders: readers(false, o) }), {
        household_id: hh,
        check_id: id,
      });
      expect([resolveAt, await answer(id)]).toMatchObject([resolveAt, { problem: 'refused' }]);
      await admin.query('delete from settings_check');
    }
    expect(fake.requests).toEqual([]);
    // Loopback, even where a service name resolves to it, is the family's own server.
    resolveTo = '127.0.0.1';
    const id = await ask('ai_reader');
    await runSettingsCheck(
      deps({ aiReaders: readers(false, { services: { web: ['127.0.0.1'] }, own: ['127.0.0.1'] }) }),
      { household_id: hh, check_id: id },
    );
    expect(await answer(id)).toMatchObject({ problem: null });
  });

  it('an address no Test has passed at is said only as not reached, or not a reader (S2b); once one has, in detail', async () => {
    await save();
    fake.answers = [{ status: 500 }];
    const id = await ask('ai_reader');
    await runSettingsCheck(deps(), { household_id: hh, check_id: id });
    expect(await answer(id)).toMatchObject({ problem: 'bad_reply' });
    fake.answers = [{ status: 404 }];
    const nf = await ask('ai_reader');
    await runSettingsCheck(deps(), { household_id: hh, check_id: nf });
    expect(await answer(nf)).toMatchObject({ problem: 'bad_reply' });
    fake.tagsStatus = 403;
    const m = await ask('ai_models');
    await runSettingsCheck(deps(), { household_id: hh, check_id: m });
    expect(await answer(m)).toMatchObject({ problem: 'bad_reply', models: [] });
    // Nothing listening there: not reached.
    await admin.query('delete from ai_reader');
    await save({ base: 'http://reader.test:1' });
    const closed = await ask('ai_reader');
    await runSettingsCheck(deps({ aiReaders: readers(false, { ports: [1] }) }), {
      household_id: hh,
      check_id: closed,
    });
    expect(await answer(closed)).toMatchObject({ problem: 'unreachable' });
    // A Test passes: the address is proven, and later failures are said in detail.
    await admin.query('delete from ai_reader');
    await save();
    fake.answers = [{ form: {} }];
    const ok = await ask('ai_reader');
    await runSettingsCheck(deps(), { household_id: hh, check_id: ok });
    expect(await answer(ok)).toMatchObject({ problem: null });
    expect(
      (await admin.query('select address_proven from ai_reader where household_id = $1', [hh]))
        .rows[0],
    ).toEqual({ address_proven: true });
    fake.answers = [{ status: 500 }];
    const later = await ask('ai_reader');
    await runSettingsCheck(deps(), { household_id: hh, check_id: later });
    expect(await answer(later)).toMatchObject({ problem: 'http_error' });
  });

  it('Test goes through the reader papers go to, and its answer ends the breaker’s rest (M5)', async () => {
    await save({ status: 'ok', runsAt: 'own_network', proven: true });
    const r = readers();
    const reader = await withSystem(db, hh, (trx) => r.readerFor(trx, hh));
    expect(reader).not.toBeNull();
    // Three server errors in a row: it rests.
    fake.answers = [{ status: 500 }];
    const offer = { kinds: [{ key: 'passport', label: 'Passport' }], names: [] };
    for (let i = 0; i < 3; i++) await reader?.read('words', offer, { priority: 'interactive' });
    expect(reader?.resting()).toBe(true);
    fake.answers = [{ form: {} }];
    const id = await ask('ai_reader');
    await runSettingsCheck(deps({ aiReaders: r }), { household_id: hh, check_id: id });
    expect(await answer(id)).toMatchObject({ problem: null });
    // The same reader: its rest is over, and papers go to it again.
    expect(reader?.resting()).toBe(false);
    expect(await withSystem(db, hh, (trx) => r.readerFor(trx, hh))).toBe(reader);
  });
});
