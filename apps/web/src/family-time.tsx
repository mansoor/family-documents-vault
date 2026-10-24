import {
  shareEndWords,
  whenExactly,
  whenWords,
  zoneShortName,
  zoneOffsetWords,
  localToday,
} from '@fdv/shared';
import { useEffect } from 'react';
import { useApp } from './app-context.js';
import { currentFamilyZone } from './family-zone-store.js';

/**
 * Every time the web app shows, on the family's clock (0.9.0, TZ; the
 * owner's ask of 23 Oct 2026).
 *
 * The household is a shared space with things on its clock — a link that
 * ends "Friday 5 pm", the hour reminders arrive, "edited 9:14" — so one
 * clock for everyone: the family's time zone (Settings → Time zone, else
 * the server's FDV_TIMEZONE, else UTC), whatever zone this browser is in.
 * Where the browser's zone differs, a time says which clock it is on,
 * "5:25pm PDT" (or "GMT+5:30" where a zone has no well-known short name),
 * so somebody travelling is never misled; in the same zone, nothing is
 * added.
 *
 * A date without a time — an expiry, a birthday, the day a reminder falls
 * due — is the same day everywhere: never put through a zone
 * (`dateOnlyWords`).
 *
 * This file is the one place in the web app that turns a moment into words
 * with the platform's date formatting: eslint.config.js refuses
 * toLocaleString with a date, toLocaleDateString, toLocaleTimeString and
 * Intl.DateTimeFormat anywhere else, so a new screen cannot slip back to the
 * browser's clock.
 */

/** The zone this browser is in: "America/Los_Angeles". */
export function browserZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * The family's zone as this page last heard it, else this browser's: for a
 * helper said outside a screen's render. A screen asks useFamilyZone, which
 * also asks the vault and re-draws it when the zone changes.
 */
export function familyZoneNow(): string {
  return currentFamilyZone() ?? browserZone();
}

/** Whether a zone's clock reads as this browser's at a moment: no name is needed then. */
function sameClock(zone: string, at: Date): boolean {
  const here = browserZone();
  if (zone === here) return true;
  return zoneOffsetWords(zone, at) === zoneOffsetWords(here, at);
}

/**
 * " PDT" after a time on the family's clock, where this browser's clock
 * reads otherwise at that moment; "" where they agree. With `always`, the
 * name is said whatever the browser's zone.
 */
export function zoneNote(zone: string, at: Date | string = new Date(), always = false): string {
  const when = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(when.getTime())) return '';
  if (!always && sameClock(zone, when)) return '';
  return ` ${zoneShortName(zone, when)}`;
}

/** Whether words carry a time of day: "4:12pm", "17:00". */
const hasTime = (words: string) => /\d:\d\d/.test(words);

/** "26 Sep 2026, 3:12pm" on the family's clock, and its zone where the browser's differs. */
export function exactWords(iso: string, zone: string = familyZoneNow()): string {
  return `${whenExactly(iso, zone)}${zoneNote(zone, iso)}`;
}

/** "yesterday, 4:12pm" on the family's clock and calendar, and its zone where the browser's differs. */
export function relativeWords(
  iso: string,
  zone: string = familyZoneNow(),
  now: Date = new Date(),
): string {
  const words = whenWords(iso, now, zone);
  return hasTime(words) ? `${words}${zoneNote(zone, iso)}` : words;
}

/** "Friday 3 October at 17:00" on the family's clock, and its zone where the browser's differs. */
export function endWords(
  at: Date | string,
  zone: string = familyZoneNow(),
  opts: { weekday?: boolean; year?: boolean } = {},
): string {
  const when = typeof at === 'string' ? new Date(at) : at;
  return `${shareEndWords(when, zone, opts)}${zoneNote(zone, when)}`;
}

/**
 * A moment, its date and time in the browser's own words ("24 October 2026
 * at 17:00", or as this browser's language says it), on `zone`'s clock;
 * its zone named where the browser's differs, or `always`.
 */
export function dateTimeWords(
  iso: string,
  zone: string = familyZoneNow(),
  opts: { date?: 'long' | 'medium' | null; always?: boolean } = {},
): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const date = opts.date === undefined ? 'long' : opts.date;
  const words = at.toLocaleString([], {
    ...(date ? { dateStyle: date } : {}),
    timeStyle: 'short',
    timeZone: safeZone(zone),
  });
  return `${words}${zoneNote(zone, at, opts.always)}`;
}

/** "12 Oct, 14:03" on the family's clock, and its zone where the browser's differs. */
export function shortWhenWords(iso: string, zone: string = familyZoneNow()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const words = at.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: safeZone(zone),
  });
  return `${words}${zoneNote(zone, at)}`;
}

/**
 * The day a moment falls on, on the family's calendar: "3 October", "3 Oct
 * 2025". A day has no time of day, so no zone is named.
 */
export function dayWordsOf(
  iso: string,
  zone: string = familyZoneNow(),
  opts: { month?: 'long' | 'short'; year?: boolean | 'other'; weekday?: boolean } = {},
): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const tz = safeZone(zone);
  const year =
    opts.year === 'other'
      ? localToday(tz, at).slice(0, 4) !== localToday(tz).slice(0, 4)
      : opts.year === true;
  return at.toLocaleDateString('en-GB', {
    ...(opts.weekday ? { weekday: 'long' } : {}),
    day: 'numeric',
    month: opts.month ?? 'long',
    ...(year ? { year: 'numeric' } : {}),
    timeZone: tz,
  });
}

/**
 * A date without a time — an expiry, a date of birth, a month — said as it
 * is: never moved by any zone, the family's or the browser's. "12 March
 * 2012"; with `month` only, "March 2012".
 */
export function dateOnlyWords(
  ymd: string,
  opts: { day?: boolean; month?: 'long' | 'short'; year?: boolean } = {},
): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(ymd);
  if (!m) return ymd;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? 1)));
  return at.toLocaleDateString('en-GB', {
    ...(opts.day === false ? {} : { day: 'numeric' }),
    month: opts.month ?? 'long',
    ...(opts.year === false ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

/**
 * The order a numeric date is read in, from the browser's locale: 14/03 or
 * 03/14. A date, never a moment: no zone comes into it.
 */
export function localeReadsMonthFirst(): boolean {
  const parts = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC' }).formatToParts(
    new Date(Date.UTC(2031, 2, 14)),
  );
  const at = (type: string) => parts.findIndex((p) => p.type === type);
  return at('month') >= 0 && at('month') < at('day') && at('day') < at('year');
}

/** A zone this browser can say times in, or UTC. */
function safeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/**
 * The family's time zone, for a signed-in screen: asked of the vault once a
 * sign-in (GET /profile), shared by every screen, and changed at once when
 * an owner changes it in Settings. Until the vault has answered, the zone
 * this browser last heard for the family, else its own.
 */
export function useFamilyZone(): string {
  const { familyZone, wantFamilyZone } = useApp();
  useEffect(() => {
    wantFamilyZone();
  }, [wantFamilyZone]);
  return familyZone ?? browserZone();
}
