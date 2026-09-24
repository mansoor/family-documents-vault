import { ApiRequestError } from './api.js';

/**
 * One Idempotency-Key per file until it is saved. Choosing the same file
 * again after a failure (an answer lost on the way back, a connection that
 * dropped) sends the same key, so the vault answers with what the first try
 * made instead of making a second document. Another file, or a save, starts
 * a new key.
 */
export function createUploadKeys() {
  let last: { file: string; key: string } | null = null;
  const same = (f: File) => [f.name, f.size, f.lastModified, f.type].join('|');
  return {
    keyFor(file: File): string {
      const id = same(file);
      if (last?.file !== id) last = { file: id, key: crypto.randomUUID() };
      return last.key;
    },
    saved(): void {
      last = null;
    },
  };
}

/**
 * The vault says an earlier try of this upload is still on its way: wait as
 * long as it asks, then ask again with the same key — which is answered with
 * what that try made once it has finished.
 */
export async function whileInProgress<T>(
  attempt: () => Promise<T>,
  opts: { tries?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const tries = opts.tries ?? 4;
  const wait = opts.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let i = 1; ; i += 1) {
    try {
      return await attempt();
    } catch (err) {
      const busy = err instanceof ApiRequestError && err.code === 'upload_in_progress';
      if (!busy || i >= tries) throw err;
      await wait((err.retryAfterSeconds ?? 5) * 1000);
    }
  }
}
