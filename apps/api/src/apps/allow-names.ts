import { Resolver } from 'node:dns/promises';
import { BlockList, isIPv4 } from 'node:net';

/**
 * The names in an app's allow-list (0.9.0-dev.64, APP7), looked up as its
 * requests come: a request is let in when its address is one of the A or
 * AAAA addresses a name points to now. Never a reverse lookup: the caller's
 * address is never asked its name.
 *
 * Each name's answer is kept for its TTL, at most five minutes (at least
 * ten seconds); a lookup that failed is remembered for thirty seconds, so a
 * name that does not answer is not asked again at every request. A lookup
 * that fails while an earlier answer is at most an hour old keeps that
 * answer; with none, the name lets nothing in (the caller refuses: fail
 * closed). A request never waits on the DNS longer than the timeout (two
 * seconds): a lookup that takes longer has failed. Lookups of one name at
 * once are one lookup. A loopback or unspecified address in an answer
 * (127.0.0.0/8, 0.0.0.0, ::1, ::) is never one a request may come from.
 */

/** Addresses no name lets in: this machine's own, and none at all. */
const NEVER = new BlockList();
NEVER.addSubnet('127.0.0.0', 8, 'ipv4');
NEVER.addAddress('0.0.0.0', 'ipv4');
NEVER.addAddress('::1', 'ipv6');
NEVER.addAddress('::', 'ipv6');
NEVER.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');
NEVER.addAddress('::ffff:0.0.0.0', 'ipv6');

/** Whether an answer's address is loopback or unspecified: never let in by a name. */
export function neverAllowed(address: string): boolean {
  try {
    return NEVER.check(address, isIPv4(address) ? 'ipv4' : 'ipv6');
  } catch {
    return true;
  }
}

/** One family's addresses for a name, and how long they may be kept (seconds). */
export type ResolveFamily = (
  name: string,
  family: 4 | 6,
) => Promise<Array<{ address: string; ttl: number }>>;

/** What a lookup of a name found: its addresses, or that it failed. */
type Answer = { addresses: string[]; ttlMs: number } | null;

interface Entry {
  addresses: string[] | null;
  /** Asked again from here. */
  freshUntil: number;
  /** An answer kept past its TTL, while a lookup fails: until here. */
  staleUntil: number;
}

export const NAME_TTL_MAX_MS = 5 * 60_000;
export const NAME_TTL_MIN_MS = 10_000;
export const NAME_FAILURE_MS = 30_000;
export const NAME_STALE_MS = 60 * 60_000;
export const NAME_TIMEOUT_MS = 2_000;
/** Names kept at most: the oldest is let go of first. */
const CACHE_MAX = 2_000;

/** No record of that family: an answer, not a failure. */
const EMPTY_CODES = new Set(['ENODATA', 'ENOTFOUND']);

/** The DNS, as Node asks it: one try, within the timeout. */
export function systemResolve(timeoutMs = NAME_TIMEOUT_MS): ResolveFamily {
  const r = new Resolver({ timeout: timeoutMs, tries: 1 });
  return async (name, family) =>
    family === 4 ? r.resolve4(name, { ttl: true }) : r.resolve6(name, { ttl: true });
}

export class AllowNames {
  private readonly cache = new Map<string, Entry>();
  private readonly asking = new Map<string, Promise<string[] | null>>();
  private readonly resolve: ResolveFamily;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: { resolve?: ResolveFamily; timeoutMs?: number; now?: () => number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? NAME_TIMEOUT_MS;
    this.resolve = opts.resolve ?? systemResolve(this.timeoutMs);
    this.now = opts.now ?? Date.now;
  }

  /**
   * A name's answer while it is fresh, without looking it up: its addresses,
   * or null for a failure remembered; undefined when it must be looked up.
   */
  fresh(name: string): string[] | null | undefined {
    const had = this.cache.get(name);
    return had && had.freshUntil > this.now() ? had.addresses : undefined;
  }

  /**
   * The addresses a name points to now: from the cache while it is fresh,
   * else looked up. Null when it cannot be told: the lookup failed, and no
   * answer of the last hour is kept.
   */
  async addresses(name: string): Promise<string[] | null> {
    const now = this.now();
    const had = this.cache.get(name);
    if (had && had.freshUntil > now) return had.addresses;
    const already = this.asking.get(name);
    if (already) return already;
    const asked = this.lookUp(name)
      .then((answer) => this.keep(name, answer, had))
      .finally(() => this.asking.delete(name));
    this.asking.set(name, asked);
    return asked;
  }

  /** Both families at once, within the timeout; a failure of either is the lookup's. */
  private async lookUp(name: string): Promise<Answer> {
    const family = async (f: 4 | 6) => {
      try {
        return await this.resolve(name, f);
      } catch (e) {
        if (EMPTY_CODES.has((e as { code?: string }).code ?? '')) return [];
        throw e;
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('dns timeout')), this.timeoutMs);
    });
    try {
      const [v4, v6] = await Promise.race([Promise.all([family(4), family(6)]), late]);
      const all = [...v4, ...v6];
      const ttl = all.length > 0 ? Math.min(...all.map((a) => a.ttl)) * 1000 : NAME_FAILURE_MS;
      return {
        addresses: all.map((a) => a.address).filter((a) => !neverAllowed(a)),
        ttlMs: Math.min(NAME_TTL_MAX_MS, Math.max(NAME_TTL_MIN_MS, ttl)),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private keep(name: string, answer: Answer, had: Entry | undefined): string[] | null {
    const now = this.now();
    let entry: Entry;
    if (answer) {
      entry = {
        addresses: answer.addresses,
        freshUntil: now + answer.ttlMs,
        staleUntil: now + answer.ttlMs + NAME_STALE_MS,
      };
    } else if (had?.addresses && had.staleUntil > now) {
      // The last answer, kept while it is not an hour stale; asked again soon.
      entry = { ...had, freshUntil: now + NAME_FAILURE_MS };
    } else {
      entry = { addresses: null, freshUntil: now + NAME_FAILURE_MS, staleUntil: 0 };
    }
    this.cache.delete(name);
    this.cache.set(name, entry);
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return entry.addresses;
  }
}
