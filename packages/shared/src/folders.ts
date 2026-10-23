import type { DocumentTypeView, Visibility } from './documents.js';
import { NOTE_KIND } from './notes.js';
import { shortTypeLabel } from './titles.js';

/**
 * Folder names → suggested details (0.8.0, S2; CAP-11).
 *
 * A family's scans are often sorted already: "Passports/Ahmed",
 * "Bills/2024", "Sara/Medical". An item added from a folder — chosen or
 * dropped on Add → Many documents, a subfolder of the scanner folder, a
 * computer's watched folder — keeps where it was under that folder, without
 * the file's own name (`itemFolder`), sealed under the item's own key like
 * its other fields, and shown to its uploader alone. Its segments are read
 * for what they say (`folderMatcher`, `suggestFromFolder`):
 *
 * - **A kind**: one of the household's kinds by its name, its short name, a
 *   part of its name of more than one word ("Property deed / lease" is
 *   "property deed" too, never "Offer" or "Registration"), or a
 *   short list of the words families use that say one kind and nothing else
 *   (`FOLDER_KIND_WORDS`). A kind's words beside other words still say it:
 *   "Car insurance" is an insurance policy, and the tag "Car". A specific
 *   kind under its general one says the specific (`FOLDER_KIND_PARENTS`:
 *   "Tax/P60" is a tax form).
 * - **Whose**: somebody of the family the uploader may choose, by the name
 *   the household knows them by, or its first word. A teen's are their own,
 *   so a teen is matched to themselves alone, and a segment naming somebody
 *   else gives them neither a person nor a tag (its kind still counts). A
 *   name two of them share says nothing.
 * - **Tags**: a tag already on a document the uploader can see (with how
 *   widely it is seen there, `visibility`); otherwise the segment's own
 *   words, as written (dates gone), proposed as a new tag — only offered,
 *   never made until the item is accepted with it.
 *
 * Matching folds case, accents, possessives, simple plurals ("Passports",
 * "Policies", "IDs"; never "News" or a person's name) and separators (`_`,
 * `-`, `.`). Years, dates, containers ("Scans", "Documents") and the
 * household's own name are ignored. Two segments that say different kinds,
 * or different people, say neither. A segment that is both a kind and a
 * person ("Will") says neither.
 *
 * Weighed with what the pages propose (`levelItem`): alone, below a sure
 * page reading (FOLDER_CONFIDENCE, under ITEM_SURE); agreeing with the
 * pages, surer — Ready only where the pages alone were nearly sure
 * (FOLDER_AGREE_FLOOR); disagreeing, the pages stand and the item is Check.
 * A batch's defaults the uploader chose win over the folder: it fills only
 * what they leave blank. Accept all Ready never files a folder's tag.
 *
 * Pure, and worked out as it is asked, from the kinds, the people and the
 * tags the uploader is given then: nothing of it is stored. A matcher is
 * built once for a context and asked for each item (`folderMatcher`).
 */

/** The most segments kept of a folder: the deepest, nearest the file. */
export const FOLDER_SEGMENTS_MAX = 10;
/** The most characters kept of a folder, separators included. */
export const FOLDER_CHARS_MAX = 512;
/** The most characters of one segment. */
const SEGMENT_CHARS_MAX = 120;
/** The longest `relative_path` an upload endpoint takes, in bytes (UTF-8), before it is tidied. */
export const RELATIVE_PATH_MAX = 4096;

/** A kind or a person the folder alone suggests: shown, and unsure (under ITEM_SURE). */
export const FOLDER_CONFIDENCE = 0.8;
/** The pages and the folder agreeing: the pages' own confidence raised by this much… */
export const FOLDER_AGREE_RAISE = 0.1;
/** …never beyond this… */
export const FOLDER_AGREE_MAX = 0.95;
/**
 * …and to a sure reading only where the pages alone were this sure already:
 * otherwise to just under ITEM_SURE, still Check.
 */
export const FOLDER_AGREE_FLOOR = 0.8;
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
const TRAILING = ['document', 'doc', 'paper', 'paperwork', 'file', 'stuff', 'thing', 'folder'];

/** Words beside a household's name that leave it the household's name: "The Khan family". */
const HOUSEHOLD_FILLER = ['the', 'family', 'families', 'household', 'home', 'familie'];

/**
 * The words families sort their papers under, by the vault's own kinds, each
 * saying that kind and nothing else (the kinds' names are matched too, and a
 * household's own kinds by theirs). A word that could as well hold another
 * kind's papers — "Statements" (a pension's, a card's), "Licences" (a TV
 * licence), "Receipts", "Trust", "Property", "School", "Gas", "Wedding",
 * "Divorce", "Birth" — is not here; its longer forms are. Written
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
  ],
  national_id: [
    'national id',
    'id',
    'ids',
    'id card',
    'identity card',
    'social security',
    'national insurance',
  ],
  visa: ['visa', 'residence permit', 'immigration', 'brp', 'green card', 'work permit'],
  birth_certificate: ['birth certificate', 'birth certificates', 'birth cert'],
  marriage_certificate: [
    'marriage certificate',
    'marriage',
    'divorce certificate',
    'divorce papers',
    'wedding certificate',
  ],
  will: ['will', 'wills', 'power of attorney', 'lpa', 'estate planning'],
  property_deed: [
    'deed',
    'deeds',
    'title deed',
    'property deed',
    'lease',
    'tenancy agreement',
    'rental agreement',
  ],
  vehicle_registration: [
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
  bank_statement: ['bank', 'banking', 'bank statement', 'bank statements', 'savings'],
  // 0.9.0 (C1, 0077): an investment's statements are a kind of their own,
  // kept under Bank or on their own; a payslip is one too.
  investment_statement: [
    'investment',
    'investments',
    'investment statement',
    'investment statements',
    'brokerage',
    'brokerage statement',
    'stocks and shares',
    '401k',
    'retirement account',
    'pension statement',
  ],
  pay_statement: [
    'payslip',
    'payslips',
    'pay slip',
    'pay slips',
    'pay stub',
    'pay stubs',
    'paystub',
    'paystubs',
    'pay statement',
    'pay statements',
    'earnings statement',
    'salary slip',
    'wage slip',
  ],
  // 0.8.0 (S5, 0072): a card's statements, kept under Bank or on their own.
  credit_card_statement: [
    'credit card',
    'credit cards',
    'credit card statement',
    'credit card statements',
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
  diploma: ['diploma', 'transcript', 'degree', 'education', 'university', 'college'],
  // Not "School" alone: a school's letters, trips and photos are kept there too.
  school_report: ['school report', 'school reports'],
  employment_contract: ['employment', 'employment contract', 'job offer', 'offer letter'],
  utility_bill: [
    'bill',
    'bills',
    'utility',
    'utilities',
    'utility bill',
    'electricity',
    'electric',
    'energy',
    'broadband',
    'phone bill',
    'gas bill',
    'water bill',
    'council tax',
  ],
  warranty: ['warranty', 'warranties', 'guarantee', 'guarantees'],
  pet_record: ['pet', 'pets', 'vet', 'veterinary', 'pet record', 'pet records'],
};

/**
 * A specific kind and the general one a family files it under: "Tax/P60" is
 * a tax form, "Medical/Prescriptions" a prescription — two segments naming
 * one of these and its parent say the specific one, not nothing.
 */
export const FOLDER_KIND_PARENTS: Readonly<Record<string, string>> = {
  tax_form: 'tax_return',
  prescription: 'medical_record',
  loan: 'bank_statement',
  credit_card_statement: 'bank_statement',
  investment_statement: 'bank_statement',
};

/**
 * Kinds no folder suggests: "Something else" is no kind, and a note (0.9.0,
 * N1) is never a paper's ("Notes", "Doctor notes").
 */
const NEVER_SUGGESTED = new Set(['other', NOTE_KIND]);

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
 * Letters that draw nothing: the Hangul fillers, Braille's blank, Khmer's
 * inherent vowels, Mongolian's vowel separator. A name of them looks empty.
 */
const BLANK = new RegExp(
  [0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0x2800, 0x3164, 0xffa0]
    .map((c) => String.fromCharCode(c))
    .join('|'),
  'gu',
);
/** Something to see: a letter or a digit. */
const VISIBLE = /[\p{L}\p{N}]/u;

const tidySegment = (s: string) =>
  s.normalize('NFC').replace(UNSEEN, '').replace(BLANK, '').replace(/\s+/g, ' ').trim();

/**
 * Where an item came from under the folder chosen or watched, as it is kept
 * (sealed) and shown: its folders, without the file's own name — dropped
 * when it is the last segment (`fileName`, both compared in NFC), or always
 * (`withFileName`) — each segment in NFC, trimmed and stripped of control
 * and blank-looking characters, one with no letter or digit left gone, `.`
 * and `..` gone, at most FOLDER_SEGMENTS_MAX segments and FOLDER_CHARS_MAX
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
    .map(tidySegment)
    .filter((s) => s !== '' && s !== '.' && s !== '..');
  const last = parts[parts.length - 1];
  if (opts.withFileName) parts = parts.slice(0, -1);
  else if (last !== undefined && opts.fileName && last === tidySegment(opts.fileName)) {
    parts = parts.slice(0, -1);
  }
  parts = parts.filter((s) => VISIBLE.test(s));
  if (opts.dropGenericTop && parts.length > 0 && isGenericFolder(parts[0] as string)) {
    parts = parts.slice(1);
  }
  parts = parts.map((s) => [...s].slice(0, SEGMENT_CHARS_MAX).join('')).slice(-FOLDER_SEGMENTS_MAX);
  while (parts.length > 0 && parts.join('/').length > FOLDER_CHARS_MAX) parts = parts.slice(1);
  return parts.length > 0 ? parts.join('/') : null;
}

/** Whether a folder's name is only a container ("Scans", "My Documents", "2024"). */
export function isGenericFolder(name: string): boolean {
  const key = undated(tokensOf(name))
    .map((t) => singular(t.fold))
    .join(' ');
  return key === '' || GENERIC_KEYS.has(key);
}

/** Words that look plural and are not, or are not to be made singular. */
const NOT_PLURAL = new Set([
  'news',
  'series',
  'species',
  'means',
  'status',
  'bus',
  'gas',
  'yes',
  'his',
  'this',
  'was',
  'has',
  'its',
  'lens',
  'atlas',
  'canvas',
  'chaos',
  'christmas',
  'diabetes',
  'measles',
  'mumps',
  'physics',
  'maths',
  'mathematics',
  'economics',
  'politics',
  'savings',
  'ethics',
]);

/** A word as a plural is folded: "passports" → "passport", "policies" → "policy", "IDs" → "id". */
export function singular(word: string): string {
  if (word.length <= 2 || NOT_PLURAL.has(word)) return word;
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (/(?:ch|sh|x)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** One word of a name: as written (NFC), and folded for matching. */
interface Token {
  orig: string;
  fold: string;
}

/**
 * A name's words, each as written and folded: accents gone, lower case, a
 * possessive gone ("Ahmed's"), and anything but letters and digits between
 * them (`_`, `-`, `.`, spaces) a break.
 */
function tokensOf(s: string): Token[] {
  const out: Token[] = [];
  for (const m of tidySegment(s).matchAll(/[\p{L}\p{N}\p{M}'’ʼ`]+/gu)) {
    const orig = m[0].replace(/^['’ʼ`]+|['’ʼ`]+$/g, '');
    const fold = orig
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/['’ʼ`]s$/, '')
      .replace(/['’ʼ`]/g, '');
    if (fold) out.push({ orig, fold });
  }
  return out;
}

/** A name's words folded, as a list: "Bank_Statements" → ["bank", "statements"]. */
export function foldWords(s: string): string[] {
  return tokensOf(s).map((t) => t.fold);
}

/** A name folded and singular, as a whole: "Bank_Statements" → "bank statement". */
export const foldKey = (s: string): string =>
  tokensOf(s)
    .map((t) => singular(t.fold))
    .join(' ');

/** A year, a part of a date, a tax year ("fy2024"): two digits or more. */
const numeric = (w: string) => /^(?:fy|q[1-4])?\d{2,}$/.test(w);

/**
 * A segment's words without its years and dates ("Tax 2023-24" → "Tax",
 * "March 2024" → nothing, "01 Passports" → "Passports"): its numbers go, a
 * number it starts with, the months beside a number, and a month alone.
 * "W-2" keeps its 2.
 */
function undated(words: Token[]): Token[] {
  if (words.length > 0 && words.every((w) => MONTHS.has(w.fold))) return [];
  const dated = words.some((w) => numeric(w.fold));
  return words.filter(
    (w, i) =>
      !numeric(w.fold) &&
      !(dated && MONTHS.has(w.fold)) &&
      !(i === 0 && words.length > 1 && /^\d+$/.test(w.fold)),
  );
}

const GENERIC_KEYS = new Set(GENERIC.map(foldKey));
const TRAILING_KEYS = new Set(TRAILING.map(foldKey));
const FILLER = new Set(HOUSEHOLD_FILLER);

/** A kind as a folder is matched to it: GET /document-types' view, or enough of it. */
export type FolderKind = Pick<DocumentTypeView, 'key' | 'label'> &
  Partial<Pick<DocumentTypeView, 'short_label' | 'hidden'>>;

/** A tag the uploader can see on a document, and the widest it is seen there. */
export interface SeenTag {
  value: string;
  visibility: Visibility;
}

export interface FolderContext {
  /** The kinds the uploader is given now. */
  types: readonly FolderKind[];
  /** The family the uploader can see now, by the name the household knows them by. */
  people: ReadonlyArray<{ id: string; name: string }>;
  /**
   * Whom the uploader may choose: everybody seen, but a teen themselves
   * alone. A segment with the name of somebody seen but not to be chosen
   * gives neither a person nor a tag; its kind still counts.
   */
  choosable?: (id: string) => boolean;
  /** The tags on documents the uploader can see now, each with the widest it is seen there. */
  tags?: readonly SeenTag[];
  /** The household's own name: a container, never a tag. */
  household?: string | null;
}

/** A tag a folder proposes: one already used, or a new one from the folder's name. */
export interface FolderTag {
  value: string;
  /** Already on a document the uploader can see; otherwise new, and only offered. */
  existing: boolean;
  /** For one already used: the widest it is seen on a document (null for a new one). */
  visibility: Visibility | null;
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

const NARROW: Record<Visibility, number> = { private: 0, adults: 1, household: 2 };
const words = (s: string) => s.split(' ').filter(Boolean).length;

/**
 * A matcher for one uploader's context (see above): the kinds', the
 * people's and the tags' keys worked out once, then each item's folder
 * matched against them. Never a kind the uploader is not given, nor a person
 * they cannot see; a teen only themselves.
 */
export function folderMatcher(
  ctx: FolderContext,
): (folder: string | null | undefined) => FolderSuggestion | null {
  const choosable = ctx.choosable ?? (() => true);
  const kinds = ctx.types.filter((t) => !NEVER_SUGGESTED.has(t.key));
  // A kind's names: its whole name and short name, the parts of its name and
  // its key of more than one word, and the families' own words for it.
  const kindKeys = index<string>(
    kinds.flatMap((t) => {
      const names = [
        t.label,
        shortTypeLabel(t),
        ...t.label.split('/').filter((part) => words(foldKey(part)) > 1),
        ...(words(t.key.replace(/_/g, ' ')) > 1 ? [t.key.replace(/_/g, ' ')] : []),
        ...(FOLDER_KIND_WORDS[t.key] ?? []),
      ];
      return names.map((n) => [foldKey(n), t.key] as [string, string]);
    }),
  );
  // A person's names, folded but never made singular: "James" is not "Jame".
  const personKeys = index<string>(
    ctx.people.flatMap((m) => {
      const w = foldWords(m.name);
      return [[w.join(' '), m.id] as [string, string], [w[0] ?? '', m.id] as [string, string]];
    }),
  );
  const tagKeys = new Map<string, Map<string, Visibility>>();
  for (const t of ctx.tags ?? []) {
    const key = foldKey(t.value);
    if (!key) continue;
    const at = tagKeys.get(key) ?? new Map<string, Visibility>();
    const was = at.get(t.value);
    if (!was || NARROW[t.visibility] > NARROW[was]) at.set(t.value, t.visibility);
    tagKeys.set(key, at);
  }
  // The household's own name, less "The" and "family": a container wherever it is all a segment says.
  const home = foldWords(ctx.household ?? '').filter((w) => !FILLER.has(w));
  const isHome = (raw: string[]) =>
    home.length > 0 &&
    home.every((w) => raw.includes(w)) &&
    raw.every((w) => home.includes(w) || FILLER.has(w) || GENERIC_KEYS.has(singular(w)));

  return (folder) => {
    const path = itemFolder(folder);
    if (!path) return null;
    const kindsSaid = new Set<string>();
    const peopleSaid = new Set<string>();
    const tags: FolderTag[] = [];
    const tagSeen = new Set<string>();
    let newTags = 0;
    // Nearest the file first: its own folder says most, and its tags come first.
    for (const segment of path.split('/').reverse()) {
      const ts = undated(tokensOf(segment));
      if (ts.length === 0) continue;
      const raw = ts.map((t) => t.fold);
      const sing = raw.map(singular);
      const key = sing.join(' ');
      if (GENERIC_KEYS.has(key) || isHome(raw)) continue;
      const n = raw.length;
      const kindAt = (i: number, j: number) => kindKeys.get(sing.slice(i, j).join(' '));
      const personAt = (i: number, j: number) => personKeys.get(raw.slice(i, j).join(' '));
      // The longest run of words that is a kind, then the longest that is a
      // person beside it; a run that is both, or two of either, says nothing.
      let kind: { i: number; j: number; key: string | null } | null = null;
      let person: { i: number; j: number; id: string | null } | null = null;
      for (let len = n; len > 0 && !kind; len -= 1) {
        for (let i = 0; i + len <= n && !kind; i += 1) {
          const k = kindAt(i, i + len);
          if (!k) continue;
          const both = personAt(i, i + len);
          kind = { i, j: i + len, key: k.size === 1 && !both ? ([...k][0] as string) : null };
        }
      }
      const outside = (i: number, j: number) => !kind || j <= kind.i || i >= kind.j;
      for (let len = n; len > 0 && !person; len -= 1) {
        for (let i = 0; i + len <= n && !person; i += 1) {
          if (!outside(i, i + len)) continue;
          const p = personAt(i, i + len);
          if (!p) continue;
          person = { i, j: i + len, id: p.size === 1 ? ([...p][0] as string) : null };
        }
      }
      // Somebody else's name, for a teen (or a name two share): no person, and no tag.
      const blocked = person !== null && (person.id === null || !choosable(person.id));
      if (kind?.key) kindsSaid.add(kind.key);
      if (person && !blocked && person.id) peopleSaid.add(person.id);
      if (blocked) continue;
      // What is left — not the kind, not the person, not "documents" — a tag.
      const rest = ts.filter(
        (_, i) =>
          (!kind || i < kind.i || i >= kind.j) && (!person || i < person.i || i >= person.j),
      );
      const restKey = rest.map((t) => singular(t.fold)).join(' ');
      if (
        rest.length === 0 ||
        GENERIC_KEYS.has(restKey) ||
        isHome(rest.map((t) => t.fold)) ||
        rest.every((t) => TRAILING_KEYS.has(singular(t.fold)) || GENERIC_KEYS.has(singular(t.fold)))
      ) {
        continue;
      }
      if (tagSeen.has(restKey)) continue;
      tagSeen.add(restKey);
      const used = tagKeys.get(restKey);
      if (used && used.size === 1) {
        const [value, visibility] = [...used][0] as [string, Visibility];
        tags.push({ value, existing: true, visibility });
        continue;
      }
      if (used) continue;
      const value = [
        ...rest
          .map((t) => t.orig)
          .join(' ')
          .normalize('NFC'),
      ]
        .slice(0, TAG_CHARS_MAX)
        .join('')
        .trim();
      if (!value || newTags >= FOLDER_NEW_TAGS_MAX) continue;
      tags.push({ value, existing: false, visibility: null });
      newTags += 1;
    }
    // A specific kind under its general one says the specific.
    for (const k of [...kindsSaid]) {
      const parent = FOLDER_KIND_PARENTS[k];
      if (parent && kindsSaid.has(parent)) kindsSaid.delete(parent);
    }
    return {
      path,
      type_key: kindsSaid.size === 1 ? ([...kindsSaid][0] as string) : null,
      owner_member_id: peopleSaid.size === 1 ? ([...peopleSaid][0] as string) : null,
      tags,
    };
  };
}

/** What a folder suggests in a context, matched once (`folderMatcher` for many). */
export function suggestFromFolder(
  folder: string | null | undefined,
  ctx: FolderContext,
): FolderSuggestion | null {
  return folderMatcher(ctx)(folder);
}

/** "suggested from the folder ‘Passports/Ahmed’": a detail's mark, as the card says it. */
export const folderWords = (path: string): string => `suggested from the folder ‘${path}’`;
