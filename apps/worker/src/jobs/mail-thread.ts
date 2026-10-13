/**
 * Mail read off the worker's event loop (0.8.0, S4): a household mailbox's
 * mail is untrusted input from anybody who knows its address, so its MIME is
 * read on a thread of its own (mail-parse-worker.ts), as the proposal
 * thread reads an item's words (proposal-thread.ts) and a Word file's XML is
 * turned into text (word-text.ts): one long-lived thread for the process,
 * started on first use, never keeping the process alive, holding none of
 * its environment (no master key, no database address, no mailbox
 * password) and a bounded heap; one mail at a time, and a mail that takes
 * longer than its deadline has the thread ended. What comes back is plain
 * data: an address, a Message-ID, codes, a verdict, and each attachment's
 * name, kind, size and bytes.
 *
 * The worker tells apart a mail the thread could not read (`failed`: its
 * MIME is broken — the parser threw), one too slow or that took the thread
 * down (`too_slow`, `died`: never asked again), and a thread that could not
 * be had (`unavailable`: the mail is tried again later).
 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import type { MailHead, MailJob, MailPart, MailReply, MailSkipped } from '../mail-parse-worker.js';

export type { MailHead, MailSkipped };

/** An attachment, as the worker has it: its bytes a Buffer. */
export type ReadPart = Omit<MailPart, 'content'> & { content: Buffer | null };

/** How long a mail's header may take on the thread. */
export const HEAD_DEADLINE_MS = 10_000;
/** How long a whole mail may take: up to 50 MB of MIME. */
export const MESSAGE_DEADLINE_MS = 60_000;
/** The thread's heap: a mail's headers and structure; its bytes are buffers, bounded by the size limit. */
const HEAP_MB = 256;
/** How long a new thread may take to load (tsx compiles first, under the tests). */
const START_MS = 30_000;

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
    ? new URL('../mail-parse-worker.ts', import.meta.url)
    : new URL('./mail-parse-worker.mjs', import.meta.url);
}

/** What a mail came to. */
export type MailAnswer =
  | { state: 'done'; head: MailHead; parts: ReadPart[]; skipped: MailSkipped }
  /** The parser could not read it: broken MIME. */
  | { state: 'failed' }
  /** Longer than its deadline: the thread was ended. */
  | { state: 'too_slow' }
  /** The thread stopped while it held this mail (out of memory, say). */
  | { state: 'died' }
  /** No thread could be had: ask again later. */
  | { state: 'unavailable' };

/** What the mailbox's runner needs of the thread. */
export interface MailReader {
  head(bytes: Buffer, authservId: string | null): Promise<MailAnswer>;
  message(bytes: Buffer, authservId: string | null, maxPartBytes: number): Promise<MailAnswer>;
  close(): Promise<void>;
}

export interface MailThreadOptions {
  entry?: URL;
  headDeadlineMs?: number;
  messageDeadlineMs?: number;
}

interface Running {
  id: number;
  done: (a: MailAnswer) => void;
  timer: NodeJS.Timeout;
}

/** The bytes as the thread's own: copied once, then handed over. */
const own = (b: Buffer) => new Uint8Array(b);

export class MailThread implements MailReader {
  private worker: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private running: Running | null = null;
  private turn: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private closed = false;
  /** Threads ended at their deadline. */
  ended = 0;

  constructor(private readonly opts: MailThreadOptions = {}) {}

  head(bytes: Buffer, authservId: string | null): Promise<MailAnswer> {
    return this.queue(
      (id) => ({ id, kind: 'head', bytes: own(bytes), authservId }),
      this.opts.headDeadlineMs ?? HEAD_DEADLINE_MS,
    );
  }

  message(bytes: Buffer, authservId: string | null, maxPartBytes: number): Promise<MailAnswer> {
    return this.queue(
      (id) => ({ id, kind: 'message', bytes: own(bytes), authservId, maxPartBytes }),
      this.opts.messageDeadlineMs ?? MESSAGE_DEADLINE_MS,
    );
  }

  /** Ends the thread; a mail on it is answered `unavailable`. */
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

  private queue(make: (id: number) => MailJob, deadlineMs: number): Promise<MailAnswer> {
    const mine = this.turn.then(() => this.one(make, deadlineMs));
    this.turn = mine.catch(() => undefined);
    return mine.catch((): MailAnswer => ({ state: 'unavailable' }));
  }

  private async one(make: (id: number) => MailJob, deadlineMs: number): Promise<MailAnswer> {
    if (this.closed) return { state: 'unavailable' };
    if (!(await this.started())) return { state: 'unavailable' };
    const worker = this.worker;
    if (!worker) return { state: 'unavailable' };
    return new Promise<MailAnswer>((done) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.running?.id !== id) return;
        this.running = null;
        this.ended += 1;
        void this.drop()
          ?.terminate()
          .catch(() => undefined);
        done({ state: 'too_slow' });
      }, deadlineMs);
      timer.unref();
      this.running = { id, done, timer };
      try {
        const job = make(id);
        worker.postMessage(job, [job.bytes.buffer as ArrayBuffer]);
      } catch {
        clearTimeout(timer);
        this.running = null;
        done({ state: 'unavailable' });
      }
    });
  }

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
          // Mail from outside: nothing of the environment. From source alone,
          // the temp folder, where tsx keeps its cache.
          env: loader ? { TEMP: tmpdir(), TMP: tmpdir(), TMPDIR: tmpdir() } : {},
          resourceLimits: { maxOldGenerationSizeMb: HEAP_MB },
        };
        made = new Worker(BOOT, options);
      } catch {
        this.drop();
        resolve(false);
        return;
      }
      const slow = setTimeout(() => {
        this.failed(made);
        resolve(false);
      }, START_MS);
      slow.unref();
      made.on('message', (m: MailReply) => {
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
        if ('failed' in m) {
          running.done({ state: 'failed' });
          return;
        }
        const parts: ReadPart[] = (m.parts ?? []).map((p) => ({
          ...p,
          content: p.content
            ? Buffer.from(p.content.buffer, p.content.byteOffset, p.content.byteLength)
            : null,
        }));
        running.done({
          state: 'done',
          head: m.head,
          parts,
          skipped: m.skipped ?? { tooMany: 0, tooDeep: 0 },
        });
      });
      const gone = () => {
        clearTimeout(slow);
        this.failed(made);
        resolve(false);
      };
      made.on('error', gone);
      made.on('exit', gone);
      made.unref();
      this.worker = made;
    });
    return this.ready;
  }

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
