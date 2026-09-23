import { ApiRequestError } from './errors.js';

/** The longest a client waits between two tries. */
export const MAX_RETRY_SECONDS = 300;

/**
 * How long to wait before trying again, in milliseconds.
 *
 * The server's Retry-After wins when it gave one. Otherwise exponential
 * backoff with full jitter — a random wait up to 2^attempt seconds, capped
 * — so a family's phones coming back online together do not all knock at
 * the same moment.
 */
export function retryDelay(err: unknown, attempt: number, random: () => number = Math.random) {
  if (err instanceof ApiRequestError && err.retryAfterSeconds !== undefined) {
    return Math.min(err.retryAfterSeconds, MAX_RETRY_SECONDS) * 1000;
  }
  const ceiling = Math.min(MAX_RETRY_SECONDS, 2 ** Math.max(0, attempt));
  return Math.round(random() * ceiling * 1000);
}
