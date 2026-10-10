/**
 * Proposals off the worker's event loop (Phase 6, I2), as the API keeps
 * them off its own (5.37, N537P-01, apps/api/src/documents/proposal-pool.ts):
 * `proposeDetails` on a thread of its own, one item's words at a time, and
 * a page that takes longer than its deadline has the thread ended. The
 * worker's loop runs every other job — the pages drawn, reminders, backups —
 * so a crafted page must never hold it.
 *
 * The worker reads one item at a time, so this is the API's pool without its
 * queue: one long-lived thread for the process, started on first use, never
 * keeping the process alive, holding none of its environment and a bounded
 * heap; a page sent while another is on it waits its turn. Unlike the API —
 * which answers "nothing proposed" either way — the worker tells apart a
 * page that was too slow (the item's read fails: `too_slow`) from a thread
 * that could not be had (the item is read again later).
 *
 * The thread is started from a few lines of JavaScript that import its
 * entry: dist/proposal-worker.mjs beside the bundled worker, or — under tsx
 * and vitest — proposal-worker.ts in the source, with tsx's loader first.
 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import type { DetailProposal, LearnedClash, LearnedContext, ProposalContext } from '@fdv/shared';
import type { ProposalJob, ProposalReply } from '../proposal-worker.js';

/**
 * How long one item's words may take on the thread before it is ended: the
 * API's second (5.37), with room for a worker sharing its machine with
 * Tesseract. A real page takes a few milliseconds.
 */
export const ITEM_PROPOSAL_DEADLINE_MS = 3_000;
/** The thread's heap: the words sent are at most PROPOSAL_TEXT_MAX characters. */
const HEAP_MB = 128;
/** How long a new thread may take to load (tsx compiles the rules first). */
const START_MS = 30_000;

/** Imports the entry; first registers tsx's loader, for an entry in TypeScript. */
const BOOT = `
const { workerData } = require('node:worker_threads');
(async () => {
  if (workerData.loader) {
    const tsx = await import(workerData.loader);
    (tsx.register ?? tsx.default.register)();
  }
  await import(workerData.entry);
})();
`;

/** The thread's entry: bundled beside the worker, or the source. */
function defaultEntry(): URL {
  return import.meta.url.endsWith('.ts')
    ? new URL('../proposal-worker.ts', import.meta.url)
    : new URL('./proposal-worker.mjs', import.meta.url);
}

/** What one item's words came to. */
export type ThreadAnswer =
  /** `clash`: where a sure rule of the uploader's disagreed with the pages (I4). */
  | { state: 'done'; proposal: DetailProposal; clash?: LearnedClash }
  /** Longer than the deadline: the thread was ended, and nothing is proposed. */
  | { state: 'too_slow' }
  /** The rules failed on these words: nothing is proposed, and asking again would not help. */
  | { state: 'failed' }
  /**
   * The thread stopped while it held these words — out of memory, say
   * (the review, P-I2-1): asked again once, then not read.
   */
  | { state: 'died' }
  /** No thread could be had, or it stopped: ask again later. */
  | { state: 'unavailable' };

/** What the reading of an item needs of the thread. */
export interface ItemProposer {
  /** `learned`: the uploader's own rules (I4), applied on the thread too. */
  propose(
    text: string,
    ctx: ProposalContext,
    learned?: LearnedContext | null,
  ): Promise<ThreadAnswer>;
}

export interface ProposalThreadOptions {
  /** The thread's entry; a test gives one that stands in for the rules. */
  entry?: URL;
  deadlineMs?: number;
  /** Makes the thread; a test gives one that throws, as `new Worker` can (ERR_WORKER_INIT_FAILED). */
  createWorker?: (code: string, options: WorkerOptions) => Worker;
}

interface Running {
  id: number;
  done: (a: ThreadAnswer) => void;
  timer: NodeJS.Timeout;
}

export class ProposalThread implements ItemProposer {
  private worker: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private running: Running | null = null;
  /** One page at a time: the next waits for this. */
  private turn: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private closed = false;
  /** Threads ended at their deadline, for tests and for the curious. */
  ended = 0;

  constructor(private readonly opts: ProposalThreadOptions = {}) {}

  /** The words' proposal, or why there is none. Never rejects. */
  propose(
    text: string,
    ctx: ProposalContext,
    learned: LearnedContext | null = null,
  ): Promise<ThreadAnswer> {
    const mine = this.turn.then(() => this.one(text, ctx, learned));
    this.turn = mine.catch(() => undefined);
    return mine.catch((): ThreadAnswer => ({ state: 'unavailable' }));
  }

  /** Ends the thread; a page on it is answered `unavailable`. */
  async close(): Promise<void> {
    this.closed = true;
    const running = this.running;
    this.running = null;
    if (running) {
      clearTimeout(running.timer);
      running.done({ state: 'unavailable' });
    }
    const worker = this.drop();
    if (worker) await worker.terminate().catch(() => undefined);
  }

  private async one(
    text: string,
    ctx: ProposalContext,
    learned: LearnedContext | null,
  ): Promise<ThreadAnswer> {
    if (this.closed) return { state: 'unavailable' };
    if (!(await this.started())) return { state: 'unavailable' };
    const worker = this.worker;
    if (!worker) return { state: 'unavailable' };
    return new Promise<ThreadAnswer>((done) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        // Too long: the thread is ended, and the next page gets a new one.
        if (this.running?.id !== id) return;
        this.running = null;
        this.ended += 1;
        void this.drop()
          ?.terminate()
          .catch(() => undefined);
        done({ state: 'too_slow' });
      }, this.opts.deadlineMs ?? ITEM_PROPOSAL_DEADLINE_MS);
      timer.unref();
      this.running = { id, done, timer };
      try {
        worker.postMessage({ id, text, ctx, learned } satisfies ProposalJob);
      } catch {
        clearTimeout(timer);
        this.running = null;
        done({ state: 'unavailable' });
      }
    });
  }

  /** A thread that has said it is ready, made if there is none; false if none could be. */
  private started(): Promise<boolean> {
    if (this.worker && this.ready) return this.ready;
    this.ready = new Promise<boolean>((resolve) => {
      let made: Worker;
      try {
        const entry = this.opts.entry ?? defaultEntry();
        const loader = entry.pathname.endsWith('.ts')
          ? pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href
          : null;
        const options: WorkerOptions = {
          eval: true,
          workerData: { entry: entry.href, loader },
          execArgv: [],
          // It reads words from outside: no copy of the master key, the
          // database's address or anything else of the environment. From
          // source alone, the temp folder, where tsx keeps its cache.
          env: loader ? { TEMP: tmpdir(), TMP: tmpdir(), TMPDIR: tmpdir() } : {},
          resourceLimits: { maxOldGenerationSizeMb: HEAP_MB },
        };
        made = (this.opts.createWorker ?? ((code, o) => new Worker(code, o)))(BOOT, options);
      } catch (e) {
        process.emitWarning(
          `The proposal thread would not start: ${e instanceof Error ? e.message : String(e)}`,
          'FdvWarning',
        );
        this.drop();
        resolve(false);
        return;
      }
      const slow = setTimeout(() => {
        this.failed(made);
        resolve(false);
      }, START_MS);
      slow.unref();
      made.on('message', (m: ProposalReply) => {
        if (made !== this.worker) return;
        if ('ready' in m) {
          clearTimeout(slow);
          resolve(true);
          return;
        }
        const running = this.running;
        if (!running || running.id !== m.id) return;
        clearTimeout(running.timer);
        this.running = null;
        running.done(
          'failed' in m
            ? { state: 'failed' }
            : {
                state: 'done',
                proposal: m.proposal,
                // Said only where a sure rule disagreed with the pages (I4).
                ...(m.clash && Object.keys(m.clash).length > 0 ? { clash: m.clash } : {}),
              },
        );
      });
      const gone = () => {
        clearTimeout(slow);
        this.failed(made);
        resolve(false);
      };
      made.on('error', gone);
      made.on('exit', gone);
      // After the listeners: the thread never keeps the process alive.
      made.unref();
      this.worker = made;
    });
    return this.ready;
  }

  /** The thread failed or stopped by itself: what was on it is answered, and the next page makes another. */
  private failed(worker: Worker): void {
    if (worker !== this.worker) return;
    this.drop();
    void worker.terminate().catch(() => undefined);
    const running = this.running;
    this.running = null;
    if (running) {
      clearTimeout(running.timer);
      running.done({ state: 'died' });
    }
  }

  private drop(): Worker | null {
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    return worker;
  }
}
