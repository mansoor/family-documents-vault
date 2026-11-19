import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The code first-run setup asks for (0.9.0): until the vault is set up,
 * whoever reaches it first would otherwise become its owner — anybody on
 * the home network, or anybody on the internet with a public site in
 * front. Only somebody who can read the server's `.env` (FDV_SETUP_TOKEN,
 * which scripts/gen-env.mjs writes) or the API's own log (a code made as it
 * starts, when there is no FDV_SETUP_TOKEN) can set it up.
 *
 * Only its SHA-256 is kept; a code made at start is shown once, in the log,
 * and a new one is made each time the API starts until the vault is set up.
 */
export class SetupToken {
  private readonly hash: Buffer;

  constructor(token: string) {
    this.hash = digest(token);
  }

  /** A new code: 16 random bytes, base64url (22 characters). */
  static generate(): { token: string; gate: SetupToken } {
    const token = randomBytes(16).toString('base64url');
    return { token, gate: new SetupToken(token) };
  }

  /** Whether `given` is the code, compared in constant time; spaces around it forgiven. */
  matches(given: unknown): boolean {
    if (typeof given !== 'string' || given.length === 0 || given.length > 256) return false;
    return timingSafeEqual(digest(given.trim()), this.hash);
  }
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** The least an FDV_SETUP_TOKEN may be: long enough not to be guessed in the time setup is open. */
export const SETUP_TOKEN_MIN_LENGTH = 16;
