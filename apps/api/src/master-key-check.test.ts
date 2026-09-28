import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './test-harness.js';

/**
 * The API does not start on a master key that does not open the vault
 * (ROT-O-01): after a rotation with .env not updated, or restarted with
 * `docker compose restart`, it used to answer /readyz, fail every owner's
 * two-step sign-in with a 500, and seal what it was given under the wrong
 * key. Run here as its container runs it: server.ts, bundled as the build
 * bundles it.
 */

const API_DIR = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = path.join(API_DIR, '..', '..', 'scripts', 'bundle.mjs');

interface Started {
  code: number | null;
  listening: boolean;
  stderr: string;
}

/** A port nothing is listening on, for the API to take. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

describe.skipIf(!testAdminUrl())('the API and its master key at start', () => {
  let h: Harness;
  let vaultDir: string;
  /** In dist/, beside the app's node_modules, as the image has it. */
  let bundleDir: string;

  /** Starts the API; resolves when it exits, or when it listens (and is stopped). */
  async function startApi(masterKey: string): Promise<Started> {
    const port = await freePort();
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(bundleDir, 'server.mjs')], {
        cwd: API_DIR,
        env: {
          ...process.env,
          DATABASE_URL: h.adminUrl,
          DATABASE_ADMIN_URL: h.adminUrl,
          FDV_MASTER_KEY: masterKey,
          FDV_LOCAL_VAULT_DIR: vaultDir,
          // The harness migrated it: straight to the check.
          FDV_RUN_MIGRATIONS: 'false',
          FDV_MIGRATIONS_DIR: path.join(API_DIR, '..', '..', 'packages', 'db', 'migrations'),
          HOST: '127.0.0.1',
          PORT: String(port),
          LOG_LEVEL: 'info',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let listening = false;
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => {
        if (!listening && /Server listening/.test(c.toString())) {
          listening = true;
          child.kill();
        }
      });
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      const timer = setTimeout(() => child.kill(), 90_000);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, listening, stderr });
      });
    });
  }

  beforeAll(async () => {
    h = await createHarness();
    await h.setup(); // a household, and its scope keys under TEST_MASTER
    vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-start-'));
    bundleDir = path.join(API_DIR, 'dist', `test-${randomUUID().slice(0, 8)}`);
    execFileSync(process.execPath, [BUNDLE, 'src/server.ts', path.join(bundleDir, 'server.mjs')], {
      cwd: API_DIR,
      stdio: 'ignore',
    });
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
  });

  it('refuses to start on a key that does not open the vault, and says what to do', async () => {
    const started = await startApi('the-key-after-a-rotation-that-is-not-in-use-000');
    expect(started.listening).toBe(false);
    expect(started.code).toBe(1);
    expect(started.stderr).toMatch(/FDV_MASTER_KEY does not open this vault \(the \w+ scope key/);
    expect(started.stderr).toContain('docker compose up -d');
  }, 120_000);
});
