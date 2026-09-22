import type { Capabilities } from '@fdv/shared';

/**
 * A thin client for the parts of the API the web app uses. Grows with each
 * iteration; every function here maps to one documented endpoint.
 */

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function get<T>(path: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    let code = 'http_error';
    let message = `The server answered ${res.status}.`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // not JSON; keep the generic message
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const fetchCapabilities = (fetchImpl?: typeof fetch) =>
  get<Capabilities>('/api/v1/capabilities', fetchImpl);
