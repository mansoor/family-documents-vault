import {
  AI_READER_PATHS,
  ANTHROPIC_VERSION,
  aiReaderRunsAtSaid,
  anthropicRequestBody,
  openAiRequestBody,
  type AiReaderRunsAt,
  type LocalAiOffer,
} from '@fdv/shared';
import type { AiReaderModels, LocalAiAnswer, ReadAsk } from './ai-reader.js';
import { LOCAL_AI_TEST_MS, PinnedReader, type LocalAiClientOptions } from './pinned-reader.js';

/**
 * The readers AIR3 adds (0.9.0, plan-ai-readers decision 1), each on the
 * shared `PinnedReader` — pinned to the address resolved for each call, no
 * redirect or proxy, only its own paths, the guards of decision 9, the
 * bounds, the line and the breaker — so nothing here keeps a call safe that
 * Ollama's does not. Each says only how its requests and replies look.
 *
 * Neither is ever sent a page or a file: only the words the vault read, the
 * kinds' names and the family's display names (decision 3), and only once
 * the sending rule let the paper go (`mayReadWith`, in the worker before
 * every call). What either answers is read on the proposal thread
 * (`readLocalAiReply`, told whose envelope it is), and what Test and the
 * list of models found never hands on a word of a reply: one not in that
 * API's shape is `bad_reply`.
 */

/** Whether a Messages API reply is that API's shape: a message, its content a list of blocks. */
function messageShaped(body: string): boolean {
  try {
    const o = JSON.parse(body) as { type?: unknown; content?: unknown } | null;
    return !!o && typeof o === 'object' && o.type === 'message' && Array.isArray(o.content);
  } catch {
    return false;
  }
}

/** Whether a chat completion is that API's shape: a choice with a message whose content is words or null. */
function completionShaped(body: string): boolean {
  try {
    const o = JSON.parse(body) as { choices?: unknown } | null;
    if (!o || typeof o !== 'object' || !Array.isArray(o.choices)) return false;
    const m = (o.choices[0] as { message?: { content?: unknown } } | undefined)?.message;
    return !!m && typeof m === 'object' && (typeof m.content === 'string' || m.content === null);
  } catch {
    return false;
  }
}

/** A refusal that speaks of the response format (the AIR3 review, M2): only then is it asked again. */
const ABOUT_FORMAT = /response_format|json_schema|schema/i;

/** Test's tiny fixed prompt: no paper. */
const READY = 'Reply with the single word: ready';

/**
 * Anthropic's Messages API (AIR3): `POST https://api.anthropic.com/v1/messages`
 * with `x-api-key` and `anthropic-version`, the reply made structured by the
 * one tool it must call, whose input schema is R4's form. Its address is
 * fixed (a test alone gives another); it is always a cloud service. Its
 * models are those `GET /v1/models` lists.
 */
export class AnthropicReader extends PinnedReader {
  readonly kind = 'anthropic' as const;
  protected readonly paths = AI_READER_PATHS.anthropic;

  /** Always a cloud service (decision 2), wherever its address resolves. */
  protected override where(): AiReaderRunsAt {
    return 'cloud';
  }

  override get runsAt(): AiReaderRunsAt {
    return 'cloud';
  }

  /** The key, where one is saved, and the API's version: never `Authorization`. */
  protected headers(): Record<string, string> {
    const key = this.opts.apiKey;
    return { 'anthropic-version': ANTHROPIC_VERSION, ...(key ? { 'x-api-key': key } : {}) };
  }

  async read(text: string, offer: LocalAiOffer, o: ReadAsk): Promise<LocalAiAnswer> {
    const began = this.now();
    if (this.resting()) return { state: 'without', why: 'resting', ms: 0 };
    const body = anthropicRequestBody(this.settings.model, text, offer);
    return this.turn(
      o.priority,
      this.settings.timeoutMs,
      began,
      o.signal,
      (signal) => this.request('POST', '/v1/messages', body, signal),
      true,
      o.stillMay,
    );
  }

  async test(o: { findWhere?: boolean } = {}): Promise<LocalAiAnswer> {
    const body = JSON.stringify({
      model: this.settings.model,
      max_tokens: 4,
      temperature: 0,
      messages: [{ role: 'user', content: READY }],
    });
    return this.turn(
      'interactive',
      this.opts.testMs ?? LOCAL_AI_TEST_MS,
      this.now(),
      undefined,
      async (signal) => {
        const got = await this.request('POST', '/v1/messages', body, signal, {
          findWhere: o.findWhere === true,
        });
        if (got.state === 'replied' && !messageShaped(got.body)) {
          return { state: 'without', why: 'bad_reply', ms: got.ms };
        }
        return got;
      },
      false,
    );
  }

  /** The models the API lists (AIR3's addition to decision 9's paths): the names alone. */
  models(): Promise<AiReaderModels> {
    return this.dataModels('/v1/models?limit=1000');
  }

  probe(): Promise<'reachable' | 'unreachable' | 'no_model'> {
    return this.probeByModels();
  }
}

/** What an OpenAI-compatible reader is told beyond the shared options. */
export interface OpenAiCompatibleOptions extends LocalAiClientOptions {
  /**
   * The owner's word that it is on their own network (decision 2): it
   * counts as there only at a private address too. Left out, a cloud service.
   */
  ownNetwork?: boolean;
}

/**
 * An OpenAI-compatible server (AIR3): OpenAI itself, or LM Studio, vLLM or
 * llama.cpp's server. `POST {base}/v1/chat/completions` with the form's
 * schema as `response_format: json_schema` — or, where the server refuses
 * that (a 400 or 422), `json_object`, remembered for this reader once it
 * answers so. `Authorization: Bearer` only where a key is set. Its models
 * are those `GET /v1/models` lists.
 */
export class OpenAiCompatibleReader extends PinnedReader {
  readonly kind = 'openai_compatible' as const;
  protected readonly paths = AI_READER_PATHS.openai_compatible;
  /** How it is asked for JSON: the schema, until it refused that and took an object. */
  format: 'json_schema' | 'json_object' = 'json_schema';

  constructor(
    settings: ConstructorParameters<typeof PinnedReader>[0],
    protected override readonly opts: OpenAiCompatibleOptions = {},
  ) {
    super(settings, opts);
  }

  /** A cloud service unless the owner said otherwise and it was found at a private address. */
  protected override where(found: AiReaderRunsAt): AiReaderRunsAt {
    return aiReaderRunsAtSaid('openai_compatible', found, this.opts.ownNetwork === true);
  }

  protected headers(): Record<string, string> {
    const key = this.opts.apiKey;
    return key ? { authorization: `Bearer ${key}` } : {};
  }

  async read(text: string, offer: LocalAiOffer, o: ReadAsk): Promise<LocalAiAnswer> {
    const began = this.now();
    if (this.resting()) return { state: 'without', why: 'resting', ms: 0 };
    const model = this.settings.model;
    const assumed = o.assumed ?? null;
    return this.turn(
      o.priority,
      this.settings.timeoutMs,
      began,
      o.signal,
      async (signal) => {
        const asked = this.format;
        const got = await this.request(
          'POST',
          '/v1/chat/completions',
          openAiRequestBody(model, text, offer, asked),
          signal,
          { assumed, ...(asked === 'json_schema' ? { peek: ABOUT_FORMAT } : {}) },
        );
        // The schema refused — a 400 or 422 that speaks of the response
        // format, not the model or the key (the AIR3 review, M2): asked again
        // for a JSON object, a second send of the words, counted as one
        // (`again`); and that remembered once it answers.
        if (
          asked === 'json_schema' &&
          got.state === 'without' &&
          got.why === 'http_error' &&
          got.aboutFormat === true &&
          !signal.aborted &&
          (!o.again || (await o.again().catch(() => false)))
        ) {
          const again = await this.request(
            'POST',
            '/v1/chat/completions',
            openAiRequestBody(model, text, offer, 'json_object'),
            signal,
            { assumed },
          );
          if (again.state === 'replied') {
            this.format = 'json_object';
            this.opts.log?.('info', 'the AI reader took JSON without its schema', {
              kind: this.kind,
            });
          }
          return again;
        }
        // Never what it said: a yes or no about the format, let go here.
        if (got.state === 'without') {
          return {
            state: 'without',
            why: got.why,
            ms: got.ms,
            ...(got.status ? { status: got.status } : {}),
          };
        }
        return got;
      },
      true,
      o.stillMay,
    );
  }

  async test(o: { findWhere?: boolean } = {}): Promise<LocalAiAnswer> {
    const body = JSON.stringify({
      model: this.settings.model,
      max_tokens: 4,
      temperature: 0,
      stream: false,
      messages: [{ role: 'user', content: READY }],
    });
    return this.turn(
      'interactive',
      this.opts.testMs ?? LOCAL_AI_TEST_MS,
      this.now(),
      undefined,
      async (signal) => {
        const got = await this.request('POST', '/v1/chat/completions', body, signal, {
          findWhere: o.findWhere === true,
        });
        if (got.state === 'replied' && !completionShaped(got.body)) {
          return { state: 'without', why: 'bad_reply', ms: got.ms };
        }
        return got;
      },
      false,
    );
  }

  models(): Promise<AiReaderModels> {
    return this.dataModels('/v1/models');
  }

  probe(): Promise<'reachable' | 'unreachable' | 'no_model'> {
    return this.probeByModels();
  }
}
