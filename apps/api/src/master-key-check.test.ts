import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testAdminUrl } from '@fdv/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, TEST_MASTER, type Harness } from './test-harness.js';

/**
 * The API does not start on a master key that does not open the vault
 * (ROT-O-01): after a rotation with .env not updated, or restarted with
 * `docker compose restart`, it used to answer /readyz, fail every owner's
 * two-step sign-in with a 500, and seal what it was given under the wrong
 * key. Run here as its container runs it: server.ts, bundled as the build
 * bundles it.
 *
 * In the compose setup the API is not given the owning role at all: the
 * one-shot migrate service (`cli.mjs migrate`, bundled the same way) migrates
 * and makes the same check before the API starts, and the API starts on the
 * application role alone.
 */

const API_DIR = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = path.join(API_DIR, '..', '..', 'scripts', 'bundle.mjs');
const MIGRATIONS = path.join(API_DIR, '..', '..', 'packages', 'db', 'migrations');
const WRONG_KEY = 'the-key-after-a-rotation-that-is-not-in-use-000';

interface Ran {
  code: number | null;
  listening: boolean;
  stdout: string;
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

  /**
   * Runs a bundle with the environment given, and nothing of the test
   * runner's database settings; resolves when it exits, or when it listens
   * (and is stopped).
   */
  function run(bundle: string, args: string[], env: Record<string, string>): Promise<Ran> {
    const base = { ...process.env };
    delete base.DATABASE_URL;
    delete base.DATABASE_ADMIN_URL;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(bundleDir, bundle), ...args], {
        cwd: API_DIR,
        env: {
          ...base,
          FDV_LOCAL_VAULT_DIR: vaultDir,
          FDV_MIGRATIONS_DIR: MIGRATIONS,
          HOST: '127.0.0.1',
          LOG_LEVEL: 'info',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let listening = false;
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c: Buffer) => {
        stdout += c.toString();
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
        resolve({ code, listening, stdout, stderr });
      });
    });
  }

  async function startApi(env: Record<string, string>): Promise<Ran> {
    return run('server.mjs', [], { PORT: String(await freePort()), ...env });
  }

  beforeAll(async () => {
    h = await createHarness();
    await h.setup(); // a household, and its scope keys under TEST_MASTER
    vaultDir = await mkdtemp(path.join(tmpdir(), 'fdv-start-'));
    bundleDir = path.join(API_DIR, 'dist', `test-${randomUUID().slice(0, 8)}`);
    for (const [src, out] of [
      ['src/server.ts', 'server.mjs'],
      ['src/cli.ts', 'cli.mjs'],
    ] as const) {
      execFileSync(process.execPath, [BUNDLE, src, path.join(bundleDir, out)], {
        cwd: API_DIR,
        stdio: 'ignore',
      });
    }
  }, 120_000);
  afterAll(async () => {
    await h?.close();
    if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
  });

  it('refuses to start on a key that does not open the vault, and says what to do', async () => {
    const started = await startApi({
      DATABASE_URL: h.adminUrl,
      DATABASE_ADMIN_URL: h.adminUrl,
      FDV_MASTER_KEY: WRONG_KEY,
      // The harness migrated it: straight to the check.
      FDV_RUN_MIGRATIONS: 'false',
    });
    expect(started.listening).toBe(false);
    expect(started.code).toBe(1);
    expect(started.stderr).toMatch(/FDV_MASTER_KEY does not open this vault \(the \w+ scope key/);
    expect(started.stderr).toContain('docker compose up -d');
  }, 120_000);

  it('the migrate service refuses the same key, so the API and the worker never start on it', async () => {
    const ran = await run('cli.mjs', ['migrate'], {
      DATABASE_URL: h.appUrl,
      DATABASE_ADMIN_URL: h.adminUrl,
      FDV_MASTER_KEY: WRONG_KEY,
    });
    expect(ran.code).toBe(1);
    expect(ran.stdout).toMatch(/\[migrate\] up to date/);
    expect(ran.stderr).toMatch(/FDV_MASTER_KEY does not open this vault/);
  }, 120_000);

  it('the migrate service needs the owning role, and two different keys are refused', async () => {
    const without = await run('cli.mjs', ['migrate'], {
      DATABASE_URL: h.appUrl,
      FDV_MASTER_KEY: TEST_MASTER,
    });
    expect(without.code).toBe(1);
    expect(without.stderr).toMatch(/DATABASE_ADMIN_URL is needed/);

    const file = path.join(vaultDir, 'fdv_master_key');
    await writeFile(file, `${WRONG_KEY}\n`);
    const both = await run('cli.mjs', ['migrate'], {
      DATABASE_URL: h.appUrl,
      DATABASE_ADMIN_URL: h.adminUrl,
      FDV_MASTER_KEY: TEST_MASTER,
      FDV_MASTER_KEY_FILE: file,
    });
    expect(both.code).toBe(1);
    expect(both.stderr).toMatch(/both set, to different keys/);
    expect(both.stderr).not.toContain(TEST_MASTER);
  }, 120_000);

  it('migrates and checks with the right key, and the API then starts on the application role alone', async () => {
    // Before this release's migrate service has recorded a key, the API on
    // the application role alone cannot check it, and says so (as before).
    const before = await startApi({ DATABASE_URL: h.appUrl, FDV_MASTER_KEY: TEST_MASTER });
    expect(before.stdout).toMatch(/master key is checked by the migrate service/);
    expect(before.listening).toBe(true);

    const migrated = await run('cli.mjs', ['migrate'], {
      DATABASE_URL: h.appUrl,
      DATABASE_ADMIN_URL: h.adminUrl,
      FDV_MASTER_KEY: TEST_MASTER,
    });
    expect(migrated.stderr).toBe('');
    expect(migrated.code).toBe(0);
    expect(migrated.stdout).toMatch(/job queue schema ready/);
    expect(migrated.stdout).toMatch(/the master key opens the vault; done/);

    // No DATABASE_ADMIN_URL, as the compose file starts it: it does not
    // migrate, finds its key is the one migrate recorded, and serves.
    const started = await startApi({ DATABASE_URL: h.appUrl, FDV_MASTER_KEY: TEST_MASTER });
    expect(started.stderr).toBe('');
    expect(started.stdout).not.toMatch(/\[migrate\]/);
    expect(started.stdout).toMatch(/the one the migrate service last opened the vault with/);
    expect(started.listening).toBe(true);

    // And refuses any other key, on the application role alone too, never
    // saying either key.
    const wrong = await startApi({ DATABASE_URL: h.appUrl, FDV_MASTER_KEY: WRONG_KEY });
    expect(wrong.listening).toBe(false);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toMatch(/not the key this vault was last opened with/);
    expect(wrong.stderr).toContain('docker compose run --rm --no-deps migrate');
    expect(`${wrong.stdout}${wrong.stderr}`).not.toContain(WRONG_KEY);
    expect(`${wrong.stdout}${wrong.stderr}`).not.toContain(TEST_MASTER);
  }, 240_000);
});
