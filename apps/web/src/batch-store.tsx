import {
  BATCH_MAX_FILES,
  type BatchDefaults,
  type BatchDetail,
  type BatchItemView,
} from '@fdv/shared';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { api, ApiRequestError, NetworkError } from './api.js';
import { useApp } from './app-context.js';
import { sendBatchItem, sha256Of, takenKind, type BatchSending } from './batch-upload.js';
import { sizeWords } from './screens/Incoming.js';

/**
 * The upload of many documents, held beside the app rather than its page
 * (the I1 review): leaving Add many documents does not stop it, and coming
 * back shows it — its files, its progress, and Stop — while the shell says
 * "Uploading 12 of 200" everywhere else. Signing out, or somebody else
 * signing in, stops it at once; closing the tab while files are still to
 * send asks first. Its files are sent one after another, each with an
 * Idempotency-Key kept for it until it arrives, so a file sent again after
 * its answer was lost is the item it made, never a second.
 */

/** One file chosen, and what became of it. */
export interface Chosen {
  key: string;
  file: File;
  state: 'ready' | 'refused' | 'sending' | 'sent' | 'skipped' | 'failed';
  /** Why it was not sent, in the vault's words or the page's. */
  reason?: string;
  /** How much of it has gone. */
  sent: number;
  /** Its Idempotency-Key, kept until it arrives. */
  idem: string;
}

/** Choosing; the batch being made; files going; stopped (asked, or by what happened); done. */
export type UploadPhase = 'choosing' | 'making' | 'sending' | 'stopped' | 'done';

export interface Upload {
  chosen: Chosen[];
  phase: UploadPhase;
  /** The batch the files go into, once made or carried on. */
  batch: { id: string; label: string } | null;
  /** Carrying on a batch made before (`?batch=`), rather than a new one. */
  carryOn: boolean;
  /** What the batch chose for all of them, said while and after the files go. */
  defaults: BatchDefaults | null;
  /** Why it stopped by itself, and when to try again. */
  problem: string | null;
  /** Said politely: as it starts, as each file arrives, as it stops. */
  said: string;
  /** Stop asked: heard after the file being sent. */
  stopping: boolean;
  /** Finished where its page saw it end: a new visit to the page starts a new one. */
  seen: boolean;
  /** Bumped as what waits in the Inbox changes: the shell counts it again then. */
  changed: number;
}

const EMPTY: Upload = {
  chosen: [],
  phase: 'choosing',
  batch: null,
  carryOn: false,
  defaults: null,
  problem: null,
  said: '',
  stopping: false,
  seen: true,
  changed: 0,
};

/** How far it has got: what is to send, what arrived, what was not sent, what waits. */
export function progressOf(u: Upload) {
  const toSend = u.chosen.filter((c) => c.state !== 'refused');
  return {
    total: toSend.length,
    arrived: u.chosen.filter((c) => c.state === 'sent' || c.state === 'skipped').length,
    refused: u.chosen.filter((c) => c.state === 'refused').length,
    waiting: u.chosen.filter((c) => c.state === 'ready' || c.state === 'failed').length,
  };
}

export const running = (u: Upload) => u.phase === 'making' || u.phase === 'sending';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A file and its size and when it was changed, and where it was under a folder: chosen once. */
const fileKey = (f: File) =>
  `${(f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name}:${f.size}:${f.lastModified}`;

type WithToken = <T>(fn: (token: string) => Promise<T>) => Promise<T | null>;

/**
 * What a refusal means for the rest (the I1 review). The vault busy, or no
 * answer at all — a 429, a 408, a 5xx, the connection — stops the upload,
 * and the file waits to be sent again, with when. A batch that takes no
 * more — removed (404), ended, full, or the uploader no longer adding —
 * stops it for good: the rest are not offered again. Only a refusal of
 * that one file (too big, a kind the vault does not take, a detail it
 * refused) lets the rest carry on.
 */
type Outcome =
  | { kind: 'stopped' }
  | { kind: 'again'; file: string; all: string }
  | { kind: 'batch'; why: string }
  | { kind: 'file'; why: string };

function outcomeOf(err: unknown): Outcome {
  if (err instanceof DOMException && err.name === 'AbortError') return { kind: 'stopped' };
  if (err instanceof NetworkError || !(err instanceof ApiRequestError)) {
    return {
      kind: 'again',
      file: 'The connection dropped: it can be sent again.',
      all: 'The connection to the vault dropped. Send the rest again when it is back.',
    };
  }
  if (
    err.status === 408 ||
    err.status === 429 ||
    err.status >= 500 ||
    err.code === 'upload_in_progress'
  ) {
    const wait = err.retryAfterSeconds;
    return {
      kind: 'again',
      file: 'The vault was busy: it can be sent again.',
      all: `${err.message} ${
        wait !== undefined
          ? `Send the rest in about ${plural(Math.max(1, Math.ceil(wait)), 'second')}.`
          : 'Send the rest again in a moment.'
      }`,
    };
  }
  if (err.status === 404) {
    return {
      kind: 'batch',
      why: 'This batch is not there any more: it was removed. Start a new batch for the rest.',
    };
  }
  if (err.status === 403 || err.code === 'batch_ended' || err.code === 'batch_full') {
    return { kind: 'batch', why: err.message };
  }
  return { kind: 'file', why: err.message };
}

/** How often, at most, the shell is told to count again while files arrive. */
const COUNT_EVERY_MS = 10_000;

export class BatchUploads {
  private state: Upload = EMPTY;
  private readonly listeners = new Set<() => void>();
  private watching = 0;
  private lastVisit: string | null = null;
  private current: BatchSending | null = null;
  /** One run at a time: Start pressed twice, or Send the rest, makes one batch and sends once. */
  private busy = false;
  private stopAsked = false;
  private aborted = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = (): Upload => this.state;

  private set(change: Partial<Upload> | ((was: Upload) => Partial<Upload>)): void {
    const patch = typeof change === 'function' ? change(this.state) : change;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private update(key: string, change: Partial<Chosen>): void {
    this.set((was) => ({
      chosen: was.chosen.map((c) => (c.key === key ? { ...c, ...change } : c)),
    }));
  }

  /** What waits in the Inbox has changed: the shell counts it again. */
  readonly changed = (): void => this.set((was) => ({ changed: was.changed + 1 }));

  /**
   * Add many documents opened (a visit is a new location): an upload on
   * its way is shown; one that finished while nobody looked is shown once;
   * otherwise the page starts afresh. Watched while it is open.
   */
  opened(visit: string): () => void {
    if (this.lastVisit !== visit) {
      this.lastVisit = visit;
      const s = this.state;
      if (running(s)) {
        // Shown as it is.
      } else if ((s.phase === 'stopped' || s.phase === 'done') && !s.seen) {
        this.set({ seen: true });
      } else {
        this.reset();
      }
    }
    this.watching += 1;
    return () => {
      this.watching -= 1;
    };
  }

  /** A new upload: nothing chosen. Never while one is on its way. */
  reset(): void {
    if (running(this.state) || this.busy) return;
    this.set({ ...EMPTY, changed: this.state.changed });
  }

  /** Files chosen, checked as the vault would check them: refused here, with why, or ready. */
  choose(files: File[], opts: { limit: number; already: number }): void {
    this.set((was) => {
      const keys = new Set(was.chosen.map((c) => c.key));
      const next = [...was.chosen];
      for (const file of files) {
        const key = fileKey(file);
        if (keys.has(key)) continue;
        keys.add(key);
        const room =
          BATCH_MAX_FILES - opts.already - next.filter((c) => c.state !== 'refused').length;
        const reason = !takenKind(file)
          ? 'Not a kind the vault takes: PDFs, photos and scans, Word and Excel files.'
          : file.size > opts.limit
            ? `Too big: over ${sizeWords(opts.limit)}, the most this vault takes for one file.`
            : room <= 0
              ? `A batch holds ${BATCH_MAX_FILES} files: start another batch for this one.`
              : null;
        next.push({
          key,
          file,
          state: reason ? 'refused' : 'ready',
          sent: 0,
          idem: crypto.randomUUID(),
          ...(reason ? { reason } : {}),
        });
      }
      return { chosen: next };
    });
  }

  takeOff(key: string): void {
    if (this.state.phase !== 'choosing') return;
    this.set((was) => ({ chosen: was.chosen.filter((c) => c.key !== key) }));
  }

  takeAllOff(): void {
    if (this.state.phase !== 'choosing') return;
    this.set({ chosen: [] });
  }

  /**
   * Start: the batch made with what was chosen for all of them, or the one
   * carried on, then the files. Pressed twice, it starts once.
   */
  async start(
    withToken: WithToken,
    how:
      | { make: { name: string | null; defaults: Partial<BatchDefaults> }; shown: BatchDefaults }
      | { carry: BatchDetail; label: string },
  ): Promise<void> {
    if (this.busy || this.state.phase !== 'choosing') return;
    this.busy = true;
    try {
      let target: { id: string; label: string };
      let there: BatchItemView[] = [];
      if ('carry' in how) {
        target = { id: how.carry.id, label: how.label };
        there = how.carry.items;
        this.set({ batch: target, carryOn: true, defaults: how.carry.defaults, problem: null });
      } else {
        this.set({ phase: 'making', problem: null, said: 'Making the batch.' });
        let made: BatchDetail | null;
        try {
          made = await withToken((t) =>
            api.createBatch(t, {
              ...(how.make.name ? { name: how.make.name } : {}),
              defaults: how.make.defaults,
            }),
          );
        } catch (err) {
          this.set({
            phase: 'choosing',
            said: '',
            problem: err instanceof ApiRequestError ? err.message : UNREACHABLE_WORDS,
          });
          return;
        }
        if (this.aborted) {
          this.forget();
          return;
        }
        if (!made) {
          this.set({ phase: 'choosing', said: '' });
          return;
        }
        target = { id: made.id, label: made.name ?? labelOfDay(made.created_at) };
        this.set({ batch: target, carryOn: false, defaults: { ...how.shown, ...made.defaults } });
      }
      await this.run(withToken, target, there);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Send the rest (after Stop, or after the vault was busy or the
   * connection dropped): into the same batch, asked first what is in it
   * now — a file whose answer was lost may have arrived — and what is
   * there is not sent again.
   */
  async sendRest(withToken: WithToken): Promise<void> {
    const target = this.state.batch;
    if (this.busy || running(this.state) || !target) return;
    this.busy = true;
    try {
      this.set({ phase: 'sending', problem: null, said: 'Asking the batch what arrived.' });
      let there: BatchItemView[] = [];
      try {
        there = (await withToken((t) => api.batch(t, target.id)))?.items ?? [];
      } catch {
        // Not asked: the keys still make a file sent twice the item it made.
      }
      await this.run(withToken, target, there);
    } finally {
      this.busy = false;
    }
  }

  /** Stop after the file being sent. */
  stop(): void {
    if (!running(this.state)) return;
    this.stopAsked = true;
    this.set({ stopping: true, said: 'Stopping after this file.' });
  }

  /** Signed out, or somebody else signed in: stopped now, the file going stopped too, and forgotten. */
  abort(): void {
    this.aborted = true;
    this.stopAsked = true;
    this.current?.stop();
    if (!this.busy) this.forget();
  }

  private forget(): void {
    this.aborted = false;
    this.stopAsked = false;
    this.current = null;
    this.state = { ...EMPTY, changed: this.state.changed + 1 };
    for (const l of this.listeners) l();
  }

  /**
   * One file after another into the batch. A file already in it — the
   * same bytes, by SHA-256, against every item there — is not sent again.
   */
  private async run(
    withToken: WithToken,
    target: { id: string; label: string },
    there: BatchItemView[],
  ): Promise<void> {
    if (this.aborted) {
      this.forget();
      return;
    }
    this.stopAsked = false;
    const todo = this.state.chosen.filter((c) => c.state === 'ready' || c.state === 'failed');
    this.set({
      phase: 'sending',
      stopping: false,
      problem: null,
      said: `Sending ${plural(todo.length, 'file')}.`,
    });
    const sizes = new Set(there.map((i) => i.byte_size));
    let done = 0;
    let stoppedBy: string | null = null;
    let counted = Date.now();
    for (const c of todo) {
      if (this.stopAsked || this.aborted) break;
      if (sizes.has(c.file.size)) {
        const hash = await sha256Of(c.file).catch(() => null);
        if (hash && there.some((i) => i.sha256 === hash)) {
          this.update(c.key, { state: 'skipped', reason: 'Already in this batch.' });
          done += 1;
          continue;
        }
      }
      if (this.stopAsked || this.aborted) break;
      this.update(c.key, { state: 'sending', sent: 0 });
      try {
        const item = await withToken((t) => {
          const sending = sendBatchItem(
            t,
            target.id,
            c.file,
            (sent) => this.update(c.key, { sent }),
            c.idem,
          );
          this.current = sending;
          return sending.done;
        });
        this.current = null;
        if (!item) {
          // Signed out on the way: nothing more goes.
          this.update(c.key, { state: 'ready', sent: 0 });
          break;
        }
        this.update(c.key, { state: 'sent', sent: c.file.size });
        done += 1;
        this.set({ said: `${done} of ${todo.length} sent.` });
        if (Date.now() - counted >= COUNT_EVERY_MS) {
          counted = Date.now();
          this.changed();
        }
      } catch (err) {
        this.current = null;
        const out = outcomeOf(err);
        if (out.kind === 'stopped') {
          this.update(c.key, { state: 'ready', sent: 0 });
          break;
        }
        if (out.kind === 'again') {
          this.update(c.key, { state: 'failed', sent: 0, reason: out.file });
          stoppedBy = out.all;
          break;
        }
        this.update(c.key, { state: 'refused', reason: out.why });
        if (out.kind === 'batch') {
          // Nothing more goes in this batch: the rest are not offered again.
          this.set((was) => ({
            chosen: was.chosen.map((x) =>
              x.state === 'ready' || x.state === 'failed'
                ? { ...x, state: 'refused' as const, reason: 'Not sent: the batch takes no more.' }
                : x,
            ),
          }));
          stoppedBy = out.why;
          break;
        }
      }
    }
    if (this.aborted) {
      this.forget();
      return;
    }
    const stopped = this.stopAsked || stoppedBy !== null || progressOf(this.state).waiting > 0;
    this.set((was) => ({
      phase: stopped ? 'stopped' : 'done',
      problem: stoppedBy,
      stopping: false,
      said: this.stopAsked ? 'Stopped. What arrived is in your Inbox.' : '',
      seen: this.watching > 0,
      changed: was.changed + 1,
    }));
    this.stopAsked = false;
  }
}

const UNREACHABLE_WORDS =
  "We can't reach the vault right now. Check that it is running, then reload.";

/** "Upload of 6 Oct": a batch with no name, called by the day it was made. */
export const labelOfDay = (iso: string) =>
  `Upload of ${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;

const Ctx = createContext<BatchUploads | null>(null);

/**
 * Beside AppProvider: the upload lives as long as the app does. A change of
 * who is signed in stops it; while files are still to send, closing the tab
 * asks first.
 */
export function BatchUploadProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new BatchUploads());
  const { authVersion } = useApp();
  const signedInAs = useRef(authVersion);
  useEffect(() => {
    if (signedInAs.current === authVersion) return;
    signedInAs.current = authVersion;
    store.abort();
  }, [authVersion, store]);
  const sending = useSyncExternalStore(store.subscribe, () => running(store.get()));
  useEffect(() => {
    if (!sending) return;
    const ask = (e: BeforeUnloadEvent) => {
      // Files still to send: the browser asks before the tab goes.
      e.preventDefault();
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [sending]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

/** The upload as it is now, and what changes it. */
export function useUploads(): [Upload, BatchUploads] {
  const store = useContext(Ctx);
  if (!store) throw new Error('useUploads outside BatchUploadProvider');
  const state = useSyncExternalStore(store.subscribe, store.get);
  return [state, store];
}
