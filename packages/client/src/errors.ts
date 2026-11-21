import { APP_UPDATE_REQUIRED_CODE } from '@fdv/shared';

/**
 * The two ways a request can fail, kept apart because a client has to
 * treat them oppositely: an answer from the server is to be read and
 * shown, a missing answer is to be waited out and retried — and above all
 * never mistaken for "you have been signed out".
 */

export interface ApiErrorExtra {
  /** Why a session ended, where the server says (expired, revoked, …). */
  reason?: string;
  retriable?: boolean;
  requestId?: string;
  detail?: string;
  /** From a Retry-After header, in seconds from now. */
  retryAfterSeconds?: number;
  /**
   * A `step_up_required` that only a passkey or a code will answer, never
   * the password (0.9.0: changing how somebody with either signs in).
   */
  factor?: boolean;
}

/** The server answered, and the answer was no. Its `message` is safe to show. */
export class ApiRequestError extends Error {
  readonly reason: string | undefined;
  readonly retriable: boolean;
  readonly requestId: string | undefined;
  readonly detail: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  /** A step-up only a passkey or a code answers (0.9.0). */
  readonly factor: boolean;

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Which consequential action asked for a fresh credential (SEC-17). */
    public readonly action?: string,
    extra: ApiErrorExtra = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.reason = extra.reason;
    this.retriable = extra.retriable ?? isRetriableStatus(status);
    this.requestId = extra.requestId;
    this.detail = extra.detail;
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.factor = extra.factor === true;
  }
}

/**
 * The vault will not work with this app until it is updated (0.9.0-dev.79):
 * `426 app_update_required`, which a vault answers a phone app older than
 * its `min_client_version` on any call but the capability document, a
 * session's renewal, sign-out and the health checks — in its own envelope
 * only: a bare 426 is no vault's, and stays `http_error`. An
 * `ApiRequestError` too, so code that catches those still does; an app
 * catches this one first and shows its "update the app" screen, not the
 * call's own error. It never ends a session. `message` is the vault's,
 * safe to show.
 */
export class AppUpdateRequired extends ApiRequestError {
  /** The oldest app version the vault works with, when it said (it always does). */
  readonly minClientVersion: string | undefined;

  constructor(message: string, minClientVersion?: string, extra: ApiErrorExtra = {}) {
    super(426, APP_UPDATE_REQUIRED_CODE, message, undefined, { ...extra, retriable: false });
    this.name = 'AppUpdateRequired';
    this.minClientVersion = minClientVersion;
  }
}

/** Whether an error is the vault saying this app must be updated first. */
export function isAppUpdateRequired(err: unknown): err is AppUpdateRequired {
  return err instanceof AppUpdateRequired;
}

/**
 * No answer at all: the network is down, or the server did not reply in
 * time. What the platform's fetch threw is its standard `cause`, and
 * `detail` says it in a few words (a code such as `ECONNREFUSED`, or the
 * error's message), for a log: `message` stays the one to show.
 */
export class NetworkError extends Error {
  /** Why, in a few words, from what fetch threw; undefined when nothing was given. */
  readonly detail: string | undefined;

  constructor(
    public readonly kind: 'offline' | 'timeout',
    message = kind === 'timeout'
      ? 'The vault took too long to answer.'
      : "We can't reach the vault right now.",
    options: { cause?: unknown } = {},
  ) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    // An engine that ignores the option (an older Hermes) still keeps it.
    if ('cause' in options && !('cause' in this)) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        writable: true,
        configurable: true,
      });
    }
    this.name = 'NetworkError';
    this.detail = 'cause' in options ? networkDetail(options.cause) : undefined;
  }
}

/**
 * What a failed fetch says, in a few words: the first `code` down its
 * chain of causes (Node's fetch puts `ECONNREFUSED`, `ENOTFOUND` and the
 * like on its cause), else its message, on one line — but never a message
 * with an address in it (`://`), which says only "the request failed".
 */
export function networkDetail(err: unknown): string | undefined {
  let at: unknown = err;
  for (let depth = 0; depth < 4 && at !== null && typeof at === 'object'; depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    at = (at as { cause?: unknown }).cause;
  }
  const message =
    err !== null && typeof err === 'object' ? (err as { message?: unknown }).message : err;
  if (typeof message !== 'string' || !message.trim()) return undefined;
  // A message naming an address may carry its query, or a password in it:
  // never repeated here.
  if (message.includes('://')) return 'the request failed';
  const one = message.trim().replace(/\s+/g, ' ');
  return one.length > 120 ? `${one.slice(0, 119)}…` : one;
}

/**
 * The only two answers that mean this session cannot be used again.
 *
 * Not every 401 does: the API also answers 401 when a credential presented
 * *inside* a request was wrong — a mistyped current password, a passkey
 * that is not yours — and signing somebody out for a typo is its own small
 * betrayal.
 */
export function isSessionOver(err: unknown): boolean {
  return (
    err instanceof ApiRequestError &&
    err.status === 401 &&
    (err.code === 'session_ended' || err.code === 'unauthenticated')
  );
}

/** Statuses worth trying again later, whatever the envelope says. */
export function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * A Retry-After header as seconds from `now`: either a number of seconds,
 * or an HTTP date. Undefined when absent or unreadable.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}
