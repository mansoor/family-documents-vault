import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
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
const authStub = {
  setupComplete: async () => true,
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
) {
  app = await buildApp(
    { ...config, ...over },
    {
      serverVersion: '0.0.1',
      pingDatabase,
      auth: authStub,
      vaults: vaultsStub,
      documents: documentsStub,
      sealedSearch: anyStub,
      household: householdStub,
      invitations: anyStub,
      coOwners: anyStub,
      visibility: anyStub,
      totp: anyStub,
      passkeys: anyStub,
      stepUp: anyStub,
      exports: anyStub,
      reminders: anyStub,
      suggestions: anyStub,
      notifications: anyStub,
      logger: false,
    },
  );
  return app;
}

describe('health', () => {
  it('/healthz is up regardless of dependencies', async () => {
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

describe('GET /api/v1/capabilities', () => {
  it('returns the capability document with cache headers', async () => {
    const res = await (await make()).inject('/api/v1/capabilities');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
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

  it('honours a caller-supplied request id', async () => {
    const res = await (
      await make()
    ).inject({
      url: '/healthz',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });
});

describe('whose X-Forwarded-For is believed', () => {
  // The audit log records where an action came from and the rate limiter
  // counts per address. Believing any caller's header would let anyone
  // write their own address into someone else's log.
  const seen = async (headers: Record<string, string>, over: Partial<ApiConfig> = {}) => {
    const built = await make(undefined, over);
    let ip = '';
    built.get('/spy', (req) => {
      ip = req.ip;
      return { ok: true };
    });
    await built.inject({ url: '/spy', headers, remoteAddress: '10.1.2.3' });
    return ip;
  };

  it('by default a private proxy is believed', async () => {
    expect(await seen({ 'x-forwarded-for': '203.0.113.9' })).toBe('203.0.113.9');
  });

  it('with none, the header is ignored entirely', async () => {
    expect(await seen({ 'x-forwarded-for': '203.0.113.9' }, { FDV_TRUST_PROXY: 'none' })).toBe(
      '10.1.2.3',
    );
  });

  it('a caller from a public address cannot claim to be a proxy', async () => {
    const built = await make();
    let ip = '';
    built.get('/spy2', (req) => {
      ip = req.ip;
      return { ok: true };
    });
    await built.inject({
      url: '/spy2',
      headers: { 'x-forwarded-for': '198.51.100.7' },
      remoteAddress: '203.0.113.200',
    });
    expect(ip).toBe('203.0.113.200');
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
  });
});
