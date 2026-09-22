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

/** Derived reminder dates for a document: one per lead, from the end of the expiry period. */
export function derivedFireDates(
  expiresIso: string,
  leads: number[],
): Array<{ lead: number; fire_at: string }> {
  return [...new Set(leads)]
    .filter((l) => l >= 0)
    .sort((a, b) => b - a)
    .map((lead) => ({ lead, fire_at: addDays(expiresIso, -lead) }));
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

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}
