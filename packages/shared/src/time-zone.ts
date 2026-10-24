/**
 * The family's time zone (0.9.0, TZ; the owner's ask of 23 Oct 2026).
 *
 * Every time the vault shows is on one clock, the household's: a link that
 * ends "Friday 5 pm", the hour reminders and digests arrive at, "edited
 * 9:14". Which zone that is:
 *
 *   the household's own   an owner chose it in Settings (or by
 *                         PUT /profile {timezone}); `household.timezone`;
 *   the server's default  FDV_TIMEZONE, which whoever runs the vault sets
 *                         in its .env, when no owner has chosen one;
 *   UTC                   when neither is set.
 *
 * `effectiveZone` is that rule, the one place it is written: the API's
 * answers and the worker both ask it. A date without a time — a passport's
 * expiry, a birthday, the day a reminder falls due — is never put through a
 * zone at all: it is the same day everywhere.
 */

/** Where the zone in effect came from: an owner's choice, or the server's default. */
export type TimeZoneSource = 'household' | 'server_default';

/** The zone a vault falls back to with nothing set. */
export const DEFAULT_TIME_ZONE = 'UTC';

let supported: Set<string> | null | undefined;
/** The zones this runtime lists (Intl.supportedValuesOf), or null where it cannot say. */
function supportedZones(): Set<string> | null {
  if (supported !== undefined) return supported;
  try {
    const list = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    supported = list ? new Set(list('timeZone')) : null;
  } catch {
    supported = null;
  }
  return supported;
}

/** The zone a name stands for, as the runtime resolves it ("Asia/Kolkata" is "Asia/Calcutta"), or null. */
function resolvedZone(name: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Each part of the name starting with a capital: "America/Port-au-Prince", "Etc/GMT+5". */
const WRITTEN_PROPERLY = /^[A-Z][A-Za-z0-9_+-]*(\/[A-Z][A-Za-z0-9_+-]*)+$/;

/**
 * A time zone's IANA name, properly spelt — "europe/london" is
 * "Europe/London", "Etc/UTC" and "utc" are "UTC" — or null for anything else
 * (the TZ review): an abbreviation ("EST", "GMT"), an offset ("+05:30"), or
 * a name for a zone the runtime does not list (Intl.supportedValuesOf, and
 * UTC). What the API stores, and FDV_TIMEZONE is read as. A current name
 * the runtime knows by an older one ("Asia/Kolkata", "Europe/Kyiv") is kept
 * as written, never turned into the older.
 */
export function canonicalZone(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const given = name.trim();
  if (given.length === 0 || given.length > 64) return null;
  // A region and a place, or UTC itself: never an abbreviation or an offset.
  if (!given.includes('/') && given.toUpperCase() !== 'UTC') return null;
  const canon = resolvedZone(given);
  if (canon === null) return null;
  if (canon === 'UTC') return 'UTC';
  const list = supportedZones();
  if (list && !list.has(canon)) return null;
  // As the runtime spells it ("europe/london" is "Europe/London"); but a
  // name it knows by an older one, written properly, is kept as written.
  return WRITTEN_PROPERLY.test(given) ? given : canon;
}

/** Whether two names are the same zone: "Asia/Kolkata" and "Asia/Calcutta" are. */
export function sameZone(a: string, b: string): boolean {
  if (a === b) return true;
  const ra = resolvedZone(a);
  return ra !== null && ra === resolvedZone(b);
}

/** Whether this is a time zone the vault takes: an IANA name this runtime lists, or UTC. */
export function isTimeZone(name: unknown): name is string {
  return canonicalZone(name) !== null;
}

/**
 * The household's zone in effect: its own when an owner chose one, else the
 * server's default (FDV_TIMEZONE), else UTC — each as the runtime spells it.
 * A zone this runtime does not know (a name a newer server stored) is passed
 * over as if unset.
 */
export function effectiveZone(
  own: string | null | undefined,
  serverDefault: string | null | undefined,
): { timezone: string; timezone_source: TimeZoneSource } {
  const mine = canonicalZone(own);
  if (mine) return { timezone: mine, timezone_source: 'household' };
  return {
    timezone: canonicalZone(serverDefault) ?? DEFAULT_TIME_ZONE,
    timezone_source: 'server_default',
  };
}

/**
 * A zone's short name at a moment: "BST", "PDT", "CEST" where it has a
 * well-known abbreviation (in British or American English), else its offset,
 * "GMT+5:30". UTC is "UTC".
 */
export function zoneShortName(timezone: string, at: Date = new Date()): string {
  const named = (locale: string): string => {
    try {
      return (
        new Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: 'short' })
          .formatToParts(at)
          .find((p) => p.type === 'timeZoneName')?.value ?? ''
      );
    } catch {
      return '';
    }
  };
  const offset = /^(GMT|UTC)([+\-−]|$)/;
  const us = named('en-US');
  if (us && !offset.test(us)) return us;
  const gb = named('en-GB');
  if (gb && !offset.test(gb)) return gb;
  return us || gb || timezone;
}

/** A zone's offset from UTC at a moment, as a clock says it: "GMT+1", "GMT-7", "GMT+5:30", "GMT". */
export function zoneOffsetWords(timezone: string, at: Date = new Date()): string {
  try {
    const v =
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone, timeZoneName: 'shortOffset' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const offset = v.replace('−', '-');
    // UTC's own offset is said as a clock says it: "GMT", not "GMT+0".
    return offset === 'GMT+0' || offset === 'GMT-0' ? 'GMT' : offset;
  } catch {
    return 'GMT';
  }
}

/**
 * The zones a picker offers: every one this runtime knows, and a short list
 * of the common ones where it cannot say (an older browser), the zone in
 * use always among them.
 */
export function timeZoneNames(including: readonly string[] = []): string[] {
  let all: string[];
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    all = supported ? supported('timeZone') : [];
  } catch {
    all = [];
  }
  if (all.length === 0) all = [...FALLBACK_TIME_ZONES];
  // "UTC" is not among supportedValuesOf's names, but is one to choose.
  const out = new Set([DEFAULT_TIME_ZONE, ...all]);
  for (const z of including) {
    const c = canonicalZone(z);
    if (c) out.add(c);
  }
  return [...out].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}

/** The zones offered where a browser cannot list its own. */
export const FALLBACK_TIME_ZONES: readonly string[] = [
  'UTC',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'America/Anchorage',
  'America/Bogota',
  'America/Chicago',
  'America/Denver',
  'America/Halifax',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Phoenix',
  'America/Sao_Paulo',
  'America/St_Johns',
  'America/Toronto',
  'America/Vancouver',
  'Asia/Bangkok',
  'Asia/Dhaka',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Jakarta',
  'Asia/Jerusalem',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Manila',
  'Asia/Riyadh',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tehran',
  'Asia/Tokyo',
  'Atlantic/Reykjavik',
  'Australia/Adelaide',
  'Australia/Brisbane',
  'Australia/Melbourne',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Athens',
  'Europe/Berlin',
  'Europe/Dublin',
  'Europe/Helsinki',
  'Europe/Istanbul',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Moscow',
  'Europe/Paris',
  'Europe/Rome',
  'Europe/Stockholm',
  'Europe/Warsaw',
  'Europe/Zurich',
  'Pacific/Auckland',
  'Pacific/Honolulu',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
];
