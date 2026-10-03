/**
 * A person's identity details (5.26): the field catalogue, and what a
 * client is shown of them.
 *
 * The catalogue is the Bitwarden identity set (A35) — name parts, a
 * username, a company and job title, emails, phones and addresses, and the
 * numbers on passports, driving licences and social security cards — with
 * what a family keeps besides: place and country of birth, sex as written
 * on documents, nationalities, government IDs of any kind (each with its
 * number, issuer, dates and, optionally, the document it is on), custom
 * fields and notes. No blood type and no allergies (A35).
 *
 * Each record has two parts: `shared`, which the person, the owners and —
 * as the household chooses (A34) — the adults or the whole family read; and
 * `only_me`, which only the person ever reads (A33). Every ID number, and
 * every custom field marked hidden, is masked until somebody reveals it,
 * which is audited by key, never by value.
 */

/** Who reads other people's shared identity details (A34), narrowest first. */
export const IDENTITY_AUDIENCES = ['owners_and_self', 'adults', 'family'] as const;
export type IdentityAudience = (typeof IDENTITY_AUDIENCES)[number];

/** The two parts of a record. */
export const IDENTITY_PARTS = ['shared', 'only_me'] as const;
export type IdentityPart = (typeof IDENTITY_PARTS)[number];

/** How long a wider audience waits, while everybody is told and can mark fields Only me (A34). */
export const IDENTITY_NOTICE_HOURS = 72;

/** How wide an audience is: one never heard of is narrower than any. */
export function identityAudienceRank(audience: string): number {
  return (IDENTITY_AUDIENCES as readonly string[]).indexOf(audience);
}

/** Each audience in words, for a setting and a sentence. */
export const IDENTITY_AUDIENCE_LABELS: Record<IdentityAudience, string> = {
  owners_and_self: 'The owners, and each person their own',
  adults: 'All adults',
  family: 'Everyone in the family',
};

/** The kinds of government ID. */
export const IDENTITY_ID_KINDS = [
  'passport',
  'national_id',
  'driving_licence',
  'residence_permit',
  'tax_id',
  'social_security',
  'health_insurance',
  'other',
] as const;
export type IdentityIdKind = (typeof IDENTITY_ID_KINDS)[number];

/** Sex as a passport writes it. */
export const IDENTITY_SEXES = ['F', 'M', 'X'] as const;

/** An email address or a phone number, with what it is for. */
export interface IdentityContact {
  /** Chosen by the client, unique in its list: what keys it in `filled` and a reveal. */
  id: string;
  label?: string | null;
  value: string;
}

export interface IdentityAddress {
  id: string;
  label?: string | null;
  line1?: string | null;
  line2?: string | null;
  line3?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  /** ISO 3166-1 alpha-2. */
  country?: string | null;
}

/**
 * A passport, a licence, a tax number. Its `number` is masked. Its
 * `document_id` is shown only to a reader who may see that document.
 */
export interface IdentityGovernmentId {
  id: string;
  kind: IdentityIdKind;
  /** What it is called, for 'other', or to tell two apart. */
  label?: string | null;
  number?: string | null;
  /** Who issued it: an authority, or a country. */
  issuer?: string | null;
  issued_on?: string | null;
  expires_on?: string | null;
  document_id?: string | null;
}

/** A field of the family's own. A hidden one's value is masked. */
export interface IdentityCustomField {
  id: string;
  label: string;
  value?: string | null;
  hidden?: boolean;
}

/** One part of a record, as sealed. Every field is optional. */
export interface IdentityFields {
  title?: string | null;
  given_name?: string | null;
  middle_name?: string | null;
  family_name?: string | null;
  /** Names before, or besides: a maiden name, a name on an old passport. */
  other_names?: string | null;
  place_of_birth?: string | null;
  /** ISO 3166-1 alpha-2. */
  country_of_birth?: string | null;
  /** As written on documents: F, M or X. */
  sex?: (typeof IDENTITY_SEXES)[number] | null;
  /** ISO 3166-1 alpha-2, each. */
  nationalities?: string[];
  username?: string | null;
  company?: string | null;
  job_title?: string | null;
  emails?: IdentityContact[];
  phones?: IdentityContact[];
  addresses?: IdentityAddress[];
  ids?: IdentityGovernmentId[];
  custom?: IdentityCustomField[];
  notes?: string | null;
}

/** The fields one value each. */
export const IDENTITY_TEXT_FIELDS = [
  'title',
  'given_name',
  'middle_name',
  'family_name',
  'other_names',
  'place_of_birth',
  'country_of_birth',
  'sex',
  'username',
  'company',
  'job_title',
  'notes',
] as const;

/** The fields that are lists of entries, each with its own `id`. */
export const IDENTITY_LISTS = ['emails', 'phones', 'addresses', 'ids', 'custom'] as const;
export type IdentityList = (typeof IDENTITY_LISTS)[number];

/** The catalogue, in the order a form shows it, with what each is called. */
export const IDENTITY_FIELDS: ReadonlyArray<{
  key: keyof IdentityFields;
  label: string;
  section: 'name' | 'birth' | 'contact' | 'work' | 'ids' | 'other';
}> = [
  { key: 'title', label: 'Title', section: 'name' },
  { key: 'given_name', label: 'First name', section: 'name' },
  { key: 'middle_name', label: 'Middle name', section: 'name' },
  { key: 'family_name', label: 'Last name', section: 'name' },
  { key: 'other_names', label: 'Other names', section: 'name' },
  { key: 'place_of_birth', label: 'Place of birth', section: 'birth' },
  { key: 'country_of_birth', label: 'Country of birth', section: 'birth' },
  { key: 'sex', label: 'Sex, as on documents', section: 'birth' },
  { key: 'nationalities', label: 'Nationalities', section: 'birth' },
  { key: 'emails', label: 'Email addresses', section: 'contact' },
  { key: 'phones', label: 'Phone numbers', section: 'contact' },
  { key: 'addresses', label: 'Addresses', section: 'contact' },
  { key: 'username', label: 'Username', section: 'contact' },
  { key: 'company', label: 'Company', section: 'work' },
  { key: 'job_title', label: 'Job title', section: 'work' },
  { key: 'ids', label: 'Government IDs', section: 'ids' },
  { key: 'custom', label: 'Other details', section: 'other' },
  { key: 'notes', label: 'Notes', section: 'other' },
];

/** What each kind of ID is called. */
export const IDENTITY_ID_LABELS: Record<IdentityIdKind, string> = {
  passport: 'Passport',
  national_id: 'National ID card',
  driving_licence: 'Driving licence',
  residence_permit: 'Residence permit',
  tax_id: 'Tax number',
  social_security: 'Social security number',
  health_insurance: 'Health insurance number',
  other: 'Other ID',
};

const blank = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

/** Whether a list entry holds anything but its id, label and kind. */
function entryFilled(list: IdentityList, entry: Record<string, unknown>): boolean {
  const skip =
    list === 'ids'
      ? ['id', 'kind', 'label']
      : list === 'custom'
        ? ['id', 'label', 'hidden']
        : ['id', 'label'];
  return Object.entries(entry).some(([k, v]) => !skip.includes(k) && !blank(v));
}

/**
 * What a part has a value for, by key: each field of one value as its own
 * name, each list entry as `<list>.<id>` ("ids.p1"). Never a value.
 */
export function identityFilled(f: IdentityFields): string[] {
  const out: string[] = [];
  for (const key of IDENTITY_TEXT_FIELDS) if (!blank(f[key])) out.push(key);
  if (!blank(f.nationalities)) out.push('nationalities');
  for (const list of IDENTITY_LISTS) {
    for (const entry of (f[list] ?? []) as unknown as Array<Record<string, unknown>>) {
      if (entryFilled(list, entry)) out.push(`${list}.${String(entry.id)}`);
    }
  }
  return out;
}

/**
 * The keys of what is masked in a part: each government ID with a number
 * (`ids.<id>`), and each hidden custom field with a value (`custom.<id>`).
 */
export function identityMaskedKeys(f: IdentityFields): string[] {
  return [
    ...(f.ids ?? []).filter((i) => !blank(i.number)).map((i) => `ids.${i.id}`),
    ...(f.custom ?? [])
      .filter((c) => c.hidden === true && !blank(c.value))
      .map((c) => `custom.${c.id}`),
  ];
}

/**
 * A part as a reader is shown it: every masked value taken out (null), and
 * the keys of what was. Revealing one is a request of its own, asked to
 * confirm who is asking, and audited by key.
 */
export function maskIdentity(f: IdentityFields): { fields: IdentityFields; masked: string[] } {
  const masked = identityMaskedKeys(f);
  const fields: IdentityFields = { ...f };
  if (f.ids) fields.ids = f.ids.map((i) => (blank(i.number) ? { ...i } : { ...i, number: null }));
  if (f.custom) {
    fields.custom = f.custom.map((c) =>
      c.hidden === true && !blank(c.value) ? { ...c, value: null } : { ...c },
    );
  }
  return { fields, masked };
}

/** The masked values asked for, by key; a key that names nothing masked is left out. */
export function revealIdentity(f: IdentityFields, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const [list, id] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    if (list === 'ids') {
      const found = (f.ids ?? []).find((i) => i.id === id);
      if (found && !blank(found.number)) out[key] = String(found.number);
    } else if (list === 'custom') {
      const found = (f.custom ?? []).find((c) => c.id === id);
      if (found && found.hidden === true && !blank(found.value)) out[key] = String(found.value);
    }
  }
  return out;
}

/** A value as compared: blank is none, an entry's keys in order and its blanks left out. */
function canon(v: unknown): unknown {
  if (blank(v)) return null;
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter((k) => !blank((v as Record<string, unknown>)[k]))
        .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/**
 * What a write changes of a part, by key: each field of one value whose
 * value moved, `nationalities`, and each list entry added, changed or taken
 * out (`<list>.<id>`). Never a value.
 */
export function identityChanges(before: IdentityFields, after: IdentityFields): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  const out: string[] = [];
  for (const key of IDENTITY_TEXT_FIELDS) if (!same(before[key], after[key])) out.push(key);
  if (!same(before.nationalities, after.nationalities)) out.push('nationalities');
  for (const list of IDENTITY_LISTS) {
    const was = new Map(
      ((before[list] ?? []) as unknown as Array<{ id: string }>).map((e) => [e.id, e]),
    );
    const now = new Map(
      ((after[list] ?? []) as unknown as Array<{ id: string }>).map((e) => [e.id, e]),
    );
    for (const id of new Set([...was.keys(), ...now.keys()])) {
      if (!same(was.get(id), now.get(id))) out.push(`${list}.${id}`);
    }
  }
  return out;
}

/**
 * A write, made from what the writer was shown (5.26). What a part keeps
 * that the writer could not see goes on as it was:
 *
 *  - a masked value the write leaves out — an ID's `number`, a hidden
 *    custom field's `value`, on an entry of the same id — is kept; one sent
 *    as null or blank is cleared;
 *  - an ID's document, where the writer may not see it (`mayLink` says no),
 *    is kept whatever the write says; one they may see is kept when left
 *    out, and cleared by null.
 *
 * Entries left out of a list are taken out; fields left out are cleared.
 */
export function mergeIdentityWrite(
  stored: IdentityFields,
  incoming: IdentityFields,
  mayLink: (documentId: string) => boolean,
): IdentityFields {
  const out: IdentityFields = { ...incoming };
  if (incoming.ids) {
    const was = new Map((stored.ids ?? []).map((i) => [i.id, i]));
    out.ids = incoming.ids.map((i) => {
      const before = was.get(i.id);
      const next: IdentityGovernmentId = { ...i };
      if (before && !('number' in i)) next.number = before.number ?? null;
      const linked = before?.document_id ?? null;
      if (linked && (!mayLink(linked) || !('document_id' in i))) next.document_id = linked;
      return next;
    });
  }
  if (incoming.custom) {
    const was = new Map((stored.custom ?? []).map((c) => [c.id, c]));
    out.custom = incoming.custom.map((c) => {
      const before = was.get(c.id);
      return before && !('value' in c) ? { ...c, value: before.value ?? null } : { ...c };
    });
  }
  return out;
}

/** The documents a part's IDs are on, by id. */
export function identityDocuments(f: IdentityFields): string[] {
  return [
    ...new Set(
      (f.ids ?? []).map((i) => i.document_id).filter((d): d is string => typeof d === 'string'),
    ),
  ];
}
