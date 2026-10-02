import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * For tests that run a worker entry point as its container does: bundled
 * as `pnpm build` bundles it, into dist/ beside the worker's node_modules.
 * A bundle starts in a fraction of the time tsx takes, which matters with
 * the rest of the suite running beside it.
 */

const WORKER_DIR = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = path.join(WORKER_DIR, '..', '..', 'scripts', 'bundle.mjs');
/** Where the image puts them, and says so with FDV_MIGRATIONS_DIR. */
const MIGRATIONS = path.join(WORKER_DIR, '..', '..', 'packages', 'db', 'migrations');

export interface Bundled {
  run(
    args: string[],
    env: Record<string, string>,
    opts?: { stopWhen?: RegExp },
  ): Promise<{ code: number | null; stdout: string; stderr: string; stopped: boolean }>;
  remove(): Promise<void>;
}

export function bundleForTest(entry: string): Bundled {
  const dir = path.join(WORKER_DIR, 'dist', `test-${randomUUID().slice(0, 8)}`);
  const file = path.join(dir, `${path.basename(entry, '.ts')}.mjs`);
  execFileSync(process.execPath, [BUNDLE, entry, file], { cwd: WORKER_DIR, stdio: 'ignore' });
  return {
    run: (args, env, opts = {}) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [file, ...args], {
          cwd: WORKER_DIR,
          env: {
            ...process.env,
            FDV_MIGRATIONS_DIR: MIGRATIONS,
            FDV_MASTER_KEY_PREVIOUS: '',
            ...env,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let stopped = false;
        child.stdout.on('data', (c: Buffer) => {
          stdout += c.toString();
          if (!stopped && opts.stopWhen?.test(stdout)) {
            stopped = true;
            child.kill();
          }
        });
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
        const timer = setTimeout(() => child.kill(), 90_000);
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr, stopped });
        });
      }),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}
