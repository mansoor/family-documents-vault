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
  /**
   * A yearly review (0.9.0, H3): somebody's own reminder (`manual`,
   * `recurrence: 'annual'`) to look the paper over again every year, its
   * note `REVIEW_NOTE`. Done brings the next one a year on. Absent from
   * older vaults.
   */
  review?: boolean;
}

/**
 * Kinds a yearly review may be set on (0.9.0, H3): an advance directive, a
 * healthcare proxy and a HIPAA authorization — papers whose wishes or
 * permissions are worth reading again every year. Off until somebody turns
 * it on for a document.
 */
export const YEARLY_REVIEW_KINDS: ReadonlySet<string> = new Set([
  'advance_directive',
  'healthcare_proxy',
  'hipaa_authorization',
]);

/** Whether a yearly review may be set on a document of this kind (YEARLY_REVIEW_KINDS). */
export const yearlyReviewOffered = (
  type: { key?: string | null | undefined } | null | undefined,
): boolean => !!type?.key && YEARLY_REVIEW_KINDS.has(type.key);

/** A yearly review's note, as every reminder list and digest says it (outside neutral wording). */
export const REVIEW_NOTE = 'Yearly review';

/** The switch on the document's page (H3). */
export const REVIEW_LABEL = 'Remind us to review it every year';

/**
 * A yearly review's first day (H3): the next anniversary of the day it was
 * signed, after today; with no such day, a year from today.
 */
export function firstReview(signed: string | null | undefined, today: string): string {
  const from = signed?.slice(0, 10);
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return nextOccurrence(from, 'annual', today) ?? addMonths(today, 12);
  }
  return addMonths(today, 12);
}

/**
 * The day a yearly review comes back after Done (H3): a year on from its
 * day — never today or before, nor its own day again when it was done
 * early. On the household's calendar (`today`). Counted from the day it
 * was first set for (`anchor`, `reminder.recur_from`), so a review on 29
 * February is on the 28th in other years and the 29th in a leap year.
 */
export function nextReview(fireAt: string, today: string, anchor: string = fireAt): string {
  const after = fireAt > today ? fireAt : today;
  return nextOccurrence(anchor, 'annual', after) ?? addMonths(after, 12);
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

/**
 * The next instance of a recurring reminder, strictly after `after`:
 * counted in whole steps from `anchor`, the day it was first set for —
 * never from the last instance, so the 31st and 29 February do not drift
 * to the 30th or the 28th for good (`addMonths` gives the last day of a
 * shorter month, and the day itself again in the next long one).
 */
export function nextOccurrence(anchor: string, recurrence: string, after: string): string | null {
  const months = parseRecurrence(recurrence);
  if (!months) return null;
  let next = anchor;
  for (let k = 1; k <= 1200 && next <= after; k++) next = addMonths(anchor, months * k);
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
