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
}

/** The server answered, and the answer was no. Its `message` is safe to show. */
export class ApiRequestError extends Error {
  readonly reason: string | undefined;
  readonly retriable: boolean;
  readonly requestId: string | undefined;
  readonly detail: string | undefined;
  readonly retryAfterSeconds: number | undefined;

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
  }
}

/** No answer at all: the network is down, or the server did not reply in time. */
export class NetworkError extends Error {
  constructor(
    public readonly kind: 'offline' | 'timeout',
    message = kind === 'timeout'
      ? 'The vault took too long to answer.'
      : "We can't reach the vault right now.",
  ) {
    super(message);
    this.name = 'NetworkError';
  }
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
