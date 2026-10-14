/**
 * What a tool the worker runs is given of its environment (the S4 review,
 * F7): only what a tool needs to run — where programs are, a home, the
 * language, a temporary folder, and its own settings (ImageMagick's,
 * Tesseract's, fontconfig's; libpq's for the database's own tools) — never
 * the master key, the database's address, the mailbox's password or
 * anything else the worker was started with. Each caller adds what it alone
 * needs.
 */

/** Names kept as they are: what any program needs to start, here or on Windows. */
const KEEP = new Set([
  'PATH',
  'Path',
  'HOME',
  'LANG',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'PATHEXT',
  'COMSPEC',
]);

/** And a tool's own settings, by their prefix: the language's, ImageMagick's, Tesseract's, fontconfig's. */
const TOOLS = /^(LC_|MAGICK_|FONTCONFIG_|XDG_)|^(TESSDATA_PREFIX|OMP_THREAD_LIMIT)$/;

/** libpq's own settings (sslmode, a root certificate, …), for pg_dump and psql alone. */
export const LIBPQ = /^PG[A-Z]+$/;

/**
 * The environment for a tool: the few names any program needs, its kind's
 * settings (`also`, beyond the tools' own), and what the caller adds.
 */
export function childEnv(
  extra: Record<string, string | undefined> = {},
  also?: RegExp,
  from: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    if (KEEP.has(k) || TOOLS.test(k) || also?.test(k)) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
  return out;
}
