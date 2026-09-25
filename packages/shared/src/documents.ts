/**
 * Document shapes on the wire (API spec, section 4) and the status
 * derivation. Dates are always objects with a precision; status is always
 * computed by the server and never accepted from a client.
 */

export type DatePrecision = 'day' | 'month' | 'year';
export type Visibility = 'household' | 'adults' | 'private';

export interface DateValue {
  /** ISO calendar date. With month/year precision, the last day of the period. */
  date: string;
  precision: DatePrecision;
}

export type StatusValue =
  'active' | 'expiring_soon' | 'expired' | 'valid' | 'needs_info' | 'superseded' | 'missing';

export interface Status {
  value: StatusValue;
  /** Pre-rendered by the server so every client says the same thing. */
  label: string;
}

export interface DocumentView {
  id: string;
  type_key: string | null;
  title: string | null;
  owner_member_id: string | null;
  category: string | null;
  visibility: Visibility;
  issued: DateValue | null;
  expires: DateValue | null;
  identifier: string | null;
  physical_location: string | null;
  is_essential: boolean;
  tags: string[];
  notes: string | null;
  extra: Record<string, unknown>;
  status: Status;
  versions: number;
  latest_version_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  etag: string;
}

export interface VersionView {
  id: string;
  document_id: string;
  version_no: number;
  filename: string;
  mime: string;
  byte_size: number;
  sha256: string;
  page_count: number | null;
  ocr_status: string;
  uploaded_at: string;
}

export interface DocumentTypeView {
  key: string;
  label: string;
  category: string;
  fields: Array<{ key: string; label: string; kind: 'text' | 'date' | 'year' }>;
  expiry_driver: string | null;
  reminder_leads: number[];
  usually_essential: boolean;
  default_visibility: Visibility;
}

/** Renders a date value the way a person wrote it: "14 Mar 2031", "March 2031", "2031". */
export function formatDate(d: DateValue, locale = 'en-GB'): string {
  const [y, m, day] = d.date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, day));
  switch (d.precision) {
    case 'day':
      return dt.toLocaleDateString(locale, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
    case 'month':
      return dt.toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    case 'year':
      return String(y);
  }
}

/** The order of a numeric date in the reader's locale: 14/03/2031 or 03/14/2031. */
export type DateOrder = 'dmy' | 'mdy';

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** 'Mar', 'march', 'Sept.' → 3, 3, 9; anything else → null. */
function monthNumber(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w === 'sept') return 9;
  const i = MONTHS.findIndex((m) => m === w || (w.length === 3 && m.startsWith(w)));
  return i < 0 ? null : i + 1;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function dayValue(y: number, mo: number, d: number): DateValue | null {
  if (mo < 1 || mo > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    return null;
  return { date: `${pad(y, 4)}-${pad(mo)}-${pad(d)}`, precision: 'day' };
}

function monthValue(y: number, mo: number): DateValue | null {
  if (mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { date: `${pad(y, 4)}-${pad(mo)}-${pad(last)}`, precision: 'month' };
}

/**
 * A date as a person types it, to a date with its precision. A month is kept
 * as its last day and a year as 31 December, so "expires March 2031" is
 * still valid on 31 March.
 *
 * Accepted: 2031-03-14, 2031-03, 2031, 14 Mar 2031, 14 March 2031, 14th
 * March 2031, March 14, 2031, Mar 2031, March 2031. A numeric date such as
 * 14/03/2031 is read only when the caller says which order its reader's
 * locale uses; without it, 03/04/2031 could be either and is refused.
 */
export function parseDateInput(input: string, opts: { order?: DateOrder } = {}): DateValue | null {
  const s = input.trim().replace(/\s+/g, ' ');
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return dayValue(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return monthValue(Number(m[1]), Number(m[2]));
  m = /^(\d{4})$/.exec(s);
  if (m) return { date: `${m[1]}-12-31`, precision: 'year' };

  // 14 Mar 2031, 14 March 2031, 14th March 2031
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+\.?),? (\d{4})$/i.exec(s);
  if (m) {
    const mo = monthNumber(m[2] as string);
    return mo ? dayValue(Number(m[3]), mo, Number(m[1])) : null;
  }
  // March 14, 2031
  m = /^([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/i.exec(s);
  if (m) {
    const mo = monthNumber(m[1] as string);
    return mo ? dayValue(Number(m[3]), mo, Number(m[2])) : null;
  }
  // Mar 2031, March 2031
  m = /^([a-z]+\.?),? (\d{4})$/i.exec(s);
  if (m) {
    const mo = monthNumber(m[1] as string);
    return mo ? monthValue(Number(m[2]), mo) : null;
  }
  // 14/03/2031, 14.03.2031, 14-03-2031 — only in a known order.
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m && opts.order) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return opts.order === 'dmy' ? dayValue(y, b, a) : dayValue(y, a, b);
  }
  // 03/2031 — a month and a year, whatever the order of days.
  m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return monthValue(Number(m[2]), Number(m[1]));
  return null;
}

export interface StatusInput {
  type: { key: string; expiry_driver: string | null; reminder_leads: number[] } | null;
  owner_member_id: string | null;
  expires: DateValue | null;
  superseded?: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY);
}

/**
 * Status is a pure function of the document, its type's rules and today
 * (REM-01). Computed on read, never stored authoritatively.
 */
export function deriveStatus(doc: StatusInput, todayIso: string): Status {
  if (doc.superseded) return { value: 'superseded', label: 'Replaced by a newer version' };
  if (!doc.type) return { value: 'needs_info', label: 'Needs a name' };
  if (!doc.owner_member_id) return { value: 'needs_info', label: 'Needs a person' };
  if (!doc.type.expiry_driver) return { value: 'valid', label: '' };
  if (!doc.expires) return { value: 'needs_info', label: 'Needs an expiry date' };

  const days = daysBetween(todayIso, doc.expires.date);
  if (days < 0) return { value: 'expired', label: `Expired ${formatDate(doc.expires)}` };
  const window = Math.max(0, ...doc.type.reminder_leads);
  if (days <= window) {
    return {
      value: 'expiring_soon',
      label: days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`,
    };
  }
  return { value: 'active', label: `Valid for ${humaniseDays(days)}` };
}

function humaniseDays(days: number): string {
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const parts: string[] = [];
  if (years) parts.push(`${years} year${years === 1 ? '' : 's'}`);
  if (months) parts.push(`${months} month${months === 1 ? '' : 's'}`);
  if (!parts.length) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  return parts.join(' ');
}
