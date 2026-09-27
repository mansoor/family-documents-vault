/**
 * Reminder arithmetic: pure functions over calendar dates, shared by the
 * API (creating and editing) and the worker (firing).
 */

export type Recurrence = 'monthly' | 'quarterly' | 'annual' | `every:${number}m`;

export interface ReminderView {
  id: string;
  document_id: string;
  document_title: string | null;
  kind: 'derived' | 'manual';
  fire_at: string;
  lead_days: number | null;
  note: string | null;
  recurrence: string | null;
  status: 'scheduled' | 'due' | 'snoozed' | 'acknowledged' | 'resolved';
  snoozed_until: string | null;
  /** Pre-rendered: "In 12 days · 2 Oct", "Due today", "Overdue by 3 days". */
  label: string;
  /**
   * Which date a derived reminder is about (0.5.15): `'expires'`, or the
   * key of the date field its kind reminds from; null for one somebody set
   * themselves. Absent from older vaults, where every derived reminder is
   * about Expires.
   */
  source?: string | null;
  /**
   * That date, in the kind's words, and how far off it is: "Due date:
   * 10 Oct, in 7 days" (0.5.15). Show it before `label`, which says when
   * the reminder itself fell due. Null for a manual reminder; absent from
   * older vaults.
   */
  about?: string | null;
}

/** ISO date arithmetic without time zones: dates are calendar days. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(iso: string, months: number): string {
  const [y, m, day] = iso.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

export function daysUntil(todayIso: string, iso: string): number {
  return Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000,
  );
}

export function parseRecurrence(r: string | null | undefined): number | null {
  if (!r) return null;
  if (r === 'monthly') return 1;
  if (r === 'quarterly') return 3;
  if (r === 'annual') return 12;
  const m = /^every:(\d{1,2})m$/.exec(r);
  return m ? Number(m[1]) : null;
}

/** The next instance of a recurring reminder, strictly after `after`. */
export function nextOccurrence(fireAt: string, recurrence: string, after: string): string | null {
  const months = parseRecurrence(recurrence);
  if (!months) return null;
  let next = fireAt;
  for (let i = 0; i < 1200 && next <= after; i++) next = addMonths(next, months);
  return next;
}

/**
 * Derived reminder dates for a document: one per lead, counted back from
 * the date its kind reminds from — the end of the expiry period, or a
 * date field such as a bill's due date (0.5.15).
 */
export function derivedFireDates(
  dateIso: string,
  leads: number[],
): Array<{ lead: number; fire_at: string }> {
  return [...new Set(leads)]
    .filter((l) => l >= 0)
    .sort((a, b) => b - a)
    .map((lead) => ({ lead, fire_at: addDays(dateIso, -lead) }));
}

/**
 * The date a derived reminder is about (0.5.15): its day plus its lead
 * time — the expiry, or the due date. Null for a manual reminder, which
 * is about nothing but itself.
 */
export function aboutDate(r: {
  kind: string;
  fire_at: string;
  lead_days: number | null;
}): string | null {
  return r.kind === 'derived' && r.lead_days !== null
    ? addDays(r.fire_at.slice(0, 10), r.lead_days)
    : null;
}

/**
 * Whether a reminder speaks of something that has lapsed: the date a
 * derived one is about has passed (0.5.15) — a late 7-day reminder for a
 * bill due in 6 days has not — and a manual one, its own day.
 */
export function lapsed(
  r: { kind: string; fire_at: string; lead_days: number | null },
  todayIso: string,
): boolean {
  return (aboutDate(r) ?? r.fire_at.slice(0, 10)) < todayIso;
}

/**
 * What a derived reminder is about, in the kind's word for the date and
 * how far off it is (0.5.15): "Due date: 10 Oct, in 7 days", "Expires:
 * 14 Mar 2031, in 4 years", "MOT: 2 Oct, 3 days ago". The year is said
 * when it is not this one.
 */
export function reminderAbout(word: string, dateIso: string, todayIso: string): string {
  const [y] = dateIso.split('-').map(Number) as [number];
  const [ty] = todayIso.split('-').map(Number) as [number];
  const on = y === ty ? shortDate(dateIso) : `${shortDate(dateIso)} ${y}`;
  return `${word}: ${on}, ${howFar(daysUntil(todayIso, dateIso))}`;
}

/** "today", "tomorrow", "in 7 days", "in 9 months", "in 4 years", "yesterday", "3 days ago". */
function howFar(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  const n = Math.abs(days);
  const span =
    n < 60
      ? `${n} days`
      : n < 730
        ? `${Math.round(n / 30)} months`
        : `${Math.round(n / 365)} years`;
  return days > 0 ? `in ${span}` : `${span} ago`;
}

/** "Today" on the household's calendar. */
export function localToday(timezone: string, now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The household's local hour, 0–23. */
export function localHour(timezone: string, now = new Date()): number {
  try {
    const h = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    }).format(now);
    return Number(h) % 24;
  } catch {
    return now.getUTCHours();
  }
}

export function reminderLabel(
  fireAt: string,
  todayIso: string,
  status: ReminderView['status'],
  snoozedUntil: string | null,
): string {
  if (status === 'snoozed' && snoozedUntil) return `Later · ${shortDate(snoozedUntil)}`;
  const d = daysUntil(todayIso, fireAt);
  if (d === 0) return 'Due today';
  if (d < 0) return `Overdue by ${-d} day${d === -1 ? '' : 's'}`;
  return `In ${d} day${d === 1 ? '' : 's'} · ${shortDate(fireAt)}`;
}

/** A calendar day as the reminder rows say it: "3 Oct" (the web's "Reminder on 3 Oct", 0.5.16). */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}
