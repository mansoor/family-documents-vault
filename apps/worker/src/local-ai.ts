import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import {
  localAiRequestBody,
  LOCAL_AI_PROBE_MS,
  LOCAL_AI_REPLY_MAX_BYTES,
  type LocalAiOffer,
} from '@fdv/shared';

/**
 * The local AI reader's client (0.9.0, R4), in the worker alone — never in
 * the API's request path. One Ollama-compatible endpoint, the operator's
 * own (FDV_LOCAL_AI_URL and FDV_LOCAL_AI_MODEL, validated at start: http or
 * https, no credentials in it); nothing here ever reaches anywhere else.
 *
 *  - **Pinned:** its name is resolved once a call and the connection made
 *    to that address (the name kept for TLS and the Host header), as the
 *    mailbox's is (S4, mail-address.ts): a DNS change mid-call cannot send
 *    it elsewhere. Redirects are never followed; proxies in the environment
 *    are never used. Private addresses are allowed: the endpoint is local by
 *    design, and the operator's to choose.
 *  - **Bounded:** a connection in LOCAL_AI_CONNECT_MS, the whole call in the
 *    operator's timeout (FDV_LOCAL_AI_TIMEOUT_SECONDS, 120 unless set, 5 to
 *    300) counted from when it was asked for, and the reply read only up to
 *    LOCAL_AI_REPLY_MAX_BYTES — more, and it is dropped unread. The reply is
 *    handed on as it came: it is parsed on the proposal thread
 *    (`readLocalAiReply`), never on this event loop.
 *  - **One call at a time**, a worker: a paper the family is waiting on
 *    (`interactive`: a batch's item, Test) goes before the Reading check's
 *    (`check`), and stops one of the check's that is running — the check
 *    yields, and reads that paper again later.
 *  - **A circuit breaker:** after LOCAL_AI_FAILURES_TO_REST failures in a
 *    row — no answer in time, nothing listening, an error — it rests for
 *    LOCAL_AI_REST_MS: nothing is sent, each paper is read without it at
 *    once, and nothing piles up waiting. Then one call is tried; it answers,
 *    and the rest is over.
 *  - **Says nothing of a paper:** what it logs is why and how long, never a
 *    word sent or received.
 */

/** How long a connection may take to be made. */
export const LOCAL_AI_CONNECT_MS = 5_000;
/** Failures in a row before the breaker opens. */
export const LOCAL_AI_FAILURES_TO_REST = 3;
/** How long it rests once open. */
export const LOCAL_AI_REST_MS = 5 * 60_000;
/** Test's own timeout: a tiny prompt, but the model may have to be loaded first. */
export const LOCAL_AI_TEST_MS = 45_000;
/** The probe's own time, its lookup included. */
export const LOCAL_AI_PROBE_TIMEOUT_MS = 10_000;
/** The most of /api/tags read: a list of many models is long. */
export const LOCAL_AI_TAGS_MAX_BYTES = 512 * 1024;
/** A call that waited longer than this in line has not its whole time (L4). */
export const LOCAL_AI_WAIT_SLACK_MS = 250;

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

export interface LocalAiSettings {
  /** FDV_LOCAL_AI_URL, as validated: its base (no trailing slash). */
  url: URL;
  /** FDV_LOCAL_AI_MODEL. */
  model: string;
  /** FDV_LOCAL_AI_TIMEOUT_SECONDS, in milliseconds. */
  timeoutMs: number;
}

/** Why there is no answer to use. */
export type LocalAiWithout =
  /** Resting after failures in a row: nothing was sent. */
  | 'resting'
  /** No answer within the time. */
  | 'timeout'
  /** Nothing listening, the name not found, the connection lost. */
  | 'unreachable'
  /** An answer, but not 200 (a model not pulled is 404). */
  | 'http_error'
  /** More than LOCAL_AI_REPLY_MAX_BYTES. */
  | 'too_big'
  /** A paper the family waits on came first (a Reading check's call alone). */
  | 'preempted'
  /** The caller gave up (a check cancelled). */
  | 'cancelled';

export type LocalAiAnswer =
  | { state: 'replied'; body: string; ms: number }
  | { state: 'without'; why: LocalAiWithout; ms: number; status?: number };

/**
 * What this worker found of the endpoint, said where the API reads it
 * (local_ai_state, 0081): the model and host the operator set — never the
 * URL's path — and whether it answered. A row a worker process; rows no
 * worker has said in a day go. The API counts a word only while it is fresh
 * (LOCAL_AI_STALE_MS).
 */
export async function recordLocalAi(
  admin: { query(sql: string, params?: unknown[]): Promise<unknown> },
  worker: string,
  settings: LocalAiSettings,
  state: 'reachable' | 'unreachable' | 'no_model',
): Promise<void> {
  await admin.query(
    `insert into local_ai_state (worker, model, host, state, checked_at) values ($1, $2, $3, $4, now())
     on conflict (worker) do update
       set model = excluded.model, host = excluded.host, state = excluded.state, checked_at = now()`,
    [worker.slice(0, 200), settings.model, localAiHost(settings.url).slice(0, 300), state],
  );
  await admin.query(`delete from local_ai_state where checked_at < now() - interval '1 day'`);
}

/**
 * Asks the endpoint whether it answers and has the model, now and every
 * `every` milliseconds while the worker runs, and says so (`record`).
 * Answers a function that stops it.
 */
export function keepProbingLocalAi(
  client: Pick<LocalAiClient, 'probe'>,
  record: (state: 'reachable' | 'unreachable' | 'no_model') => void,
  every: number = LOCAL_AI_PROBE_MS,
): () => void {
  const say = () => {
    void client.probe().then(record, () => record('unreachable'));
  };
  say();
  const timer = setInterval(say, every);
  timer.unref();
  return () => clearInterval(timer);
}

/** The worker's settings for it, from its configuration: none, with no FDV_LOCAL_AI_URL. */
export function localAiSettings(c: {
  FDV_LOCAL_AI_URL?: URL | undefined;
  FDV_LOCAL_AI_MODEL?: string | undefined;
  FDV_LOCAL_AI_TIMEOUT_SECONDS: number;
}): LocalAiSettings | null {
  if (!c.FDV_LOCAL_AI_URL || !c.FDV_LOCAL_AI_MODEL) return null;
  return {
    url: c.FDV_LOCAL_AI_URL,
    model: c.FDV_LOCAL_AI_MODEL,
    timeoutMs: c.FDV_LOCAL_AI_TIMEOUT_SECONDS * 1000,
  };
}

/** What the endpoint is, as Settings shows it: its host and port, never a path or anything else. */
export function localAiHost(url: URL): string {
  return url.host;
}

/** A host resolved: DNS, unless a test stands in. */
export type Resolve = (host: string) => Promise<string>;
const dns: Resolve = async (host) => (await lookup(host, { verbatim: true })).address;

/** A promise, or a rejection as soon as the signal aborts: whichever comes first. */
function raced<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** What a call sends: a test may stand in for the network with its own server. */
export interface LocalAiClientOptions {
  resolve?: Resolve;
  log?: Log;
  now?: () => number;
  /** Told what each call found of the endpoint, for local_ai_state. */
  onState?: (state: 'reachable' | 'unreachable' | 'no_model') => void;
  /** The probe's own time: LOCAL_AI_PROBE_TIMEOUT_MS, unless a test says. */
  probeMs?: number;
  /** Test's own time: LOCAL_AI_TEST_MS, unless a test says. */
  testMs?: number;
}

interface Slot {
  priority: 'interactive' | 'check';
  stop: AbortController;
}

interface Waiter {
  priority: 'interactive' | 'check';
  done: boolean;
  /** The turn handed over: false if this one had given up already. */
  grant: (slot: Slot) => boolean;
}

export class LocalAiClient {
  /** Failures in a row the breaker has counted (L5), for the tests. */
  failures = 0;
  private restingUntil = 0;
  private busy: Slot | null = null;
  private waiting: Waiter[] = [];
  /** Calls sent, for the tests and the counts. */
  sent = 0;

  constructor(
    readonly settings: LocalAiSettings,
    private readonly opts: LocalAiClientOptions = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Whether it is resting after failures (the breaker open). */
  resting(): boolean {
    return this.now() < this.restingUntil;
  }

  /**
   * A paper's words read by the model: the reply as it came, for the
   * proposal thread to read, or why there is none. Never rejects.
   */
  async read(
    text: string,
    offer: LocalAiOffer,
    o: { priority: 'interactive' | 'check'; signal?: AbortSignal },
  ): Promise<LocalAiAnswer> {
    const began = this.now();
    if (this.resting()) return { state: 'without', why: 'resting', ms: 0 };
    const body = localAiRequestBody(this.settings.model, text, offer);
    return this.turn(o.priority, this.settings.timeoutMs, began, o.signal, (signal) =>
      this.post('/api/chat', body, signal),
    );
  }

  /**
   * Test (R4, Settings → Reading): a tiny fixed prompt, no paper's words,
   * whatever the breaker says — and it answering ends a rest. How long it
   * took, and why not.
   */
  async test(): Promise<LocalAiAnswer> {
    const body = JSON.stringify({
      model: this.settings.model,
      stream: false,
      options: { temperature: 0, num_predict: 4 },
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    });
    return this.turn(
      'interactive',
      this.opts.testMs ?? LOCAL_AI_TEST_MS,
      this.now(),
      undefined,
      (signal) => this.post('/api/chat', body, signal),
      false,
    );
  }

  /**
   * Whether the endpoint answers, and has the model (R4): GET /api/tags,
   * which lists the models pulled (up to LOCAL_AI_TAGS_MAX_BYTES), its names
   * read from the JSON — the operator's own endpoint's list, never a paper's
   * words. An endpoint with /api/chat but no list (404) is taken as
   * answering, the model not known: Test says whether it has it. Not a turn:
   * it sends no paper, and everything it does — its lookup too — is within
   * LOCAL_AI_PROBE_TIMEOUT_MS.
   */
  async probe(): Promise<'reachable' | 'unreachable' | 'no_model'> {
    const got = await this.request(
      'GET',
      '/api/tags',
      null,
      AbortSignal.timeout(this.opts.probeMs ?? LOCAL_AI_PROBE_TIMEOUT_MS),
      LOCAL_AI_TAGS_MAX_BYTES,
    );
    if (got.state !== 'replied') {
      return got.why === 'http_error' && got.status === 404 ? 'reachable' : 'unreachable';
    }
    let names: string[] = [];
    try {
      const list = (JSON.parse(got.body) as { models?: unknown }).models;
      if (Array.isArray(list)) {
        names = list.flatMap((m: unknown) => {
          const o = m as { name?: unknown; model?: unknown } | null;
          return [o?.name, o?.model].filter((n): n is string => typeof n === 'string');
        });
      }
    } catch {
      return 'unreachable';
    }
    const m = this.settings.model;
    const has = names.includes(m) || (!m.includes(':') && names.includes(`${m}:latest`));
    return has ? 'reachable' : 'no_model';
  }

  /** One call at a time, the family's first; a check's call stopped for theirs. */
  private async turn(
    priority: 'interactive' | 'check',
    budgetMs: number,
    began: number,
    signal: AbortSignal | undefined,
    call: (signal: AbortSignal) => Promise<LocalAiAnswer>,
    respectRest = true,
  ): Promise<LocalAiAnswer> {
    const left = () => budgetMs - (this.now() - began);
    const slot = await this.take(priority, Math.max(0, left()));
    // Not ours in time: read without it, and out of the line.
    if (!slot) return { state: 'without', why: 'timeout', ms: this.now() - began };
    const stop = slot.stop;
    try {
      // Rested while it waited: a paper is read without it (Test tries anyway).
      if (respectRest && this.resting()) {
        return { state: 'without', why: 'resting', ms: this.now() - began };
      }
      const remaining = left();
      if (remaining <= 0) return { state: 'without', why: 'timeout', ms: this.now() - began };
      // Whether this call has its whole time: one that waited in line for
      // part of it is no measure of the endpoint (the R4 review, L4).
      const whole = remaining >= budgetMs - LOCAL_AI_WAIT_SLACK_MS;
      const timeout = AbortSignal.timeout(remaining);
      const all = AbortSignal.any([timeout, stop.signal, ...(signal ? [signal] : [])]);
      this.sent += 1;
      const got = await call(all);
      const ms = this.now() - began;
      if (got.state === 'replied') {
        this.failures = 0;
        this.restingUntil = 0;
        this.opts.onState?.('reachable');
        return { ...got, ms };
      }
      const why: LocalAiWithout = signal?.aborted
        ? 'cancelled'
        : stop.signal.aborted
          ? 'preempted'
          : timeout.aborted
            ? 'timeout'
            : got.why;
      // What the breaker counts (the R4 review, L5): the endpoint not to be
      // reached, a server error (5xx), and no answer in a call's whole time.
      // Never being stopped, a call that waited in line, an answer too big,
      // or a 4xx — a model not pulled says so at once, and costs nothing.
      const down =
        why === 'unreachable' ||
        (why === 'http_error' && (got.status ?? 0) >= 500) ||
        (why === 'timeout' && whole);
      if (down) this.failed(why, ms);
      if (why !== 'preempted' && why !== 'cancelled') {
        this.opts.onState?.(
          why === 'http_error' && got.status === 404 ? 'no_model' : 'unreachable',
        );
      }
      return { state: 'without', why, ms, ...(got.status ? { status: got.status } : {}) };
    } finally {
      this.give();
    }
  }

  /**
   * The turn, when it is ours: at once if nobody has it, else in line — the
   * family's before the check's, in order within each, and a check's call
   * running stopped for theirs. Null if it is not ours within `waitMs`.
   */
  private take(priority: 'interactive' | 'check', waitMs: number): Promise<Slot | null> {
    if (!this.busy && this.waiting.length === 0) {
      this.busy = { priority, stop: new AbortController() };
      return Promise.resolve(this.busy);
    }
    if (priority === 'interactive' && this.busy?.priority === 'check') this.busy.stop.abort();
    return new Promise<Slot | null>((resolve) => {
      const w: Waiter = {
        priority,
        done: false,
        grant: (slot) => {
          if (w.done) return false;
          w.done = true;
          clearTimeout(timer);
          resolve(slot);
          return true;
        },
      };
      const timer = setTimeout(() => {
        if (w.done) return;
        w.done = true;
        this.waiting = this.waiting.filter((x) => x !== w);
        resolve(null);
      }, waitMs);
      timer.unref();
      const at =
        priority === 'interactive' ? this.waiting.findIndex((x) => x.priority === 'check') : -1;
      if (at < 0) this.waiting.push(w);
      else this.waiting.splice(at, 0, w);
    });
  }

  /** The turn handed to the next in line, or let go. */
  private give(): void {
    this.busy = null;
    for (let w = this.waiting.shift(); w; w = this.waiting.shift()) {
      const slot: Slot = { priority: w.priority, stop: new AbortController() };
      this.busy = slot;
      if (w.grant(slot)) return;
      this.busy = null;
    }
  }

  private failed(why: LocalAiWithout, ms: number): void {
    this.failures += 1;
    this.opts.log?.('warn', 'the local AI did not answer', { why, ms, failures: this.failures });
    if (this.failures >= LOCAL_AI_FAILURES_TO_REST) {
      this.restingUntil = this.now() + LOCAL_AI_REST_MS;
      this.failures = 0;
      this.opts.log?.(
        'warn',
        'the local AI is rested after failures in a row: papers are read without it',
        {
          for_seconds: LOCAL_AI_REST_MS / 1000,
        },
      );
    }
  }

  private post(path: string, body: string, signal: AbortSignal): Promise<LocalAiAnswer> {
    return this.request('POST', path, body, signal);
  }

  /**
   * One request to the endpoint, at the address its name has now (pinned),
   * its reply read up to LOCAL_AI_REPLY_MAX_BYTES. Never rejects.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: string | null,
    signal: AbortSignal,
    /** The most of the reply read: LOCAL_AI_REPLY_MAX_BYTES, but for the list of models. */
    maxBytes: number = LOCAL_AI_REPLY_MAX_BYTES,
  ): Promise<LocalAiAnswer> {
    const began = this.now();
    const without = (why: LocalAiWithout, status?: number): LocalAiAnswer => ({
      state: 'without',
      why,
      ms: this.now() - began,
      ...(status ? { status } : {}),
    });
    const base = this.settings.url;
    const host = base.hostname.replace(/^\[(.*)\]$/, '$1');
    let address: string;
    try {
      // The name looked up within the call's own time (the R4 review, L3):
      // a slow resolver never holds the call, or the line, past it.
      address = isIP(host) ? host : await raced((this.opts.resolve ?? dns)(host), signal);
    } catch {
      return without(signal.aborted ? 'timeout' : 'unreachable');
    }
    if (signal.aborted) return without('timeout');
    const family = isIP(address) === 6 ? 6 : 4;
    const secure = base.protocol === 'https:';
    const port = base.port ? Number(base.port) : secure ? 443 : 80;
    const prefix = base.pathname.replace(/\/+$/, '');
    const payload = body === null ? null : Buffer.from(body, 'utf8');
    return new Promise<LocalAiAnswer>((done) => {
      let settled = false;
      const finish = (a: LocalAiAnswer) => {
        if (settled) return;
        settled = true;
        clearTimeout(connecting);
        signal.removeEventListener('abort', onAbort);
        done(a);
      };
      const options: https.RequestOptions = {
        method,
        host: address,
        port,
        path: `${prefix}${path}`,
        // The name for the Host header and TLS; the address pinned.
        headers: {
          host: base.host,
          accept: 'application/json',
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
            : {}),
        },
        // The address checked, never the name again: no lookup is made.
        family,
        agent: false,
        ...(secure ? { servername: isIP(host) ? undefined : host } : {}),
      };
      const req = (secure ? https : http).request(options, (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.resume();
          finish(without('http_error', status));
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            finish(without('too_big'));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          finish({
            state: 'replied',
            body: Buffer.concat(chunks).toString('utf8'),
            ms: this.now() - began,
          }),
        );
        res.on('error', () => finish(without('unreachable')));
        res.on('aborted', () => finish(without('unreachable')));
      });
      const connecting = setTimeout(() => {
        finish(without('timeout'));
        req.destroy();
      }, LOCAL_AI_CONNECT_MS);
      connecting.unref();
      req.on('socket', (s) => {
        if (!s.connecting) clearTimeout(connecting);
        else s.once('connect', () => clearTimeout(connecting));
        s.once('secureConnect', () => clearTimeout(connecting));
      });
      const onAbort = () => {
        finish(without('timeout'));
        req.destroy();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('error', () => finish(without('unreachable')));
      if (payload) req.end(payload);
      else req.end();
    });
  }
}
