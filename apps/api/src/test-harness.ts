import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveKey, EnvKeyProvider, ScopeKeys } from '@fdv/crypto';
import { createDb, createPool, type Db } from '@fdv/db';
import { createTestDatabase, type TestDatabase } from '@fdv/db/testing';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { AuthService, type Tokens } from './auth/service.js';
import { deriveSigningKey } from './auth/tokens.js';
import { loadConfig } from './config.js';
import { DocumentService } from './documents/service.js';
import { VaultService } from './vaults/service.js';

/**
 * A fully wired API on a throwaway database with a temp local vault.
 * Integration tests build one per file.
 */
export const TEST_MASTER = 'test-master-key-that-is-long-enough-0123456789';

export interface Harness {
  app: FastifyInstance;
  db: Db;
  vaultDir: string;
  /** Jobs the API asked the worker to run. */
  jobs: Array<{ name: string; data: Record<string, unknown> }>;
  close(): Promise<void>;
  /** Runs first-run setup and returns the owner's tokens. */
  setup(overrides?: Partial<SetupBody>): Promise<Tokens>;
  /** Bearer header for a token set. */
  as(t: Tokens): { authorization: string };
}

export interface SetupBody {
  household_name: string;
  display_name: string;
  email: string;
  password: string;
}

export async function createHarness(): Promise<Harness> {
  const tdb: TestDatabase = await createTestDatabase();
  const vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-api-vault-'));
  const db = createDb(createPool(tdb.appUrl, 4));
  const config = loadConfig({
    DATABASE_URL: tdb.appUrl,
    FDV_MASTER_KEY: TEST_MASTER,
    FDV_LOCAL_VAULT_DIR: vaultDir,
    LOG_LEVEL: 'error',
  });
  const vaults = new VaultService(db, deriveKey(TEST_MASTER, 'vault-credentials'), vaultDir);
  const keys = new ScopeKeys(new EnvKeyProvider(TEST_MASTER));
  const jobs: Harness['jobs'] = [];
  const app = await buildApp(config, {
    serverVersion: '0.0.0-test',
    pingDatabase: async () => undefined,
    auth: new AuthService(db, deriveSigningKey(TEST_MASTER), keys, (trx, hh) =>
      vaults.createDefaultLocal(trx, hh),
    ),
    vaults,
    documents: new DocumentService(db, keys, vaults, 5 * 1024 * 1024, async (name, data) => {
      jobs.push({ name, data });
    }),
    logger: false,
  });

  return {
    app,
    db,
    vaultDir,
    jobs,
    async close() {
      await app.close();
      await db.destroy();
      await tdb.drop();
      await rm(vaultDir, { recursive: true, force: true });
    },
    async setup(overrides = {}) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/setup',
        payload: {
          household_name: 'The Test family',
          display_name: 'Owner',
          email: 'owner@example.test',
          password: 'correct horse battery',
          ...overrides,
        },
      });
      if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
      return res.json<Tokens>();
    },
    as: (t) => ({ authorization: `Bearer ${t.access_token}` }),
  };
}
