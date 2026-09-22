import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { AuthService } from './auth/service.js';
import type { DocumentService } from './documents/service.js';
import type { HouseholdService } from './household/service.js';
import type { VaultService } from './vaults/service.js';
import { loadConfig } from './config.js';

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

async function make(pingDatabase: () => Promise<void> = async () => undefined) {
  app = await buildApp(config, {
    serverVersion: '0.0.1',
    pingDatabase,
    auth: authStub,
    vaults: vaultsStub,
    documents: documentsStub,
    household: householdStub,
    visibility: anyStub,
    totp: anyStub,
    exports: anyStub,
    reminders: anyStub,
    notifications: anyStub,
    logger: false,
  });
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
