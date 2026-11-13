import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  AI_READER_MODEL,
  AI_READER_MODELS_MAX,
  aiReaderAddressAllowed,
  aiReaderIdentity,
  aiReaderRunsAtByName,
  aiReaderRunsAtOf,
  LOCAL_AI_REPLY_MAX_BYTES,
  type AiReaderKind,
  type AiReaderRunsAt,
  type LocalAiOffer,
} from '@fdv/shared';
import type {
  AiReader,
  AiReaderGuard,
  AiReaderModels,
  ReadAsk,
  LocalAiAnswer,
  LocalAiSettings,
  LocalAiWithout,
} from './ai-reader.js';

/**
 * What every kind of AI reader shares (0.9.0, R4's client; a base of its
 * own since AIR3, so Ollama, Anthropic and an OpenAI-compatible server are
 * held to one set of guards, never three): in the worker alone — never in
 * the API's request path. Each kind says only its paths, its headers and
 * how its requests and replies look; everything that keeps a call safe is
 * here, once.
 *
 *  - **Pinned:** the reader's name is resolved once a call and the
 *    connection made to that address (the name kept for TLS and the Host
 *    header), as the mailbox's is (S4, mail-address.ts): a DNS change
 *    mid-call cannot send it elsewhere. Redirects are never followed;
 *    proxies in the environment are never used. A reader saved in Settings
 *    is guarded besides (`AiReaderGuard`, decision 9): the address found is
 *    checked before anything is sent — never link-local; on the hosted
 *    edition never inside a network; only the allowed ports; never one of
 *    the vault's own services; never a public one for a reader said to be on
 *    the household's own network — and refused (`refused`) without a byte
 *    sent.
 *  - **Only its own paths** (decision 9, `AI_READER_PATHS`): a call to
 *    anything else is a mistake here, and is never made.
 *  - **Bounded:** a connection in LOCAL_AI_CONNECT_MS, the whole call in its
 *    timeout counted from when it was asked for, and the reply read only up
 *    to its bound — more, and it is dropped unread. A paper's reply is
 *    handed on as it came: it is parsed on the proposal thread
 *    (`readLocalAiReply`, told whose envelope it is), never on this event
 *    loop.
 *  - **One call at a time**, a reader: a paper the family is waiting on
 *    (`interactive`: a batch's item, Test) goes before the Reading check's
 *    (`check`), and stops one of the check's that is running.
 *  - **A circuit breaker:** after LOCAL_AI_FAILURES_TO_REST failures in a
 *    row it rests for LOCAL_AI_REST_MS: nothing is sent, each paper is read
 *    without it at once. Then one call is tried; it answers, and the rest is
 *    over.
 *  - **Says nothing of a paper:** what it logs is why and how long, never a
 *    word sent or received. Test and the list of models never hand on what
 *    the reader said: an answer not in its own API's shape is `bad_reply`.
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
/** The most of a list of models read: a list of many models is long. */
export const LOCAL_AI_TAGS_MAX_BYTES = 512 * 1024;
/** A call that waited longer than this in line has not its whole time (L4). */
export const LOCAL_AI_WAIT_SLACK_MS = 250;

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

/** A host resolved: DNS, unless a test stands in. */
export type Resolve = (host: string) => Promise<string>;
const dns: Resolve = async (host) => (await lookup(host, { verbatim: true })).address;

/** The worker's own addresses: a Docker network's among them. */
function ownAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) out.add(a.address.toLowerCase());
  }
  return out;
}

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

/**
 * The model names in a `{ data: [{ id }] }` list (OpenAI's and Anthropic's
 * `/v1/models`, AIR3) — each a model name's shape (AI_READER_MODEL), at most
 * AI_READER_MODELS_MAX, once each — or null when the reply is not that shape.
 */
export function dataModelNames(body: string): string[] | null {
  let list: unknown;
  try {
    list = (JSON.parse(body) as { data?: unknown } | null)?.data;
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const names: string[] = [];
  for (const m of list) {
    const id = (m as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && AI_READER_MODEL.test(id) && !names.includes(id)) names.push(id);
    if (names.length >= AI_READER_MODELS_MAX) break;
  }
  return names;
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
  /** The API key saved with the reader (AIR1): sent as its kind sends one, only when set. */
  apiKey?: string | null;
  /**
   * The guards on an address an owner typed (AIR1, decision 9). Absent for
   * .env's reader, which is the operator's to choose.
   */
  guard?: AiReaderGuard;
  /** The worker's own addresses, for the hosted edition's guard: the real ones, unless a test says. */
  ownAddresses?: () => Set<string>;
  /**
   * Which reader it is (`aiReaderIdentity`; the AIR3 review, S3): a saved
   * one's, said by HouseholdAiReaders; .env's, its kind and host, unless said.
   */
  identity?: string;
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

/** One request's own bounds and leave. */
export interface RequestOptions {
  /** The most of the reply read: LOCAL_AI_REPLY_MAX_BYTES unless said. */
  maxBytes?: number;
  /** A Test, which finds where it runs rather than holding it to where it was said to. */
  findWhere?: boolean;
  /**
   * Where the sending rule took it to run (the AIR3 review, M5): on the
   * household's own network, and a public address found is refused —
   * nothing sent — guard or none.
   */
  assumed?: AiReaderRunsAt | null;
  /**
   * For a 400 or 422: whether its body speaks of this (the AIR3 review, M2)
   * — read up to ERROR_PEEK_BYTES to tell, never kept, logged or handed on.
   */
  peek?: RegExp;
}

/** The most of a refusal's body read, to tell whether it speaks of the response format. */
const ERROR_PEEK_BYTES = 4096;

export abstract class PinnedReader implements AiReader {
  abstract readonly kind: AiReaderKind;
  /** The only paths this kind is ever sent to (`AI_READER_PATHS`). */
  protected abstract readonly paths: readonly string[];
  /** Failures in a row the breaker has counted (L5), for the tests. */
  failures = 0;
  private restingUntil = 0;
  private busy: Slot | null = null;
  private waiting: Waiter[] = [];
  /** Calls sent, for the tests and the counts. */
  sent = 0;
  /** Where the last call found the address, by what it resolved to; null, none made. */
  protected found: AiReaderRunsAt | null = null;

  constructor(
    readonly settings: LocalAiSettings,
    protected readonly opts: LocalAiClientOptions = {},
  ) {}

  /** The headers that say who is asking: a key, where one is set, as this kind sends it. */
  protected abstract headers(): Record<string, string>;

  abstract read(text: string, offer: LocalAiOffer, o: ReadAsk): Promise<LocalAiAnswer>;
  abstract test(o?: { findWhere?: boolean }): Promise<LocalAiAnswer>;
  abstract models(): Promise<AiReaderModels>;
  abstract probe(): Promise<'reachable' | 'unreachable' | 'no_model'>;

  /**
   * Where it counts as running, from where its address was found (decision
   * 2): as found, unless the kind says otherwise (Anthropic, always a cloud
   * service; an OpenAI-compatible reader, one unless the owner said).
   */
  protected where(found: AiReaderRunsAt): AiReaderRunsAt {
    return found;
  }

  /** Where the last call found it runs (AIR1); null, none made. */
  get lastRunsAt(): AiReaderRunsAt | null {
    return this.found === null ? null : this.where(this.found);
  }

  /**
   * Where it runs for the sending rule (AIR3, `mayReadWith`): where it was
   * saved to run (its Test found it, and the guard holds it there); else
   * where its last call found it; else what its name alone says; else null,
   * which the rule counts as a cloud service.
   */
  get runsAt(): AiReaderRunsAt | null {
    // Through the kind's own word too (the AIR3 review, S1): an
    // OpenAI-compatible reader the owner no longer says is theirs is a cloud
    // service, whatever was stored.
    const said = this.opts.guard?.runsAt;
    if (said) return this.where(said);
    if (this.lastRunsAt) return this.lastRunsAt;
    const byName = aiReaderRunsAtByName(this.settings.url.hostname);
    return byName ? this.where(byName) : null;
  }

  /** Which reader it is, for "Also send sensitive papers" (S3): .env's by its kind and host. */
  get identity(): string {
    return this.opts.identity ?? aiReaderIdentity('env', this.kind, this.settings.url.host);
  }

  protected now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Whether it is resting after failures (the breaker open). */
  resting(): boolean {
    return this.now() < this.restingUntil;
  }

  /** One call at a time, the family's first; a check's call stopped for theirs. */
  protected async turn(
    priority: 'interactive' | 'check',
    budgetMs: number,
    began: number,
    signal: AbortSignal | undefined,
    call: (signal: AbortSignal) => Promise<LocalAiAnswer>,
    respectRest = true,
    /** Asked once the turn is ours, before anything is sent (the AIR3 review, S2). */
    stillMay?: () => Promise<boolean>,
  ): Promise<LocalAiAnswer> {
    const left = () => budgetMs - (this.now() - began);
    const slot = await this.take(priority, Math.max(0, left()));
    // Not ours in time: read without it, and out of the line — nothing sent.
    if (!slot) return { state: 'without', why: 'timeout', ms: this.now() - began, queued: true };
    const stop = slot.stop;
    try {
      // Rested while it waited: a paper is read without it (Test tries anyway).
      if (respectRest && this.resting()) {
        return { state: 'without', why: 'resting', ms: this.now() - began };
      }
      // The paper as it is now, asked again right before its words go: one
      // made Only me or sensitive while it waited is never sent.
      // Not to be asked (the database a moment away): not sent.
      if (stillMay && !(await stillMay().catch(() => false))) {
        return { state: 'without', why: 'held', ms: this.now() - began };
      }
      const remaining = left();
      if (remaining <= 0) {
        return { state: 'without', why: 'timeout', ms: this.now() - began, queued: true };
      }
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
      // Nor an address refused (AIR1): nothing was sent.
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
    this.opts.log?.('warn', 'the AI reader did not answer', {
      kind: this.kind,
      why,
      ms,
      failures: this.failures,
    });
    if (this.failures >= LOCAL_AI_FAILURES_TO_REST) {
      this.restingUntil = this.now() + LOCAL_AI_REST_MS;
      this.failures = 0;
      this.opts.log?.(
        'warn',
        'the AI reader is rested after failures in a row: papers are read without it',
        { kind: this.kind, for_seconds: LOCAL_AI_REST_MS / 1000 },
      );
    }
  }

  /**
   * Whether the address a call resolved to may be sent to (AIR1, decision
   * 9), for a reader an owner saved: only the ports allowed; never one of
   * the vault's own services; never link-local or "this network"; on the
   * hosted edition never inside a network, nor one of the worker's own
   * addresses, nor over http; and never a public one for a reader said to
   * be on the household's own network. .env's reader is the operator's to
   * choose.
   */
  private async allowed(
    address: string,
    secure: boolean,
    port: number,
    findWhere: boolean,
    assumed: AiReaderRunsAt | null | undefined,
  ): Promise<boolean> {
    // The sending rule let the paper go as to a reader on the household's
    // own network (the AIR3 review, M5): at a public address it is not —
    // .env's reader too, which has no guard of its own.
    if (assumed === 'own_network' && aiReaderRunsAtOf(address) === 'cloud') return false;
    const g = this.opts.guard;
    if (!g) return true;
    // Only the ports the operator allows (the AIR1 review, S2a).
    if (g.ports && !g.ports.includes(port)) return false;
    // Never one of the vault's own services (S2c).
    if (g.vaultsOwn && (await g.vaultsOwn()).has(address.toLowerCase())) return false;
    if (g.publicOnly) {
      if (!secure) return false;
      if ((this.opts.ownAddresses ?? ownAddresses)().has(address.toLowerCase())) return false;
    }
    if (!aiReaderAddressAllowed(address, { publicOnly: g.publicOnly })) return false;
    if (!findWhere && g.runsAt === 'own_network' && aiReaderRunsAtOf(address) === 'cloud') {
      return false;
    }
    return true;
  }

  /**
   * One request to the reader, at the address its name has now (pinned),
   * its reply read up to its bound. Never rejects. Only the kind's own paths
   * are ever asked for (a fixed query of the vault's own aside).
   */
  protected async request(
    method: 'GET' | 'POST',
    path: string,
    body: string | null,
    signal: AbortSignal,
    o: RequestOptions = {},
  ): Promise<LocalAiAnswer> {
    const began = this.now();
    const maxBytes = o.maxBytes ?? LOCAL_AI_REPLY_MAX_BYTES;
    const without = (why: LocalAiWithout, status?: number): LocalAiAnswer => ({
      state: 'without',
      why,
      ms: this.now() - began,
      ...(status ? { status } : {}),
    });
    // Nothing but the reader's own paths (decision 9).
    const bare = path.split('?')[0] ?? '';
    if (!this.paths.includes(bare)) return without('refused');
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
    const secure = base.protocol === 'https:';
    const port = base.port ? Number(base.port) : secure ? 443 : 80;
    // The address found, checked before a byte is sent (AIR1).
    if (
      !isIP(address) ||
      !(await this.allowed(address, secure, port, o.findWhere === true, o.assumed))
    ) {
      return without('refused');
    }
    if (signal.aborted) return without('timeout');
    this.found = aiReaderRunsAtOf(address);
    const family = isIP(address) === 6 ? 6 : 4;
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
          ...this.headers(),
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
        // A redirect, or anything but 200, is no answer: never followed,
        // and its body never read — but for a 400 or 422 whose caller asks
        // whether it speaks of one thing (M2): a yes or no, the words let go.
        if (status !== 200) {
          const peek = o.peek;
          if (peek && (status === 400 || status === 422)) {
            const seen: Buffer[] = [];
            let got = 0;
            const said = () => {
              const words = Buffer.concat(seen).toString('utf8');
              finish({
                state: 'without',
                why: 'http_error',
                ms: this.now() - began,
                status,
                aboutFormat: peek.test(words),
              });
              req.destroy();
            };
            res.on('data', (c: Buffer) => {
              if (got >= ERROR_PEEK_BYTES) return;
              seen.push(c.subarray(0, ERROR_PEEK_BYTES - got));
              got += c.length;
              if (got >= ERROR_PEEK_BYTES) said();
            });
            res.on('end', said);
            res.on('error', () => finish(without('http_error', status)));
            res.on('aborted', () => finish(without('http_error', status)));
            return;
          }
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
            shape: this.kind,
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

  /**
   * A list of models, `{ data: [{ id }] }` (AIR3: OpenAI's and Anthropic's
   * `/v1/models`): the names alone. A reply not in that shape is
   * `bad_reply`, and nothing else of it is kept. Not a turn: it sends no paper.
   */
  protected async dataModels(path: string): Promise<AiReaderModels> {
    const got = await this.request(
      'GET',
      path,
      null,
      AbortSignal.timeout(this.opts.probeMs ?? LOCAL_AI_PROBE_TIMEOUT_MS),
      { maxBytes: LOCAL_AI_TAGS_MAX_BYTES },
    );
    if (got.state !== 'replied') return got;
    const names = dataModelNames(got.body);
    if (!names) return { state: 'without', why: 'bad_reply', ms: got.ms };
    return { state: 'listed', names, ms: got.ms };
  }

  /** Whether it answers and has the model, by its list of models (AIR3's kinds). */
  protected async probeByModels(): Promise<'reachable' | 'unreachable' | 'no_model'> {
    const got = await this.models();
    if (got.state !== 'listed') return 'unreachable';
    return got.names.includes(this.settings.model) ? 'reachable' : 'no_model';
  }
}
