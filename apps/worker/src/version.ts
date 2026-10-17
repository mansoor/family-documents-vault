import { readFile } from 'node:fs/promises';

/** Replaced with the release version by scripts/bundle.mjs; absent when unbundled. */
declare const __FDV_VERSION__: string | undefined;

/**
 * The release this worker is (0.9.0, R0: a Reading check says which reader
 * it measured), as the API's own serverVersion() says it: stamped into the
 * bundle, or read from the root package.json under tsx and vitest.
 */
export async function workerVersion(): Promise<string> {
  if (typeof __FDV_VERSION__ === 'string') return __FDV_VERSION__;
  const root = new URL('../../../package.json', import.meta.url);
  return (JSON.parse(await readFile(root, 'utf8')) as { version: string }).version;
}
