import { TWILIO_API_URL, type SmsState } from '@fdv/shared';
import {
  SMS_TIMEOUT_MS,
  smsGate,
  SmsProviderError,
  type SmsAskWithin,
  type SmsProvider,
  type SmsProviderFactory,
  type SmsSent,
  type SmsStateNow,
  type TwilioConnection,
} from './sms-gate.js';

/**
 * Sending a text through Twilio (0.9.0-dev.71), the second provider behind
 * `SmsProvider`: a paid service on the internet, which the household's
 * owners sign up to themselves and pay for each text.
 *
 * Twilio's Messages API: `POST /2010-04-01/Accounts/{SID}/Messages.json`,
 * form-encoded, signed in with HTTP Basic (the Account SID and Auth Token),
 * from one of the account's numbers (`From`) or through a Messaging Service
 * (`MessagingServiceSid`). How a text stands is asked of its own resource,
 * `GET …/Messages/{sid}.json`, as SMS Gate's is: no webhooks, so nothing of
 * Twilio's ever calls the vault.
 *
 * Plain `fetch`, no SDK. Every request waits ten seconds at most and never
 * follows a redirect. Asking how a text stands is tried again, twice, after
 * a 429 or a 5xx, after a wait that doubles (or the `Retry-After` Twilio
 * gives, up to ten seconds). Sending is tried again only after a 429, which
 * Twilio answers before it makes anything: after a 5xx, a connection that
 * broke or an answer that never came, Twilio may have made the message, so
 * it is never sent again — that is `unconfirmed`, and the vault counts it
 * as sent, its delivery unknown. Nothing here logs; what it throws never holds the Auth Token,
 * the text's words or the number — Twilio's own error messages can hold the
 * number, so only its error code is kept, and said in the vault's words.
 *
 * Only a test points it anywhere but api.twilio.com (`baseUrl`): Settings
 * never offers that.
 */

/** The most of an answer read: Twilio's are a few kilobytes. */
const MAX_ANSWER_BYTES = 64 * 1024;

/** How many times a 429 (or, asking after a text, a 5xx) is tried again, and the first wait before it. */
export const TWILIO_RETRIES = 2;
export const TWILIO_RETRY_MS = 1000;
/** The longest a `Retry-After` is waited for. */
const MAX_RETRY_WAIT_MS = 10_000;

/** A status as Twilio writes it, as the vault keeps it. */
export function twilioStateOf(word: unknown): SmsState {
  switch (typeof word === 'string' ? word.toLowerCase() : '') {
    case 'accepted':
    case 'scheduled':
    case 'queued':
      return 'pending';
    case 'sending':
      return 'processed';
    case 'sent':
      return 'sent';
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'undelivered':
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return 'pending';
  }
}

/** Twilio's error codes the vault can say in plain words; any other is said by its number. */
const TWILIO_ERRORS: Readonly<Record<number, string>> = {
  20003: 'Twilio refused the Account SID or Auth Token',
  20429: 'Twilio asked the vault to slow down',
  21211: 'the number isn’t a valid phone number',
  21408: 'the Twilio account may not text that country (check its Geo permissions)',
  21606: 'the From number can’t send texts from this account',
  21608: 'a trial Twilio account can only text numbers verified in it',
  21610: 'the person replied STOP to this sender, so Twilio won’t text them',
  21612: 'Twilio can’t send from that sender to that number',
  21614: 'the number isn’t a mobile number',
  30003: 'the phone was switched off or out of reach',
  30004: 'the text was blocked',
  30005: 'the number is unknown or no longer in service',
  30006: 'the number is a landline, or its network can’t take texts',
  30007: 'the mobile network filtered the text',
  30008: 'the mobile network gave no reason',
  30034: 'the sender isn’t registered for texting in the US (A2P 10DLC)',
};

/** "Twilio error 30003: the phone was switched off or out of reach", or undefined with no code. */
export function twilioErrorWords(code: unknown): string | undefined {
  const n = typeof code === 'string' && /^[0-9]{1,6}$/.test(code) ? Number(code) : code;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0 || n > 999_999) return undefined;
  const words = TWILIO_ERRORS[n];
  return words ? `Twilio error ${n}: ${words}` : `Twilio error ${n}`;
}

export interface TwilioOptions {
  /** Tests: a fake Twilio's address. Never from Settings. */
  baseUrl?: string;
  /** Tests: a shorter wait than SMS_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Tests: a shorter first wait before trying again than TWILIO_RETRY_MS. */
  retryMs?: number;
  /** Tests: a fetch of their own. */
  fetch?: typeof fetch;
}

/** A message's id as Twilio gives it: SM (a text) or MM (a picture message), and 32 hex digits. */
export const TWILIO_MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/;

/** Errors that say nothing reached Twilio at all: no connection was made. */
const NEVER_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Twilio's Messages API, for one account. */
export class TwilioProvider implements SmsProvider {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly retryMs: number;
  private readonly fetch: typeof fetch;

  constructor(
    private readonly c: TwilioConnection,
    opts: TwilioOptions = {},
  ) {
    this.base = (opts.baseUrl ?? TWILIO_API_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? SMS_TIMEOUT_MS;
    this.retryMs = opts.retryMs ?? TWILIO_RETRY_MS;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async send(to: string, text: string): Promise<SmsSent> {
    const form = new URLSearchParams({ To: to, Body: text });
    if (this.c.messagingServiceSid) form.set('MessagingServiceSid', this.c.messagingServiceSid);
    else if (this.c.from) form.set('From', this.c.from);
    else
      throw new SmsProviderError(
        'refused',
        'Twilio has no number or Messaging Service to send from',
      );
    const body = (await this.request('POST', '/Messages.json', { form })) as {
      sid?: unknown;
      status?: unknown;
    } | null;
    // The id goes into the address a state is asked at: only one shaped as
    // Twilio's is kept.
    if (!body || typeof body.sid !== 'string' || !TWILIO_MESSAGE_SID.test(body.sid)) {
      throw new SmsProviderError('refused', 'Twilio took the text but gave no id the vault knows');
    }
    return { id: body.sid, state: twilioStateOf(body.status) };
  }

  async state(id: string, within?: SmsAskWithin): Promise<SmsStateNow> {
    if (!TWILIO_MESSAGE_SID.test(id)) {
      throw new SmsProviderError('not_found', 'That is not an id Twilio gives');
    }
    const body = (await this.request('GET', `/Messages/${id}.json`, {
      timeoutMs: within?.timeoutMs,
      retry: within?.retry,
    })) as {
      status?: unknown;
      error_code?: unknown;
    } | null;
    const state = twilioStateOf(body?.status);
    // Twilio's error_message is never read: it can hold the number.
    const error = state === 'failed' ? twilioErrorWords(body?.error_code) : undefined;
    return error ? { state, error } : { state };
  }

  /** How long to wait before trying again: Twilio's Retry-After, else a wait that doubles. */
  private waitBefore(attempt: number, retryAfter: string | null): number {
    const seconds =
      retryAfter !== null && /^[0-9]{1,4}$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
    return Math.min(this.retryMs * 2 ** attempt, MAX_RETRY_WAIT_MS);
  }

  /**
   * One request, signed in, ten seconds a try at most (or less, as asked),
   * never following a redirect. A GET is tried again after a 429 or a 5xx;
   * a POST only after a 429, and one that may have reached Twilio is
   * `unconfirmed`, never tried again.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    o: { form?: URLSearchParams; timeoutMs?: number | undefined; retry?: boolean | undefined } = {},
  ): Promise<unknown> {
    const form = o.form;
    const timeoutMs = Math.max(1, Math.min(o.timeoutMs ?? this.timeoutMs, this.timeoutMs));
    const retries = o.retry === false ? 0 : TWILIO_RETRIES;
    const url = `${this.base}/2010-04-01/Accounts/${encodeURIComponent(this.c.accountSid)}${path}`;
    const auth = Buffer.from(`${this.c.accountSid}:${this.c.authToken}`, 'utf8').toString('base64');
    for (let attempt = 0; ; attempt += 1) {
      let status: number;
      let text: string;
      let retryAfter: string | null;
      try {
        const res = await this.fetch(url, {
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            authorization: `Basic ${auth}`,
            accept: 'application/json',
            'user-agent': 'FamilyVault',
            ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          },
          ...(form ? { body: form.toString() } : {}),
        });
        status = res.status;
        retryAfter = res.headers.get('retry-after');
        text = await readCapped(res);
      } catch (err) {
        if (err instanceof SmsProviderError) throw err;
        const name = (err as { name?: unknown } | null)?.name;
        const cause = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
        const neverConnected = typeof cause === 'string' && NEVER_CONNECTED.has(cause);
        // A send that may have reached Twilio is never sent again.
        if (method === 'POST' && !neverConnected) {
          throw new SmsProviderError('unconfirmed', 'Twilio did not say whether it took the text');
        }
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new SmsProviderError(
            'timeout',
            `Twilio did not answer within ${Math.round(timeoutMs / 1000)} seconds`,
          );
        }
        // Never the error's own words: they can hold the address, and so the account.
        throw new SmsProviderError('unreachable', 'The vault could not reach Twilio');
      }
      // Twilio answers 429 before it makes anything: safe to send again. A
      // 5xx to a send may come after the message was made, so only asking
      // after one is tried again.
      const again = status === 429 || (method === 'GET' && status >= 500);
      if (again && attempt < retries) {
        await new Promise((r) => setTimeout(r, this.waitBefore(attempt, retryAfter)));
        continue;
      }
      if (method === 'POST' && status >= 500) {
        throw new SmsProviderError(
          'unconfirmed',
          `Twilio answered ${status}, and may have taken the text`,
          status,
        );
      }
      return answerOf(method, status, text);
    }
  }
}

/** Twilio's answer, or why not: its error code kept, never its message. */
function answerOf(method: 'GET' | 'POST', status: number, text: string): unknown {
  let body: unknown;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = undefined;
  }
  const raw = (body as { code?: unknown } | null | undefined)?.code;
  const code = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
  if (status === 401 || status === 403) {
    throw new SmsProviderError(
      'unauthorised',
      'Twilio refused the Account SID or Auth Token',
      status,
      code,
    );
  }
  if (status === 404 && method === 'GET') {
    throw new SmsProviderError('not_found', 'Twilio does not know that text', status, code);
  }
  if (status < 200 || status >= 300) {
    // A redirect is an answer like any other: never followed.
    throw new SmsProviderError('refused', `Twilio answered ${status}`, status, code);
  }
  if (body === undefined) {
    throw new SmsProviderError('refused', 'Twilio answered with something else', status);
  }
  return body;
}

/** An answer's words, no more than MAX_ANSWER_BYTES of them. */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Node's web streams are async iterable; leaving the loop early cancels the stream.
  for await (const value of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      throw new SmsProviderError('refused', 'Twilio answered with too much', res.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Twilio, as the vault reaches it in production. */
export const twilio = (c: TwilioConnection): SmsProvider => new TwilioProvider(c);

/** Whichever provider the household chose, as the vault reaches it in production. */
export const smsProviders: SmsProviderFactory = (c) =>
  c.provider === 'twilio' ? twilio(c) : smsGate(c);
