import { readFile } from 'node:fs/promises';

/** Replaced with the release version by scripts/bundle.mjs; absent when unbundled. */
declare const __FDV_VERSION__: string | undefined;

/**
 * The release this server is.
 *
 * The root package.json holds it, set to each release's tag (CI fails a
 * tag that disagrees). The bundler stamps it into the built server, so an
 * image reports what it is; unbundled — tests, `pnpm dev` — it is read
 * from the file. Until 0.4.4 every server reported 0.0.1, which a client
 * declaring a minimum server version would have refused.
 */
export async function serverVersion(): Promise<string> {
  if (typeof __FDV_VERSION__ === 'string') return __FDV_VERSION__;
  const root = new URL('../../../package.json', import.meta.url);
  return (JSON.parse(await readFile(root, 'utf8')) as { version: string }).version;
}
