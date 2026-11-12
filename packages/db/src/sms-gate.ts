import { lookup as dnsLookup, type LookupAllOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isLoopbackName, isPrivateAddress, type SmsMode, type SmsState } from '@fdv/shared';

/**
 * Sending a text (0.9.0, SMS1): what the vault asks of whatever sends it,
 * and SMS Gate for Android (sms-gate.app), the one that does today.
 *
 * SMS Gate is an app on a phone the family owns. It answers one HTTP API,
 * reached three ways: on the home network (`local`, http or https to the
 * phone itself), through SMS Gate's cloud relay (`cloud`), or through a
 * server of the family's own (`private`, https). It signs in with HTTP
 * Basic, the username and password the app shows.
 *
 * Where it may go: the local server is on the home network by design, so
 * any address is allowed for it. The cloud and a private server never reach
 * an address inside the vault's own network — loopback, private,
 * link-local (cloud metadata) and the like — checked when the connection is
 * made, on the address DNS gives then (a blind-SSRF guard, as a push's is).
 * Every request waits ten seconds at most, and a redirect is never followed.
 *
 * Here, beside the database, since notifications by text (0.9.0, SMS2):
 * the API sends a test and the codes, the worker the reminders, the alerts
 * and the news of a link opened, both through this one client and `sendSms`.
 */

/** What a provider says of a text it took: its id for it, and how it stands. */
export interface SmsSent {
  id: string;
  state: SmsState;
}

/** How a text stands now, and why it failed, in the provider's words. */
export interface SmsStateNow {
  state: SmsState;
  error?: string;
}

/** Whatever sends the household's texts: SMS Gate today; a test's fake; another, one day. */
export interface SmsProvider {
  send(to: string, text: string): Promise<SmsSent>;
  state(id: string): Promise<SmsStateNow>;
}

/** Where and as whom a provider signs in: what an owner set up. */
export interface SmsConnection {
  mode: SmsMode;
  baseUrl: string;
  username: string;
  password: string;
}

/** Makes the provider for a household's settings. */
export type SmsProviderFactory = (c: SmsConnection) => SmsProvider;

/**
 * Why a provider could not do what it was asked, as a word: never its
 * password, never a number.
 *
 *  - `unauthorised`: it refused the username or password (401, 403).
 *  - `timeout`: no answer within ten seconds.
 *  - `unreachable`: no connection at all (refused, no such name).
 *  - `address_refused`: the address is inside the vault's own network, and
 *    only the local server may be.
 *  - `refused`: any other answer than the one asked for (`status` says which).
 *  - `not_found`: it does not know that text (404 to a state).
 */
export type SmsProblem =
  'unauthorised' | 'timeout' | 'unreachable' | 'address_refused' | 'refused' | 'not_found';

export class SmsProviderError extends Error {
  constructor(
    readonly problem: SmsProblem,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SmsProviderError';
  }
}

/** How long SMS Gate has to answer one request. */
export const SMS_TIMEOUT_MS = 10_000;

/** The most of an answer read: SMS Gate's are a few hundred bytes. */
const MAX_ANSWER_BYTES = 64 * 1024;

/** DNS as usual, but for the cloud and a private server no address inside the vault's own network. */
export function smsLookup(
  allowPrivate: boolean,
  base: typeof dnsLookup = dnsLookup,
): LookupFunction {
  return ((
    hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    base(hostname, { ...(options as object), all: true } as LookupAllOptions, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const [first] = addresses;
      if (!first) return callback(new Error(`${hostname} has no address`), '', 0);
      if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) {
        return callback(
          new SmsProviderError('address_refused', `${hostname} is inside the vault's own network`),
          '',
          0,
        );
      }
      if (options.all) return callback(null, addresses);
      return callback(null, first.address, first.family);
    });
  }) as LookupFunction;
}

/** A state as SMS Gate writes it ("Pending", "Delivered"), as the vault keeps it. */
export function stateOf(word: unknown): SmsState {
  switch (typeof word === 'string' ? word.toLowerCase() : '') {
    case 'pending':
      return 'pending';
    case 'processed':
      return 'processed';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

/** Printable, one line, and short: what a provider said is never trusted to be any of those. */
export function cleanWords(words: unknown, max = 300): string | undefined {
  if (typeof words !== 'string') return undefined;
  const clean = words
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, max) : undefined;
}

export interface SmsGateOptions {
  /** Tests: DNS of their own. */
  lookup?: typeof dnsLookup;
  /** Tests: a shorter wait than SMS_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** SMS Gate for Android's API: `POST {base}/messages`, `GET {base}/messages/{id}`. */
export class SmsGateProvider implements SmsProvider {
  private readonly base: URL;
  private readonly timeoutMs: number;
  private readonly lookup: LookupFunction;

  constructor(
    private readonly c: SmsConnection,
    opts: SmsGateOptions = {},
  ) {
    this.base = new URL(c.baseUrl.replace(/\/+$/, ''));
    this.timeoutMs = opts.timeoutMs ?? SMS_TIMEOUT_MS;
    this.lookup = smsLookup(c.mode === 'local', opts.lookup);
  }

  async send(to: string, text: string): Promise<SmsSent> {
    const answer = await this.request('POST', '/messages', {
      textMessage: { text },
      phoneNumbers: [to],
      withDeliveryReport: true,
    });
    const body = answer as { id?: unknown; state?: unknown } | null;
    if (!body || typeof body.id !== 'string' || !body.id) {
      throw new SmsProviderError('refused', 'SMS Gate took the text but gave no id for it');
    }
    return { id: body.id.slice(0, 200), state: stateOf(body.state) };
  }

  async state(id: string): Promise<SmsStateNow> {
    const answer = (await this.request('GET', `/messages/${encodeURIComponent(id)}`)) as {
      state?: unknown;
      recipients?: Array<{ state?: unknown; error?: unknown }>;
    } | null;
    const recipient = answer?.recipients?.[0];
    // One number a text: its recipient's state is the text's, when there is one.
    const state = stateOf(recipient?.state ?? answer?.state);
    const error = cleanWords(recipient?.error);
    return error ? { state, error } : { state };
  }

  /** One request, signed in, ten seconds at most, never following a redirect. */
  private request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = new URL(this.base.href.replace(/\/+$/, '') + path);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // The cloud and a private server: an address typed as a number, or a
    // name that is always this machine, is refused before anything is sent.
    if (
      this.c.mode !== 'local' &&
      (isLoopbackName(host) || (isIP(host) !== 0 && isPrivateAddress(host)))
    ) {
      return Promise.reject(
        new SmsProviderError('address_refused', `${host} is inside the vault's own network`),
      );
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const auth = Buffer.from(`${this.c.username}:${this.c.password}`, 'utf8').toString('base64');
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const req = client.request(
        url,
        {
          method,
          lookup: this.lookup,
          agent: false,
          headers: {
            authorization: `Basic ${auth}`,
            accept: 'application/json',
            'user-agent': 'FamilyVault',
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': payload.length }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_ANSWER_BYTES) {
              req.destroy();
              finish(() =>
                reject(new SmsProviderError('refused', 'SMS Gate answered with too much')),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', (err) =>
            finish(() => reject(new SmsProviderError('unreachable', err.message))),
          );
          res.on('end', () =>
            finish(() => {
              const status = res.statusCode ?? 0;
              const text = Buffer.concat(chunks).toString('utf8');
              if (status === 401 || status === 403) {
                reject(
                  new SmsProviderError(
                    'unauthorised',
                    'SMS Gate refused the username or password',
                    status,
                  ),
                );
                return;
              }
              if (status === 404 && method === 'GET') {
                reject(
                  new SmsProviderError('not_found', 'SMS Gate does not know that text', status),
                );
                return;
              }
              if (status < 200 || status >= 300) {
                // A redirect is an answer like any other: never followed.
                reject(
                  new SmsProviderError(
                    'refused',
                    `SMS Gate answered ${status}${cleanWords(text, 200) ? `: ${cleanWords(text, 200)}` : ''}`,
                    status,
                  ),
                );
                return;
              }
              try {
                resolve(text ? (JSON.parse(text) as unknown) : null);
              } catch {
                reject(
                  new SmsProviderError('refused', 'SMS Gate answered with something else', status),
                );
              }
            }),
          );
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        finish(() =>
          reject(
            new SmsProviderError(
              'timeout',
              `SMS Gate did not answer within ${Math.round(this.timeoutMs / 1000)} seconds`,
            ),
          ),
        );
      }, this.timeoutMs);
      req.on('error', (err) =>
        finish(() =>
          reject(
            err instanceof SmsProviderError
              ? err
              : new SmsProviderError('unreachable', err.message),
          ),
        ),
      );
      if (payload) req.write(payload);
      req.end();
    });
  }
}

/** SMS Gate, as the vault reaches it in production. */
export const smsGate: SmsProviderFactory = (c) => new SmsGateProvider(c);
