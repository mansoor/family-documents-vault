import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { openAiReaderKey } from '@fdv/crypto';
import type { Db } from '@fdv/db';
import {
  AI_READER_DEFAULT_PORTS,
  AI_READER_KINDS_OFFERED,
  AI_READER_SERVICE_NAMES,
  ANTHROPIC_BASE_URL,
  aiReaderAddress,
  aiReaderHostedAllows,
  aiReaderIdentity,
  aiReaderPort,
  aiReaderUnprovenProblem,
  type AiReaderKind,
  type AiReaderRunsAt,
  type LocalAiOffer,
} from '@fdv/shared';
import { AnthropicReader, OpenAiCompatibleReader } from './cloud-readers.js';
import { OllamaReader } from './ollama-reader.js';
import type { LocalAiClientOptions } from './pinned-reader.js';

/**
 * The AI reader (0.9.0, R4; an interface since AIR1): what reads a paper's
 * words beside the rules, whichever kind it is — Ollama (`OllamaReader`),
 * and since AIR3 Anthropic (`AnthropicReader`) and an OpenAI-compatible
 * server (`OpenAiCompatibleReader`), all on `PinnedReader`. The reader a household's
 * papers go to is .env's where the operator set one (it wins, decision 8),
 * else the one an owner saved in Settings, once a Test passed
 * (`HouseholdAiReaders`), unless FDV_AI_READER_SETTINGS=off.
 */

type Log = (level: string, msg: string, extra?: Record<string, unknown>) => void;

export interface LocalAiSettings {
  /** FDV_LOCAL_AI_URL, as validated, or the address saved: its base (no trailing slash). */
  url: URL;
  /** FDV_LOCAL_AI_MODEL, or the model saved. */
  model: string;
  /** FDV_LOCAL_AI_TIMEOUT_SECONDS, or the timeout saved, in milliseconds. */
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
  /** An answer, but not 200 (a model not pulled is 404; a redirect, never followed). */
  | 'http_error'
  /** More than LOCAL_AI_REPLY_MAX_BYTES. */
  | 'too_big'
  /** A paper the family waits on came first (a Reading check's call alone). */
  | 'preempted'
  /** The caller gave up (a check cancelled). */
  | 'cancelled'
  /** The address found is one the vault won't send to (AIR1, decision 9): nothing was sent. */
  | 'refused'
  /** An answer, but not in the reader's own API's shape (AIR1; Test and the models alone). */
  | 'bad_reply'
  /**
   * The sending rule, asked again once the turn was its, said no (the AIR3
   * review, S2): the paper changed while it waited, and nothing was sent.
   */
  | 'held';

/** How a paper is asked about (AIR3): its line, and what is asked again before it goes. */
export interface ReadAsk {
  priority: 'interactive' | 'check';
  signal?: AbortSignal;
  /**
   * Asked once the turn is the paper's, right before its words go (the
   * AIR3 review, S2): false, and nothing is sent (`held`).
   */
  stillMay?: () => Promise<boolean>;
  /**
   * Asked before the same words are sent again (an OpenAI-compatible
   * server's json_object retry; the review, M2): false — this month's papers
   * all sent — and they are not.
   */
  again?: () => Promise<boolean>;
  /**
   * Where the sending rule took the reader to run (the review, M5): on the
   * household's own network, and an address found to be public is refused,
   * nothing sent — .env's reader included, which has no guard of its own.
   */
  assumed?: AiReaderRunsAt | null;
}

export type LocalAiAnswer =
  /** `shape`: whose API's envelope the body is (AIR3); Ollama's where not said. */
  | { state: 'replied'; body: string; ms: number; shape?: AiReaderKind }
  | {
      state: 'without';
      why: LocalAiWithout;
      ms: number;
      status?: number;
      /**
       * It never left the line: its turn did not come in time, and nothing
       * was sent (the AIR3 review, M3) — not counted against the month's cap.
       */
      queued?: true;
      /**
       * A refusal (400 or 422) that speaks of the response format — its body
       * read only to tell this, never kept or shown (the AIR3 review, M2).
       */
      aboutFormat?: boolean;
    };

/** The reader's list of models: names alone, or why none. */
export type AiReaderModels =
  | { state: 'listed'; names: string[]; ms: number }
  | { state: 'without'; why: LocalAiWithout; ms: number; status?: number };

/**
 * The guards on an address an owner typed (AIR1, decision 9), checked on the
 * address each call resolves to, before anything is sent.
 */
export interface AiReaderGuard {
  /** The hosted edition: only https, and only to a public address. */
  publicOnly: boolean;
  /**
   * Where the reader was found to run when its Test passed: one said to be
   * on the household's own network is sent nothing at a public address.
   * Null while not known (a Test, which finds it).
   */
  runsAt: AiReaderRunsAt | null;
  /** FDV_AI_READER_ALLOWED_PORTS (the AIR1 review, S2a): any other port is refused. */
  ports?: readonly number[];
  /** The vault's own services' addresses (S2c), loopback aside: never a reader. */
  vaultsOwn?: () => Promise<Set<string>>;
}

/** A reader of a paper's words, whichever kind. */
export interface AiReader {
  readonly kind: AiReaderKind;
  readonly settings: LocalAiSettings;
  /** Where the last call found it runs; null, none made. */
  readonly lastRunsAt: AiReaderRunsAt | null;
  /**
   * Where it runs for the sending rule (AIR3, `mayReadWith`): where it was
   * saved to run, else found, else its name says; null, not known — which
   * the rule counts as a cloud service.
   */
  readonly runsAt: AiReaderRunsAt | null;
  /**
   * Which reader it is, for "Also send sensitive papers" (the AIR3 review,
   * S3): `aiReaderIdentity` — a saved one's kind and address, .env's kind and host.
   */
  readonly identity: string;
  /** A paper's words read: the reply as it came, for the proposal thread to read. Never rejects. */
  read(text: string, offer: LocalAiOffer, o: ReadAsk): Promise<LocalAiAnswer>;
  /**
   * Test: a tiny fixed prompt, no paper. Never rejects. `findWhere`: where
   * it runs is found, not held to where it was said to run.
   */
  test(o?: { findWhere?: boolean }): Promise<LocalAiAnswer>;
  /** The models it has, by name alone. Never rejects. */
  models(): Promise<AiReaderModels>;
  /** Whether it answers and has the model. */
  probe(): Promise<'reachable' | 'unreachable' | 'no_model'>;
  /** Resting after failures in a row. */
  resting(): boolean;
}

/** The reader an owner saved for the household, as the worker reads it (0089). */
export interface SavedAiReader {
  kind: AiReaderKind;
  base_url: string | null;
  model: string;
  timeout_seconds: number;
  runs_at: AiReaderRunsAt;
  api_key_encrypted: Buffer | null;
  status: 'untested' | 'ok' | 'failed';
  updated_at: Date;
  /** The hosted edition's rule, as the API stamped it (the AIR1 review, S1). */
  https_only: boolean;
  /** A Test has passed at this kind and address (S2b). */
  address_proven: boolean;
  /** The owner's word that an OpenAI-compatible reader is on their own network (0092, AIR3). */
  own_network: boolean;
}

/** The household's saved reader, whatever its status; undefined, none. As the vault. */
export async function savedAiReader(trx: Db, hh: string): Promise<SavedAiReader | undefined> {
  return trx
    .selectFrom('ai_reader')
    .select([
      'kind',
      'base_url',
      'model',
      'timeout_seconds',
      'runs_at',
      'api_key_encrypted',
      'status',
      'updated_at',
      'https_only',
      'address_proven',
      'own_network',
    ])
    .where('household_id', '=', hh)
    .executeTakeFirst();
}

/** Why a saved reader could not be made into one to call. */
export type NotBuilt = 'not_offered' | 'refused' | 'key';

export interface HouseholdAiReadersOptions {
  /** deriveKey(master, AI_READER_KEY_PURPOSE): what a saved API key is opened with. */
  key: Buffer;
  /**
   * The hosted edition (FDV_EDITION=hosted): only https to a public address.
   * A reader the API saved as https-only is held to it too, whatever this
   * says (the AIR1 review, S1).
   */
  publicOnly: boolean;
  /** FDV_AI_READER_ALLOWED_PORTS (S2a): the default list unless set. */
  ports?: readonly number[];
  /** How the vault's own service names are resolved (S2c): DNS, unless a test says. */
  resolveAll?: (host: string) => Promise<string[]>;
  log?: Log;
  /** Tests: the network stood in for, and the clock. */
  client?: Pick<LocalAiClientOptions, 'resolve' | 'now' | 'testMs' | 'probeMs' | 'ownAddresses'>;
  /** Tests alone: where Anthropic's reader is sent, in place of its fixed address. */
  anthropicUrl?: string;
}

/**
 * The readers owners saved in Settings (AIR1), a household each: built from
 * the saved row — its key opened here, the guards set — and kept while the
 * row is as it was, so each keeps its own line and breaker. Used only where
 * .env sets no reader, and FDV_AI_READER_SETTINGS is not off (main.ts).
 */
export class HouseholdAiReaders {
  private readonly kept = new Map<string, { print: string; reader: AiReader }>();
  private own: { at: number; set: Promise<Set<string>> } | null = null;

  constructor(private readonly o: HouseholdAiReadersOptions) {}

  /**
   * The vault's own addresses (the AIR1 review, S2c), found again each
   * minute: the worker's own but loopback, and what the compose file's
   * service names resolve to — loopback aside, which a reader on a family's
   * own server may be.
   */
  private vaultsOwn = (): Promise<Set<string>> => {
    const now = Date.now();
    if (this.own && now - this.own.at < 60_000) return this.own.set;
    const set = (async () => {
      const out = new Set<string>();
      const mine = this.o.client?.ownAddresses?.() ?? workerAddresses();
      for (const a of mine) out.add(a.toLowerCase());
      const resolveAll = this.o.resolveAll ?? dnsAll;
      for (const name of AI_READER_SERVICE_NAMES) {
        try {
          for (const a of await resolveAll(name)) out.add(a.toLowerCase());
        } catch {
          // Not a name here.
        }
      }
      for (const a of [...out]) if (isLoopback(a)) out.delete(a);
      return out;
    })();
    this.own = { at: now, set };
    return set;
  };

  /**
   * The reader kept for the household, when it is the one saved as it is
   * now (AIR1 review, M5): Test and the models go through it, its line and
   * breaker, and a Test that answers ends its rest.
   */
  keptFor(hh: string, row: SavedAiReader): AiReader | null {
    const had = this.kept.get(hh);
    return had && had.print === fingerprint(row) ? had.reader : null;
  }

  /**
   * The reader a household's papers go to now: its saved one, once a Test
   * passed for it as it is; or none. Read as the vault, inside the caller's
   * transaction.
   */
  async readerFor(trx: Db, hh: string): Promise<AiReader | null> {
    const row = await savedAiReader(trx, hh);
    if (!row || row.status !== 'ok') {
      this.kept.delete(hh);
      return null;
    }
    const print = fingerprint(row);
    const had = this.kept.get(hh);
    if (had?.print === print) return had.reader;
    const built = this.build(hh, row, row.runs_at);
    if ('not' in built) {
      this.kept.delete(hh);
      return null;
    }
    this.kept.set(hh, { print, reader: built.reader });
    return built.reader;
  }

  /**
   * A reader made from a saved row, whatever its status — a fresh one, for
   * Test and the list of models, which find where it runs (`runsAt` null) —
   * or why it can't be. Only the kinds this vault reads with; only an
   * address that is one the vault keeps; and its key, if any, opened.
   */
  build(
    hh: string,
    row: SavedAiReader,
    runsAt: AiReaderRunsAt | null = null,
  ): { reader: AiReader } | { not: NotBuilt } {
    if (!AI_READER_KINDS_OFFERED.includes(row.kind)) return { not: 'not_offered' };
    // The strictest of the worker's edition and the rule saved with it (S1).
    const publicOnly = this.o.publicOnly || row.https_only;
    // Anthropic's address is the vault's own to say, never typed (AIR3).
    const anthropic = row.kind === 'anthropic';
    // Checked again here as the API checked it: what it let through is not trusted.
    const address = aiReaderAddress(anthropic ? ANTHROPIC_BASE_URL : (row.base_url ?? ''), {
      httpsOnly: publicOnly,
    });
    if ('problem' in address) return { not: 'refused' };
    // The hosted edition: only the providers its subprocessor list names (decision 9).
    if (publicOnly && !aiReaderHostedAllows(row.kind, address.url)) return { not: 'refused' };
    const ports = this.o.ports ?? AI_READER_DEFAULT_PORTS;
    // Anthropic's fixed address is on 443 whatever ports a typed one may use.
    if (!anthropic && !ports.includes(aiReaderPort(address.url))) return { not: 'refused' };
    let apiKey: string | null = null;
    if (row.api_key_encrypted) {
      try {
        apiKey = openAiReaderKey(this.o.key, row.api_key_encrypted, hh, {
          kind: row.kind,
          baseUrl: row.base_url,
        });
      } catch {
        // Never said why beyond this: a key that does not open is never sent.
        this.o.log?.('warn', 'the AI reader’s key could not be opened', { household: hh });
        return { not: 'key' };
      }
    }
    const settings = {
      url: new URL(this.o.anthropicUrl && anthropic ? this.o.anthropicUrl : address.url),
      model: row.model,
      timeoutMs: row.timeout_seconds * 1000,
    };
    const opts = {
      ...(this.o.client ?? {}),
      ...(this.o.log ? { log: this.o.log } : {}),
      apiKey,
      identity: aiReaderIdentity('settings', row.kind, row.base_url),
      guard: {
        publicOnly,
        runsAt,
        ...(anthropic ? {} : { ports }),
        vaultsOwn: this.vaultsOwn,
      },
    };
    switch (row.kind) {
      case 'anthropic':
        return { reader: new AnthropicReader(settings, opts) };
      case 'openai_compatible':
        return {
          reader: new OpenAiCompatibleReader(settings, { ...opts, ownNetwork: row.own_network }),
        };
      default:
        return { reader: new OllamaReader(settings, opts) };
    }
  }
}

/** What a kept reader is kept by: everything it was made from, the key by its hash alone. */
function fingerprint(row: SavedAiReader): string {
  return [
    row.kind,
    row.base_url ?? '',
    row.model,
    String(row.timeout_seconds),
    row.runs_at,
    String(row.https_only),
    String(row.own_network),
    row.updated_at.toISOString(),
    row.api_key_encrypted ? createHash('sha256').update(row.api_key_encrypted).digest('hex') : '',
  ].join('\0');
}

/** The worker's own addresses. */
function workerAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) out.add(a.address.toLowerCase());
  }
  return out;
}

const dnsAll = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Loopback: this machine, which a reader on a family's own server may be. */
const isLoopback = (a: string) => /^127\./.test(a) || a === '::1' || /^::ffff:127\./i.test(a);

/** What a Test or the models say of an address no Test has passed at (S2b): two outcomes alone. */
export const unproven = aiReaderUnprovenProblem;
