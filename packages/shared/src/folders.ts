import type { DocumentTypeView } from './documents.js';

/**
 * Folder names → suggested details (0.8.0, S2; CAP-11).
 *
 * A family's scans are often sorted already: "Passports/Ahmed",
 * "Bills/2024", "Sara/Medical". An item added from a folder — chosen or
 * dropped on Add → Many documents, a subfolder of the scanner folder, a
 * computer's watched folder — keeps where it was under that folder, without
 * the file's own name (`itemFolder`), sealed under the item's own key like
 * its other fields, and shown to its uploader alone. Its segments are read
 * for what they say (`suggestFromFolder`):
 *
 * - **A kind**: one of the household's kinds by its name, any part of it
 *   ("Bank / investment statement" is "Bank" too), its short name, or a
 *   small list of the words families use (`FOLDER_KIND_WORDS`).
 * - **Whose**: somebody of the family the uploader can see, by the name the
 *   household knows them by, or its first word. A teen's are their own, so a
 *   teen is matched to themselves alone. A name two of them share says
 *   nothing.
 * - **Tags**: an existing tag the uploader can see; and a segment that is
 *   none of the above, nor a year, a date or a container ("Scans",
 *   "Documents") — proposed as a new tag, at low confidence, never made until
 *   the item is accepted with it.
 *
 * Matching folds case, accents, possessives, simple plurals ("Passports",
 * "Policies") and separators (`_`, `-`, `.`). Two segments that say
 * different kinds, or different people, say neither. A segment that names
 * both a kind and a person ("Will") says neither.
 *
 * Weighed with what the pages propose (`levelItem`): below a sure page
 * reading (FOLDER_CONFIDENCE, under ITEM_SURE), so the folder alone never
 * makes an item Ready; the pages and the folder agreeing make it surer
 * (FOLDER_AGREE_RAISE); disagreeing, the pages stand and the item is Check.
 * A batch's defaults the uploader chose win over the folder: it fills only
 * what they leave blank.
 *
 * Pure, and worked out as it is asked, from the kinds, the people and the
 * tags the uploader is given then: nothing of it is stored.
 */

/** The most segments kept of a folder: the deepest, nearest the file. */
export const FOLDER_SEGMENTS_MAX = 10;
/** The most characters kept of a folder, separators included. */
export const FOLDER_CHARS_MAX = 512;
/** The most characters of one segment. */
const SEGMENT_CHARS_MAX = 120;
/** The longest `relative_path` an upload endpoint takes, before it is tidied. */
export const RELATIVE_PATH_MAX = 4096;

/** A kind or a person the folder alone suggests: shown, and unsure (under ITEM_SURE). */
export const FOLDER_CONFIDENCE = 0.8;
/** The pages and the folder agreeing: the pages' confidence raised by this much… */
export const FOLDER_AGREE_RAISE = 0.1;
/** …and never beyond this. */
export const FOLDER_AGREE_MAX = 0.95;
/** The most new tags one item's folder proposes. */
export const FOLDER_NEW_TAGS_MAX = 3;
/** A tag is 40 characters at most, as a document's are. */
const TAG_CHARS_MAX = 40;

/**
 * Folders that hold papers rather than say anything of them: the top of a
 * folder chosen, a scanner's, a download's. Folded and singular (`foldKey`).
 */
const GENERIC = [
  'scan',
  'scans',
  'scanned',
  'scanned document',
  'scanner',
  'my scan',
  'document',
  'documents',
  'doc',
  'docs',
  'my document',
  'my documents',
  'download',
  'downloads',
  'desktop',
  'file',
  'files',
  'paper',
  'papers',
  'paperwork',
  'important',
  'important document',
  'important papers',
  'family document',
  'family papers',
  'misc',
  'miscellaneous',
  'other',
  'others',
  'stuff',
  'old',
  'new',
  'new folder',
  'untitled folder',
  'folder',
  'inbox',
  'upload',
  'uploads',
  'to file',
  'to sort',
  'unsorted',
  'archive',
  'temp',
  'tmp',
  'image',
  'images',
  'picture',
  'pictures',
  'photo',
  'photos',
  'home',
  'household',
  'family',
  'personal',
  'shared',
  'onedrive',
  'dropbox',
  'google drive',
  'icloud',
  'icloud drive',
  'vault',
  'user',
  'users',
];

/** The words that only say "papers of": "Ahmed's documents" is Ahmed's. */
const TRAILING = ['document', 'doc', 'paper', 'paperwork', 'file', 'stuff', 'thing'];

/**
 * The words families sort their papers under, by the vault's own kinds (its
 * labels are matched too, and a household's own kinds by theirs). Written
 * naturally: each is folded as a folder is (`foldKey`).
 */
export const FOLDER_KIND_WORDS: Readonly<Record<string, readonly string[]>> = {
  passport: ['passport', 'passports'],
  drivers_licence: [
    'driving licence',
    'driving license',
    'drivers licence',
    'drivers license',
    "driver's licence",
    "driver's license",
    'driver licence',
    'driver license',
    'licence',
    'license',
  ],
  national_id: ['national id', 'id card', 'identity card', 'social security', 'national insurance'],
  visa: ['visa', 'residence permit', 'immigration', 'brp', 'green card', 'work permit'],
  birth_certificate: ['birth certificate', 'birth certificates', 'birth cert', 'birth'],
  marriage_certificate: ['marriage certificate', 'marriage', 'divorce', 'wedding'],
  will: ['will', 'wills', 'trust', 'power of attorney', 'lpa', 'estate planning'],
  property_deed: [
    'deed',
    'deeds',
    'title deed',
    'property',
    'lease',
    'tenancy',
    'rental agreement',
  ],
  vehicle_registration: [
    'vehicle',
    'vehicles',
    'vehicle registration',
    'car registration',
    'v5c',
    'logbook',
    'log book',
    'car title',
  ],
  insurance_policy: ['insurance', 'insurance policy', 'policy', 'policies'],
  tax_return: ['tax', 'taxes', 'tax return', 'tax returns', 'self assessment'],
  tax_form: ['tax form', 'tax forms', 'w2', 'w-2', 'p60', 'p45', 'p11d'],
  bank_statement: [
    'bank',
    'banking',
    'bank statement',
    'bank statements',
    'statement',
    'statements',
    'investment',
    'investments',
    'savings',
    'brokerage',
  ],
  loan: ['loan', 'loans', 'mortgage', 'credit agreement'],
  medical_record: [
    'medical',
    'medical record',
    'medical records',
    'health',
    'immunisation',
    'immunization',
    'vaccination',
    'vaccinations',
    'hospital',
    'doctor',
    'gp',
    'dental',
    'dentist',
  ],
  prescription: ['prescription', 'prescriptions', 'rx'],
  diploma: ['diploma', 'transcript', 'degree', 'education', 'school', 'university', 'college'],
  employment_contract: ['employment', 'employment contract', 'job offer', 'offer letter'],
  utility_bill: [
    'bill',
    'bills',
    'utility',
    'utilities',
    'utility bill',
    'electricity',
    'electric',
    'gas',
    'water',
    'energy',
    'broadband',
    'phone bill',
    'council tax',
  ],
  warranty: ['warranty', 'warranties', 'guarantee', 'receipt', 'receipts'],
  pet_record: ['pet', 'pets', 'vet', 'veterinary', 'pet record', 'pet records'],
};

/** Kinds no folder suggests: "Something else" is no kind. */
const NEVER_SUGGESTED = new Set(['other']);

/** Months and quarters: words of a date beside a year, or alone. */
const MONTHS = new Set([
  'jan',
  'january',
  'feb',
  'february',
  'mar',
  'march',
  'apr',
  'april',
  'may',
  'jun',
  'june',
  'jul',
  'july',
  'aug',
  'august',
  'sep',
  'sept',
  'september',
  'oct',
  'october',
  'nov',
  'november',
  'dec',
  'december',
  'q1',
  'q2',
  'q3',
  'q4',
  'fy',
]);

/** Control and format characters (a bidi override among them): never kept, never shown. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu;

/**
 * Where an item came from under the folder chosen or watched, as it is kept
 * (sealed) and shown: its folders, without the file's own name — dropped
 * when it is the last segment (`fileName`), or always (`withFileName`) —
 * each segment trimmed and stripped of control characters, `.` and `..`
 * gone, at most FOLDER_SEGMENTS_MAX segments and FOLDER_CHARS_MAX
 * characters (the deepest kept), joined by `/`. With `dropGenericTop`, the
 * top folder's name goes when it is only a container ("Scans",
 * "Documents"): "Ahmed" as a top folder says whose. Null for none.
 */
export function itemFolder(
  relativePath: string | null | undefined,
  opts: { fileName?: string | null; withFileName?: boolean; dropGenericTop?: boolean } = {},
): string | null {
  if (!relativePath) return null;
  let parts = relativePath
    .slice(0, RELATIVE_PATH_MAX)
    .split(/[/\\]+/)
    .map((s) => s.replace(UNSEEN, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '' && s !== '.' && s !== '..');
  const last = parts[parts.length - 1];
  if (opts.withFileName) parts = parts.slice(0, -1);
  else if (last !== undefined && opts.fileName) {
    const name = opts.fileName.replace(UNSEEN, '').replace(/\s+/g, ' ').trim();
    if (last === name) parts = parts.slice(0, -1);
  }
  if (opts.dropGenericTop && parts.length > 0 && isGenericFolder(parts[0] as string)) {
    parts = parts.slice(1);
  }
  parts = parts.map((s) => [...s].slice(0, SEGMENT_CHARS_MAX).join('')).slice(-FOLDER_SEGMENTS_MAX);
  while (parts.length > 0 && parts.join('/').length > FOLDER_CHARS_MAX) parts = parts.slice(1);
  return parts.length > 0 ? parts.join('/') : null;
}

/** Whether a folder's name is only a container ("Scans", "My Documents", "2024"). */
export function isGenericFolder(name: string): boolean {
  const key = segmentKey(name);
  return key === '' || GENERIC_KEYS.has(key);
}

/** A word as a plural is folded: "passports" → "passport", "policies" → "policy". */
export function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (/(?:ch|sh|x)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * A name's words as folders and names are compared: accents gone, lower
 * case, a possessive gone ("Ahmed's"), `_`, `-`, `.` and other punctuation
 * a space, spaced once.
 */
export function foldWords(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/'s\b/g, '')
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** A name folded and singular, as a whole: "Bank_Statements" → "bank statement". */
export const foldKey = (s: string): string => foldWords(s).map(singular).join(' ');

/** A year, a part of a date, a tax year ("fy2024"): two digits or more. */
const numeric = (w: string) => /^(?:fy|q[1-4])?\d{2,}$/.test(w);

/**
 * A segment's words without its years and dates ("Tax 2023-24" → "tax",
 * "March 2024" → nothing, "01 Passports" → "passports"): its numbers go,
 * a number it starts with, and the months beside a number. "W-2" keeps its 2.
 */
function undated(s: string): string[] {
  const words = foldWords(s);
  // "March", "Q3": a month alone is a date too.
  if (words.length > 0 && words.every((w) => MONTHS.has(w))) return [];
  const dated = words.some(numeric);
  return words.filter(
    (w, i) =>
      !numeric(w) && !(dated && MONTHS.has(w)) && !(i === 0 && words.length > 1 && /^\d+$/.test(w)),
  );
}

const segmentKey = (s: string) => undated(s).map(singular).join(' ');

const GENERIC_KEYS = new Set(GENERIC.map(foldKey));
const TRAILING_KEYS = new Set(TRAILING.map(foldKey));

/** A kind as a folder is matched to it: GET /document-types' view, or enough of it. */
export type FolderKind = Pick<DocumentTypeView, 'key' | 'label'> &
  Partial<Pick<DocumentTypeView, 'short_label' | 'hidden'>>;

export interface FolderContext {
  /** The kinds the uploader is given now. */
  types: readonly FolderKind[];
  /** The family the uploader can see now, by the name the household knows them by. */
  people: ReadonlyArray<{ id: string; name: string }>;
  /**
   * Whom the uploader may choose: everybody seen, but a teen themselves
   * alone. A name of somebody seen but not to be chosen says nothing — not
   * whose, and not a tag.
   */
  choosable?: (id: string) => boolean;
  /** The tags the uploader can see on documents now (as GET /tags gives them). */
  tags?: readonly string[];
  /** The household's own name: a container, never a tag. */
  household?: string | null;
}

/** A tag a folder proposes: one already used, or a new one from the folder's name. */
export interface FolderTag {
  value: string;
  /** Already on a document the uploader can see; otherwise new, and only offered. */
  existing: boolean;
}

/** What an item's folder suggests, as it is asked. */
export interface FolderSuggestion {
  /** The folder, as kept and shown: "Passports/Ahmed". */
  path: string;
  type_key: string | null;
  owner_member_id: string | null;
  tags: FolderTag[];
}

/** Each key, and the kinds or people it names: more than one is a name that says nothing. */
function index<T>(entries: Iterable<[string, T]>): Map<string, Set<T>> {
  const out = new Map<string, Set<T>>();
  for (const [k, v] of entries) {
    if (!k) continue;
    const set = out.get(k) ?? new Set<T>();
    set.add(v);
    out.set(k, set);
  }
  return out;
}

/**
 * What a folder suggests: a kind, whose it is, and tags — from the kinds,
 * the people and the tags the uploader is given now (see above). Never a
 * kind they are not given, nor a person they cannot see; a teen only
 * themselves. Null with no folder.
 */
export function suggestFromFolder(
  folder: string | null | undefined,
  ctx: FolderContext,
): FolderSuggestion | null {
  const path = itemFolder(folder);
  if (!path) return null;
  const choosable = ctx.choosable ?? (() => true);
  const kinds = ctx.types.filter((t) => !NEVER_SUGGESTED.has(t.key));
  const kindKeys = index<string>(
    kinds.flatMap((t) => {
      const names = [
        t.label,
        ...t.label.split('/'),
        t.short_label ?? '',
        t.key.replace(/_/g, ' '),
        ...(FOLDER_KIND_WORDS[t.key] ?? []),
      ];
      return names.map((n) => [foldKey(n), t.key] as [string, string]);
    }),
  );
  const personKeys = index<string>(
    ctx.people.flatMap((m) => {
      const words = foldWords(m.name).map(singular);
      return [
        [words.join(' '), m.id] as [string, string],
        [words[0] ?? '', m.id] as [string, string],
      ];
    }),
  );
  const tagKeys = index<string>((ctx.tags ?? []).map((t) => [foldKey(t), t]));
  const household = ctx.household ? foldKey(ctx.household) : '';

  /** One name: a kind, a person, or neither — `null` when it names both, or two of either. */
  const named = (key: string) => {
    const k = kindKeys.get(key);
    const p = personKeys.get(key);
    if (!k && !p) return undefined;
    if (k && p) return null;
    if (k) return k.size === 1 ? { kind: [...k][0] as string } : null;
    const ids = [...(p as Set<string>)];
    if (ids.length !== 1 || !choosable(ids[0] as string)) return null;
    return { person: ids[0] as string };
  };

  const kindsSaid = new Set<string>();
  const peopleSaid = new Set<string>();
  const tags: FolderTag[] = [];
  let newTags = 0;
  // Nearest the file first: its own folder says most.
  for (const segment of path.split('/').reverse()) {
    const words = undated(segment);
    const key = words.map(singular).join(' ');
    if (!key || GENERIC_KEYS.has(key) || key === household) continue;
    const whole = named(key);
    if (whole === null) continue;
    if (whole) {
      if (whole.kind) kindsSaid.add(whole.kind);
      if (whole.person) peopleSaid.add(whole.person);
      continue;
    }
    // "Ahmed's documents": the words after a name that say only "papers of".
    const keyWords = key.split(' ');
    if (keyWords.length > 1 && TRAILING_KEYS.has(keyWords[keyWords.length - 1] as string)) {
      const bare = named(keyWords.slice(0, -1).join(' '));
      if (bare === null) continue;
      if (bare) {
        if (bare.kind) kindsSaid.add(bare.kind);
        if (bare.person) peopleSaid.add(bare.person);
        continue;
      }
    }
    // "Ahmed passport", "Passports Sara": a person and a kind, in either order.
    let both = false;
    for (let at = 1; at < keyWords.length && !both; at += 1) {
      const a = named(keyWords.slice(0, at).join(' '));
      const b = named(keyWords.slice(at).join(' '));
      if (!a || !b) continue;
      const kind = a.kind ?? b.kind;
      const person = a.person ?? b.person;
      if (kind && person) {
        kindsSaid.add(kind);
        peopleSaid.add(person);
        both = true;
      }
    }
    if (both) continue;
    // Not a kind, a person, a year or a container: a tag.
    const existing = tagKeys.get(key);
    if (existing) {
      if (existing.size === 1) {
        const value = [...existing][0] as string;
        if (!tags.some((t) => t.value === value)) tags.push({ value, existing: true });
      }
      continue;
    }
    // A name of somebody seen, but not to be chosen: nothing, not a tag.
    if (personKeys.has(key)) continue;
    const value = [...words.join(' ')].slice(0, TAG_CHARS_MAX).join('').trim();
    if (!value || newTags >= FOLDER_NEW_TAGS_MAX || tags.some((t) => t.value === value)) continue;
    tags.push({ value, existing: false });
    newTags += 1;
  }
  return {
    path,
    type_key: kindsSaid.size === 1 ? ([...kindsSaid][0] as string) : null,
    owner_member_id: peopleSaid.size === 1 ? ([...peopleSaid][0] as string) : null,
    tags,
  };
}

/** "suggested from the folder ‘Passports/Ahmed’": a detail's mark, as the card says it. */
export const folderWords = (path: string): string => `suggested from the folder ‘${path}’`;
