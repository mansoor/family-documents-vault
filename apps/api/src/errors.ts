/**
 * The one error envelope (API-03). `message` is written for the person and
 * safe to show verbatim; `detail` is for logs and support. Clients switch on
 * `code`, never on `message`.
 */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    detail?: string;
    retriable: boolean;
    request_id: string;
    /** Which consequential action asked for a fresh credential (SEC-17). */
    action?: string;
    /** Why a session ended (session_ended, 0.4.11). */
    reason?: string;
    /** A step-up only a passkey or a code answers, never the password (0.9.0). */
    factor?: true;
    /**
     * Seconds to wait before trying again, as Retry-After says (0.9.0):
     * signing in waiting after too many failures (`sign_in_throttled`), and
     * every other answer that sends Retry-After.
     */
    retry_after?: number;
  };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly options: {
      detail?: string;
      retriable?: boolean;
      action?: string;
      /** Seconds to wait before trying again; sent as Retry-After. */
      retryAfter?: number;
      /** Why a session ended (0.4.11): expired, revoked, reused, removed or malformed. */
      reason?: string;
      /** A step-up only a passkey or a code answers (0.9.0). */
      factor?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(requestId: string): ErrorBody {
    const error: ErrorBody['error'] = {
      code: this.code,
      message: this.message,
      retriable: this.options.retriable ?? false,
      request_id: requestId,
    };
    if (this.options.detail !== undefined) error.detail = this.options.detail;
    if (this.options.action !== undefined) error.action = this.options.action;
    if (this.options.reason !== undefined) error.reason = this.options.reason;
    if (this.options.factor === true) error.factor = true;
    if (this.options.retryAfter !== undefined) error.retry_after = this.options.retryAfter;
    return { error };
  }
}

export const notFound = (what = 'That page') =>
  new ApiError(404, 'not_found', `${what} does not exist.`);

export const notReady = (detail: string) =>
  new ApiError(503, 'not_ready', 'The vault is starting up or cannot reach its database.', {
    detail,
    retriable: true,
  });
