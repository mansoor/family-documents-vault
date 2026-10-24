import { canonicalZone, effectiveZone, localToday, type TimeZoneSource } from '@fdv/shared';
import type { Db } from './client.js';

/**
 * The server's default time zone (FDV_TIMEZONE, 0.9.0 TZ): the household's
 * clock until an owner chooses one. The API and the worker check it at
 * startup and refuse to start with a name that is not a zone; it is read
 * here as it is set, so both answer with the same. Unset (or, past that
 * check, not a zone) is UTC.
 */
export function serverZone(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.FDV_TIMEZONE?.trim();
  return canonicalZone(set) ?? 'UTC';
}

/**
 * The household's zone in effect, from `household.timezone` as stored: its
 * own when an owner chose one, else the server's default. Every time the
 * API or the worker says is said on this.
 */
export function householdZone(own: string | null | undefined): string {
  return effectiveZone(own, serverZone()).timezone;
}

/** The zone in effect and where it came from, for an answer: `timezone`, `timezone_source`. */
export function householdZoneOf(own: string | null | undefined): {
  timezone: string;
  timezone_source: TimeZoneSource;
} {
  return effectiveZone(own, serverZone());
}

const todays = new WeakMap<Db, Promise<string>>();

/**
 * The household's today, "2026-10-23", on its own calendar (the TZ review):
 * what a document's status, a checklist's "still valid" and anything else
 * that says "expired" or "due" is worked out against — never the server's
 * UTC day, which is already tomorrow for a family in Auckland after noon
 * UTC. Asked once a transaction, of the household the transaction is scoped
 * to (row-level security, or the system's own scope).
 */
export function householdToday(trx: Db): Promise<string> {
  let day = todays.get(trx);
  if (!day) {
    day = trx
      .selectFrom('household')
      .select('timezone')
      .executeTakeFirst()
      .then((hh) => localToday(householdZone(hh?.timezone)));
    todays.set(trx, day);
  }
  return day;
}
