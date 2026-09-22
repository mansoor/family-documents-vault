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

/** Normalises a partial date to the end of its period: "2031-03" -> 2031-03-31 (month). */
export function parseDateInput(input: string): DateValue | null {
  const s = input.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const [, y, mo, d] = m;
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    if (dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) return null;
    return { date: s, precision: 'day' };
  }
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return { date: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`, precision: 'month' };
  }
  m = /^(\d{4})$/.exec(s);
  if (m) return { date: `${s}-12-31`, precision: 'year' };
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
