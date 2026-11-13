import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { sealAiReaderKey } from '@fdv/crypto';
import { aiReaderMonthCount, appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  AI_READER_CAP_DEFAULT,
  ANTHROPIC_BASE_URL,
  OPENAI_BASE_URL,
  aiReaderHostedAllows,
  aiReaderIdentity,
  aiReaderProvider,
  aiReaderRunsAtSaid,
  AI_READER_CAP_MAX,
  AI_READER_DEFAULT_PORTS,
  AI_READER_SERVICE_NAMES,
  aiReaderPort,
  AI_READER_CAP_MIN,
  AI_READER_KEY_MAX,
  AI_READER_KINDS,
  AI_READER_KINDS_OFFERED,
  AI_READER_KIND_NAMES,
  AI_READER_MODEL,
  AI_READER_TIMEOUT_MAX,
  AI_READER_TIMEOUT_MIN,
  aiReaderAddress,
  aiReaderAddressAllowed,
  aiReaderAddressWords,
  aiReaderRunsAtByName,
  aiReaderRunsAtOf,
  isLoopbackName,
  LOCAL_AI_PROBLEMS,
  type AiReaderInput,
  type AiReaderKind,
  type AiReaderRunsAt,
  type AiReaderSaved,
  type AiReaderSource,
  type AiReaderView,
  type LocalAiProblem,
  type LocalAiReaderSummary,
  type LocalAiServerView,
  type SettingsCheckView,
} from '@fdv/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AlertRequest } from '../alert-job.js';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import type { StepUpService } from '../auth/step-up.js';
import { ApiError } from '../errors.js';
import type { SettingsCheckService } from '../settings-checks.js';

/**
 * The AI reader set in Settings → Reading → AI reader (0.9.0, AIR1), an
 * owner's: the kind of reader, its address, the model, how long a paper may
 * take, its API key, and the most papers a month a cloud reader may be sent.
 *
 * The O1 review kept the local AI's address out of Settings: an address an
 * owner types points the server at its own network. This lets an owner type
 * one, with the guards the mailbox (S4) and SMS Gate (SMS1) have, held to
 * strictly (plan-ai-readers, decision 9; `@fdv/shared` ai-reader.ts):
 *
 *  - The address is http(s), `scheme://host[:port]` and nothing more — no
 *    sign-in, path, query or fragment; the worker adds the reader's own
 *    paths and calls nothing else. On the hosted edition, https only, and a
 *    name that resolves inside a network is refused here (and again by the
 *    worker on every call, which is what holds: it connects).
 *  - The API never reaches the reader. Test and the list of models are the
 *    worker's (settings checks), and what they give back is the vault's own
 *    words: never anything the reader said.
 *  - The key is sealed under a master-derived key with the household, kind
 *    and address bound in (MASTER_SEALED), never returned — `set` and its
 *    last four characters — and forgotten when the kind or the address
 *    changes: a key is never sent to an address it was not typed for.
 *  - Saved, it is untested, and used for nothing until a Test passes; the
 *    database takes that word from the vault alone (0089). Each change is in
 *    the activity log, and the other owners are emailed.
 *  - .env wins (decision 8): where the operator set FDV_LOCAL_AI_URL and
 *    FDV_LOCAL_AI_MODEL, a worker says so (local_ai_state) and this is
 *    locked; FDV_AI_READER_SETTINGS=off takes it out of Settings.
 */

/** A name resolved to its addresses: DNS, unless a test stands in. */
export type Resolve = (host: string) => Promise<string[]>;
const resolveHost: Resolve = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const ownersOnly = () =>
  new ApiError(403, 'forbidden', 'Only an owner can change how the vault reads papers.');
const bad = (words: string) => new ApiError(422, 'validation_failed', words);
const refused = () =>
  new ApiError(
    422,
    'ai_reader_address_refused',
    'The vault won’t send papers to that address. Choose a reader on your own network, or a public one over https.',
  );
const off = () =>
  new ApiError(
    409,
    'ai_reader_settings_off',
    'Whoever runs this vault keeps the AI reader out of Settings.',
  );
const locked = () =>
  new ApiError(
    409,
    'ai_reader_locked',
    'The AI reader is set by whoever runs this server, in .env, and can’t be changed here.',
  );
const portRefused = (ports: readonly number[]) =>
  new ApiError(
    422,
    'ai_reader_port_refused',
    `The vault reaches readers only on the ports whoever runs it allows: ${ports.join(', ')}. Ollama’s own is 11434.`,
  );
/** A key this long or longer has its last four kept, to tell one from another; a shorter one, none. */
export const AI_READER_KEY_TAIL_FROM = 12;
const ownRefused = () =>
  new ApiError(
    422,
    'ai_reader_address_refused',
    'That is the vault’s own server, not a reader. Type the address of the machine Ollama runs on.',
  );
/** Loopback: this machine, which a reader on a family's own server may be. */
const isLoopback = (a: string) => /^127\./.test(a) || a === '::1' || /^::ffff:127\./i.test(a);
const notSaved = () =>
  new ApiError(409, 'ai_reader_not_saved', 'Save the AI reader first, then try again.');

/** A control character: never in a key. */
const CONTROL = /\p{Cc}/u;

export interface AiReaderOptions {
  /**
   * The key the reader's API key is sealed under (deriveKey(master,
   * AI_READER_KEY_PURPOSE)). Without it no key can be kept.
   */
  key?: Buffer;
  /** FDV_EDITION: on the hosted edition, https to a public address alone. */
  edition?: 'self_hosted' | 'hosted';
  /** FDV_AI_READER_SETTINGS: off, and none is offered here. */
  settings?: 'on' | 'off';
  /** The worker's answers: Test and the list of models. */
  checks?: SettingsCheckService | null;
  /** .env's reader, as the workers said it lately (LocalAiService.server). */
  server?: () => Promise<LocalAiServerView>;
  /** Tests: DNS of their own. */
  resolve?: Resolve;
  /** Other owners told when the reader changes. */
  alert?: (a: AlertRequest) => Promise<void>;
  /** FDV_AI_READER_ALLOWED_PORTS (the AIR1 review, S2a). */
  allowedPorts?: readonly number[];
  /** This process's own addresses: the real ones, unless a test says. */
  ownAddresses?: () => Set<string>;
}

/** This process's own addresses but loopback: a Docker network's among them. */
function ownAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal) out.add(a.address.toLowerCase());
  }
  return out;
}

type Row = {
  kind: AiReaderKind;
  base_url: string | null;
  model: string;
  timeout_seconds: number;
  runs_at: AiReaderRunsAt;
  own_network: boolean;
  has_key: boolean;
  api_key_last4: string | null;
  monthly_cap: number;
  status: 'untested' | 'ok' | 'failed';
  last_tested_at: Date | null;
  last_problem: string | null;
  updated_at: Date;
};

const viewOf = (r: Row): AiReaderSaved => ({
  kind: r.kind,
  base_url: r.base_url,
  model: r.model,
  timeout_seconds: r.timeout_seconds,
  runs_at: r.runs_at,
  own_network: r.kind === 'openai_compatible' && r.own_network,
  api_key: r.has_key ? 'set' : 'not_set',
  api_key_last4: r.has_key ? r.api_key_last4 : null,
  monthly_cap: r.monthly_cap,
  status: r.status,
  last_tested_at: r.last_tested_at?.toISOString() ?? null,
  last_problem: LOCAL_AI_PROBLEMS.includes(r.last_problem as LocalAiProblem)
    ? (r.last_problem as LocalAiProblem)
    : null,
  updated_at: r.updated_at.toISOString(),
});

export class AiReaderService {
  private readonly key: Buffer | null;
  private readonly httpsOnly: boolean;
  private readonly settingsOn: boolean;
  private readonly checks: SettingsCheckService | null;
  private readonly envServer: () => Promise<LocalAiServerView>;
  private readonly resolve: Resolve;
  private readonly alert: (a: AlertRequest) => Promise<void>;
  private readonly allowedPorts: readonly number[];
  private readonly own: () => Set<string>;

  constructor(
    private readonly db: Db,
    opts: AiReaderOptions = {},
  ) {
    this.key = opts.key ?? null;
    this.httpsOnly = opts.edition === 'hosted';
    this.settingsOn = opts.settings !== 'off';
    this.checks = opts.checks ?? null;
    this.envServer = opts.server ?? (async () => ({ state: 'not_set_up' }));
    this.resolve = opts.resolve ?? resolveHost;
    this.alert = opts.alert ?? (async () => undefined);
    this.allowedPorts = opts.allowedPorts ?? AI_READER_DEFAULT_PORTS;
    this.own = opts.ownAddresses ?? ownAddresses;
  }

  /**
   * The vault's own addresses, never a reader whatever the edition (the
   * AIR1 review, S2c): this process's, and what the compose file's service
   * names resolve to here — loopback aside, which stays allowed on a
   * server of the family's own. Best effort: a name not found is nothing.
   */
  private async vaultsOwn(): Promise<Set<string>> {
    const out = new Set(this.own());
    for (const name of AI_READER_SERVICE_NAMES) {
      try {
        for (const a of await this.resolve(name)) out.add(a.toLowerCase());
      } catch {
        // Not a name here.
      }
    }
    for (const a of [...out])
      if (aiReaderRunsAtOf(a) === 'own_network' && isLoopback(a)) out.delete(a);
    return out;
  }

  /** `features.ai_reader_settings`: offered in Settings, unless the operator said off. */
  offered(): boolean {
    return this.settingsOn;
  }

  /** Where the reader is set now: .env wins; off takes it out of Settings. */
  private async source(): Promise<{ source: AiReaderSource; env: LocalAiServerView }> {
    // Asked before any transaction, never inside one (the R2 re-check).
    const env = await this.envServer();
    if (env.state !== 'not_set_up') return { source: 'env', env };
    return { source: this.settingsOn ? 'settings' : 'off', env };
  }

  private async row(trx: Db, lock = false): Promise<Row | undefined> {
    const q = trx
      .selectFrom('ai_reader')
      .select([
        'kind',
        'base_url',
        'model',
        'timeout_seconds',
        'runs_at',
        'own_network',
        sql<boolean>`api_key_encrypted is not null`.as('has_key'),
        'api_key_last4',
        'monthly_cap',
        'status',
        'last_tested_at',
        'last_problem',
        'updated_at',
      ]);
    return (lock ? q.forUpdate() : q).executeTakeFirst();
  }

  /**
   * The reader papers would go to now, as "Also send sensitive papers" is
   * held to it (the AIR3 review, S3): .env's while it wins, by its kind and
   * host; else the one saved, by its kind and address; else none.
   */
  private readerNow(
    source: AiReaderSource,
    env: LocalAiServerView,
    row: Row | undefined,
  ): {
    kind: AiReaderKind;
    base_url: string | null;
    runs_at: AiReaderRunsAt | null;
    identity: string;
  } | null {
    if (source === 'env' && env.state !== 'not_set_up') {
      const kind = env.kind ?? 'ollama';
      return {
        kind,
        base_url: null,
        runs_at: env.runs_at ?? null,
        identity: aiReaderIdentity('env', kind, env.host),
      };
    }
    if (source === 'settings' && row) {
      return {
        kind: row.kind,
        base_url: row.base_url,
        runs_at: row.runs_at,
        identity: aiReaderIdentity('settings', row.kind, row.base_url),
      };
    }
    return null;
  }

  /** GET /household/reading/ai-reader: an owner's. Never the key, only whether one is set. */
  async get(p: Principal): Promise<AiReaderView> {
    if (p.role !== 'owner') throw ownersOnly();
    const { source, env } = await this.source();
    const { row, sendSensitive, month } = await withPrincipal(this.db, p, async (trx) => {
      const r = await this.row(trx);
      const now = this.readerNow(source, env, r);
      const s = await this.switchOf(trx, p.householdId);
      return {
        row: r,
        // On for the reader papers go to now alone (S3): turned on for
        // another — .env's taking over, or moving — it is off.
        sendSensitive: s.on && now !== null && s.for === now.identity,
        // The papers sent to a cloud reader this month (AIR3), on the household's calendar.
        month: await aiReaderMonthCount(trx),
      };
    });
    return {
      source,
      kinds: [...AI_READER_KINDS_OFFERED],
      env:
        env.state === 'not_set_up'
          ? null
          : {
              kind: env.kind ?? 'ollama',
              model: env.model,
              host: env.host,
              runs_at: env.runs_at ?? null,
            },
      reader: row ? viewOf(row) : null,
      https_only: this.httpsOnly,
      send_sensitive: sendSensitive,
      month: {
        month: month.month.slice(0, 7),
        sent: month.sent,
        cap: row?.monthly_cap ?? AI_READER_CAP_DEFAULT,
        warned: month.warned,
      },
    };
  }

  /**
   * The household's "Also send sensitive papers" as stored (AIR3), and the
   * reader it was turned on for (S3). `lock`: the household's row held, so
   * a save of the reader and the switch wait for each other (M1).
   */
  private async switchOf(
    trx: Db,
    hh: string,
    lock = false,
  ): Promise<{ on: boolean; for: string | null }> {
    const q = trx
      .selectFrom('household')
      .select(['ai_send_sensitive', 'ai_send_sensitive_for'])
      .where('id', '=', hh);
    const h = await (lock ? q.forUpdate() : q).executeTakeFirst();
    return { on: h?.ai_send_sensitive === true, for: h?.ai_send_sensitive_for ?? null };
  }

  /** Every owner of the household: the switch's email goes to each (AIR3). */
  private async owners(trx: Db): Promise<string[]> {
    const rows = await trx
      .selectFrom('account_household')
      .select('account_id')
      .where('role', '=', 'owner')
      .execute();
    return rows.map((r) => r.account_id);
  }

  /**
   * "Also send sensitive papers" set, or turned off by the vault as the
   * reader changed (AIR3, decision 6): written to the activity log, and
   * every owner emailed. Inside the caller's transaction, as the owner.
   */
  private async switched(
    trx: Db,
    p: Principal,
    meta: RequestMeta,
    on: boolean,
    reader: { kind: AiReaderKind; base_url: string | null; identity?: string } | null,
    readerChanged: boolean,
  ): Promise<void> {
    await trx
      .updateTable('household')
      // On for this reader alone (S3); off, for none.
      .set({ ai_send_sensitive: on, ai_send_sensitive_for: on ? (reader?.identity ?? null) : null })
      .where('id', '=', p.householdId)
      .execute();
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'ai_reader.send_sensitive_changed',
      objectType: 'household',
      objectId: p.householdId,
      // Which way, and to which kind of reader: never its address or key.
      detail: {
        send_sensitive: on,
        ...(reader ? { kind: reader.kind } : {}),
        ...(readerChanged ? { reader_changed: true } : {}),
      },
      ip: meta.ip,
    });
    const me = await trx
      .selectFrom('member')
      .select('display_name')
      .where('id', '=', p.memberId)
      .executeTakeFirst();
    const who = me?.display_name ?? 'An owner';
    const provider = reader ? aiReaderProvider(reader.kind, reader.base_url).name : 'the AI reader';
    const owners = await this.owners(trx);
    if (owners.length === 0) return;
    await this.alert({
      householdId: p.householdId,
      accountIds: owners,
      emailOnly: true,
      subject: on
        ? 'Sensitive papers are now sent to the AI reader'
        : 'Sensitive papers are no longer sent to the AI reader',
      body: on
        ? `${who} turned on “Also send sensitive papers” in Settings → Reading: the words of papers marked Sensitive — passports, bank statements and the like — are now sent to ${provider} to be read, as the household’s other papers are. Never the page or the file, and never an Only me paper. If that is a surprise, ask them about it, and turn it off in Settings.`
        : readerChanged
          ? `${who} changed the AI reader, so “Also send sensitive papers” was turned off: papers marked Sensitive are read on this server alone until an owner turns it on again.`
          : `${who} turned off “Also send sensitive papers” in Settings → Reading: papers marked Sensitive are read on this server alone.`,
    });
  }

  /**
   * PUT /household/reading/ai-reader/send-sensitive (step-up
   * `send_sensitive_papers`, AIR3): "Also send sensitive papers", an
   * owner's. On only while the household's reader is a cloud service
   * (`409 ai_reader_not_cloud`): on the household's own network every paper
   * is read anyway. Off always. Each change emailed to every owner and
   * written to the activity log; the same again changes nothing.
   */
  async setSendSensitive(p: Principal, on: boolean, meta: RequestMeta): Promise<AiReaderView> {
    if (p.role !== 'owner') throw ownersOnly();
    const { source, env } = await this.source();
    await withPrincipal(this.db, p, async (trx) => {
      // The household's row, then the reader's, held: a save of the reader
      // waits for this, and this for it (the AIR3 review, M1).
      const before = await this.switchOf(trx, p.householdId, true);
      const reader = this.readerNow(source, env, await this.row(trx, true));
      // On for the reader papers go to now, or not (S3).
      const onNow = before.on && reader !== null && before.for === reader.identity;
      if (onNow === on && (on || !before.on)) return;
      if (on && reader?.runs_at !== 'cloud') {
        throw new ApiError(
          409,
          'ai_reader_not_cloud',
          'Sensitive papers are held back only from a cloud AI reader, and the household has none.',
        );
      }
      await this.switched(trx, p, meta, on, reader, false);
    });
    return this.get(p);
  }

  /**
   * The reader a household's local AI switch uses (LocalAiService): .env's
   * where it is set, else the one saved, ready once its Test passed; or
   * none. As whoever asks: the database gives the saved one to owners alone.
   */
  async summary(p: Principal, env: LocalAiServerView): Promise<LocalAiReaderSummary | null> {
    if (env.state !== 'not_set_up') {
      return {
        source: 'env',
        kind: env.kind ?? 'ollama',
        model: env.model,
        host: env.host,
        runs_at: env.runs_at ?? null,
        ready: true,
      };
    }
    if (!this.settingsOn) return null;
    const row = await withPrincipal(this.db, p, (trx) => this.row(trx));
    if (!row) return null;
    return {
      source: 'settings',
      kind: row.kind,
      model: row.model,
      host: row.base_url ? new URL(row.base_url).host : 'api.anthropic.com',
      runs_at: row.runs_at,
      ready: row.status === 'ok' && AI_READER_KINDS_OFFERED.includes(row.kind),
    };
  }

  /**
   * Where a reader at this address runs (decision 2), and whether the vault
   * may send to it, as far as the API can tell: an address as it is; a name
   * that means this machine, a `.local` name or one with no dot, the
   * household's own network; any other name resolved — every address it
   * gives inside a network, the household's own; any public, a cloud
   * service; not resolved, a cloud service until a Test finds otherwise.
   * The worker checks again on every call, at the address it connects to.
   */
  private async place(hostname: string): Promise<AiReaderRunsAt> {
    const literal = isIP(hostname) ? [hostname] : null;
    if (this.httpsOnly && isLoopbackName(hostname)) throw refused();
    let addresses: string[] = literal ?? [];
    if (!literal && !isLoopbackName(hostname)) {
      try {
        addresses = await this.resolve(hostname);
      } catch {
        addresses = [];
      }
    }
    if (addresses.some((a) => !aiReaderAddressAllowed(a, { publicOnly: this.httpsOnly }))) {
      throw refused();
    }
    const own = await this.vaultsOwn();
    if (addresses.some((a) => own.has(a.toLowerCase()))) throw ownRefused();
    const byName = aiReaderRunsAtByName(hostname);
    if (literal) return byName ?? 'cloud';
    if (addresses.length > 0) {
      return addresses.every((a) => aiReaderRunsAtOf(a) === 'own_network')
        ? 'own_network'
        : 'cloud';
    }
    return byName ?? 'cloud';
  }

  /**
   * PUT /household/reading/ai-reader (step-up `change_ai_reader`): the
   * reader, as an owner sets it. Only the kinds this vault reads with (422
   * ai_reader_kind_not_offered); an address refused by the guards (422
   * ai_reader_address_refused). The key, when given, is sealed; left out,
   * the one set is kept — unless the kind or the address changed, when it is
   * forgotten; null forgets it. Saved, it waits for a Test if anything that
   * reaches the reader changed; a new timeout or limit alone keeps a Test
   * that passed.
   */
  async put(p: Principal, input: AiReaderInput, meta: RequestMeta): Promise<AiReaderView> {
    if (p.role !== 'owner') throw ownersOnly();
    const { source } = await this.source();
    if (source === 'off') throw off();
    if (source === 'env') throw locked();
    if (!AI_READER_KINDS.includes(input.kind)) throw bad('Choose a kind of reader.');
    if (!AI_READER_KINDS_OFFERED.includes(input.kind)) {
      throw new ApiError(
        422,
        'ai_reader_kind_not_offered',
        `This vault doesn’t read with ${AI_READER_KIND_NAMES[input.kind]} yet. Choose ${AI_READER_KINDS_OFFERED.map((k) => AI_READER_KIND_NAMES[k]).join(' or ')}.`,
      );
    }
    // Anthropic's address is fixed (AIR3): never typed, never kept.
    const anthropic = input.kind === 'anthropic';
    if (anthropic && typeof input.base_url === 'string' && input.base_url.trim() !== '') {
      throw bad('Anthropic’s address is the vault’s own to say: leave the address out.');
    }
    const address = aiReaderAddress(anthropic ? ANTHROPIC_BASE_URL : (input.base_url ?? ''), {
      httpsOnly: this.httpsOnly,
    });
    if ('problem' in address) {
      if (address.problem === 'own') throw ownRefused();
      throw bad(aiReaderAddressWords(address.problem));
    }
    // The hosted edition: only the providers its subprocessor list names (decision 9).
    if (this.httpsOnly && !aiReaderHostedAllows(input.kind, address.url)) {
      throw new ApiError(
        422,
        'ai_reader_provider_not_offered',
        `On this vault an OpenAI-compatible reader can only be OpenAI itself, at ${OPENAI_BASE_URL}.`,
      );
    }
    if (!anthropic && !this.allowedPorts.includes(aiReaderPort(address.url))) {
      throw portRefused(this.allowedPorts);
    }
    const model = input.model.trim();
    if (!AI_READER_MODEL.test(model)) {
      throw bad('Type the model’s name as the reader has it, such as qwen2.5:3b-instruct.');
    }
    if (
      !Number.isInteger(input.timeout_seconds) ||
      input.timeout_seconds < AI_READER_TIMEOUT_MIN ||
      input.timeout_seconds > AI_READER_TIMEOUT_MAX
    ) {
      throw bad(
        `How long a paper may take is a number of seconds from ${AI_READER_TIMEOUT_MIN} to ${AI_READER_TIMEOUT_MAX}.`,
      );
    }
    if (
      !Number.isInteger(input.monthly_cap) ||
      input.monthly_cap < AI_READER_CAP_MIN ||
      input.monthly_cap > AI_READER_CAP_MAX
    ) {
      throw bad(
        `The most papers in a month is a number from ${AI_READER_CAP_MIN} to ${AI_READER_CAP_MAX}.`,
      );
    }
    const apiKey = typeof input.api_key === 'string' ? input.api_key.trim() : input.api_key;
    if (typeof apiKey === 'string') {
      if (apiKey.length === 0 || apiKey.length > AI_READER_KEY_MAX) {
        throw bad(`The key is 1 to ${AI_READER_KEY_MAX} characters.`);
      }
      if (CONTROL.test(apiKey)) throw bad('The key can’t have a line break or a tab in it.');
    }
    const key = this.key;
    if (typeof apiKey === 'string' && !key) {
      throw new ApiError(503, 'unavailable', 'The vault can’t keep a key just now.');
    }
    const kind = input.kind;
    // Anthropic's is kept as none: its address is the vault's (0089).
    const baseUrl = anthropic ? null : address.url;
    // The owner's word that an OpenAI-compatible reader is on their own
    // network (decision 2); the other kinds' place is never theirs to say.
    const ownNetwork = kind === 'openai_compatible' && input.own_network === true;
    // Where it runs, and whether it may be sent to: asked before the
    // transaction, never inside it. Anthropic is a cloud service, wherever.
    const placed = anthropic ? 'cloud' : await this.place(address.hostname);
    let reached = false;
    await withPrincipal(this.db, p, async (trx) => {
      // The household's row first, as the switch takes it (the AIR3 review,
      // M1): a save and "Also send sensitive papers" wait for each other.
      await this.switchOf(trx, p.householdId, true);
      const before = await trx
        .selectFrom('ai_reader')
        .select([
          'kind',
          'base_url',
          'model',
          'runs_at',
          'api_key_encrypted',
          'api_key_last4',
          'https_only',
          'own_network',
        ])
        .forUpdate()
        .executeTakeFirst();
      // The key was kept for one kind and address alone.
      const moved = before !== undefined && (before.kind !== kind || before.base_url !== baseUrl);
      const keyNow =
        typeof apiKey === 'string'
          ? {
              api_key_encrypted: sealAiReaderKey(key as Buffer, apiKey, p.householdId, {
                kind,
                baseUrl,
              }),
              // The last four of a long key alone: a short one would be shown whole.
              api_key_last4: apiKey.length >= AI_READER_KEY_TAIL_FROM ? apiKey.slice(-4) : null,
            }
          : apiKey === null || moved || !before
            ? { api_key_encrypted: null, api_key_last4: null }
            : { api_key_encrypted: before.api_key_encrypted, api_key_last4: before.api_key_last4 };
      const keyChanged =
        typeof apiKey === 'string' ||
        ((before?.api_key_encrypted ?? null) !== null && keyNow.api_key_encrypted === null);
      // Anthropic answers nobody without a key (AIR3).
      if (anthropic && keyNow.api_key_encrypted === null) {
        throw bad('Type the API key Anthropic gave you: it reads nothing without one.');
      }
      const ownChanged = (before?.own_network ?? false) !== ownNetwork;
      // Where it runs is kept while the address is: a Test found it — and
      // the owner's word on it, which waits for a Test of its own.
      const runsAt = aiReaderRunsAtSaid(
        kind,
        before && !moved && !ownChanged ? before.runs_at : placed,
        ownNetwork,
      );
      reached =
        before === undefined ||
        moved ||
        ownChanged ||
        before.model !== model ||
        keyChanged ||
        before.https_only !== this.httpsOnly;
      const values = {
        kind,
        base_url: baseUrl,
        model,
        timeout_seconds: input.timeout_seconds,
        monthly_cap: input.monthly_cap,
        runs_at: runsAt,
        own_network: ownNetwork,
        // The hosted edition's rule, kept with the reader (the AIR1 review,
        // S1): the worker holds it to the strictest of this and its own.
        https_only: this.httpsOnly,
        // A Test passed at an address goes with it (S2b).
        ...(before === undefined || moved ? { address_proven: false } : {}),
        ...keyNow,
        updated_by: p.accountId,
        updated_at: new Date(),
        ...(reached
          ? { status: 'untested' as const, last_tested_at: null, last_problem: null }
          : {}),
      };
      if (before) {
        await trx.updateTable('ai_reader').set(values).execute();
      } else {
        await trx
          .insertInto('ai_reader')
          .values({ household_id: p.householdId, ...values })
          .execute();
      }
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'ai_reader.changed',
        objectType: 'household',
        objectId: p.householdId,
        // Which kind, where it runs, and what changed: never the key, nor
        // the address itself.
        detail: {
          kind,
          runs_at: runsAt,
          address_changed: before === undefined || moved,
          model_changed: before === undefined || before.model !== model,
          key_changed: keyChanged,
          timeout_seconds: input.timeout_seconds,
          monthly_cap: input.monthly_cap,
          ...(kind === 'openai_compatible' ? { own_network: ownNetwork } : {}),
        },
        ip: meta.ip,
      });
      if (reached) await this.tellOtherOwners(trx, p, 'changed');
      // A new kind of reader or a new address: the switch's warning named
      // another provider, so sensitive papers are no longer sent (AIR3) —
      // the switch turned off where it was on for the reader replaced (S3).
      if (before && moved) {
        const s = await this.switchOf(trx, p.householdId);
        if (s.on && s.for === aiReaderIdentity('settings', before.kind, before.base_url)) {
          await this.switched(trx, p, meta, false, { kind, base_url: baseUrl }, true);
        }
      }
    });
    return this.get(p);
  }

  /** DELETE /household/reading/ai-reader (step-up): the reader forgotten, key and all. */
  async remove(p: Principal, meta: RequestMeta): Promise<AiReaderView> {
    if (p.role !== 'owner') throw ownersOnly();
    // In every state — .env's reader winning, or the reader out of Settings
    // (the AIR1 review, M4): a key kept can always be forgotten.
    await withPrincipal(this.db, p, async (trx) => {
      const s = await this.switchOf(trx, p.householdId, true);
      const gone = await trx.deleteFrom('ai_reader').returning(['kind', 'base_url']).execute();
      const was = gone[0];
      if (was) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'ai_reader.changed',
          objectType: 'household',
          objectId: p.householdId,
          detail: { removed: true },
          ip: meta.ip,
        });
        await this.tellOtherOwners(trx, p, 'removed');
        // Gone with the reader it named (AIR3; S3): on for this one alone.
        if (s.on && s.for === aiReaderIdentity('settings', was.kind, was.base_url)) {
          await this.switched(trx, p, meta, false, null, true);
        }
      }
    });
    return this.get(p);
  }

  /**
   * Whoever runs the reader reads every paper the household sends it: the
   * other owners are told when where papers go changes, as they are of the
   * mail server and of SMS Gate.
   */
  private async tellOtherOwners(trx: Db, p: Principal, what: 'changed' | 'removed') {
    const me = await trx
      .selectFrom('member')
      .select('display_name')
      .where('id', '=', p.memberId)
      .executeTakeFirst();
    const others = await trx
      .selectFrom('account_household')
      .select('account_id')
      .where('role', '=', 'owner')
      .where('account_id', '!=', p.accountId)
      .execute();
    if (others.length === 0) return;
    const who = me?.display_name ?? 'An owner';
    await this.alert({
      householdId: p.householdId,
      accountIds: others.map((o) => o.account_id),
      subject:
        what === 'removed'
          ? 'The vault’s AI reader was removed'
          : 'The vault’s AI reader was changed',
      body:
        what === 'removed'
          ? `${who} removed the AI reader set in Settings. Papers are read by the vault’s rules alone, unless whoever runs the server set one.`
          : `${who} changed the AI reader in Settings: where papers’ words are sent to be read. It is used only once a Test passes, and only while the household’s local AI is on. If that is a surprise, ask them about it.`,
    });
  }

  /** Test, or the list of models: answered by the worker, for the reader saved. */
  private async ask(p: Principal, kind: 'ai_reader' | 'ai_models'): Promise<SettingsCheckView> {
    if (p.role !== 'owner') throw ownersOnly();
    const { source } = await this.source();
    if (source === 'off') throw off();
    if (source === 'env') throw locked();
    const has = await withPrincipal(this.db, p, (trx) =>
      trx.selectFrom('ai_reader').select('kind').executeTakeFirst(),
    );
    if (!has) throw notSaved();
    if (!this.checks) {
      throw new ApiError(503, 'unavailable', 'The worker can’t be asked just now.', {
        retriable: true,
      });
    }
    return this.checks.ask(p, kind, null);
  }

  /** POST /household/reading/ai-reader/test: a tiny fixed prompt, no paper; must pass before it is used. */
  async test(p: Principal): Promise<SettingsCheckView> {
    return this.ask(p, 'ai_reader');
  }

  /** POST /household/reading/ai-reader/models: the saved reader's models, names alone. */
  async models(p: Principal): Promise<SettingsCheckView> {
    return this.ask(p, 'ai_models');
  }
}

/**
 * Settings → Reading → AI reader (0.9.0, AIR1): GET, PUT and DELETE
 * /household/reading/ai-reader, POST …/test and …/models. An owner's alone:
 * anybody else is refused before their body is read. A change asks for
 * step-up: a session picked up from an unlocked device could otherwise send
 * the family's papers to a server of its own.
 */
export function registerAiReader(
  app: FastifyInstance,
  ai: AiReaderService,
  stepUp?: StepUpService,
): void {
  const owners = {
    preHandler: [
      app.requireAuth,
      async (req: FastifyRequest) => {
        if (req.principal && req.principal.role !== 'owner') throw ownersOnly();
      },
    ],
  };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const noStore = { 'cache-control': 'no-store' };

  app.get('/api/v1/household/reading/ai-reader', owners, async (req, reply) => {
    void reply.headers(noStore);
    return ai.get(principal(req));
  });

  app.put('/api/v1/household/reading/ai-reader', owners, async (req, reply) => {
    const body = parse(
      z
        .object({
          kind: z.enum(AI_READER_KINDS),
          base_url: z.string().max(2048).nullable().optional(),
          model: z.string().min(1).max(200),
          timeout_seconds: z.number().int(),
          monthly_cap: z.number().int(),
          api_key: z.string().max(AI_READER_KEY_MAX).nullable().optional(),
          own_network: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    await stepUp?.require(principal(req), 'change_ai_reader');
    void reply.headers(noStore);
    return ai.put(principal(req), body, metaOf(req));
  });

  app.delete('/api/v1/household/reading/ai-reader', owners, async (req, reply) => {
    await stepUp?.require(principal(req), 'change_ai_reader');
    void reply.headers(noStore);
    return ai.remove(principal(req), metaOf(req));
  });

  // "Also send sensitive papers" (AIR3): an owner's, with a step-up of its
  // own — a session picked up from an unlocked device could otherwise send
  // the words of the family's passports to a provider.
  app.put('/api/v1/household/reading/ai-reader/send-sensitive', owners, async (req, reply) => {
    const body = parse(z.object({ send_sensitive: z.boolean() }).strict(), req.body);
    await stepUp?.require(principal(req), 'send_sensitive_papers');
    void reply.headers(noStore);
    return ai.setSendSensitive(principal(req), body.send_sensitive, metaOf(req));
  });

  app.post('/api/v1/household/reading/ai-reader/test', owners, async (req, reply) =>
    reply.status(202).send(await ai.test(principal(req))),
  );
  app.post('/api/v1/household/reading/ai-reader/models', owners, async (req, reply) =>
    reply.status(202).send(await ai.models(principal(req))),
  );
}
