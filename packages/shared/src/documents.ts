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
   * When its note's words last changed — written, changed or taken away
   * (5.35, A30). Only the words move it: an edit to anything else, or the
   * same words saved again, leaves it as it was. Null when nobody has
   * written one since 5.35; absent from older vaults.
   */
  notes_updated_at?: string | null;
  /**
   * Who changed them then, as the household knows them — on the activity
   * log's terms, as a version's `uploaded_by_name`: null to a viewer, who is
   * not told what the family has been doing, and when that person has left
   * the household. Absent from older vaults.
   */
  notes_updated_by_name?: string | null;
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
  /**
   * Whether the one asking filed it (5.17c, A72): a teen may change who
   * sees their own documents that they filed, between Only me and
   * Everyone. Only ever about the caller. Absent from older vaults.
   */
  filed_by_me?: boolean;
  /**
   * When an owner asked to remove it for good (5.24): in the Trash only.
   * Whoever filed it, and the other owners, were told then; bringing it
   * back clears it. Null when nobody has asked; absent from older vaults.
   */
  purge_requested_at?: string | null;
  /**
   * From when an owner may remove it for good, having asked:
   * `PURGE_NOTICE_HOURS` after `purge_requested_at`. Null when nobody has
   * asked — one an owner filed, or that is theirs, they remove at once.
   */
  purge_allowed_from?: string | null;
  /**
   * Whether the one asking, an owner, may remove it for good at once rather
   * than ask first (5.24): one they filed, or one that is theirs when nobody
   * filed it or whoever did is no longer in the household. False for anybody
   * else, and out of the Trash. Absent from older vaults.
   */
  purge_at_once?: boolean;
  /**
   * Its newest version's file was removed for good after the backup the
   * vault was restored from was made (5.24): the record is back, the file
   * is not. Absent from older vaults.
   */
  file_removed?: boolean;
  etag: string;
}

/**
 * How long somebody else's document waits, once an owner has asked to
 * remove it for good, for whoever filed it to bring it back (5.24, D1).
 */
export const PURGE_NOTICE_HOURS = 24;

/** What a document whose file was removed for good says in place of it (5.24). */
export const FILE_REMOVED = 'The file was removed for good.';

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
  /**
   * Its file was removed for good after the backup the vault was restored
   * from was made (5.24): its content, pages and thumbnail answer `410
   * file_removed`. Absent from older vaults.
   */
  file_removed?: boolean;
  /**
   * Where this version came from when somebody outside the family sent it
   * through a request (5.23), as its history line says it: "Sent through a
   * request link (Jane, accountant)". Only to whoever may review that
   * request — to anybody else, as to an older vault's reader, it is null and
   * `uploaded_by_name` names whoever filed it.
   */
  sent_through?: string | null;
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
  /**
   * The type as it is now (0.5.10): send it as `If-Match` on
   * `PATCH /document-types/{key}`, which refuses an edit made to an older
   * one (`409 conflict`). Absent from older vaults.
   */
  etag?: string;
  /**
   * The date its reminders count back from (0.5.15): `'expires'` (Review
   * by on the Will), or the key of one of its own `date` fields, such as
   * `'due_date'`; null, no reminders. Only a date the kind shows, with lead
   * times. Absent from older vaults: read it with `reminderOf`.
   */
  remind_from?: string | null;
  /**
   * That date's lead times, in days (0.5.15). While nothing reminds, the
   * times Expires kept. `reminder_leads` is Expires's alone, as older
   * phones read it: `[]` while a date field reminds.
   */
  remind_leads?: number[];
}

/** The longest a kind of document's name, or one of its fields' names, may be (0.5.10). */
export const TYPE_LABEL_MAX = 80;

/**
 * A new kind of document, or a change to one (0.5.10): every field
 * optional on a change, and what is left out stays as it is. A built-in
 * keeps its name and category (its label, category, short label and noun);
 * the household's own cannot be `hidden`, it is archived instead.
 */
export interface DocumentTypeInput {
  label?: string;
  /** One of the twelve (CATEGORY_LABELS). */
  category?: string;
  short_label?: string | null;
  issuer_noun?: string | null;
  /**
   * The fixed fields, each changed key by key. `expires.shown` is whether
   * the kind expires at all. A field is required only where it is shown.
   */
  core?: Partial<Record<CoreField, Partial<CoreFieldRule>>>;
  /**
   * The kind's own fields, the whole list in order, each a field of the
   * library (GET /document-attributes) by key: its kind and its answers are
   * the library's, its label the library's unless given.
   */
  fields?: Array<{ key: string; label?: string; required?: boolean }>;
  /**
   * The lead times of the date it reminds from, at most eight of them: as
   * before 0.5.15, Expires's, and `[]` is no reminders. Never with
   * `remind_leads`.
   */
  reminder_leads?: number[];
  /**
   * The date to remind from (0.5.15): `'expires'` or one of its `date`
   * fields shown, or null for no reminders. Left out, a kind that reminds
   * nobody starts reminding from Expires as before (`nextReminder`).
   */
  remind_from?: string | null;
  /** That date's lead times (0.5.15), one to eight; left out, the date's default. */
  remind_leads?: number[];
  default_visibility?: Visibility;
  usually_essential?: boolean;
  /** A built-in, no longer offered (or offered again). */
  hidden?: boolean;
}

/** A field for the library, made by the household (0.5.10). */
export interface DocumentAttributeInput {
  label: string;
  kind: AttributeKind;
  /** The answers a `choice` field offers; only a choice has them. */
  choices?: string[] | null;
}

/** How many of a kind's documents have a value for one of its fields. */
export interface FieldImpact {
  key: string;
  /** The kind's name for it; null is the app's own word, or a field the kind does not ask for. */
  label: string | null;
  with_value: number;
  without_value: number;
}

/**
 * What a change to a kind of document would touch (GET
 * /document-types/{key}/impact, 0.5.10): its documents the caller can see,
 * never those they cannot, and `unseen` says so in words, always, with no
 * number — a count would say that somebody's Only me documents are of
 * this kind. "12 passports have no number yet".
 */
export interface DocumentTypeImpact {
  key: string;
  /** Its documents the caller can see, out of the Trash. */
  documents: number;
  /** In the Trash, that the caller can see. */
  in_trash: number;
  /** Each fixed field: how many of those documents have a value for it. */
  core: Record<CoreField, { with_value: number; without_value: number }>;
  /**
   * Each of its own fields, the same; then every other field one of those
   * documents keeps a value for (one the kind dropped: 5.12), `label` null.
   * A field not listed, none of them has.
   */
  fields: FieldImpact[];
  /** Reminders made from its lead times, not done yet, on those documents. */
  reminders: number;
  /**
   * The same reminders by the date each is about (0.5.15): `{ expires: 3,
   * due_date: 2 }`. A date none is about is left out. Absent from older vaults.
   */
  reminders_by_source?: Record<string, number>;
  /** "Documents you can't see may also be affected." */
  unseen: string;
}

/** Said with every count of a kind's documents, whether or not there are any the reader can't see. */
export const UNSEEN_DOCUMENTS = "Documents you can't see may also be affected.";

/**
 * A kind of document's delete refused (`409 type_in_use`, 0.5.10): only
 * for a document the caller can see (the 5.11 review). One that only
 * documents they cannot see use is deleted for them, as an unused one is.
 */
export const TYPE_IN_USE =
  "This kind of document is still in use, so it can't be deleted. Archive it instead: every document filed under it stays as it is.";

/**
 * A change asking a kind that expires not to require its expiry (`422`,
 * `detail: "expires"`, the 5.11 review): every kind that expires requires
 * one, and `core.expires.required` always says whether the kind expires.
 */
export const EXPIRY_ALWAYS_REQUIRED =
  'A kind of document that expires always needs its expiry date. Switch Expires off instead.';

// ------------------------------------------------ reminders from any date

/**
 * A kind reminds from one date it shows (0.5.15, A61): Expires (Review by
 * on the Will), or one of its own `date` fields — a bill's Due date, a
 * car's MOT. Issued and a year are never offered: they have happened by
 * the time a document is filed. Nothing repeats.
 */

/** `remind_from` refused (422, `detail: 'remind_from'`): a date the kind does not ask for. */
export const REMIND_FROM_NOT_ASKED =
  'Reminders can only count back from a date this kind asks for: Expires, or one of its date fields.';

/** A date to remind from with no lead times (422, `detail: 'remind_leads'`). */
export const REMIND_NEEDS_LEADS = 'Choose how long before to remind, or switch reminders off.';

/** Lead times sent with reminders switched off (422, `detail: 'remind_leads'`). */
export const REMIND_OFF_NO_LEADS =
  'Reminders are off, so there is nothing to remind before. Choose a date to remind from first.';

/** The reminding date made optional (422, `detail`: the field's key). */
export const REMINDING_DATE_REQUIRED =
  'Reminders come from this date, so every document of this kind needs it. Choose another date, or switch reminders off, first.';

/** `reminder_leads` and `remind_leads` sent together (422). */
export const ONE_SET_OF_LEADS =
  'Send the lead times once: remind_leads, or reminder_leads as before, not both.';

/** A new field named like one the library has (422, `detail: 'label'`). */
export const libraryHasName = (label: string): string =>
  `The library already has “${label}”. Ask for that one instead of adding another.`;

/** The built-in library field a bill reminds from (0038). */
export const DUE_DATE = 'due_date';

/** A date to remind from, and how long before it. */
export interface Reminding {
  /** `'expires'` or a date field's key; null, no reminders. */
  from: string | null;
  /** Days before, each once, furthest first. */
  leads: number[];
}

/** Lead times each once, furthest first, as the vault keeps them. */
export const leadTimes = (leads: ReadonlyArray<number>): number[] =>
  [...new Set(leads)].sort((a, b) => b - a);

/**
 * What a kind reminds from, and how long before; while nothing reminds,
 * `from` is null and `leads` are the times Expires kept. A vault older
 * than 0.5.15 says no `remind_from`: its kinds remind from Expires while
 * they expire and have lead times, as every vault has since 0.4.10.
 */
export function reminderOf(
  type: Pick<DocumentTypeView, 'expiry_driver' | 'reminder_leads' | 'remind_from' | 'remind_leads'>,
): Reminding {
  if (type.remind_from !== undefined) {
    return {
      from: type.remind_from,
      leads: leadTimes(type.remind_leads ?? (type.remind_from ? type.reminder_leads : [])),
    };
  }
  return type.expiry_driver && type.reminder_leads.length > 0
    ? { from: 'expires', leads: leadTimes(type.reminder_leads) }
    : { from: null, leads: [] };
}

/**
 * The lead times a date starts with when it is chosen with none: 7 days
 * for a due date, 30 for any other. Expires takes back the times it kept
 * while it was switched off (`kept`), the only ones ever kept then — so a
 * passport's nine and six months never carry over to a bill.
 */
export function defaultLeads(source: string, kept: ReadonlyArray<number> = []): number[] {
  if (source === 'expires') return kept.length > 0 ? leadTimes(kept) : [30];
  return source === DUE_DATE ? [7] : [30];
}

/** What `reminderWord` and `reminderChoices` read of a kind. */
export interface ReminderWords {
  expiry_driver: string | null;
  core?: Partial<Record<CoreField, Partial<CoreFieldRule>>> | null | undefined;
  fields?: ReadonlyArray<Pick<TypeField, 'key' | 'label' | 'kind'>> | null | undefined;
}

/**
 * The kind's word for the date a reminder is about: its name for Expires,
 * else "Review by" (the Will) or "Expires"; or its date field's label.
 * `library` names a field the kind no longer asks for.
 */
export function reminderWord(
  type: ReminderWords | null | undefined,
  source: string,
  library: ReadonlyArray<Pick<DocumentAttributeView, 'key' | 'label'>> = [],
): string {
  if (source === 'expires') {
    return (
      type?.core?.expires?.label ?? (type?.expiry_driver === 'review_on' ? 'Review by' : 'Expires')
    );
  }
  return (
    type?.fields?.find((f) => f.key === source)?.label ??
    library.find((a) => a.key === source)?.label ??
    source
  );
}

/**
 * The dates a kind can remind from, in its own words and in the order its
 * card asks for them: Expires (or Review by) while shown, then each of its
 * `date` fields. A household's own field named like a built-in one reads
 * "Due date (your own)".
 */
export function reminderChoices(
  type: ReminderWords,
  library: ReadonlyArray<Pick<DocumentAttributeView, 'key' | 'label' | 'builtin'>> = [],
): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  if (type.expiry_driver !== null)
    out.push({ key: 'expires', label: reminderWord(type, 'expires') });
  for (const f of type.fields ?? []) {
    if (f.kind !== 'date') continue;
    const own = library.find((a) => a.key === f.key)?.builtin === false;
    const clash =
      own &&
      library.some(
        (a) => a.builtin && a.label.trim().toLowerCase() === f.label.trim().toLowerCase(),
      );
    out.push({ key: f.key, label: clash ? `${f.label} (your own)` : f.label });
  }
  return out;
}

/** What `nextReminder` reads of a change to a kind. */
export interface ReminderChange {
  remind_from?: string | null | undefined;
  remind_leads?: number[] | undefined;
  reminder_leads?: number[] | undefined;
  fields?: ReadonlyArray<{ key: string; required?: boolean | undefined }> | undefined;
}

/** A change refused: the sentence, and the field it is about. */
export interface ReminderProblem {
  message: string;
  detail: string;
}

/**
 * What a kind reminds from after a change, worked out on the kind as it
 * will be — the same rules on the server and in the fakes (0.5.15):
 *
 *  - The date must be one the kind asks for: Expires while shown, or a
 *    `date` field it shows. Anything else is refused (REMIND_FROM_NOT_ASKED).
 *  - Reminders on need lead times (REMIND_NEEDS_LEADS). A date chosen with
 *    none sent gets its default (`defaultLeads`); the date it already
 *    reminds from keeps its own.
 *  - `remind_from` left out, the rule every vault has kept: a kind that
 *    reminds nobody starts reminding from Expires when Expires is switched
 *    on, when it is made showing Expires, or when lead times are sent while
 *    it shows Expires — with the times sent, else those kept, else 30
 *    days. `reminder_leads` sets the reminding date's times, and `[]` is
 *    no reminders, as it always was. A kind that reminds from another date
 *    keeps it.
 *  - Hiding the date reminders come from switches them off. Expires keeps
 *    its lead times, as it always has; any other date's are cleared, and
 *    so are they when `remind_from` is null.
 *  - The reminding date is always required: a change that makes it
 *    optional is refused (REMINDING_DATE_REQUIRED, naming it).
 *
 * `before` is the kind as it is (null for a new one); `after`, whether it
 * will show Expires and the keys of the `date` fields it will show.
 */
export function nextReminder(
  sent: ReminderChange,
  before: { reminding: Reminding; expires: boolean } | null,
  after: { expires: boolean; dates: ReadonlyArray<string> },
): Reminding | { problem: ReminderProblem } {
  if (sent.remind_leads !== undefined && sent.reminder_leads !== undefined) {
    return { problem: { message: ONE_SET_OF_LEADS, detail: 'remind_leads' } };
  }
  const leadsSent = sent.remind_leads ?? sent.reminder_leads;
  const dates = after.expires ? ['expires', ...after.dates] : [...after.dates];
  let from = before?.reminding.from ?? null;
  let leads = before?.reminding.leads ?? [];
  if (sent.remind_from === null) {
    if (leadsSent?.length)
      return { problem: { message: REMIND_OFF_NO_LEADS, detail: 'remind_leads' } };
    from = null;
    leads = [];
  } else if (sent.remind_from !== undefined) {
    if (!dates.includes(sent.remind_from)) {
      return { problem: { message: REMIND_FROM_NOT_ASKED, detail: 'remind_from' } };
    }
    if (leadsSent !== undefined) {
      if (leadsSent.length === 0) {
        return { problem: { message: REMIND_NEEDS_LEADS, detail: 'remind_leads' } };
      }
      leads = leadsSent;
    } else if (sent.remind_from !== from) {
      // Only Expires keeps its times while off: another date's are gone.
      leads = defaultLeads(sent.remind_from, from === null ? leads : []);
    }
    from = sent.remind_from;
  } else {
    // The date reminders come from, hidden by this change: switched off.
    if (from !== null && !dates.includes(from)) {
      if (from !== 'expires') leads = [];
      from = null;
    }
    if (leadsSent !== undefined) {
      if (leadsSent.length === 0) {
        from = null;
        leads = [];
      } else {
        leads = leadsSent;
        if (from === null && after.expires) from = 'expires';
      }
    } else if (from === null && after.expires && !before?.expires) {
      from = 'expires';
      if (leads.length === 0) leads = [30];
    }
  }
  if (from !== null && from !== 'expires') {
    if (sent.fields?.some((f) => f.key === from && f.required === false)) {
      return { problem: { message: REMINDING_DATE_REQUIRED, detail: from } };
    }
  }
  return { from, leads: leadTimes(leads) };
}

/** Who a visibility reaches, fewest first. An unknown one reaches nobody. */
const REACH: Record<string, number> = { private: 1, adults: 2, household: 3 };

/**
 * Whether a kind's default visibility of `to` puts a new document in front
 * of more people than `from` did (0.5.10): Only me or Adults only to
 * Everyone, Only me to Adults only. An owner's decision, confirmed.
 */
export function widensVisibility(from: Visibility, to: Visibility): boolean {
  return (REACH[to] ?? 0) > (REACH[from] ?? 0);
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
