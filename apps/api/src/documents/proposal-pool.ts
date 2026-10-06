/**
 * Proposals off the event loop (5.37, N537P-01). `proposeDetails` is
 * linear in what it reads, but a crafted page found three ways in two
 * rounds to cost the API seconds of its one thread — every request
 * waiting behind it. So it runs on a worker thread of its own, one page
 * at a time, and a page that takes longer than its deadline has the thread
 * ended: it is answered with no proposal (`unavailable`), never a 500, and
 * the next page gets a new thread.
 *
 * One long-lived thread for the process, started on first use, with a
 * short queue: a page that finds the queue full is answered with none at
 * once. The thread never keeps the process alive, and holds none of its
 * environment.
 *
 * The thread is started from a few lines of JavaScript that import its
 * entry: dist/proposal-worker.mjs beside the bundled server, or — under tsx
 * and vitest, where this file is TypeScript — proposal-worker.ts beside it,
 * with tsx's loader registered first.
 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import type { DetailProposal, ProposalContext } from '@fdv/shared';
import type { ProposalJob, ProposalReply } from './proposal-worker.js';

/** How long one page may take on the thread before the thread is ended. */
export const PROPOSAL_DEADLINE_MS = 1_000;
/** Pages that may wait for the thread; one more is answered with no proposal at once. */
export const PROPOSAL_QUEUE = 8;
/** The thread's heap: a page's text is at most PAGES_TEXT_MAX characters. */
const HEAP_MB = 128;
/** How long a new thread may take to load (tsx compiles the rules first). */
const START_MS = 30_000;
/** After a thread that would not start, how long before another is tried. */
const REST_MS = 10_000;

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

/** The thread's entry: bundled beside the server, or the source beside this file. */
function defaultEntry(): URL {
  return import.meta.url.endsWith('.ts')
    ? new URL('./proposal-worker.ts', import.meta.url)
    : new URL('./proposal-worker.mjs', import.meta.url);
}

export interface ProposalPoolOptions {
  /** The thread's entry; a test gives one that stands in for the rules. */
  entry?: URL;
  deadlineMs?: number;
  queue?: number;
  /** After a thread that would not start, how long before another is tried. */
  restMs?: number;
  /**
   * Makes the thread. A test gives one that throws, as `new Worker` does
   * under thread, process or memory pressure (ERR_WORKER_INIT_FAILED).
   */
  createWorker?: (code: string, options: WorkerOptions) => Worker;
}

/** What a caller needs of the pool: a page in, its proposal or null out. */
export interface Proposals {
  propose(text: string, ctx: ProposalContext): Promise<DetailProposal | null>;
}

interface Waiting {
  id: number;
  text: string;
  ctx: ProposalContext;
  done: (proposal: DetailProposal | null) => void;
}

export class ProposalPool implements Proposals {
  private worker: Worker | null = null;
  private ready = false;
  private waiting: Waiting[] = [];
  private running: { job: Waiting; timer: NodeJS.Timeout } | null = null;
  private starting: NodeJS.Timeout | null = null;
  private restUntil = 0;
  private nextId = 1;
  private closed = false;
  /** Threads ended at their deadline, for tests and for the curious. */
  ended = 0;

  constructor(private readonly opts: ProposalPoolOptions = {}) {}

  /**
   * The page's proposal; null when it took too long, the queue was full, or
   * the thread failed or could not be made. Never rejects.
   */
  propose(text: string, ctx: ProposalContext): Promise<DetailProposal | null> {
    if (this.closed || Date.now() < this.restUntil) return Promise.resolve(null);
    if (this.waiting.length >= (this.opts.queue ?? PROPOSAL_QUEUE)) return Promise.resolve(null);
    return new Promise((done) => {
      this.waiting.push({ id: this.nextId++, text, ctx, done });
      this.pump();
    });
  }

  /** Ends the thread; the page on it, and anything waiting, is answered with no proposal. */
  async close(): Promise<void> {
    this.closed = true;
    const running = this.running;
    this.running = null;
    if (running) {
      clearTimeout(running.timer);
      running.job.done(null);
    }
    for (const job of this.waiting.splice(0)) job.done(null);
    const worker = this.drop();
    if (worker) await worker.terminate();
  }

  /** The next page to the thread, starting one if there is none. Never throws, whoever calls. */
  private pump(): void {
    if (this.closed || this.running || this.waiting.length === 0) return;
    if (!this.worker) {
      this.start();
      return;
    }
    if (!this.ready) return;
    const job = this.waiting.shift() as Waiting;
    const timer = setTimeout(() => this.overdue(), this.opts.deadlineMs ?? PROPOSAL_DEADLINE_MS);
    timer.unref();
    this.running = { job, timer };
    try {
      this.worker.postMessage({ id: job.id, text: job.text, ctx: job.ctx } satisfies ProposalJob);
    } catch {
      // A page that cannot be sent is answered with none; the next may be.
      clearTimeout(timer);
      this.running = null;
      job.done(null);
      this.pump();
    }
  }

  /**
   * A new thread. Making one can throw — ERR_WORKER_INIT_FAILED when the
   * machine is short of threads, processes or memory (R2-01) — and it is
   * called from a request, from the deadline's timer and from the thread's
   * own events: a throw is answered here, as a thread that would not start,
   * never passed on to crash the API or leave pages waiting for good.
   */
  private start(): void {
    let worker: Worker | null = null;
    try {
      const entry = this.opts.entry ?? defaultEntry();
      const loader = entry.pathname.endsWith('.ts')
        ? pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href
        : null;
      const options: WorkerOptions = {
        eval: true,
        workerData: { entry: entry.href, loader },
        execArgv: [],
        // It reads text from outside: no copy of the master key, the
        // database's address or anything else of the environment (R2-03).
        // From source alone, the temp folder, where tsx keeps its cache:
        // Windows finds it only from the environment.
        env: loader ? { TEMP: tmpdir(), TMP: tmpdir(), TMPDIR: tmpdir() } : {},
        resourceLimits: { maxOldGenerationSizeMb: HEAP_MB },
      };
      const made = (this.opts.createWorker ?? ((code, o) => new Worker(code, o)))(BOOT, options);
      worker = made;
      made.on('message', (m: ProposalReply) => {
        if (made !== this.worker) return;
        if ('ready' in m) {
          if (this.starting) clearTimeout(this.starting);
          this.starting = null;
          this.ready = true;
          this.pump();
          return;
        }
        const running = this.running;
        if (!running || running.job.id !== m.id) return;
        clearTimeout(running.timer);
        this.running = null;
        running.job.done(m.proposal);
        this.pump();
      });
      made.on('error', (e) => this.failed(made, e.message));
      made.on('exit', () => this.failed(made, 'it stopped'));
      // After the listeners, which hold the thread open as they are added
      // (R2-02): the thread never keeps the process alive.
      made.unref();
      this.worker = made;
      this.ready = false;
      this.starting = setTimeout(() => this.failed(made, 'it did not start in time'), START_MS);
      this.starting.unref();
    } catch (e) {
      if (worker) void worker.terminate().catch(() => undefined);
      this.drop();
      this.unstarted(e instanceof Error ? e.message : String(e));
    }
  }

  /** The page took too long: its thread is ended, and the next page gets a new one. */
  private overdue(): void {
    const running = this.running;
    this.running = null;
    running?.job.done(null);
    this.ended += 1;
    void this.drop()
      ?.terminate()
      .catch(() => undefined);
    this.pump();
  }

  /** The thread failed or stopped by itself. */
  private failed(worker: Worker, why: string): void {
    if (worker !== this.worker) return;
    const started = this.ready;
    this.drop();
    void worker.terminate().catch(() => undefined);
    const running = this.running;
    this.running = null;
    if (running) {
      clearTimeout(running.timer);
      running.job.done(null);
    }
    if (!started) {
      this.unstarted(why);
      return;
    }
    this.pump();
  }

  /** A thread that would not start: say so once, answer what waits, and rest a while. */
  private unstarted(why: string): void {
    process.emitWarning(`The proposal thread would not start: ${why}`, 'FdvWarning');
    for (const job of this.waiting.splice(0)) job.done(null);
    this.restUntil = Date.now() + (this.opts.restMs ?? REST_MS);
  }

  private drop(): Worker | null {
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    if (this.starting) clearTimeout(this.starting);
    this.starting = null;
    return worker;
  }
}

/** The process's one pool: its thread is started by the first page proposed for. */
export const proposalPool = new ProposalPool();
