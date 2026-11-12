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
 * Three kinds are kept (decision 1); this vault reads with those in
 * `features.ai_reader_kinds` — Ollama alone, until AIR3.
 */

/** Every kind of reader the vault knows (decision 1). */
export const AI_READER_KINDS = ['ollama', 'anthropic', 'openai_compatible'] as const;
export type AiReaderKind = (typeof AI_READER_KINDS)[number];

/** The kinds this vault reads with now (`features.ai_reader_kinds`): Ollama, until AIR3. */
export const AI_READER_KINDS_OFFERED: readonly AiReaderKind[] = ['ollama'];

/** Where a reader runs (decision 2). */
export type AiReaderRunsAt = 'own_network' | 'cloud';

/** Whether a Test has passed for the settings saved: only the vault says `ok`. */
export type AiReaderStatus = 'untested' | 'ok' | 'failed';

/**
 * The only paths each kind of reader is ever sent to (decision 9), after its
 * address: nothing else is called.
 */
export const AI_READER_PATHS: Readonly<Record<AiReaderKind, readonly string[]>> = {
  ollama: ['/api/chat', '/api/tags'],
  openai_compatible: ['/v1/chat/completions', '/v1/models'],
  anthropic: ['/v1/messages'],
};

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
  'not_url' | 'scheme' | 'credentials' | 'query' | 'path' | 'no_host' | 'https_needed';

const ADDRESS_WORDS: Readonly<Record<AiReaderAddressProblem, string>> = {
  not_url: 'Type the reader’s address, such as http://192.168.1.30:11434.',
  scheme: 'The address starts with http:// or https://.',
  credentials: 'Type only the address: no user name or password in it. A key goes in its own box.',
  query: 'Type only the address: nothing after a ? or a #.',
  path: 'Type only the address, such as http://192.168.1.30:11434: the vault adds the rest.',
  no_host: 'Type the reader’s address, with its host: http://192.168.1.30:11434.',
  https_needed: 'On this vault the reader’s address must start with https://.',
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
  return {
    url: `${url.protocol}//${url.host}`,
    host: url.host,
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
  };
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
