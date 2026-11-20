/**
 * Secrets the vault will not start with: the example file's placeholders,
 * and a master key too guessable to protect anything.
 *
 * `cp .env.example .env && docker compose up` would otherwise give a vault
 * whose master key is printed in the public repository: its session signing
 * key, every sealed secret and every backup derivable by anybody. The API
 * and the worker both refuse to start on one, saying what to do; the
 * rotation and repair commands (cli.mjs) still run, so a vault that started
 * on a weak key before this can be moved off it.
 */

/** Words no generated secret holds, and every placeholder does. */
const PLACEHOLDER = /replace|change-?me|example|placeholder|your[-_ ]?key/i;

/**
 * The least a master key may carry, in bits, as its own letters count them
 * (`estimatedBits`). A key from scripts/gen-env.mjs (32 random bytes,
 * base64url) has about 200; 64 random hex digits about 250; a passphrase of
 * five or six random words over 32 characters, well over 100.
 */
export const MASTER_KEY_MIN_BITS = 100;

/** And at least this many different characters. */
export const MASTER_KEY_MIN_DISTINCT = 10;

/**
 * A rough measure of how much a string could hold: its length times the
 * Shannon entropy of its own characters. Not how random it is — nothing can
 * say that of one string — but a key of one letter repeated, a short word
 * padded out, or `aaaa…` comes out far too low, and anything generated far
 * above.
 */
export function estimatedBits(s: string): number {
  const chars = [...s];
  if (chars.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
  let perChar = 0;
  for (const n of counts.values()) {
    const p = n / chars.length;
    perChar -= p * Math.log2(p);
  }
  return perChar * chars.length;
}

const GENERATE =
  'Generate a real one with `node scripts/gen-env.mjs` on a new install. On a vault that ' +
  'already has documents, move to a new key with the rotate-master-key command (README, ' +
  '"Rotating the master key") — never just change it, or the documents cannot be opened.';

/**
 * Why a master key is refused, in words for the operator; null when it may
 * be used. Refused: a placeholder (anything with "replace", "change-me",
 * "example"…), fewer than MASTER_KEY_MIN_DISTINCT different characters, or
 * under MASTER_KEY_MIN_BITS by `estimatedBits`.
 */
export function masterSecretProblem(secret: string): string | null {
  if (PLACEHOLDER.test(secret)) {
    return `FDV_MASTER_KEY is the example file's placeholder, which anybody can read. ${GENERATE}`;
  }
  const distinct = new Set(secret).size;
  if (distinct < MASTER_KEY_MIN_DISTINCT || estimatedBits(secret) < MASTER_KEY_MIN_BITS) {
    return `FDV_MASTER_KEY is too easy to guess (too short, or too few different characters). ${GENERATE}`;
  }
  return null;
}

/**
 * Why a database connection string is refused: its password is the example
 * file's `replace-me` (or another placeholder). `name` is the setting's, for
 * the message. Null when it may be used, or it holds no password at all.
 */
export function databasePasswordProblem(url: string, name: string): string | null {
  let password: string;
  try {
    password = decodeURIComponent(new URL(url).password);
  } catch {
    return null;
  }
  if (password && PLACEHOLDER.test(password)) {
    return (
      `${name} uses the example file's placeholder password, which anybody can read. ` +
      'Set FDV_DB_PASSWORD and FDV_DB_APP_PASSWORD to long random values ' +
      '(`node scripts/gen-env.mjs` makes them) before the database is first started.'
    );
  }
  return null;
}

/** The least a setup code may carry, in bits, as `estimatedBits` counts them. */
export const SETUP_TOKEN_MIN_BITS = 64;

/**
 * Why a setup code (FDV_SETUP_TOKEN, 0.9.0) is refused, or null: a
 * placeholder, fewer than 8 different characters, or under
 * SETUP_TOKEN_MIN_BITS. One from scripts/gen-env.mjs (16 random bytes,
 * base64url) has about 95.
 */
export function setupTokenProblem(token: string): string | null {
  if (
    PLACEHOLDER.test(token) ||
    new Set(token).size < 8 ||
    estimatedBits(token) < SETUP_TOKEN_MIN_BITS
  ) {
    return 'is a placeholder, or too easy to guess; scripts/gen-env.mjs writes a good one';
  }
  return null;
}
