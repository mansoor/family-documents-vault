import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { proposeDetails, type ProposalContext } from '@fdv/shared';
import { TUNED, FIXTURE_KINDS, FIXTURE_PEOPLE } from '@fdv/shared/testdata';
import { describe, expect, it } from 'vitest';
import { ProposalThread } from './proposal-thread.js';

/**
 * The worker's proposal thread (Phase 6, I2): `proposeDetails` off the
 * worker's event loop, as the API keeps it off its own (5.37). A page that
 * takes too long has its thread ended — `too_slow` — while the loop runs
 * on; the next page gets a new thread; a thread that cannot be had is
 * `unavailable`, never a rejection; and it holds none of the environment.
 */

const WORKER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const BUNDLE = path.join(WORKER_DIR, '..', '..', 'scripts', 'bundle.mjs');
const PASSPORT = (TUNED[0] as { text: string }).text;
const CTX: ProposalContext = { types: FIXTURE_KINDS, people: FIXTURE_PEOPLE, dateOrder: 'dmy' };

/**
 * Stands in for the rules: answers at once — unless the page says SPIN (it
 * never answers), EXIT (it stops), THROW (the rules failed) or ENV (it
 * answers with the names in its environment).
 */
const CANNED = { type_key: { value: 'passport', confidence: 0.97, cue: 'kind_words' } };
const STAND_IN = new URL(
  `data:text/javascript,${encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (job) => {
  if (job.text.includes('SPIN')) for (;;) {}
  if (job.text.includes('EXIT')) process.exit(1);
  if (job.text.includes('THROW')) return parentPort.postMessage({ id: job.id, failed: true });
  const proposal = job.text.includes('ENV') ? { env: Object.keys(process.env) } : ${JSON.stringify(CANNED)};
  parentPort.postMessage({ id: job.id, proposal });
});
parentPort.postMessage({ ready: true });
`)}`,
);

describe('the worker’s proposal thread (I2)', () => {
  it('proposes on its own thread what proposeDetails proposes', async () => {
    const thread = new ProposalThread();
    try {
      const got = await thread.propose(PASSPORT, CTX);
      expect(got).toEqual({ state: 'done', proposal: proposeDetails(PASSPORT, CTX) });
      expect(await thread.propose(PASSPORT, CTX)).toEqual(got);
      expect(thread.ended).toBe(0);
    } finally {
      await thread.close();
    }
  }, 60_000);

  it('a page that takes too long is ended at its deadline — the loop free meanwhile — and the next gets a new thread', async () => {
    const thread = new ProposalThread({ entry: STAND_IN, deadlineMs: 400 });
    try {
      expect(await thread.propose('a page', CTX)).toEqual({ state: 'done', proposal: CANNED });
      const started = Date.now();
      let answered = false;
      const slow = thread.propose('SPIN', CTX).then((a) => {
        answered = true;
        return a;
      });
      // Pages wait their turn: one sent meanwhile is answered after.
      const queued = thread.propose('a page', CTX);
      const ticked = await new Promise<number>((r) =>
        setTimeout(() => r(Date.now() - started), 50),
      );
      expect(ticked).toBeLessThan(300);
      expect(answered).toBe(false);
      expect(await slow).toEqual({ state: 'too_slow' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(380);
      expect(thread.ended).toBe(1);
      expect(await queued).toEqual({ state: 'done', proposal: CANNED });
    } finally {
      await thread.close();
    }
  }, 30_000);

  it('rules that fail are `failed`; a thread that stops, or cannot be made, is `unavailable` — never a rejection', async () => {
    const thread = new ProposalThread({ entry: STAND_IN });
    try {
      expect(await thread.propose('THROW', CTX)).toEqual({ state: 'failed' });
      expect(await thread.propose('EXIT', CTX)).toEqual({ state: 'unavailable' });
      expect(await thread.propose('a page', CTX)).toEqual({ state: 'done', proposal: CANNED });
    } finally {
      await thread.close();
    }
    let calls = 0;
    const broken = new ProposalThread({
      entry: STAND_IN,
      createWorker: (code: string, options: WorkerOptions) => {
        calls += 1;
        if (calls === 1) throw new Error('Worker initialization failure: 11');
        return new Worker(code, options);
      },
    });
    try {
      await expect(broken.propose('a page', CTX)).resolves.toEqual({ state: 'unavailable' });
      // The next page tries again.
      expect(await broken.propose('a page', CTX)).toEqual({ state: 'done', proposal: CANNED });
    } finally {
      await broken.close();
    }
    const missing = new ProposalThread({
      entry: pathToFileURL(path.join(WORKER_DIR, 'no-such-entry.mjs')),
    });
    try {
      await expect(missing.propose('a page', CTX)).resolves.toEqual({ state: 'unavailable' });
    } finally {
      await missing.close();
    }
  }, 60_000);

  it('holds none of the worker’s environment: no master key, no database address', async () => {
    process.env.FDV_TEST_SECRET_FOR_THREAD = 'not for the thread';
    const thread = new ProposalThread({ entry: STAND_IN });
    try {
      const got = await thread.propose('ENV', CTX);
      expect(got.state).toBe('done');
      expect((got as unknown as { proposal: { env: string[] } }).proposal.env).toEqual([]);
    } finally {
      delete process.env.FDV_TEST_SECRET_FOR_THREAD;
      await thread.close();
    }
  }, 30_000);

  it('bundled, as the image runs it: the thread is dist/proposal-worker.mjs beside the worker, and never keeps it alive', async () => {
    const dir = path.join(WORKER_DIR, 'dist', `test-proposals-${randomUUID().slice(0, 8)}`);
    await mkdir(dir, { recursive: true });
    try {
      const mod = path.relative(dir, path.join(WORKER_DIR, 'src', 'jobs', 'proposal-thread.js'));
      await writeFile(
        path.join(dir, 'entry.ts'),
        [
          `import { readFileSync } from 'node:fs';`,
          `import { ProposalThread } from '${mod.split(path.sep).join('/')}';`,
          `const { text, ctx } = JSON.parse(readFileSync(new URL('./input.json', import.meta.url), 'utf8'));`,
          `const awake = setInterval(() => undefined, 1000);`,
          `const thread = new ProposalThread();`,
          `console.log(JSON.stringify(await thread.propose(text, ctx)));`,
          `clearInterval(awake);`,
        ].join('\n'),
      );
      await writeFile(path.join(dir, 'input.json'), JSON.stringify({ text: PASSPORT, ctx: CTX }));
      const here = path.relative(WORKER_DIR, dir).split(path.sep).join('/');
      for (const [entry, out] of [
        [`${here}/entry.ts`, 'main.mjs'],
        ['src/proposal-worker.ts', 'proposal-worker.mjs'],
      ] as const) {
        execFileSync(process.execPath, [BUNDLE, entry, path.join(dir, out)], {
          cwd: WORKER_DIR,
          stdio: 'ignore',
        });
      }
      const out = execFileSync(process.execPath, [path.join(dir, 'main.mjs')], {
        cwd: WORKER_DIR,
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(JSON.parse(out.trim())).toEqual({
        state: 'done',
        proposal: proposeDetails(PASSPORT, CTX),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
