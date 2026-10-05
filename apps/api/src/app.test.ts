import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { metaOf } from './auth/routes.js';
import type { AuthService } from './auth/service.js';
import type { DocumentService } from './documents/service.js';
import type { HouseholdService } from './household/service.js';
import type { VaultService } from './vaults/service.js';
import { loadConfig, type ApiConfig } from './config.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused',
  FDV_MASTER_KEY: 'test-master-key-that-is-long-enough-0123456789',
  FDV_DISPLAY_NAME: 'Test vault',
  LOG_LEVEL: 'error',
});

// Health and capabilities need no database; the auth service is stubbed.
// A test may make its first call fail as the database would.
let setupComplete: () => Promise<boolean> = async () => true;
const authStub = {
  setupComplete: () => setupComplete(),
  displayName: async () => null,
} as unknown as AuthService;
const vaultsStub = {} as unknown as VaultService;
const documentsStub = {} as unknown as DocumentService;
const householdStub = {} as unknown as HouseholdService;
const anyStub = {} as never;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function make(
  pingDatabase: () => Promise<void> = async () => undefined,
  over: Partial<ApiConfig> = {},
  logger?: object,
  /** The networks the API is on, for FDV_TRUST_PROXY=network (5.30): this machine's otherwise. */
  networks?: string[],
) {
  app = await buildApp(
    { ...config, ...over },
    {
      serverVersion: '0.0.1',
      pingDatabase,
      auth: authStub,
      vaults: vaultsStub,
      documents: documentsStub,
      purge: anyStub,
      types: anyStub,
      collections: anyStub,
      sealedSearch: anyStub,
      household: householdStub,
      photos: anyStub,
      identity: anyStub,
      locks: anyStub,
      restrictions: anyStub,
      resets: anyStub,
      invitations: anyStub,
      coOwners: anyStub,
      shares: anyStub,
      uploads: anyStub,
      incoming: anyStub,
      audit: anyStub,
      passwords: anyStub,
      offline: anyStub,
      visibility: anyStub,
      totp: anyStub,
      passkeys: anyStub,
      stepUp: anyStub,
      exports: anyStub,
      reminders: anyStub,
      suggestions: anyStub,
      notifications: anyStub,
      logger: logger ?? false,
      ...(networks ? { ownNetworks: () => networks } : {}),
    },
  );
  return app;
}

describe('health', () => {
  // The file's first app is built cold, every route module loaded for the
  // first time: under the whole suite's load that has taken over 5 s (5.2).
  it('/healthz is up regardless of dependencies', { timeout: 20_000 }, async () => {
    const res = await (await make(() => Promise.reject(new Error('db down')))).inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('/readyz is 200 when the database answers', async () => {
    const res = await (await make()).inject('/readyz');
    expect(res.statusCode).toBe(200);
  });

  it('/readyz is 503 with the error envelope when the database does not', async () => {
    const res = await (
      await make(() => Promise.reject(new Error('connection refused')))
    ).inject('/readyz');
    expect(res.statusCode).toBe(503);
    const body = res.json<{ error: Record<string, unknown> }>();
    expect(body.error.code).toBe('not_ready');
    expect(body.error.retriable).toBe(true);
    expect(body.error.detail).toBe('connection refused');
    expect(body.error.request_id).toBe(res.headers['x-request-id']);
  });
});

describe('what a device may keep', () => {
  it('every answer says no-store unless its route says otherwise, errors included', async () => {
    const app = await make();
    const missing = await app.inject('/api/v1/no-such-thing');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
    const unauthenticated = await app.inject('/api/v1/me');
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['cache-control']).toBe('no-store');
  });

  it('every answer says which version gave it, the one the capability document names', async () => {
    const app = await make();
    const caps = await app.inject('/api/v1/capabilities');
    const version = caps.json<{ server_version: string }>().server_version;
    expect(caps.headers['x-fdv-server-version']).toBe(version);
    expect((await app.inject('/api/v1/no-such-thing')).headers['x-fdv-server-version']).toBe(
      version,
    );
    expect((await app.inject('/api/v1/me')).headers['x-fdv-server-version']).toBe(version);
  });
});

describe('the log (0.5.0)', () => {
  it('never keeps a secret from a URL: a link token, a PIN, or what somebody searched for', async () => {
    const lines: string[] = [];
    const app = await make(
      undefined,
      {},
      { level: 'info', stream: { write: (s: string) => void lines.push(s) } },
    );
    await app.inject('/api/v1/shared/tokensecret123/content?pin=4242');
    await app.inject('/api/v1/password-resets/resetsecret123');
    await app.inject('/api/v1/invitations/invitesecret123');
    await app.inject('/api/v1/documents?q=divorce');
    // What the lines say, without the log's own numbers: a PIN of 4242 is
    // in a timestamp like 1790424273535, or a random request id like
    // …-344b62cf4242, by chance, not by leaking.
    const log = lines
      .map((l) => {
        const said = JSON.parse(l) as Record<string, unknown>;
        delete said.time;
        delete said.pid;
        delete said.responseTime;
        delete said.reqId;
        return JSON.stringify(said);
      })
      .join(' ');
    expect(log).toContain('/api/v1/shared/[redacted]/content?[redacted]');
    for (const secret of [
      'tokensecret123',
      '4242',
      'resetsecret123',
      'invitesecret123',
      'divorce',
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});

describe('GET /api/v1/capabilities', () => {
  it('returns the capability document, never to be cached', async () => {
    const res = await (await make()).inject('/api/v1/capabilities');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const caps = res.json<Record<string, unknown>>();
    expect(caps.product).toBe('family-document-vault');
    expect(caps.api_version).toBe(1);
    expect(caps.server_version).toBe('0.0.1');
    expect(caps.branding).toEqual({ display_name: 'Test vault' });
    expect(caps.setup_required).toBe(false);
  });
});

describe('error envelope', () => {
  it('unknown routes return the envelope, not Fastify defaults', async () => {
    const res = await (await make()).inject('/api/v1/nope');
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: Record<string, unknown> }>();
    expect(body.error.code).toBe('not_found');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.retriable).toBe(false);
  });

  it('two requests that got in each other’s way in the database are 503 busy, retriable, with Retry-After', async () => {
    const server = await make();
    try {
      for (const code of ['40P01', '40001']) {
        setupComplete = async () => {
          throw Object.assign(new Error('deadlock detected'), { code });
        };
        const res = await server.inject('/api/v1/capabilities');
        expect(res.statusCode, code).toBe(503);
        expect(res.headers['retry-after'], code).toBe('1');
        expect(
          res.json<{ error: { code: string; retriable: boolean } }>().error,
          code,
        ).toMatchObject({ code: 'busy', retriable: true });
      }
    } finally {
      setupComplete = async () => true;
    }
  });

  it('only the vault’s own “session ended while it waited” is a session’s end; a database refusing a connection (28000) is the server’s (the 5.29 review, F529-07)', async () => {
    const server = await make();
    try {
      setupComplete = async () => {
        throw Object.assign(new Error('no pg_hba.conf entry for host'), { code: '28000' });
      };
      const refused = await server.inject('/api/v1/capabilities');
      expect(refused.statusCode).toBe(500);
      expect(refused.json<{ error: { code: string } }>().error.code).not.toBe('session_ended');
      // 0052's FDV01, with why the session ended: a lock's is `suspended`.
      setupComplete = async () => {
        throw Object.assign(new Error('this sign-in has ended'), {
          code: 'FDV01',
          detail: 'sign-in locked',
        });
      };
      const ended = await server.inject('/api/v1/capabilities');
      expect(ended.statusCode).toBe(401);
      expect(ended.json<{ error: Record<string, unknown> }>().error).toMatchObject({
        code: 'session_ended',
        reason: 'suspended',
      });
    } finally {
      setupComplete = async () => true;
    }
  });

  it('honours a caller-supplied request id', async () => {
    const res = await (
      await make()
    ).inject({
      url: '/healthz',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('a 429 says rate_limited, retriable, with Retry-After', async () => {
    const server = await make();
    // The ceiling for everything outside sign-in is 300 a minute.
    let res = await server.inject('/api/v1/capabilities');
    for (let i = 0; i < 300; i += 1) res = await server.inject('/api/v1/capabilities');
    expect(res.statusCode).toBe(429);
    const seconds = Number(res.headers['retry-after']);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);
    const body = res.json<{ error: { code: string; retriable: boolean; message: string } }>();
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.retriable).toBe(true);
    expect(body.error.message).toBe(`Too many requests at once. Try again in ${seconds} seconds.`);
  });
});

describe('whose X-Forwarded-For is believed (5.30)', () => {
  // The audit log records where an action came from, the rate limiter
  // counts per address, and a browser's refresh grace compares addresses.
  // Believing any caller's header would let anyone write their own address
  // into someone else's log. The API's container is on the compose network
  // with nginx and Caddy (172.18.0.0/16 here); the family's LAN is not.
  const COMPOSE = ['172.18.0.3/16', '127.0.0.1/8', '::1/128'];
  const NGINX = '172.18.0.5';
  const CADDY = '172.18.0.7';
  const PHONE = '192.168.1.50';
  /** The address a request is recorded under (metaOf), and what rate limits count. */
  const seen = async (
    peer: string,
    forwarded: string | null,
    over: Partial<ApiConfig> = {},
    networks: string[] = COMPOSE,
  ): Promise<{ meta: string | null | undefined; status: number }> => {
    const built = await make(undefined, over, undefined, networks);
    let meta: string | null | undefined;
    built.get('/spy', (req) => {
      meta = metaOf(req).ip;
      return { ok: true };
    });
    const res = await built.inject({
      url: '/spy',
      headers: forwarded === null ? {} : { 'x-forwarded-for': forwarded },
      remoteAddress: peer,
    });
    return { meta, status: res.statusCode };
  };

  it('nginx, on the compose network, is believed: the phone it was reached from', async () => {
    expect((await seen(NGINX, PHONE)).meta).toBe(PHONE);
    expect((await seen(NGINX, null)).meta).toBe(NGINX);
  });

  it('a LAN peer cannot set the client address', async () => {
    // Straight to the API from the home Wi-Fi: its own address, whatever it says.
    expect((await seen(PHONE, '203.0.113.9')).meta).toBe(PHONE);
    // Through an nginx that adds to what it was sent, as before 5.30: the
    // LAN hop is not a proxy, so what it wrote to its left is not believed.
    expect((await seen(NGINX, `203.0.113.9, ${PHONE}`)).meta).toBe(PHONE);
    // The rule before 5.30 believed every private address, and so the phone.
    expect((await seen(NGINX, `203.0.113.9, ${PHONE}`, { FDV_TRUST_PROXY: 'private' })).meta).toBe(
      '203.0.113.9',
    );
  });

  it('through Caddy, which writes the address it was reached from: that one', async () => {
    // Caddy to the API itself (docker/caddy).
    expect((await seen(CADDY, PHONE)).meta).toBe(PHONE);
    // An IPv4 peer as an IPv6 socket names it is the same peer.
    expect((await seen(`::ffff:${NGINX}`, PHONE)).meta).toBe(PHONE);
  });

  it('a proxy on the network is believed for one hop: the address it wrote last (the 5.30 review, X530-1)', async () => {
    // The network's gateway is on it too, and Docker Desktop and
    // docker-proxy hand on outside connections from there: a proxy of one's
    // own that adds to what a caller wrote passes on a forged address behind it.
    const owners = ['172.19.0.5/16', '127.0.0.1/8', '::1/128'];
    const forged = await seen('172.19.0.9', '203.0.113.7, 172.19.0.1', {}, owners);
    expect(forged.meta).toBe('172.19.0.1');
    expect((await seen(NGINX, `${PHONE}, ${CADDY}`)).meta).toBe(CADDY);
  });

  it('a forged non-address in X-Forwarded-For is ignored, not a 500', async () => {
    for (const forged of ['<script>', 'unknown', `nonsense, ${PHONE}`, '999.1.1.1']) {
      const r = await seen(NGINX, forged);
      expect(r.status, forged).toBe(200);
      // The last address before it: the proxy's own, or the hop it named.
      expect(r.meta, forged).toBe(forged.endsWith(PHONE) ? PHONE : NGINX);
    }
    // Whatever is believed, never text: all, too.
    expect((await seen(PHONE, 'not-an-address', { FDV_TRUST_PROXY: 'all' })).meta).toBe(PHONE);
  });

  it('with none, the header is ignored entirely', async () => {
    expect((await seen(NGINX, '203.0.113.9', { FDV_TRUST_PROXY: 'none' })).meta).toBe(NGINX);
  });

  it('a caller from a public address cannot claim to be a proxy', async () => {
    expect((await seen('203.0.113.200', '198.51.100.7')).meta).toBe('203.0.113.200');
  });

  it('the rate limit counts the address as believed, not as claimed', async () => {
    const built = await make(undefined, { FDV_RATE_LIMIT_PER_MINUTE: 60 }, undefined, COMPOSE);
    // A LAN peer that writes a new address each time is still one address.
    let last = 0;
    for (let i = 0; i < 61; i += 1) {
      last = (
        await built.inject({
          url: '/api/v1/capabilities',
          headers: { 'x-forwarded-for': `203.0.113.${i}` },
          remoteAddress: PHONE,
        })
      ).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('loadConfig', () => {
  it('fails loudly on a missing database url or master key', () => {
    expect(() => loadConfig({ FDV_MASTER_KEY: config.FDV_MASTER_KEY })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'x' })).toThrow(/FDV_MASTER_KEY/);
    expect(loadConfig({ DATABASE_URL: 'x', FDV_MASTER_KEY_FILE: '/k' }).FDV_MASTER_KEY_FILE).toBe(
      '/k',
    );
    expect(() => loadConfig({ DATABASE_URL: 'x', FDV_MASTER_KEY: 'short' })).toThrow(/32/);
  });

  it('applies self-hosted defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'x', FDV_MASTER_KEY: config.FDV_MASTER_KEY });
    expect(c.PORT).toBe(3000);
    expect(c.FDV_EDITION).toBe('self_hosted');
    expect(c.FDV_MAX_UPLOAD_BYTES).toBe(104857600);
    expect(c.FDV_RATE_LIMIT_PER_MINUTE).toBe(300);
  });

  it('one address gets FDV_RATE_LIMIT_PER_MINUTE requests a minute, then 429', async () => {
    const withLimit = (v: string) =>
      loadConfig({
        DATABASE_URL: 'x',
        FDV_MASTER_KEY: config.FDV_MASTER_KEY,
        FDV_RATE_LIMIT_PER_MINUTE: v,
      });
    expect(withLimit('').FDV_RATE_LIMIT_PER_MINUTE).toBe(300);
    expect(() => withLimit('59')).toThrow(/FDV_RATE_LIMIT_PER_MINUTE/);
    await make(undefined, { FDV_RATE_LIMIT_PER_MINUTE: 60 });
    const ask = () => app!.inject({ method: 'GET', url: '/api/v1/capabilities' });
    for (let i = 0; i < 60; i++) expect((await ask()).statusCode).toBe(200);
    const refused = await ask();
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('FDV_SHARE_MAX_DAYS shortens the longest link, and never lengthens it past 90 (5.18, A20)', () => {
    const withDays = (v: string) =>
      loadConfig({
        DATABASE_URL: 'x',
        FDV_MASTER_KEY: config.FDV_MASTER_KEY,
        FDV_SHARE_MAX_DAYS: v,
      });
    expect(withDays('').FDV_SHARE_MAX_DAYS).toBe(90);
    expect(withDays('14').FDV_SHARE_MAX_DAYS).toBe(14);
    for (const bad of ['0', '91', 'forever']) {
      expect(() => withDays(bad), bad).toThrow(/FDV_SHARE_MAX_DAYS/);
    }
  });

  it('treats a variable set to nothing as one that is not set', () => {
    // Compose writes `FDV_RP_ID: ${FDV_RP_ID:-}` for everything optional,
    // so the container is handed an empty string rather than nothing at
    // all. Failing on that would be a startup error about a setting the
    // self-hoster never touched.
    const c = loadConfig({
      DATABASE_URL: 'x',
      FDV_MASTER_KEY: config.FDV_MASTER_KEY,
      FDV_RP_ID: '',
      FDV_MAX_UPLOAD_BYTES: '',
      FDV_VAPID_PUBLIC_KEY: '',
      FDV_BASE_URL: '',
    });
    expect(c.FDV_RP_ID).toBeUndefined();
    expect(c.FDV_MAX_UPLOAD_BYTES).toBe(104857600);
    expect(c.FDV_BASE_URL).toBe('http://localhost:8080');
  });

  it('FDV_PUBLIC_URL is https, but for this computer (5.16 review)', () => {
    // Over plain http a browser drops the Secure cookie Open gives, so the
    // open is counted and the file never comes.
    const base = { DATABASE_URL: 'x', FDV_MASTER_KEY: config.FDV_MASTER_KEY };
    for (const bad of ['http://192.168.1.20:8080', 'http://share.example.com/']) {
      expect(() => loadConfig({ ...base, FDV_PUBLIC_URL: bad })).toThrow(
        /FDV_PUBLIC_URL: Use https:\/\//,
      );
    }
    // Kept as the address alone, however it was written: a link is this
    // followed by /s#…, so a slash too many would make a different path.
    for (const [good, kept] of [
      ['https://share.example.com', 'https://share.example.com'],
      ['https://share.example.com:8443/', 'https://share.example.com:8443'],
      ['http://localhost:8099', 'http://localhost:8099'],
      ['http://127.0.0.1:8099/', 'http://127.0.0.1:8099'],
      ['http://[::1]:8099', 'http://[::1]:8099'],
      ['HTTPS://share.example.com', 'https://share.example.com'],
      ['HTTPS://Share.Example.COM:443/', 'https://share.example.com'],
    ] as const) {
      expect(loadConfig({ ...base, FDV_PUBLIC_URL: good }).FDV_PUBLIC_URL).toBe(kept);
    }
  });

  it('FDV_PUBLIC_URL is the address alone: nothing a link would carry on after it (5.16 review)', () => {
    const base = { DATABASE_URL: 'x', FDV_MASTER_KEY: config.FDV_MASTER_KEY };
    // Each would make a link that goes somewhere else, or nowhere: /s#… put
    // after a path, a query or a fragment, or a host that is really a name
    // and a password in front of somebody else's.
    for (const bad of [
      'https://share.example.com/s',
      'https://share.example.com#f',
      'https://share.example.com?x',
      'https://user:pw@evil.com',
      'https://localhost@evil.com',
      'http://localhost:8099/s',
    ]) {
      expect(() => loadConfig({ ...base, FDV_PUBLIC_URL: bad }), bad).toThrow(
        /^invalid configuration:\n {2}FDV_PUBLIC_URL: Give the address alone: https:\/\/share\.example\.com$/,
      );
    }
    // Plain http to a name that only says localhost is still plain http.
    expect(() => loadConfig({ ...base, FDV_PUBLIC_URL: 'http://localhost@evil.com' })).toThrow(
      /^invalid configuration:\n {2}FDV_PUBLIC_URL: Use https:\/\/[^\n]*$/,
    );
  });
});
