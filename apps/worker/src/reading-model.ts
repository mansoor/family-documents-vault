/**
 * The vault's reading model's weights (0.9.0, R2): a file of their own
 * beside the worker — reading-model.bin in the source, copied beside the
 * bundle as dist/reading-model.bin — read once by the proposal thread, and
 * used only if it is the very file this release was built with: its
 * SHA-256 is held here, and anything else (a file missing, cut short,
 * changed) is not used, with a warning, and the rules read alone.
 *
 * Made by scripts/train-reading-model.mjs (seed 1, the defaults); see
 * docs/smart-exit.md, "Reading model".
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseReadingModel, READING_MODEL_RECORD_MS, type ReadingModel } from '@fdv/shared';

/** The weights file's SHA-256, as trained. */
export const READING_MODEL_SHA256 =
  '4150533f894d944fbfe6fc8bfcead6468875a3000c061034034c1fec07c08ae1';
/** The most the file may be: it is under a megabyte. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Where the weights are: beside the bundle, or the source. */
export function defaultReadingModelFile(): string {
  return fileURLToPath(new URL('./reading-model.bin', import.meta.url));
}

/** The file system as the loader uses it: a test gives one of its own. */
export interface ReadingModelIo {
  openSync: (path: string, flags: string) => number;
  fstatSync: (fd: number) => { isFile(): boolean; size: number };
  readSync: (fd: number, buf: Buffer, offset: number, length: number, position: null) => number;
  closeSync: (fd: number) => void;
}

/** What became of the weights. */
export type ReadingModelState = 'loaded' | 'missing' | 'corrupt';

/**
 * The model, if the file is there and is the one this release holds by its
 * hash; otherwise null, and why. Never throws.
 */
export function loadReadingModel(
  file: string = defaultReadingModelFile(),
  sha256: string = READING_MODEL_SHA256,
  io: ReadingModelIo = { openSync, fstatSync, readSync, closeSync },
): { model: ReadingModel | null; state: ReadingModelState; detail?: string } {
  let bytes: Buffer;
  let fd: number;
  try {
    fd = io.openSync(file, 'r');
  } catch (e) {
    return { model: null, state: 'missing', detail: (e as NodeJS.ErrnoException).code ?? 'unread' };
  }
  try {
    // The file opened, then its size asked of what was opened, and at most a
    // byte more than the most read from it: a file far bigger than the
    // weights is never read, nor one that grows between (the R2 re-check).
    const st = io.fstatSync(fd);
    if (!st.isFile()) return { model: null, state: 'corrupt', detail: 'not a file' };
    if (st.size > MAX_BYTES) return { model: null, state: 'corrupt', detail: 'too big' };
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let got = 0;
    for (;;) {
      const n = io.readSync(fd, buf, got, buf.length - got, null);
      if (n <= 0) break;
      got += n;
      if (got >= buf.length) break;
    }
    if (got > MAX_BYTES) return { model: null, state: 'corrupt', detail: 'too big' };
    bytes = buf.subarray(0, got);
  } catch (e) {
    return { model: null, state: 'corrupt', detail: (e as Error).message.slice(0, 120) };
  } finally {
    try {
      io.closeSync(fd);
    } catch {
      // Closed already, or never to be: nothing more to do.
    }
  }
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256)
    return { model: null, state: 'corrupt', detail: 'not the file this release was built with' };
  try {
    return { model: parseReadingModel(new Uint8Array(bytes)), state: 'loaded' };
  } catch (e) {
    return { model: null, state: 'corrupt', detail: (e as Error).message.slice(0, 120) };
  }
}

/**
 * What this worker found of the weights, said where the API reads it
 * (reading_model_state, 0079), a row a worker process, said again every
 * READING_MODEL_RECORD_MS: the API offers the model only while every worker
 * that said so lately has it loaded, and Settings says when it is not (the
 * R2 review and its re-check). Rows no worker has said in a day go.
 */
export async function recordReadingModel(
  admin: { query(sql: string, params?: unknown[]): Promise<unknown> },
  worker: string,
  state: ReadingModelState | null,
): Promise<void> {
  await admin.query(
    `insert into reading_model_state (worker, state, checked_at) values ($1, $2, now())
     on conflict (worker) do update set state = excluded.state, checked_at = now()`,
    [worker.slice(0, 200), state ?? 'missing'],
  );
  await admin.query(`delete from reading_model_state where checked_at < now() - interval '1 day'`);
}

/**
 * Says what the thread found of the weights now, and again every `every`
 * milliseconds while the worker runs (the R2 re-check): the API counts a
 * worker's word only while it is fresh, so a worker that stopped saying it
 * is not taken to have the model. No thread to be had: said as missing.
 * Answers a function that stops it.
 */
export function keepRecordingReadingModel(
  thread: { warm(): Promise<ReadingModelState | null> },
  record: (state: ReadingModelState | null) => void,
  every: number = READING_MODEL_RECORD_MS,
): () => void {
  const say = () => {
    void thread.warm().then(record, () => record(null));
  };
  say();
  const timer = setInterval(say, every);
  timer.unref();
  return () => clearInterval(timer);
}
