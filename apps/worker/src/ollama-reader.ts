import {
  AI_READER_MODEL,
  AI_READER_MODELS_MAX,
  AI_READER_PATHS,
  localAiRequestBody,
  type LocalAiOffer,
} from '@fdv/shared';
import type { AiReaderModels, LocalAiAnswer, ReadAsk } from './ai-reader.js';
import {
  LOCAL_AI_PROBE_TIMEOUT_MS,
  LOCAL_AI_TAGS_MAX_BYTES,
  LOCAL_AI_TEST_MS,
  PinnedReader,
} from './pinned-reader.js';

/**
 * The Ollama reader (0.9.0, R4; behind `AiReader` since AIR1, on the shared
 * `PinnedReader` since AIR3): one Ollama-compatible endpoint — the
 * operator's own (FDV_LOCAL_AI_URL and FDV_LOCAL_AI_MODEL, validated at
 * start: http or https, no credentials in it), or the one an owner saved in
 * Settings (AIR1), guarded (`AiReaderGuard`). It is sent to at `/api/chat`
 * and `/api/tags` alone. Its pinning, bounds, line and breaker are
 * `PinnedReader`'s, shared with every kind; what is Ollama's is here: the
 * request's shape, an `Authorization: Bearer` key where one is set, and what
 * its replies look like.
 */

export {
  LOCAL_AI_CONNECT_MS,
  LOCAL_AI_FAILURES_TO_REST,
  LOCAL_AI_PROBE_TIMEOUT_MS,
  LOCAL_AI_REST_MS,
  LOCAL_AI_TAGS_MAX_BYTES,
  LOCAL_AI_TEST_MS,
  LOCAL_AI_WAIT_SLACK_MS,
  type LocalAiClientOptions,
  type Resolve,
} from './pinned-reader.js';

/** Whether an Ollama /api/chat reply is that API's shape: an object with `message.content`. */
function chatShaped(body: string): boolean {
  try {
    const o = JSON.parse(body) as { message?: { content?: unknown } } | null;
    return typeof o === 'object' && o !== null && typeof o.message?.content === 'string';
  } catch {
    return false;
  }
}

/**
 * The model names in an Ollama /api/tags reply — each a model name's shape
 * (AI_READER_MODEL), at most AI_READER_MODELS_MAX, once each — or null when
 * the reply is not that API's shape.
 */
export function ollamaModelNames(body: string): string[] | null {
  let list: unknown;
  try {
    list = (JSON.parse(body) as { models?: unknown } | null)?.models;
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const names: string[] = [];
  for (const m of list) {
    const o = m as { name?: unknown; model?: unknown } | null;
    for (const n of [o?.name, o?.model]) {
      if (typeof n === 'string' && AI_READER_MODEL.test(n) && !names.includes(n)) names.push(n);
    }
    if (names.length >= AI_READER_MODELS_MAX) break;
  }
  return names.slice(0, AI_READER_MODELS_MAX);
}

export class OllamaReader extends PinnedReader {
  readonly kind = 'ollama' as const;
  protected readonly paths = AI_READER_PATHS.ollama;

  /** A key, where one is saved (AIR1): `Authorization: Bearer`, and nothing else. */
  protected headers(): Record<string, string> {
    const key = this.opts.apiKey;
    return key ? { authorization: `Bearer ${key}` } : {};
  }

  /**
   * A paper's words read by the model: the reply as it came, for the
   * proposal thread to read, or why there is none. Never rejects.
   */
  async read(text: string, offer: LocalAiOffer, o: ReadAsk): Promise<LocalAiAnswer> {
    const began = this.now();
    if (this.resting()) return { state: 'without', why: 'resting', ms: 0 };
    const body = localAiRequestBody(this.settings.model, text, offer);
    return this.turn(
      o.priority,
      this.settings.timeoutMs,
      began,
      o.signal,
      (signal) => this.request('POST', '/api/chat', body, signal, { assumed: o.assumed ?? null }),
      true,
      o.stillMay,
    );
  }

  /**
   * Test (R4, Settings → Reading): a tiny fixed prompt, no paper's words,
   * whatever the breaker says — and it answering ends a rest. How long it
   * took, and why not. An answer not in Ollama's own shape is `bad_reply`
   * (AIR1): what it said is never handed on.
   */
  async test(o: { findWhere?: boolean } = {}): Promise<LocalAiAnswer> {
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
      async (signal) => {
        // A Test finds where it runs (AIR1): the address said is not held to.
        const got = await this.request('POST', '/api/chat', body, signal, {
          findWhere: o.findWhere === true,
        });
        if (got.state === 'replied' && !chatShaped(got.body)) {
          return { state: 'without', why: 'bad_reply', ms: got.ms };
        }
        return got;
      },
      false,
    );
  }

  /**
   * Whether the endpoint answers, and has the model (R4): GET /api/tags,
   * which lists the models pulled, its names read from the JSON. An
   * endpoint with /api/chat but no list (404) is taken as answering, the
   * model not known: Test says whether it has it. Not a turn: it sends no
   * paper, and everything it does — its lookup too — is within
   * LOCAL_AI_PROBE_TIMEOUT_MS.
   */
  async probe(): Promise<'reachable' | 'unreachable' | 'no_model'> {
    const got = await this.request(
      'GET',
      '/api/tags',
      null,
      AbortSignal.timeout(this.opts.probeMs ?? LOCAL_AI_PROBE_TIMEOUT_MS),
      { maxBytes: LOCAL_AI_TAGS_MAX_BYTES },
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

  /**
   * The models the reader has (AIR1, Settings → Reading → AI reader): GET
   * /api/tags, as the probe asks, and the names alone (`ollamaModelNames`).
   * A reply not in that shape is `bad_reply`, and nothing else of it is
   * kept. Not a turn: it sends no paper.
   */
  async models(): Promise<AiReaderModels> {
    const got = await this.request(
      'GET',
      '/api/tags',
      null,
      AbortSignal.timeout(this.opts.probeMs ?? LOCAL_AI_PROBE_TIMEOUT_MS),
      { maxBytes: LOCAL_AI_TAGS_MAX_BYTES },
    );
    if (got.state !== 'replied') return got;
    const names = ollamaModelNames(got.body);
    if (!names) return { state: 'without', why: 'bad_reply', ms: got.ms };
    return { state: 'listed', names, ms: got.ms };
  }
}
