import { sensitiveOf } from './documents.js';
import { localAiProblemWords, type LocalAiProblem } from './local-ai.js';
import { isLinkLocalAddress, isLoopbackName, isPrivateAddress } from './push.js';

/**
 * The AI reader set in Settings (0.9.0, AIR1): Settings → Reading → AI
 * reader, an owner's. Until AIR1 the local AI reader (R4) was set by the
 * operator in .env alone: an address an owner could type points the server
 * at its own network (the O1 review). It may now be set here, with the
 * guards the mailbox (S4) and SMS Gate (SMS1) have, held to strictly
 * (plan-ai-readers, decision 9):
 *
 *  - **http(s) only, the address alone:** no user or password, no query or
 *    fragment, and no path — the vault adds the reader's own paths
 *    (`AI_READER_PATHS`) and calls nothing else. On the hosted edition, only
 *    https, and only to a public address.
 *  - **Resolved once a call, and pinned** to the address found, which is
 *    checked first: never link-local (cloud metadata), "this network" or
 *    multicast, wherever it is; never inside a network at all on the hosted
 *    edition. Redirects and proxies are never followed (the worker's).
 *  - **No reply is ever shown:** a reply that is not the reader's own API's
 *    shape is a failure (`bad_reply`), and what any reply said is never
 *    given back to the owner — Test says how long it took, or why not, in
 *    the vault's own words. The list of models is names alone, each a model
 *    name's shape (`AI_READER_MODEL`).
 *  - **Where it runs is said, not guessed** (decision 2): an address that
 *    resolves inside the household's own network — loopback, a private
 *    range, `.local` — is `own_network`; one that resolves to a public
 *    address is `cloud`. A name the vault can't resolve counts as `cloud`
 *    until a Test finds where it is. A reader said to be on the household's
 *    own network that is found at a public address is sent nothing.
 *  - **Test must pass before it is used:** saved, it is `untested`; only the
 *    vault says a Test passed (`ok`), and anything that reaches the reader
 *    changed waits for a Test of its own.
 *
 * Three kinds are kept (decision 1), and since AIR3 this vault reads with
 * all three (`features.ai_reader_kinds`): Ollama, Anthropic (its address
 * fixed) and an OpenAI-compatible server.
 */

/** Every kind of reader the vault knows (decision 1). */
export const AI_READER_KINDS = ['ollama', 'anthropic', 'openai_compatible'] as const;
export type AiReaderKind = (typeof AI_READER_KINDS)[number];

/** The kinds this vault reads with now (`features.ai_reader_kinds`): all three since AIR3. */
export const AI_READER_KINDS_OFFERED: readonly AiReaderKind[] = [
  'ollama',
  'anthropic',
  'openai_compatible',
];

/** Where a reader runs (decision 2). */
export type AiReaderRunsAt = 'own_network' | 'cloud';

/** Whether a Test has passed for the settings saved: only the vault says `ok`. */
export type AiReaderStatus = 'untested' | 'ok' | 'failed';

/**
 * The only paths each kind of reader is ever sent to (decision 9), after its
 * address: nothing else is called. Anthropic's list of models
 * (`/v1/models`) is AIR3's addition to decision 9: the model is chosen from
 * those the API lists, as it is for the other kinds.
 */
export const AI_READER_PATHS: Readonly<Record<AiReaderKind, readonly string[]>> = {
  ollama: ['/api/chat', '/api/tags'],
  openai_compatible: ['/v1/chat/completions', '/v1/models'],
  anthropic: ['/v1/messages', '/v1/models'],
};

/** Anthropic's address (AIR3): fixed, never typed, always a cloud service. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** The Messages API's version the vault speaks (the `anthropic-version` header). */
export const ANTHROPIC_VERSION = '2023-06-01';
/** OpenAI's own address: the one OpenAI-compatible reader the hosted edition may use. */
export const OPENAI_BASE_URL = 'https://api.openai.com';

/**
 * The providers the hosted edition may send a paper's words to (decision 9:
 * only those named in its subprocessor list): Anthropic, and an
 * OpenAI-compatible reader only at OpenAI's own address. A self-hosted
 * vault may use any. Ollama keeps AIR1's rule there (https to a public
 * address): it is the household's own server, not a provider of ours.
 */
export const AI_READER_HOSTED_PROVIDERS: Readonly<Record<AiReaderKind, readonly string[] | null>> =
  {
    anthropic: [ANTHROPIC_BASE_URL],
    openai_compatible: [OPENAI_BASE_URL],
    ollama: null,
  };

/** Whether the hosted edition may send to this reader: a provider it names (Ollama: AIR1's rule). */
export function aiReaderHostedAllows(kind: AiReaderKind, baseUrl: string | null): boolean {
  const named = AI_READER_HOSTED_PROVIDERS[kind];
  if (named === null) return true;
  return named.includes(kind === 'anthropic' ? ANTHROPIC_BASE_URL : (baseUrl ?? ''));
}

/**
 * Where a reader counts as running (decision 2), from where its address was
 * found to be and the owner's word: Anthropic is always a cloud service; an
 * OpenAI-compatible reader is a cloud service unless the owner said it is
 * on their own network AND it was found at a private address; Ollama is
 * where its address resolves.
 */
export function aiReaderRunsAtSaid(
  kind: AiReaderKind,
  found: AiReaderRunsAt,
  ownNetworkSaid: boolean,
): AiReaderRunsAt {
  if (kind === 'anthropic') return 'cloud';
  if (kind === 'openai_compatible') {
    return ownNetworkSaid && found === 'own_network' ? 'own_network' : 'cloud';
  }
  return found;
}

/**
 * Why a paper was read without the AI though the household has it on
 * (AIR3): the sending rule held it back (`mayReadWith`) — sensitive, or Only
 * me — or this month's cap is reached (decision 10).
 */
export type AiReaderHeldBack = 'sensitive' | 'only_me' | 'cap';
export const AI_READER_HELD_BACK: readonly AiReaderHeldBack[] = ['sensitive', 'only_me', 'cap'];

/** What the proposal says of a paper held back (AIR3). */
export const AI_READER_HELD_WORDS: Readonly<Record<AiReaderHeldBack, string>> = {
  sensitive: 'Read here only: sensitive',
  only_me: 'Read here only: only you can open it',
  cap: 'Read here only: this month’s limit reached',
};

/** The paper, as the sending rule asks of it. */
export interface AiReaderPaper {
  /**
   * Its visibility: a document's own; for a batch's item not yet filed, its
   * batch's default, or null — then its kind's default visibility counts.
   */
  visibility: string | null | undefined;
  /** Its own Sensitive: null as its kind says (0090). */
  sensitive: boolean | null | undefined;
  /** Its kind as the household keeps it; null, not known — and then it counts as sensitive. */
  kind:
    | {
        sensitive_default?: boolean | null | undefined;
        default_visibility?: string | null | undefined;
      }
    | null
    | undefined;
}

/** The reader, as the sending rule asks of it. */
export interface AiReaderSending {
  /** Where it runs (decision 2); null — not known — counts as a cloud service. */
  runs_at: AiReaderRunsAt | null | undefined;
  /** The household's "Also send sensitive papers" (decision 6). */
  send_sensitive: boolean;
}

/**
 * THE sending rule (AIR3, decisions 4 and 6), the one place it is decided
 * whether a paper's words may go to a reader — asked by the worker before
 * every call:
 *
 *  - a reader on the household's own network: yes;
 *  - an Only me paper (`visibility = 'private'`), to a cloud reader: never,
 *    whatever the switch says ("Only you can open this" would not be true
 *    otherwise);
 *  - a sensitive paper (`sensitiveOf`: its own choice, else its kind's
 *    default as the household has it now; a kind not known counts as
 *    sensitive), to a cloud reader: only with "Also send sensitive papers"
 *    on — and on for this reader (`aiReaderIdentity`), which the caller
 *    says in `send_sensitive`;
 *  - a paper nobody can say who may open — no visibility of its own nor
 *    from its kind — to a cloud reader: never, as if Only me (the AIR3
 *    review, D1);
 *  - anything else: yes.
 */
export function mayReadWith(
  paper: AiReaderPaper,
  reader: AiReaderSending,
): { may: true } | { may: false; why: 'only_me' | 'sensitive' } {
  if (reader.runs_at === 'own_network') return { may: true };
  const visibility = paper.visibility ?? paper.kind?.default_visibility ?? null;
  if (visibility === 'private') return { may: false, why: 'only_me' };
  if (!reader.send_sensitive && sensitiveOf({ sensitive: paper.sensitive }, paper.kind ?? null)) {
    return { may: false, why: 'sensitive' };
  }
  // Who can open it not known — a batch's item whose batch names neither
  // its visibility nor its kind (the AIR3 review, D1): it may yet be Only
  // me, so it is held as one.
  if (visibility === null) return { may: false, why: 'only_me' };
  return { may: true };
}

/**
 * Which reader "Also send sensitive papers" was approved for (the AIR3
 * review, S3): the warning named a provider, so the switch holds for that
 * reader alone — a saved one by its kind and address, .env's by its kind
 * and host. Anything else, and it counts as off.
 */
export function aiReaderIdentity(
  source: 'settings' | 'env',
  kind: AiReaderKind,
  where: string | null,
): string {
  if (source === 'env') return `env:${kind}:${where ?? ''}`;
  return `settings:${kind}:${kind === 'anthropic' ? ANTHROPIC_BASE_URL : (where ?? '')}`;
}

/** At this share of the month's cap the owners are emailed, once a month (decision 10). */
export const AI_READER_CAP_WARN_SHARE = 0.8;

/** The count the 80% email goes at: 400 of 500. */
export const aiReaderCapWarnAt = (cap: number): number =>
  Math.max(1, Math.ceil(cap * AI_READER_CAP_WARN_SHARE));

/** A cloud reader's month (AIR3): papers sent this calendar month, of the cap. */
export interface AiReaderMonth {
  /** The month, YYYY-MM, on the household's calendar (its time zone, else the server's). */
  month: string;
  sent: number;
  cap: number;
  /** Whether the owners were emailed at 80% this month. */
  warned: boolean;
}

/** "120 of 500 this month". */
export const aiReaderMonthWords = (m: Pick<AiReaderMonth, 'sent' | 'cap'>): string =>
  `${m.sent} of ${m.cap} this month`;

/** Who a provider is, and where its terms are, for the warning (decision 11). */
export function aiReaderProvider(
  kind: AiReaderKind,
  baseUrl: string | null,
): { name: string; terms: string | null } {
  if (kind === 'anthropic') {
    return { name: 'Anthropic', terms: 'https://www.anthropic.com/legal/commercial-terms' };
  }
  if (kind === 'openai_compatible' && baseUrl === OPENAI_BASE_URL) {
    return { name: 'OpenAI', terms: 'https://openai.com/policies/business-terms/' };
  }
  const host = /^https?:\/\/([^/?#]+)/i.exec(baseUrl ?? '')?.[1];
  return { name: host ? `whoever runs ${host}` : 'whoever runs the reader', terms: null };
}

/**
 * The warning beside "Also send sensitive papers" (decisions 3, 6 and 11):
 * who is sent what — words only, never the page or the file — and that
 * whether it is kept is up to the provider's own terms (linked beside it).
 */
export function aiReaderSendSensitiveWarning(kind: AiReaderKind, baseUrl: string | null): string {
  const p = aiReaderProvider(kind, baseUrl);
  return [
    `With this on, papers marked Sensitive are sent to ${p.name} to be read, as your other papers are:`,
    'the words the vault read from the page, the names of your kinds of document and your family’s display names.',
    'Never the page itself, nor the file. Only me papers are never sent.',
    `Whether ${p.name} keeps what it is sent is up to its own terms.`,
  ].join(' ');
}

/**
 * PUT /household/reading/ai-reader/send-sensitive's body (AIR3): an
 * owner's, with step-up `send_sensitive_papers`.
 */
export interface AiReaderSendSensitiveInput {
  send_sensitive: boolean;
}

/** A model's name: as FDV_LOCAL_AI_MODEL's. */
export const AI_READER_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
/** The longest API key kept. */
export const AI_READER_KEY_MAX = 512;
/** The most model names the list gives. */
export const AI_READER_MODELS_MAX = 200;
/** How long one paper may take, in seconds: as FDV_LOCAL_AI_TIMEOUT_SECONDS. */
export const AI_READER_TIMEOUT_MIN = 5;
export const AI_READER_TIMEOUT_MAX = 300;
export const AI_READER_TIMEOUT_DEFAULT = 120;
/** Papers a month a cloud reader may be sent (decision 10; AIR3 counts them). */
export const AI_READER_CAP_MIN = 1;
export const AI_READER_CAP_MAX = 100_000;
export const AI_READER_CAP_DEFAULT = 500;

/** Why an address typed is not one the vault keeps. */
export type AiReaderAddressProblem =
  | 'not_url'
  | 'scheme'
  | 'credentials'
  | 'query'
  | 'path'
  | 'no_host'
  | 'https_needed'
  | 'too_long'
  | 'port'
  | 'own';

const ADDRESS_WORDS: Readonly<Record<AiReaderAddressProblem, string>> = {
  not_url: 'Type the reader’s address, such as http://192.168.1.30:11434.',
  scheme: 'The address starts with http:// or https://.',
  credentials: 'Type only the address: no user name or password in it. A key goes in its own box.',
  query: 'Type only the address: nothing after a ? or a #.',
  path: 'Type only the address, such as http://192.168.1.30:11434: the vault adds the rest.',
  no_host: 'Type the reader’s address, with its host: http://192.168.1.30:11434.',
  https_needed: 'On this vault the reader’s address must start with https://.',
  too_long: 'That address is too long. Type the reader’s address alone.',
  port: 'The vault reaches readers only on the ports whoever runs it allows: 11434 is Ollama’s own.',
  own: 'That is the vault’s own server, not a reader. Type the address of the machine Ollama runs on.',
};

/** What is wrong with an address, in words. */
export const aiReaderAddressWords = (p: AiReaderAddressProblem): string => ADDRESS_WORDS[p];

/**
 * The WHATWG URL parser, as Node and the browsers have it: this package
 * takes no lib of either, so what it reads of one is said here.
 */
declare const URL: new (input: string) => {
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  pathname: string;
  search: string;
  hash: string;
};

/**
 * An address as the vault keeps it — `scheme://host[:port]`, nothing more —
 * or what is wrong with it. `httpsOnly`: the hosted edition's rule.
 */
export function aiReaderAddress(
  typed: string,
  o: { httpsOnly: boolean },
): { url: string; host: string; hostname: string } | { problem: AiReaderAddressProblem } {
  const text = typed.trim();
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(text);
  } catch {
    return { problem: 'not_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { problem: 'scheme' };
  // Before anything else is looked at: `http://user@host` never kept.
  if (url.username || url.password || /^[a-z]+:\/\/[^/?#]*@/i.test(text)) {
    return { problem: 'credentials' };
  }
  if (url.search || url.hash || /[?#]/.test(text)) return { problem: 'query' };
  if (!url.hostname) return { problem: 'no_host' };
  if (url.pathname !== '/' && url.pathname !== '') return { problem: 'path' };
  if (o.httpsOnly && url.protocol !== 'https:') return { problem: 'https_needed' };
  // The database keeps 8 to 300 characters (0089): longer is said, not a server error.
  if (`${url.protocol}//${url.host}`.length > AI_READER_URL_MAX) return { problem: 'too_long' };
  // The vault's own services, by name (the AIR1 review, S2c).
  if (aiReaderNameRefused(url.hostname)) return { problem: 'own' };
  return {
    url: `${url.protocol}//${url.host}`,
    host: url.host,
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
  };
}

/** The longest address kept. */
export const AI_READER_URL_MAX = 300;

/**
 * The ports a reader set in Settings may be on unless the operator says
 * others (FDV_AI_READER_ALLOWED_PORTS; the AIR1 review, S2): Ollama's own,
 * LM Studio's, and the usual web ports — so Test is no port scanner.
 */
export const AI_READER_DEFAULT_PORTS: readonly number[] = [11434, 1234, 8000, 8080, 80, 443];

/** The port an address kept (`scheme://host[:port]`) is reached on. */
export function aiReaderPort(url: string): number {
  const m = /^(https?):\/\/(?:\[[^\]]*\]|[^:/]*)(?::(\d+))?$/i.exec(url);
  if (m?.[2]) return Number(m[2]);
  return m?.[1]?.toLowerCase() === 'https' ? 443 : 80;
}

/**
 * The vault's own services, as the compose file names them (the AIR1
 * review, S2c): never a reader, whatever the edition. Their addresses are
 * refused too, where they can be found.
 */
export const AI_READER_SERVICE_NAMES: readonly string[] = ['postgres', 'api', 'web', 'worker'];

/** Whether a host is one of the vault's own services, by name: `api`, or compose's `fdv-api-1`. */
export function aiReaderNameRefused(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return AI_READER_SERVICE_NAMES.some(
    (n) => h === n || new RegExp(`^[a-z0-9_.-]+[-_]${n}[-_]\\d+$`).test(h),
  );
}

/**
 * What a Test or the list of models says of an address no Test has ever
 * passed at (the AIR1 review, S2b): only "couldn't reach it" or "reached
 * it, but it isn't that kind of reader" — never which way it failed, so it
 * tells nothing of what else listens on the household's network.
 */
export function aiReaderUnprovenProblem(p: LocalAiProblem): LocalAiProblem {
  switch (p) {
    case 'http_error':
    case 'too_big':
    case 'bad_reply':
    case 'no_model':
      return 'bad_reply';
    case 'not_set_up':
    case 'not_saved':
      return p;
    default:
      return 'unreachable';
  }
}

/** An IP literal, v4 or v6 (unbracketed). */
const isIpLiteral = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

/**
 * Where a reader at this host runs, from its name alone, without DNS — or
 * null when only resolving it can say. An address is judged as it is; a
 * name that means this machine, a `.local` name and a name with no dot in
 * it (a container's, a machine's on the LAN) are the household's own
 * network.
 */
export function aiReaderRunsAtByName(hostname: string): AiReaderRunsAt | null {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (isIpLiteral(h)) return aiReaderRunsAtOf(h);
  if (isLoopbackName(h) || h.endsWith('.local') || !h.includes('.')) return 'own_network';
  return null;
}

/** Where a reader at this address runs: inside the network, or not. */
export const aiReaderRunsAtOf = (address: string): AiReaderRunsAt =>
  isPrivateAddress(address) ? 'own_network' : 'cloud';

/**
 * Whether the vault may send to this address (decision 9), as resolved for
 * a call: never link-local, "this network" or multicast; and on the hosted
 * edition (`publicOnly`) never one inside a network, nor a name that means
 * this machine.
 */
export function aiReaderAddressAllowed(address: string, o: { publicOnly: boolean }): boolean {
  if (isLinkLocalAddress(address)) return false;
  if (o.publicOnly && isPrivateAddress(address)) return false;
  return true;
}

/** Where the reader is set: in Settings; by whoever runs the server, in .env; or not offered here. */
export type AiReaderSource = 'settings' | 'env' | 'off';

/** The reader an owner saved (AIR1): never its key, only whether one is set and its last characters. */
export interface AiReaderSaved {
  kind: AiReaderKind;
  /** `scheme://host[:port]`; null for Anthropic, whose address is fixed (AIR3). */
  base_url: string | null;
  model: string;
  timeout_seconds: number;
  runs_at: AiReaderRunsAt;
  /**
   * The owner's word that an OpenAI-compatible reader is on their own
   * network (AIR3, decision 2): it runs there only at a private address
   * too. Absent from older vaults.
   */
  own_network?: boolean;
  api_key: 'set' | 'not_set';
  /** The key's last four characters, to tell one from another; null with none. */
  api_key_last4: string | null;
  monthly_cap: number;
  status: AiReaderStatus;
  last_tested_at: string | null;
  /** Why the last Test failed; null when it passed or none was made. */
  last_problem: LocalAiProblem | null;
  updated_at: string;
}

/**
 * GET, PUT and DELETE /household/reading/ai-reader (AIR1), an owner's: where
 * the reader is set, the kinds this vault can use, .env's reader when it
 * wins (locked: "set by whoever runs this server"), and the one saved here.
 */
export interface AiReaderView {
  source: AiReaderSource;
  /** The kinds this vault reads with: `features.ai_reader_kinds`. */
  kinds: AiReaderKind[];
  /** .env's reader, while it wins (`source: 'env'`); else null. Never its URL's path. */
  env: {
    kind: AiReaderKind;
    model: string;
    host: string;
    runs_at: AiReaderRunsAt | null;
  } | null;
  /** The reader saved for this household; null, none. Kept, but not used, while .env wins. */
  reader: AiReaderSaved | null;
  /** Only https to a public address (the hosted edition). */
  https_only: boolean;
  /**
   * "Also send sensitive papers" (AIR3, decision 6): the household's, off
   * unless an owner turned it on. Absent from older vaults.
   */
  send_sensitive?: boolean;
  /**
   * The papers sent to a cloud reader this month, of the cap (AIR3,
   * decision 10). Absent from older vaults.
   */
  month?: AiReaderMonth;
}

/**
 * PUT /household/reading/ai-reader's body (AIR1). `api_key` left out keeps
 * the key saved — unless the kind or the address changed, when it is
 * forgotten: a key is never sent to an address it was not typed for. Null
 * forgets it.
 */
export interface AiReaderInput {
  kind: AiReaderKind;
  base_url?: string | null | undefined;
  model: string;
  timeout_seconds: number;
  monthly_cap: number;
  api_key?: string | null | undefined;
  /**
   * An OpenAI-compatible reader on the household's own network (AIR3,
   * decision 2): left out, false. Ignored for the other kinds.
   */
  own_network?: boolean | undefined;
}

/** What the worker found of the reader's list of models (AIR1): names alone, or why none. */
export interface AiReaderModelsFound {
  problem: LocalAiProblem | null;
  models: string[];
}

/** The list of models, with its words. */
export interface AiReaderModelsResult extends AiReaderModelsFound {
  words: string;
}

/** The list's answer in words. */
export function aiReaderModelsResult(found: AiReaderModelsFound): AiReaderModelsResult {
  if (found.problem) return { ...found, words: localAiProblemWords(found.problem) };
  const n = found.models.length;
  return {
    ...found,
    words:
      n === 0
        ? 'It answered, but has no models yet. Pull one on the reader’s server first.'
        : n === 1
          ? 'It has 1 model.'
          : `It has ${n} models.`,
  };
}

/** Words for where a reader runs. */
export const aiReaderRunsAtWords = (r: AiReaderRunsAt | null | undefined): string =>
  r === 'own_network'
    ? 'on your own network'
    : r === 'cloud'
      ? 'as a cloud service'
      : 'where, not yet known';

/** A kind's name, as Settings says it. */
export const AI_READER_KIND_NAMES: Readonly<Record<AiReaderKind, string>> = {
  ollama: 'Local (Ollama)',
  anthropic: 'Anthropic',
  openai_compatible: 'OpenAI-compatible',
};
