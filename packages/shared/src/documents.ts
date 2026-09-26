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
  /**
   * Who issued it: the bank, the utility, the insurer, the country (0.4.10).
   * Absent from older servers.
   */
  issued_by?: string | null;
  physical_location: string | null;
  is_essential: boolean;
  tags: string[];
  /**
   * An Only me document's notes are sealed under its owner's key (0.5.8):
   * they are here when its owner asks for the document itself, and null in
   * a list — `has_notes` says whether it has any.
   */
  notes: string | null;
  /** Whether it has notes, wherever `notes` is null for being sealed (0.5.8). Absent from older vaults. */
  has_notes?: boolean;
  /**
   * The type's own details, by field key: each of its field's kind since
   * 0.5.7 (details.ts). A key its type no longer asks for may still be here.
   * Sealed like the notes on an Only me document (0.5.8): empty in a list.
   */
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
  /**
   * How many of its pages the vault has drawn (0.4.12, when
   * `features.page_previews`): GET /versions/{id}/pages/{n} serves pages 1
   * to this. Null until they are drawn — ask for page 1 and they will be;
   * 0 for a file the vault cannot draw. At most `PREVIEW_MAX_PAGES`.
   */
  preview_pages?: number | null;
  /**
   * Who added this version, as the household knows them (5.1): in a
   * document's history only (`GET /documents/{id}/versions`), and never to
   * a viewer, who is not told what the family has been doing. Null then,
   * when that person has left the household, or on an older vault.
   */
  uploaded_by_name?: string | null;
}

/** The vault draws a version's first 30 pages; the rest are opened by saving a copy. */
export const PREVIEW_MAX_PAGES = 30;

/** What a type's own field holds (0.5.6). Older vaults have text, date and year only. */
export type AttributeKind =
  'text' | 'long_text' | 'date' | 'year' | 'number' | 'money' | 'choice' | 'yes_no';

/** The fields every document has, which a type can show, require and label (0.5.6). */
export const CORE_FIELDS = [
  'identifier',
  'issued_by',
  'issued',
  'expires',
  'physical_location',
  'tags',
  'notes',
] as const;
export type CoreField = (typeof CORE_FIELDS)[number];

/** How a type asks for one of the fixed fields. A null label is the app's own word. */
export interface CoreFieldRule {
  shown: boolean;
  required: boolean;
  label: string | null;
}

/** One of a type's own fields, kept in a document's `extra` under its key. */
export interface TypeField {
  key: string;
  label: string;
  kind: AttributeKind;
  /** Asked for before the card saves (0.5.6); absent from older vaults. */
  required?: boolean;
  /** The answers a `choice` field offers. */
  choices?: string[];
}

export interface DocumentTypeView {
  key: string;
  label: string;
  category: string;
  fields: TypeField[];
  expiry_driver: string | null;
  reminder_leads: number[];
  usually_essential: boolean;
  default_visibility: Visibility;
  /** This type's word for who issued it ("Bank", "Insurer"…); null reads "Issued by" (0.4.10). */
  issued_by_label?: string | null;
  // Since 0.5.6 a household has types of its own, and changes the built-in
  // ones. The fields below are absent from older vaults, where every type
  // is a built-in and shown.
  /** One of the vault's own types, rather than the household's. */
  builtin?: boolean;
  /**
   * Hidden or archived by the household: not offered for a new document.
   * Still listed while a document uses it (unless asked with `?all=true`,
   * which lists every type), so a document's type can always be looked up.
   */
  hidden?: boolean;
  /** The fixed fields: each shown or not, required or not, and its label. */
  core?: Record<CoreField, CoreFieldRule>;
  /** Its short name in a line, "Bank statement"; null is its label. */
  short_label?: string | null;
  /** The noun after its issuer in a name, "statement"; null when named for its person. */
  issuer_noun?: string | null;
}

/** An attribute a type can ask for, from the library (GET /document-attributes, 0.5.6). */
export interface DocumentAttributeView {
  key: string;
  label: string;
  kind: AttributeKind;
  choices: string[] | null;
  /** One of the vault's own, rather than the household's. */
  builtin: boolean;
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

/** A date the card could have sent: a real day, with a precision it agrees with. */
export function wellFormedDate(d: DateValue): boolean {
  if (typeof d !== 'object' || d === null) return false;
  if (!['day', 'month', 'year'].includes(d.precision)) return false;
  const m = typeof d.date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.date) : null;
  if (!m) return false;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== day) {
    return false;
  }
  // A month is stored as its last day, a year as 31 December.
  if (d.precision === 'month') return new Date(Date.UTC(y, mo, 0)).getUTCDate() === day;
  if (d.precision === 'year') return mo === 12 && day === 31;
  return true;
}

/**
 * A field a document's type requires and the document has no value for
 * (0.5.7): one of the fixed fields ('identifier', 'expires'…) or the key of
 * one of the type's own, in `extra`. Its label is the type's name for it,
 * "Passport number"; null is the app's own word.
 */
export interface MissingField {
  key: string;
  label: string | null;
}

/** What `missingFields` reads of a type: how it asks for its fields. */
export interface RequiredRules {
  expiry_driver: string | null;
  core?: Partial<Record<CoreField, Partial<CoreFieldRule>>> | null | undefined;
  fields?: ReadonlyArray<Pick<TypeField, 'key' | 'label' | 'required'>> | null | undefined;
}

/** What `missingFields` reads of a document: its fixed fields and its details. */
export interface RequiredValues {
  identifier?: string | null | undefined;
  issued_by?: string | null | undefined;
  issued?: DateValue | null | undefined;
  expires?: DateValue | null | undefined;
  physical_location?: string | null | undefined;
  tags?: ReadonlyArray<string> | null | undefined;
  notes?: string | null | undefined;
  extra?: Record<string, unknown> | null | undefined;
}

const blank = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

/**
 * The fields a document's type requires that it has no value for, in the
 * order the card asks them: the fixed fields, then the type's own. A fixed
 * field is required only where the type shows it; an expiry date always is,
 * for a type that expires, as it has been from the start. A document is
 * never refused for any of these (A7): it is Needs info until they are given.
 */
export function missingFields(
  type: RequiredRules | null | undefined,
  doc: RequiredValues,
): MissingField[] {
  if (!type) return [];
  const out: MissingField[] = [];
  for (const key of CORE_FIELDS) {
    const rule = type.core?.[key];
    const required =
      key === 'expires'
        ? type.expiry_driver !== null
        : rule?.shown !== false && rule?.required === true;
    if (required && blank(doc[key])) out.push({ key, label: rule?.label ?? null });
  }
  for (const f of type.fields ?? []) {
    if (f.required === true && blank(doc.extra?.[f.key])) out.push({ key: f.key, label: f.label });
  }
  return out;
}

/**
 * What is known of an Only me document's sealed notes and details without
 * opening them (0.5.8): whether it has notes, and which details have a
 * value, as its owner last wrote them.
 */
export interface SealedPresence {
  notes: boolean;
  details: ReadonlyArray<string>;
}

/** Stands in for a sealed value: given, and never shown. */
const SEALED = '(sealed)';

/**
 * A document as `missingFields` needs it when its notes and details are
 * sealed under its owner's key (0.5.8), where a list, a search or the
 * nightly refresh cannot read them: each that has a value counts as given,
 * and nothing else changes. So an Only me car with its plate sealed is not
 * "Needs a registration plate" — and one without is, whatever the type
 * requires by then.
 */
export function withSealed<T extends RequiredValues>(
  doc: T,
  sealed: SealedPresence | null | undefined,
): T {
  if (!sealed || (!sealed.notes && sealed.details.length === 0)) return doc;
  return {
    ...doc,
    notes: sealed.notes && blank(doc.notes) ? SEALED : doc.notes,
    extra: { ...(doc.extra ?? {}), ...Object.fromEntries(sealed.details.map((k) => [k, SEALED])) },
  };
}

/** The app's own words for a fixed field a document needs, when its type has none. */
const CORE_WORDS: Record<CoreField, string> = {
  identifier: 'a number',
  issued_by: 'an issuer',
  issued: 'an issue date',
  expires: 'an expiry date',
  physical_location: 'where the original is',
  tags: 'a tag',
  notes: 'a note',
};

/**
 * A field's name after "Needs": "a passport number", "an insurer", "a VIN",
 * "an MOT certificate". Lower case, unless it starts with an abbreviation.
 */
function needsWords(label: string): string {
  const trimmed = label.trim();
  const abbreviation = /^[A-Z0-9]{2,}\b/.test(trimmed);
  const words = abbreviation ? trimmed : trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  const an = abbreviation
    ? /^[AEFHILMNORSX]/.test(words)
    : /^[aeiou]/.test(words) && !/^(uni|use|usu|eu|one\b)/.test(words);
  return `${an ? 'an' : 'a'} ${words}`;
}

function needsInfo(missing: ReadonlyArray<MissingField>): Status {
  const words = missing.map((m) =>
    m.label ? needsWords(m.label) : (CORE_WORDS[m.key as CoreField] ?? needsWords(m.key)),
  );
  const [first, second] = words;
  const label =
    words.length === 1
      ? `Needs ${first}`
      : words.length === 2
        ? `Needs ${first} and ${second}`
        : `Needs ${first} and ${words.length - 1} more details`;
  return { value: 'needs_info', label };
}

export interface StatusInput {
  type: { key: string; expiry_driver: string | null; reminder_leads: number[] } | null;
  owner_member_id: string | null;
  expires: DateValue | null;
  superseded?: boolean;
  /**
   * The required fields it has no value for, as `missingFields` finds them
   * (0.5.7). Left out, only the expiry date is asked for, as before.
   */
  missing?: ReadonlyArray<MissingField>;
}

const DAY = 24 * 60 * 60 * 1000;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY);
}

/**
 * Status is a pure function of the document, its type's rules and today
 * (REM-01). Computed on read, never stored authoritatively.
 *
 * A required field with no value makes it Needs info, in words that name
 * it: "Needs a passport number" (0.5.7). An expiry that has passed, or is
 * close, still comes first: that is what somebody has to act on.
 */
export function deriveStatus(doc: StatusInput, todayIso: string): Status {
  if (doc.superseded) return { value: 'superseded', label: 'Replaced by a newer version' };
  if (!doc.type) return { value: 'needs_info', label: 'Needs a name' };
  if (!doc.owner_member_id) return { value: 'needs_info', label: 'Needs a person' };
  const missing = [...(doc.missing ?? [])];
  if (!doc.type.expiry_driver)
    return missing.length ? needsInfo(missing) : { value: 'valid', label: '' };
  if (!doc.expires) {
    if (!missing.some((m) => m.key === 'expires')) missing.push({ key: 'expires', label: null });
    return needsInfo(missing);
  }

  const days = daysBetween(todayIso, doc.expires.date);
  if (days < 0) return { value: 'expired', label: `Expired ${formatDate(doc.expires)}` };
  const window = Math.max(0, ...doc.type.reminder_leads);
  if (days <= window) {
    return {
      value: 'expiring_soon',
      label: days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`,
    };
  }
  if (missing.length) return needsInfo(missing);
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
