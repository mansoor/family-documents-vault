import type { CollectionDetail } from './collections.js';
import type { DateValue, Visibility } from './documents.js';
import { FOLDER_KIND_PARENTS, FOLDER_KIND_WORDS, foldWords, singular } from './folders.js';
import { shortTypeLabel } from './titles.js';

/**
 * A collection from a checklist (0.9.0, C1): a list a family is asked for —
 * "Documents for Mansoor / W2 for 2025 and 2024 / Last 3 pay statements" —
 * read line by line with plain rules (no AI), shown back as what was
 * understood, and matched against the documents the reader can see. Nothing
 * is put in the collection until its maker ticks what to add.
 *
 * **People.** A line that reads as a heading ends the part before it and
 * starts another: "Documents for <name>", "<name>'s documents", "For
 * <name>:", "<name>:" or a line that is only a name. Its name is matched to
 * the family the reader may choose (`ChecklistContext.people`: a teen only
 * themselves, never a guest), by the name the household knows them by or
 * its first word — a family member's name before "'s" or ":" even where it
 * is a kind's word too ("Bill's documents", "May:"). Then:
 *
 * - one of them: theirs; two who share it, or "A and B:", one of them
 *   (`person_shared`, asked which, never guessed);
 * - "Joint", "Both of us", "Family": anyone's;
 * - a heading that names a purpose ("Documents for the refinance"): anyone's;
 * - any other name — "Grandma", "my wife", "the children", "documents for
 *   grandma", somebody the reader may not choose — `person_unknown`, "whose?",
 *   which says nothing of whether there is such a person.
 *
 * A line before any heading is anyone's. "<name>'s …", "… for <name>" and
 * "(<name>)" name the person of one line, by the same rules ("Dad's
 * passport" is whose?), and their words are not read for a kind.
 *
 * **Items.** Each line is an item; a line naming two kinds ("Passport and
 * driving licence", "Bank and investment statements") is two, split at its
 * commas, semicolons, "and", "&" or "plus". A part naming no kind ("… for
 * 2025 and 2024") belongs to the part before it. Read from each:
 *
 * - **how many, how recent:** "last 3", "the last two", "3 most recent",
 *   "latest", "most recent 2", a number before the kind; "3 months of"
 *   (each month of the last three); "dated within 3 months" (one dated in
 *   them); "the last 2 years of" (each of the two years before this one);
 *   "current" or "valid" (one that has not run out). More than
 *   CHECKLIST_COUNT_MAX is read as that many, and said so;
 * - **years:** "for 2025 and 2024", "2023–2025", "tax year 2024", "2024-25"
 *   and "2024/25" (the tax year ending in 2025). A range of
 *   CHECKLIST_YEARS_MAX years or more is not read: name the years;
 * - **months:** "for May and June", "Jan–Mar 2026", "June 2026": each of
 *   them, the latest of each named without a year;
 * - **the kind:** the household's kinds by their names, the parts of their
 *   names, their short names and the shared kind words (FOLDER_KIND_WORDS,
 *   S2's, and CHECKLIST_KIND_WORDS below), the longest phrase first; a tax
 *   form's own name ("W-2", "W-2s", "1099s", "P60") is kept to say and match.
 *
 * Years said anywhere in a line apply to each of its parts that says none;
 * how many, and how recent, to the parts after it. A line with no kind is
 * Not understood: the person chooses its kind, person and count, or skips it.
 *
 * **Whose, without an apostrophe** (0.9.0): "mansoors passport" is
 * Mansoor's when "mansoors", less its last "s", is somebody the reader may
 * choose (by first or full name) and "mansoors" is nobody; a name that
 * ends in "s" ("Chris", "James") never loses one, so "chriss" is nobody. A
 * line that starts with a name as it is ("james passport") is theirs when
 * the rest of it says the kind the whole line does.
 *
 * **By its title** (0.9.0): each item keeps the words that are left of it
 * — its person, how many, its years, its form and the words that only say
 * "papers of" gone — as `title_words` (at most CHECKLIST_TITLE_WORDS_MAX;
 * more is a sentence, not a title). A line that names no kind, or one whose
 * kind finds nothing at all, is looked for by them in the titles of the
 * documents the reader can see (`checkItem`).
 *
 * Bounded and linear: at most CHECKLIST_TEXT_MAX characters (the API refuses
 * more before anything reads it), CHECKLIST_LINES_MAX lines of at most
 * CHECKLIST_LINE_MAX characters, no pattern with two unbounded repeats over
 * the same characters, and kind phrases of at most six words looked up in a
 * table. Pure: the date, the kinds and the people are given.
 */

/** The most characters of a checklist, before anything reads it. */
export const CHECKLIST_TEXT_MAX = 10_000;
/** The most lines read; the rest are left out, and said to be. */
export const CHECKLIST_LINES_MAX = 100;
/** The most characters of a line kept. */
export const CHECKLIST_LINE_MAX = 200;
/** The most items a checklist keeps (a line can be two). */
export const CHECKLIST_ITEMS_MAX = 100;
/** "Last N": at most this many. */
export const CHECKLIST_COUNT_MAX = 24;
/** "N months of": at most this many. */
export const CHECKLIST_MONTHS_MAX = 24;
/** Years an item may name; a range of this many or more is not read. */
export const CHECKLIST_YEARS_MAX = 10;
/** Months an item may name. */
export const CHECKLIST_MONTH_NAMES_MAX = 12;
/** Documents shown for an item, the chosen and a few more to choose from. */
export const CHECKLIST_MATCHES_MAX = 30;
/** Of those, beyond the ones chosen: others to swap in. */
export const CHECKLIST_OTHERS_MAX = 5;

/**
 * Said beside an Only me match in a collection others see (5.33's rule for
 * collections, 5.41's for links): it would be in the collection for its
 * owner alone. Nobody else in the collection's audience is given it, and no
 * link made from the collection, or keeping up with it, sends it.
 */
export const CHECKLIST_ONLY_ME_NOTE =
  'Only me: in this collection only you would see it, and its links never send it. Change who can see it first if others need it.';

/** Said beside a match with no date, or no year, to tell it by. */
export const CHECKLIST_NO_DATE_NOTE = 'No date on it: check its year';

/** Said beside a tax form whose title names no form, when the line names one. */
export const CHECKLIST_FORM_UNSAID_NOTE = 'Its title does not say which form it is: check';

/** Said beside a bank statement offered for an investment line (0077 made them a kind of their own). */
export const CHECKLIST_WAS_BANK_NOTE = 'Filed as a bank statement before 0.9.0';

/** Said of a line, and beside a document, found by the words of its title (0.9.0). */
export const CHECKLIST_BY_TITLE_NOTE = 'Found by its title';
/** Lines of one checklist looked for by their titles' words, at most: the rest are not. */
export const CHECKLIST_TITLE_LINES_MAX = 20;
/** Words a line is looked for by, at most: a line with more says a sentence, not a title. */
export const CHECKLIST_TITLE_WORDS_MAX = 6;
/** The most characters of one of those words. */
export const CHECKLIST_TITLE_WORD_MAX = 40;

/** A kind as the checklist reads it: GET /document-types' view, or enough of it. */
export interface ChecklistKind {
  key: string;
  label: string;
  short_label?: string | null;
  hidden?: boolean;
}

/** Somebody the reader may choose, by the name the household knows them by. */
export interface ChecklistPerson {
  id: string;
  name: string;
}

export interface ChecklistContext {
  /** The household's kinds; a hidden one, or "Something else", is never read. */
  types: readonly ChecklistKind[];
  /** The family the reader may choose: a teen only themselves; never a guest. */
  people: readonly ChecklistPerson[];
  /** The reader's own member: "my", "me". */
  me?: string | null | undefined;
  /** Today (YYYY-MM-DD), for "the last 2 years of" and months named without a year. */
  today: string;
}

/** One thing a checklist asks for: as understood, or as the person set it. */
export interface ChecklistItem {
  /** The words it came from, as written: its bullet gone. */
  line: string;
  /** The heading it is under, as written, or null. */
  heading: string | null;
  type_key: string | null;
  /** Whose: one of the family, or null for whoever has it. */
  member_id: string | null;
  /** The N most recent; null for one, or one a year with years. */
  count: number | null;
  /** Each month of the last N. */
  months: number | null;
  /** Of these years, as said; empty for any. */
  years: number[];
  /** One that has not run out. */
  current: boolean;
  /** A tax form's own name, as said ("W-2"): matched against titles. */
  form: string | null;
  /** The person chose to leave it out. */
  skipped: boolean;
  /**
   * Whose is still to be chosen: its heading named nobody the reader may
   * choose, or two of them. Kept until a person is chosen; absent or null
   * when there is none to choose.
   */
  unresolved?: 'person_unknown' | 'person_shared' | null | undefined;
  /** Each of these months (YYYY-MM), as named ("for May and June"); absent or empty for none. */
  in_months?: string[] | undefined;
  /** Dated within the last N months ("dated within 3 months"); absent or null for none. */
  within?: number | null | undefined;
  /**
   * The words left of the line once its person, how many, its years and
   * its form are read (0.9.0), folded: what it is looked for by in titles
   * when it names no kind, or its kind finds nothing. Absent or null for
   * none.
   */
  title_words?: string[] | null | undefined;
}

/** Why an item is not understood: no kind, a person to choose, or years it does not read. */
export type ChecklistProblem = 'kind' | 'person_unknown' | 'person_shared' | 'years';

/** An item as the checklist was read. */
export interface ChecklistReadItem extends ChecklistItem {
  understood: boolean;
  problem: ChecklistProblem | null;
  /** For `person_shared`: whom the name could mean, to ask which. */
  person_choices: string[];
  /** What the reading says of the line beyond what it understood ("Read as the last 24…"). */
  note?: string | null | undefined;
}

export interface ChecklistReading {
  items: ChecklistReadItem[];
  /** Lines past CHECKLIST_LINES_MAX, and items past CHECKLIST_ITEMS_MAX, left out. */
  left_out: number;
}

// ------------------------------------------------------------------ words

/**
 * Words a checklist says a kind with, beyond the folder words (S2): the
 * forms by their own names, and how people write a list for a lender or an
 * accountant. Written naturally; folded as a folder is.
 */
export const CHECKLIST_KIND_WORDS: Readonly<Record<string, readonly string[]>> = {
  tax_form: [
    'tax form',
    'w2',
    'w-2',
    '1099',
    '1098',
    'p60',
    'p45',
    'p11d',
    'wage and tax statement',
  ],
  tax_return: ['tax return', 'tax returns', '1040', 'self assessment', 'federal return'],
  pay_statement: [
    'paycheck stub',
    'paycheck stubs',
    'pay check stub',
    'paycheck',
    'paychecks',
    'proof of income',
    'salary statement',
    'earnings statements',
  ],
  investment_statement: [
    'investment account statement',
    'brokerage account statement',
    'retirement statement',
    'retirement account statement',
    '401k statement',
    '401 k statement',
    'ira statement',
    'portfolio statement',
    'stock statement',
  ],
  bank_statement: [
    'checking statement',
    'checking account statement',
    'savings statement',
    'savings account statement',
    'current account statement',
    'account statement',
  ],
  credit_card_statement: ['card statement', 'card statements'],
  drivers_licence: ['license', 'licence', 'driving license', "driver's license", 'drivers license'],
  national_id: ['social security card', 'ssn card', 'ni letter', 'national insurance letter'],
  passport: ['passport', 'passports'],
  birth_certificate: ['birth certificate'],
  marriage_certificate: ['marriage certificate', 'marriage license', 'marriage licence'],
  utility_bill: ['utility bill', 'utility bills', 'proof of address'],
  insurance_policy: ['insurance policy', 'insurance declaration', 'declarations page'],
  loan: ['mortgage statement', 'loan statement'],
  property_deed: ['deed', 'lease', 'rental agreement'],
  employment_contract: ['offer letter', 'employment letter', 'employment verification'],
};

/** The kinds a tax form's own name, and a tax year, belong to. */
const TAX_KINDS = new Set(['tax_form', 'tax_return']);
/** Whether a kind is matched by the tax year it keeps, and may name a form. */
export const isTaxKind = (key: string | null | undefined): boolean => TAX_KINDS.has(key ?? '');

/** Parts of a kind's name of one word that say too little alone ("Offer", "Registration"). */
const TOO_PLAIN = new Set(['offer', 'registration', 'trust', 'title', 'other', 'id', 'record']);

/** Names that are nobody in particular: a section for whoever has it. */
const NO_ONE = new Set([
  'us',
  'both',
  'both of us',
  'everyone',
  'everybody',
  'all',
  'all of us',
  'family',
  'the family',
  'our family',
  'household',
  'the household',
  'joint',
  'jointly',
  'joint documents',
  'shared',
  'anyone',
  'either',
  'whoever',
]);
/** Names that are the reader. */
const ME = new Set(['me', 'myself', 'mine', 'my', 'i', 'self']);

/** Words that name somebody by who they are to the family: never a kind, never a title. */
const RELATIONS = new Set([
  'wife',
  'husband',
  'partner',
  'spouse',
  'son',
  'sons',
  'daughter',
  'daughters',
  'child',
  'children',
  'kid',
  'kids',
  'baby',
  'mum',
  'mom',
  'mummy',
  'mommy',
  'mother',
  'dad',
  'daddy',
  'father',
  'parent',
  'parents',
  'grandma',
  'grandpa',
  'granny',
  'grandad',
  'granddad',
  'grandmother',
  'grandfather',
  'grandparents',
  'nan',
  'nana',
  'nanna',
  'sister',
  'brother',
  'aunt',
  'auntie',
  'uncle',
  'cousin',
  'boyfriend',
  'girlfriend',
  'fiance',
  'fiancee',
  'stepson',
  'stepdaughter',
]);

const MONTH_WORDS = [
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
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
];
const MONTH_SET: ReadonlySet<string> = new Set(MONTH_WORDS);

/** Words of a heading's name that make it a purpose, not a person ("Documents for the refinance"). */
const PURPOSE = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'application',
  'applications',
  'refinance',
  'refinancing',
  'remortgage',
  'mortgage',
  'loan',
  'lender',
  'broker',
  'accountant',
  'solicitor',
  'lawyer',
  'attorney',
  'bank',
  'school',
  'visa',
  'immigration',
  'tax',
  'taxes',
  'move',
  'moving',
  'house',
  'home',
  'rental',
  'rent',
  'lease',
  'landlord',
  'trip',
  'travel',
  'holiday',
  'job',
  'work',
  'and',
  'so',
  'on',
  'etc',
  'other',
  'others',
  'misc',
  'everything',
  'more',
  'later',
  'now',
  'note',
  'notes',
  'nb',
  'important',
  'please',
  'reminder',
  'also',
  'optional',
  'required',
  'todo',
  'extra',
  'checklist',
  'list',
  'originals',
  'copies',
  ...MONTH_WORDS,
]);

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  couple: 2,
  'a couple': 2,
  'a couple of': 2,
  'couple of': 2,
};

/**
 * Words that say nothing of which paper a line means, never looked for in
 * a title (0.9.0): "the", "copies of", "please send", "documents", and the
 * words of how many and how recent.
 */
const TITLE_FILLER = new Set([
  'the',
  'a',
  'an',
  'my',
  'our',
  'your',
  'his',
  'her',
  'their',
  'its',
  'of',
  'for',
  'from',
  'to',
  'in',
  'on',
  'at',
  'by',
  'with',
  'and',
  'or',
  'plus',
  'also',
  'any',
  'each',
  'every',
  'some',
  'so',
  'etc',
  'copy',
  'copies',
  'scan',
  'scans',
  'scanned',
  'original',
  'originals',
  'document',
  'documents',
  'doc',
  'docs',
  'paper',
  'papers',
  'paperwork',
  'file',
  'files',
  'item',
  'items',
  'thing',
  'things',
  'stuff',
  'please',
  'bring',
  'send',
  'need',
  'needed',
  'required',
  'optional',
  'last',
  'latest',
  'most',
  'recent',
  'newest',
  'past',
  'previous',
  'month',
  'months',
  'year',
  'years',
  'worth',
  'dated',
  'within',
  'other',
  'others',
  'misc',
  'todo',
  'note',
  'notes',
  'nb',
]);

const N =
  '(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:a )?couple(?: of)?)';
const RECENT = '(?:last|latest|most recent|recent|past|previous|newest)';

/** A number as written, before any limit; null for none. */
const numberOf = (w: string): number | null => {
  const n = /^\d+$/.test(w) ? Number(w) : (NUMBER_WORDS[w] ?? null);
  return n === null || n < 1 ? null : n;
};

const WITHIN_RE = new RegExp(
  `\\b(?:dated |issued |from )?(?:within|no older than|not older than|less than) (?:the )?(?:last |past )?${N} months?(?: old)?\\b`,
);
const MONTHS_RE = new RegExp(
  `\\b(?:(?:the )?${RECENT} )?${N} months?(?:'s|'|s')?(?: (?:worth )?of)?\\b`,
);
const YEARS_BACK_RE = new RegExp(
  `\\b(?:the )?(?:last|past|previous) ${N} years?(?:'s|'|s')?(?: (?:worth )?of)?\\b|\\b${N} years? (?:worth )?of\\b`,
);
const COUNT_BEFORE_RE = new RegExp(`\\b(?:the )?${RECENT} ${N}\\b`);
const COUNT_AFTER_RE = new RegExp(`\\b${N} ${RECENT}\\b`);
const COUNT_LEADING_RE = new RegExp(`^(?:the )?${N}\\b(?! (?:months?|years?)\\b)`);
const CURRENT_RE =
  /\b(?:current|valid|unexpired|in date|in-date|up to date|up-to-date|still valid)\b/;
const CURRENT_ALL_RE = new RegExp(CURRENT_RE.source, 'g');
const YEAR_RANGE_RE = /\b(199\d|20\d\d) ?(?:-|\/|to|through|thru|until) ?(199\d|20\d\d|\d\d)\b/g;
const YEAR_RE = /\b(199\d|20\d\d)\b/g;
/** A tax form's own name, and its plural ("W-2s", "1099s"). */
const FORM_RE = /\b(w-?2|1099(?:-[a-z]{1,4})?|1098|p60|p45|p11d|1040)s?\b/g;

const MON = `(${MONTH_WORDS.join('|')})\\.?`;
const MONTH_RANGE_RE = new RegExp(
  `\\b${MON} ?(?:-|to|through|thru|until) ?${MON}(?:,? (199\\d|20\\d\\d))?\\b`,
  'g',
);
const MONTH_LIST_RE = new RegExp(
  `\\b(?:for|from|in|of|dated) (${MON}(?:(?:, | and | & | or |, and )${MON}){0,11})(?:,? (199\\d|20\\d\\d))?\\b`,
  'g',
);
const MONTH_YEAR_RE = new RegExp(`\\b${MON},? (199\\d|20\\d\\d)\\b`, 'g');
const MONTH_ONE_RE = new RegExp(`\\b${MON}\\b`, 'g');

const MONTH_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  MONTH_WORDS.map((m) => [
    m,
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
      m.slice(0, 3),
    ) + 1,
  ]),
);

/** How the checklist reads a line: lower case, its dashes plain, its quotes straight. */
function folded(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A form's name as people write it: "W-2", "1099-INT", "P60". */
function formName(f: string): string {
  if (/^w-?2$/.test(f)) return 'W-2';
  return f.toUpperCase();
}

/** Every form a text names, as people write them. */
function formsIn(text: string | null): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of folded(text).matchAll(FORM_RE)) out.add(formName(m[1] as string));
  return [...out];
}

// ------------------------------------------------------------------ kinds

/** The kinds' phrases: the words of each, folded and singular, to the kinds they say. */
type KindIndex = Map<string, Set<string>>;
const MAX_PHRASE = 6;

/** A word as a phrase is keyed: singular, and "2s" (of "W-2s") as "2". */
const keyWord = (w: string) => (/^\d+s$/.test(w) ? w.slice(0, -1) : singular(w));
const phraseKey = (s: string): string => foldWords(s).map(keyWord).join(' ');

function kindIndex(types: readonly ChecklistKind[]): KindIndex {
  const index: KindIndex = new Map();
  const add = (words: string, key: string) => {
    const k = phraseKey(words);
    if (!k || k.split(' ').length > MAX_PHRASE) return;
    const at = index.get(k) ?? new Set<string>();
    at.add(key);
    index.set(k, at);
  };
  for (const t of types) {
    if (t.hidden || t.key === 'other') continue;
    add(t.label, t.key);
    add(shortTypeLabel(t), t.key);
    for (const part of t.label.split('/')) {
      const k = phraseKey(part);
      if (k && (k.includes(' ') || !TOO_PLAIN.has(k))) add(part, t.key);
    }
    if (!t.key.startsWith('h_')) add(t.key.replace(/_/g, ' '), t.key);
    for (const w of FOLDER_KIND_WORDS[t.key] ?? []) add(w, t.key);
    for (const w of CHECKLIST_KIND_WORDS[t.key] ?? []) add(w, t.key);
  }
  // Words that say when, not what: read as nothing, so "P60 tax year
  // 2024-25" is a tax form, not a tax form and a tax return.
  for (const w of NEUTRAL) index.set(phraseKey(w), new Set());
  return index;
}

/** Phrases a kind's words are part of that say no kind ("tax year"). */
const NEUTRAL = ['tax year', 'tax years', 'for tax', 'year to date', 'school year'];

interface KindHit {
  key: string | null;
  /** Words long: the longest phrase wins. */
  length: number;
}

/** Every kind a text names, longest phrases first, none overlapping. */
function kindsIn(text: string, index: KindIndex): KindHit[] {
  const words = foldWords(text).map(keyWord);
  const hits: KindHit[] = [];
  let i = 0;
  while (i < words.length) {
    let found: { kinds: Set<string>; length: number } | null = null;
    for (let n = Math.min(MAX_PHRASE, words.length - i); n >= 1; n -= 1) {
      const kinds = index.get(words.slice(i, i + n).join(' '));
      if (!kinds) continue;
      found = { kinds, length: n };
      break;
    }
    if (found) {
      // A neutral phrase is read, and names nothing.
      if (found.kinds.size > 0) {
        hits.push({
          key: found.kinds.size === 1 ? ([...found.kinds][0] as string) : null,
          length: found.length,
        });
      }
      i += found.length;
    } else {
      i += 1;
    }
  }
  return hits;
}

// ----------------------------------------------------------------- people

type Whose =
  | { kind: 'person'; id: string }
  | { kind: 'anyone' }
  | { kind: 'shared'; choices: string[] }
  | { kind: 'unknown' };

const firstWord = (words: string[]) => words[0] ?? '';

/**
 * Whom a name means, of the people the reader may choose — a person, two
 * who share it, anyone ("Joint"), or nobody they may choose; null for no
 * name at all. "A and B" is either of them.
 */
function whoIs(name: string, ctx: ChecklistContext): Whose | null {
  const words = foldWords(name);
  if (words.length === 0) return null;
  const key = words.join(' ');
  if (NO_ONE.has(key)) return { kind: 'anyone' };
  if (ME.has(key)) return ctx.me ? { kind: 'person', id: ctx.me } : { kind: 'unknown' };
  const names = name.split(/\s+(?:and|&|or)\s+|\s*&\s*/i).filter((n) => n.trim() !== '');
  if (names.length > 1) {
    const each = names.map((n) => whoIs(n, ctx));
    const ids = each.flatMap((w) =>
      w?.kind === 'person' ? [w.id] : w?.kind === 'shared' ? w.choices : [],
    );
    if (each.every((w) => w?.kind === 'person' || w?.kind === 'shared')) {
      return { kind: 'shared', choices: [...new Set(ids)] };
    }
    return { kind: 'unknown' };
  }
  const people = ctx.people.map((p) => ({ id: p.id, words: foldWords(p.name) }));
  const exact = people.filter((p) => p.words.join(' ') === key);
  const pick = (found: typeof people): Whose =>
    found.length === 1
      ? { kind: 'person', id: (found[0] as (typeof people)[number]).id }
      : { kind: 'shared', choices: found.map((p) => p.id) };
  if (exact.length > 0) return pick(exact);
  // By first name: "Mansoor" for Mansoor Seikh, "Mansoor Seikh" for Mansoor.
  const first = people.filter(
    (p) =>
      firstWord(p.words) === firstWord(words) &&
      (words.length === 1 || (p.words.length === 1 && words.length === 2)),
  );
  if (first.length > 0) return pick(first);
  return { kind: 'unknown' };
}

/**
 * Somebody the reader may choose, by a name as written — their whole name,
 * or one word that is their first — never "me" or "Joint"; null for
 * nobody (0.9.0).
 */
function personNamed(name: string, ctx: ChecklistContext): Whose | null {
  const words = foldWords(name);
  if (words.length === 0) return null;
  const key = words.join(' ');
  const people = ctx.people.map((p) => ({ id: p.id, words: foldWords(p.name) }));
  let found = people.filter((p) => p.words.join(' ') === key);
  if (found.length === 0 && words.length === 1) found = people.filter((p) => p.words[0] === key);
  if (found.length === 0) return null;
  return found.length === 1
    ? { kind: 'person', id: (found[0] as (typeof found)[number]).id }
    : { kind: 'shared', choices: found.map((p) => p.id) };
}

/** A word a name is written in, without an apostrophe: letters, a dot or a hyphen. */
const NAME_WORD = /^\p{L}[\p{L}.-]{0,30}$/u;

/**
 * Whose a name without an apostrophe says (0.9.0): somebody by the name as
 * it is (`plain`), or by the name less its last "s" ("mansoors" is
 * Mansoor's) when the name as it is is nobody — and never a name that
 * ends in "s" less one more ("chriss" is not Chris's: "Chris", "James"
 * never lose an "s").
 */
function nameWithoutApostrophe(
  said: readonly string[],
  ctx: ChecklistContext,
): { whose: Whose; plain: boolean } | null {
  if (said.length === 0 || !said.every((w) => NAME_WORD.test(w))) return null;
  const plain = personNamed(said.join(' '), ctx);
  if (plain) return { whose: plain, plain: true };
  const last = said[said.length - 1] as string;
  if (!/s$/iu.test(last) || /ss$/iu.test(last)) return null;
  const stem = personNamed([...said.slice(0, -1), last.slice(0, -1)].join(' '), ctx);
  return stem ? { whose: stem, plain: false } : null;
}

/** A name that is somebody to the family ("my wife", "the children", "Grandma"). */
function relation(name: string): boolean {
  const words = foldWords(name);
  return (
    words.some((w) => RELATIONS.has(w)) &&
    words.every(
      (w) => RELATIONS.has(w) || ['my', 'our', 'the', 'his', 'her', 'their', 'and'].includes(w),
    )
  );
}

/** A name of the line's own that reads as a person's: one to three words, each a capital, none a purpose's. */
function looksLikeName(written: string): boolean {
  const words = written.trim().split(/\s+/);
  if (words.length === 0 || words.length > 3) return false;
  return words.every(
    (w) =>
      /^\p{Lu}[\p{L}'’.-]{0,30}$/u.test(w) &&
      !PURPOSE.has(
        w
          .toLowerCase()
          .replace(/['’]s$/, '')
          .replace(/\.$/, ''),
      ),
  );
}

/** A heading's name that names a purpose ("the refinance", "Mortgage"), and nobody. */
function purpose(name: string): boolean {
  const words = foldWords(name);
  return (
    words.length > 0 && words.some((w) => PURPOSE.has(w)) && !words.some((w) => RELATIONS.has(w))
  );
}

const NAME = "([\\p{L}][\\p{L}'’.-]{0,30}(?: [\\p{L}&][\\p{L}'’.-]{0,30}){0,4})";
const PAPERS = '(?:documents?|docs?|papers?|paperwork|files?|items?|things|stuff)';
const HEADING_FOR = new RegExp(`^(?:the )?${PAPERS} (?:for|of|from) ${NAME} ?:?$`, 'iu');
const HEADING_OWN = new RegExp(`^${NAME}['’]s? ${PAPERS} ?:?$`, 'iu');
/** "Mansoors documents": a name without its apostrophe (0.9.0). */
const HEADING_OWN_BARE = new RegExp(`^(\\S+(?: \\S+){0,2}) ${PAPERS} ?:?$`, 'iu');
const HEADING_FOR_COLON = new RegExp(`^for ${NAME} ?:$`, 'iu');
const HEADING_COLON = new RegExp(`^${NAME} ?: ?(.*)$`, 'iu');
const ITEM_OWNER = new RegExp(`^${NAME}['’]s `, 'iu');
const ITEM_FOR = new RegExp(` for ${NAME}$`, 'iu');
const ITEM_PAREN = new RegExp(` ?\\(${NAME}\\)`, 'iu');

/**
 * Whose a heading means: somebody, either of two, anyone, a purpose
 * (anyone's), or a name that is nobody the reader may choose.
 */
function headingWhose(
  name: string,
  ctx: ChecklistContext,
  explicit: boolean,
  index: KindIndex,
): Whose | null {
  const whose = whoIs(name, ctx);
  if (!whose) return null;
  if (whose.kind !== 'unknown') return whose;
  if (relation(name)) return { kind: 'unknown' };
  if (explicit) {
    // "Documents for the refinance": a purpose, so the part is anyone's.
    if (purpose(name) || kindsIn(name, index).length > 0) return { kind: 'anyone' };
    return { kind: 'unknown' };
  }
  // "Grandma:" — a name of its own, matching nobody; never "Note:" or "Passport:".
  if (kindsIn(name, index).length === 0 && looksLikeName(name)) return { kind: 'unknown' };
  return null;
}

/** A heading: the person it names, and what follows it on its line ("Mansoor: passport"). */
function headingOf(
  line: string,
  ctx: ChecklistContext,
  index: KindIndex,
): { whose: Whose; rest: string } | null {
  let m = HEADING_FOR.exec(line) ?? HEADING_OWN.exec(line) ?? HEADING_FOR_COLON.exec(line);
  if (m) {
    const whose = headingWhose(m[1] as string, ctx, true, index);
    return whose ? { whose, rest: '' } : null;
  }
  m = HEADING_OWN_BARE.exec(line);
  if (m) {
    const named = nameWithoutApostrophe((m[1] as string).split(' '), ctx);
    if (named) return { whose: named.whose, rest: '' };
  }
  m = HEADING_COLON.exec(line);
  if (m) {
    const whose = headingWhose(m[1] as string, ctx, false, index);
    return whose ? { whose, rest: (m[2] ?? '').trim() } : null;
  }
  // A line that is only somebody's name, or "Joint", or "my wife".
  const bare = line.replace(/:+$/, '');
  if (kindsIn(bare, index).length === 0) {
    const whose = whoIs(bare, ctx);
    if (whose && whose.kind !== 'unknown') return { whose, rest: '' };
    if (relation(bare)) return { whose: { kind: 'unknown' }, rest: '' };
  }
  return null;
}

// ------------------------------------------------------------------ items

/** A bullet, a number or a box before a line's words: "- ", "1.", "a)", "[ ]". */
const BULLET = /^(?:[-*•·▪◦‣–—+>]+|\(?\d{1,3}[.)]|\(?[a-z][.)]|\[ ?[xX]? ?\])\s*/u;
const SEPARATOR = /( ?(?:[,;]|\s&\s|\s\+\s|\band\b|\bplus\b) ?)/i;

interface Qualifiers {
  count: number | null;
  months: number | null;
  within: number | null;
  years: number[];
  inMonths: string[];
  current: boolean;
  form: string | null;
  saidYears: boolean;
  notes: string[];
  tooManyYears: boolean;
  /** What is left of the words once all of the above is read: for its title (0.9.0). */
  rest: string;
}

/** The latest month of that name, today's or before it. */
function latestMonth(month: number, today: string): string {
  const y = Number(today.slice(0, 4));
  const now = Number(today.slice(5, 7));
  return `${month <= now ? y : y - 1}-${String(month).padStart(2, '0')}`;
}

const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;

function qualifiersOf(text: string, today: string): Qualifiers {
  let s = folded(text);
  const q: Qualifiers = {
    count: null,
    months: null,
    within: null,
    years: [],
    inMonths: [],
    current: false,
    form: null,
    saidYears: false,
    notes: [],
    tooManyYears: false,
    rest: '',
  };
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(s);
    if (m) s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
    return m;
  };
  const capped = (n: number | null, max: number, what: string): number | null => {
    if (n === null || n <= max) return n;
    q.notes.push(`Read as ${max} ${what}: the most one line asks for.`);
    return max;
  };
  const form = formsIn(s)[0];
  if (form) q.form = form;

  // Months named: a range, a list after "for"/"from"/"in", a month and its year.
  const months: string[] = [];
  const addMonth = (key: string) => {
    if (!months.includes(key) && months.length < CHECKLIST_MONTH_NAMES_MAX) months.push(key);
  };
  s = s.replace(MONTH_RANGE_RE, (_all, a: string, b: string, year?: string) => {
    const from = MONTH_INDEX[a] as number;
    const to = MONTH_INDEX[b] as number;
    const endKey = year ? monthKey(Number(year), to) : latestMonth(to, today);
    let y = Number(endKey.slice(0, 4));
    const run: string[] = [];
    for (let m = to, steps = 0; steps < 12; steps += 1) {
      run.unshift(monthKey(y, m));
      if (m === from) break;
      m -= 1;
      if (m === 0) {
        m = 12;
        y -= 1;
      }
    }
    run.forEach(addMonth);
    return ' ';
  });
  s = s.replace(MONTH_YEAR_RE, (_all, a: string, year: string) => {
    addMonth(monthKey(Number(year), MONTH_INDEX[a] as number));
    return ' ';
  });
  s = s.replace(MONTH_LIST_RE, (_all, list: string, ...rest: unknown[]) => {
    const year = rest.find((r) => typeof r === 'string' && /^\d{4}$/.test(r)) as string | undefined;
    for (const m of list.matchAll(MONTH_ONE_RE)) {
      const month = MONTH_INDEX[m[1] as string] as number;
      addMonth(year ? monthKey(Number(year), month) : latestMonth(month, today));
    }
    return ' ';
  });
  q.inMonths = months.sort();

  let m = take(WITHIN_RE);
  if (m) q.within = capped(numberOf(m[1] as string), CHECKLIST_MONTHS_MAX, 'months');
  m = take(MONTHS_RE);
  if (m) q.months = capped(numberOf(m[1] as string), CHECKLIST_MONTHS_MAX, 'months');
  m = take(YEARS_BACK_RE);
  if (m) {
    const n = numberOf((m[1] ?? m[2]) as string) ?? 1;
    if (n >= CHECKLIST_YEARS_MAX) q.tooManyYears = true;
    else {
      const now = Number(today.slice(0, 4));
      for (let i = 1; i <= n; i += 1) q.years.push(now - i);
    }
    q.saidYears = true;
  }
  const years: number[] = [];
  for (const r of s.matchAll(YEAR_RANGE_RE)) {
    const from = Number(r[1]);
    const toText = r[2] as string;
    const to = toText.length === 2 ? Math.floor(from / 100) * 100 + Number(toText) : Number(toText);
    if ((toText.length === 2 || /\//.test(r[0])) && to === from + 1) {
      // "2024-25", "2024/25", "2024/2025": the tax year that ends in 2025.
      years.push(to);
      continue;
    }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    if (hi - lo + 1 >= CHECKLIST_YEARS_MAX) {
      q.tooManyYears = true;
      continue;
    }
    const run: number[] = [];
    for (let y = lo; y <= hi; y += 1) run.push(y);
    years.push(...(from <= to ? run : run.reverse()));
  }
  s = s.replace(YEAR_RANGE_RE, ' ');
  for (const y of s.matchAll(YEAR_RE)) years.push(Number(y[1]));
  for (const y of years) {
    if (!q.years.includes(y) && q.years.length < CHECKLIST_YEARS_MAX) q.years.push(y);
    q.saidYears = true;
  }
  s = s.replace(YEAR_RE, ' ').replace(FORM_RE, ' ');
  m = take(COUNT_BEFORE_RE) ?? take(COUNT_AFTER_RE);
  if (m) q.count = numberOf(m[1] as string);
  else {
    s = s.trim();
    const lead = COUNT_LEADING_RE.exec(s);
    if (lead) {
      q.count = numberOf(lead[1] as string);
      s = s.slice(lead[0].length);
    }
  }
  q.count = capped(q.count, CHECKLIST_COUNT_MAX, 'documents');
  if (CURRENT_RE.test(s)) q.current = true;
  q.rest = s.replace(CURRENT_ALL_RE, ' ');
  return q;
}

/**
 * The words a line is looked for by in titles (0.9.0): what is left of it,
 * folded, without the words that say nothing of which paper, a person's
 * relation, numbers or months; null for none, or for more than
 * CHECKLIST_TITLE_WORDS_MAX (a sentence, not a title).
 */
function titleWordsOf(rest: string): string[] | null {
  const out: string[] = [];
  for (const w of foldWords(rest)) {
    if (
      w.length < 2 ||
      /^\d+$/.test(w) ||
      TITLE_FILLER.has(w) ||
      NUMBER_WORDS[w] !== undefined ||
      MONTH_SET.has(w) ||
      ME.has(w) ||
      NO_ONE.has(w) ||
      RELATIONS.has(w)
    ) {
      continue;
    }
    if (w.length > CHECKLIST_TITLE_WORD_MAX) return null;
    if (!out.includes(w)) out.push(w);
  }
  return out.length > 0 && out.length <= CHECKLIST_TITLE_WORDS_MAX ? out : null;
}

/**
 * The person a part of a line names itself — "Mansoor's W2", "W2 for
 * Mansoor", "W2 (Mansoor)" — and its words without the name. A name that
 * reads as somebody's and is nobody the reader may choose ("Dad's
 * passport", "Grandma's") is whose?; "last year's", "for the house" name
 * nobody.
 */
function ownerIn(
  text: string,
  ctx: ChecklistContext,
  index: KindIndex,
): { whose: Whose; rest: string } | null {
  const t = text.trim();
  for (const re of [ITEM_OWNER, ITEM_FOR, ITEM_PAREN]) {
    const m = re.exec(t);
    if (!m) continue;
    const name = m[1] as string;
    const whose = whoIs(name, ctx);
    const rest = `${t.slice(0, m.index)} ${t.slice(m.index + m[0].length)}`.trim();
    if (whose && whose.kind !== 'unknown') return { whose, rest };
    if (relation(name) || looksLikeName(name)) return { whose: { kind: 'unknown' }, rest };
  }
  return leadingOwner(t, ctx, index);
}

/**
 * A part that starts with somebody, without an apostrophe (0.9.0):
 * "mansoors passport", "Mansoors EAD" — or "james passport", a name as it
 * is, when the rest names a kind. Either way the rest says the kind the
 * whole part does, so "bills for 2024" keeps its bills beside a Bill. A
 * word that is nobody stays as it was.
 */
function leadingOwner(
  t: string,
  ctx: ChecklistContext,
  index: KindIndex,
): { whose: Whose; rest: string } | null {
  const words = t.split(/\s+/).filter(Boolean);
  const whole = kindOf(kindsIn(t, index));
  for (let n = Math.min(3, words.length - 1); n >= 1; n -= 1) {
    const named = nameWithoutApostrophe(words.slice(0, n), ctx);
    if (!named) continue;
    const rest = words.slice(n).join(' ');
    // Never a name that takes the line's kind with it ("bills for 2024" with a Bill).
    const kind = kindOf(kindsIn(rest, index));
    if (kind !== whole || (named.plain && kind === null)) continue;
    return { whose: named.whose, rest };
  }
  return null;
}

interface Part {
  text: string;
  kinds: KindHit[];
}

/**
 * A line's parts: each naming a kind, a piece that names none joined to the
 * one before it (or, first, to the one after), with the words between them
 * as written.
 */
function partsOf(line: string, index: KindIndex): Part[] {
  // Pieces and the separators between them, alternately.
  const bits = line.split(SEPARATOR);
  const parts: Array<{ text: string }> = [];
  let sep = '';
  bits.forEach((bit, i) => {
    if (i % 2 === 1) {
      sep = bit;
      return;
    }
    if (bit.trim() === '') return;
    const last = parts[parts.length - 1];
    if (last && (kindsIn(bit, index).length === 0 || kindsIn(last.text, index).length === 0)) {
      last.text = `${last.text}${sep}${bit}`;
    } else {
      parts.push({ text: bit });
    }
  });
  // One part is the whole line, as written.
  if (parts.length <= 1) return [{ text: line.trim(), kinds: kindsIn(line, index) }];
  // Read whole again where joining made a longer phrase ("stocks and shares").
  return parts.map((p) => ({ text: p.text.trim(), kinds: kindsIn(p.text, index) }));
}

/** The kind a part says: its longest phrase; two different of the same length say none. */
function kindOf(hits: KindHit[]): string | null {
  if (hits.length === 0) return null;
  const longest = Math.max(...hits.map((h) => h.length));
  const keys = new Set(hits.filter((h) => h.length === longest).map((h) => h.key));
  // A specific kind beside its general one says the specific ("Tax: W2"), as a folder does.
  for (const k of keys) {
    const parent = k ? FOLDER_KIND_PARENTS[k] : undefined;
    if (parent && keys.has(parent)) keys.delete(parent);
  }
  if (keys.size !== 1) return null;
  return [...keys][0] ?? null;
}

/** A checklist read with plain rules: what each line asks for, and whose. */
export function readChecklist(text: string, ctx: ChecklistContext): ChecklistReading {
  const index = kindIndex(ctx.types);
  const lines = text
    .slice(0, CHECKLIST_TEXT_MAX)
    .split(/\r\n?|\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  let leftOut = Math.max(0, lines.length - CHECKLIST_LINES_MAX);
  const items: ChecklistReadItem[] = [];
  let heading: string | null = null;
  let section: Whose | null = null;

  for (const raw of lines.slice(0, CHECKLIST_LINES_MAX)) {
    const line = [...raw]
      .slice(0, CHECKLIST_LINE_MAX)
      .join('')
      .replace(BULLET, '')
      // Its last full stops and commas go; a colon says it is a heading.
      .replace(/[\s.;,!]+$/u, '')
      .trim();
    if (!line.replace(/:+$/, '')) continue;
    let body = line.replace(/\s*:+$/, '');
    const h = headingOf(line, ctx, index);
    if (h) {
      heading = h.rest ? (line.split(':')[0] ?? body).trim() : body;
      section = h.whose;
      if (!h.rest) continue;
      body = h.rest.replace(/[\s.;,!:]+$/u, '');
    }
    // Whose each part says itself, and its words without the name.
    const owned = partsOf(body, index).map((p) => {
      const o = ownerIn(p.text, ctx, index);
      return o
        ? { text: p.text, read: o.rest, whose: o.whose }
        : { text: p.text, read: p.text, whose: null };
    });
    const parts = owned.map((o) => ({ ...o, kinds: kindsIn(o.read, index) }));
    const quals = parts.map((p) => qualifiersOf(p.read, ctx.today));
    // Years said anywhere in the line, for the parts that say none.
    const lineYears = quals.find((q) => q.saidYears)?.years ?? [];
    const lineMonths = quals.find((q) => q.inMonths.length > 0)?.inMonths ?? [];
    const lineOwner = parts.find((p) => p.whose !== null)?.whose ?? null;
    let carried: Pick<Qualifiers, 'count' | 'months' | 'within' | 'current'> = {
      count: null,
      months: null,
      within: null,
      current: false,
    };
    parts.forEach((part, i) => {
      const q = quals[i] as Qualifiers;
      const own = q.count !== null || q.months !== null || q.within !== null || q.current;
      const how = own
        ? { count: q.count, months: q.months, within: q.within, current: q.current }
        : carried;
      carried = how;
      const whose = part.whose ?? lineOwner ?? section;
      const typeKey = kindOf(part.kinds);
      const tooMany = quals.some((x) => x.tooManyYears);
      const titleWords = titleWordsOf(q.rest);
      const problem: ChecklistProblem | null = !typeKey
        ? 'kind'
        : tooMany
          ? 'years'
          : whose?.kind === 'unknown'
            ? 'person_unknown'
            : whose?.kind === 'shared'
              ? 'person_shared'
              : null;
      const notes = [
        ...q.notes,
        ...(tooMany
          ? [
              `A run of ${CHECKLIST_YEARS_MAX} years or more is too many to look for: name the years.`,
            ]
          : []),
      ];
      items.push({
        line: part.text,
        heading,
        type_key: typeKey,
        member_id: whose?.kind === 'person' ? whose.id : null,
        count: how.count,
        months: how.months,
        within: how.within,
        years: q.saidYears ? q.years : lineYears,
        in_months: q.inMonths.length > 0 ? q.inMonths : lineMonths,
        current: how.current,
        form: isTaxKind(typeKey) ? q.form : null,
        skipped: false,
        unresolved:
          whose?.kind === 'unknown'
            ? 'person_unknown'
            : whose?.kind === 'shared'
              ? 'person_shared'
              : null,
        understood: problem === null,
        problem,
        person_choices: whose?.kind === 'shared' ? whose.choices : [],
        note: notes.length > 0 ? notes.join(' ') : null,
        ...(titleWords ? { title_words: titleWords } : {}),
      });
    });
  }
  if (items.length > CHECKLIST_ITEMS_MAX) {
    leftOut += items.length - CHECKLIST_ITEMS_MAX;
    items.length = CHECKLIST_ITEMS_MAX;
  }
  return { items, left_out: leftOut };
}

// --------------------------------------------------------------- the words

/** A kind's name in a sentence: "pay statement", "national ID". */
function kindWord(kind: ChecklistKind | undefined, form: string | null): string {
  if (form) return form;
  if (!kind) return 'document';
  const label = shortTypeLabel(kind);
  return /^\p{Lu}\p{Ll}/u.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/** "pay statements", "W-2s", "bills", "IDs". */
function plural(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:s|x|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

const and = (list: string[]) =>
  list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;

const yearsWords = (years: number[]) => and(years.map(String));

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const monthWord = (key: string) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

/** "May and June 2026", "December 2025 and January 2026". */
function monthsWords(keys: readonly string[]): string {
  const years = new Set(keys.map((k) => k.slice(0, 4)));
  if (years.size === 1) {
    return `${and(keys.map((k) => MONTH_NAMES[Number(k.slice(5, 7)) - 1] as string))} ${[...years][0]}`;
  }
  return and(keys.map(monthWord));
}

/** How many documents an item asks for. */
export function checklistWanted(item: ChecklistItem): number {
  if ((item.in_months?.length ?? 0) > 0) return item.in_months?.length ?? 1;
  if (item.count !== null) return item.count;
  if (item.months !== null) return item.months;
  if (item.years.length > 0) return item.years.length;
  return 1;
}

/** Whose, said after it: ", Mansoor's", or ", anyone's". */
function whoseWords(item: ChecklistItem, people: readonly ChecklistPerson[]): string {
  if (item.member_id === null) return ', anyone’s';
  const name = people.find((p) => p.id === item.member_id)?.name;
  return name ? `, ${name}’s` : '';
}

/**
 * What an item was understood as, in words: "3 most recent pay statements,
 * Mansoor’s", "W-2s for 2025 and 2024, Mansoor’s", "Bank statements from
 * each of the last 3 months, anyone's".
 */
export function checklistSummary(
  item: ChecklistItem,
  ctx: Pick<ChecklistContext, 'types' | 'people'>,
): string {
  const problem = (item as Partial<ChecklistReadItem>).problem;
  if (!item.type_key || problem === 'kind') return 'Not understood';
  const kind = ctx.types.find((t) => t.key === item.type_key);
  const one = kindWord(kind, item.form);
  const many = plural(one);
  const years = item.years.length > 0 ? yearsWords(item.years) : '';
  const inMonths = item.in_months ?? [];
  let what: string;
  if (problem === 'years') {
    what = `${capital(many)}: years not read`;
  } else if (inMonths.length > 0) {
    what = `${capital(inMonths.length > 1 ? many : one)} for ${monthsWords(inMonths)}`;
  } else if (item.within) {
    const n = item.count ?? 1;
    const span = item.within === 1 ? 'the last month' : `the last ${item.within} months`;
    what = n > 1 ? `${n} ${many} dated within ${span}` : `A ${one} dated within ${span}`;
  } else if (item.months !== null) {
    what =
      item.months === 1
        ? `The ${one} of the last month`
        : `${capital(many)} from each of the last ${item.months} months`;
  } else if (item.count !== null && item.count > 1) {
    what = `${item.count} most recent ${many}${years ? ` from ${years}` : ''}`;
  } else if (years && item.count === null) {
    what = `${capital(item.years.length > 1 ? many : one)} for ${years}`;
  } else {
    what = `${item.current ? 'A current' : 'The most recent'} ${one}${years ? ` from ${years}` : ''}`;
  }
  if (item.current && !what.startsWith('A current')) what += ', still valid';
  // Whose, when the heading names nobody the reader may choose, or two of them.
  if (problem === 'person_unknown' || problem === 'person_shared') return `${what}: whose?`;
  return `${what}${whoseWords(item, ctx.people)}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// --------------------------------------------------------------- matching

/** A document the reader can see, out of the Trash, as matching reads it. */
export interface ChecklistDoc {
  id: string;
  title: string | null;
  type_key: string | null;
  owner_member_id: string | null;
  visibility: Visibility;
  issued: DateValue | null;
  expires: DateValue | null;
  /** When it was added, ISO. */
  created_at: string;
  /** Its tax year as kept (a tax form's or a return's), the caller's own Only me one's opened; or null. */
  tax_year: string | null;
  /** In this collection already. */
  in_collection: boolean;
}

/** One document offered for an item. */
export interface ChecklistMatch {
  document_id: string;
  title: string | null;
  type_key: string | null;
  owner_member_id: string | null;
  visibility: Visibility;
  /** Its issue date, or null. */
  issued: DateValue | null;
  added_at: string;
  /** Ticked to add: one of those the item asks for, not in the collection, not Only me there. */
  ticked: boolean;
  /** One of those the item asks for (the rest are others to swap in). */
  chosen: boolean;
  in_collection: boolean;
  /** Why it is not ticked, or what to check, in words. */
  note: string | null;
}

/** An item, as it now stands against the documents. */
export interface ChecklistItemCheck extends ChecklistReadItem {
  summary: string;
  /** How many it asks for… */
  wanted: number;
  /** …how many of those are in the collection, or ticked to go in… */
  found: number;
  /** …and how many more were found that will not go in (an Only me one in a collection others see). */
  found_not_added: number;
  /** What is still missing, in words ("W-2 for 2024, Mansoor’s"). */
  missing: string[];
  matches: ChecklistMatch[];
  /** Found by the words of its title, not its kind (0.9.0); absent for a line found by its kind. */
  by_title?: boolean;
}

/** A document as matching reads it: once, whatever asks. */
interface Prepared {
  doc: ChecklistDoc;
  /** The date it is ordered by: its issue date, a tax year's end, or null (undated). */
  date: string | null;
  /** Its month (YYYY-MM), for "N months" and months named. */
  month: string | null;
  years: number[];
  forms: string[];
}

/** A document as a title is looked for in it (0.9.0): its title's words, singular, and years. */
interface Titled {
  p: Prepared;
  words: ReadonlySet<string>;
  years: readonly number[];
}

/** The documents a checklist is matched against, read once and grouped by kind. */
export interface ChecklistDocs {
  byKind: ReadonlyMap<string, readonly Prepared[]>;
  /**
   * Those a line is looked for in by its title (0.9.0), newest first,
   * their titles' words read once, as a title is first looked for.
   */
  titled: () => readonly Titled[];
}

/** Years in words like a tax year's or a title's: "2025", "2024/25" (2024 and 2025). */
function yearsIn(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/(?<!\d)(19\d\d|20\d\d)(?!\d)/g)) out.add(Number(m[1]));
  for (const m of text.matchAll(/(?<!\d)(19|20)(\d\d) ?[/-] ?(\d\d)(?!\d)/g)) {
    out.add(Number(`${m[1]}${m[3]}`));
  }
  return [...out];
}

function prepare(doc: ChecklistDoc): Prepared {
  const tax = isTaxKind(doc.type_key);
  let years: number[] = [];
  let date: string | null = doc.issued?.date ?? null;
  if (tax) {
    // A tax form or a return by the tax year it keeps, else the one its title names.
    years = doc.tax_year ? yearsIn(doc.tax_year) : [];
    if (years.length === 0 && doc.title) years = yearsIn(doc.title);
    // With no year at all, it is never ticked, whatever its issue date:
    // offered to check (the C1 review).
    if (years.length === 0) date = null;
    else if (!date) date = `${Math.max(...years)}-12-31`;
  } else if (date) {
    years = [Number(date.slice(0, 4))];
  }
  return {
    doc,
    date,
    month: date ? date.slice(0, 7) : null,
    years,
    forms: tax ? formsIn(doc.title) : [],
  };
}

/** Dated ones newest first, then those with no date, newest added first. */
const newestFirst = (a: Prepared, b: Prepared) =>
  // No date, '', sorts after every date.
  (b.date ?? '').localeCompare(a.date ?? '') ||
  b.doc.created_at.localeCompare(a.doc.created_at) ||
  a.doc.id.localeCompare(b.doc.id);

/** A word of a title or a line as they are compared: folded, and singular ("Cards", "W-2s"). */
const titleKey = (w: string) => keyWord(w);

/**
 * The documents grouped by kind, each read once: dated ones newest first,
 * then those with no date, newest added first. A line is looked for by its
 * title (0.9.0) in `titleDocs` and `docs` together, or in `docs` alone
 * when no `titleDocs` are given: every one the reader can see, of any kind
 * or none, and nothing else.
 */
export function prepareChecklistDocs(
  docs: readonly ChecklistDoc[],
  titleDocs?: readonly ChecklistDoc[],
): ChecklistDocs {
  const byKind = new Map<string, Prepared[]>();
  const byId = new Map<string, Prepared>();
  for (const d of docs) {
    const p = prepare(d);
    byId.set(d.id, p);
    if (!d.type_key) continue;
    const list = byKind.get(d.type_key) ?? [];
    list.push(p);
    byKind.set(d.type_key, list);
  }
  for (const list of byKind.values()) list.sort(newestFirst);
  let titled: Titled[] | null = null;
  return {
    byKind,
    titled: () => {
      if (titled) return titled;
      const all = new Map(byId);
      for (const d of titleDocs ?? []) if (!all.has(d.id)) all.set(d.id, prepare(d));
      titled = [...all.values()]
        .filter((p) => p.doc.title)
        .sort(newestFirst)
        .map((p) => {
          const title = p.doc.title as string;
          return {
            p,
            words: new Set(foldWords(title).map(titleKey)),
            years: [...new Set([...p.years, ...yearsIn(title)])],
          };
        });
      return titled;
    },
  };
}

/** The first month (YYYY-MM) of the last `n`, today's among them. */
function monthsBack(today: string, n: number): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1 - (n - 1);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

export interface ChecklistMatchOptions {
  today: string;
  /** The collection's audience: an Only me document is not ticked for one others see. */
  audience: string;
  people: readonly ChecklistPerson[];
  types: readonly ChecklistKind[];
}

/**
 * An item against the documents the reader can see (out of the Trash, by
 * the one visibility rule):
 *
 * - its kind and its person (anyone's, for none); a tax form or a return by
 *   the tax year it keeps, or its title's, otherwise by the year it was
 *   issued; a line naming a form ("W-2") ticks only documents whose title
 *   names it, and offers the rest of the kind unticked;
 * - "last N": the N most recent dated ones; "N months": each of the last N
 *   months (a month-precision date in its month); months named: each of
 *   them; "dated within N months": the most recent dated in them; years
 *   alone: every one of each year; otherwise the most recent; "current":
 *   one that has not run out;
 * - a document with no date (or a tax form with no year) is never ticked:
 *   offered after the dated, with CHECKLIST_NO_DATE_NOTE;
 * - ticked, unless it is in the collection already, or Only me in a
 *   collection others see (CHECKLIST_ONLY_ME_NOTE); a few more offered
 *   unticked, to swap in; for an investment statement, the person's bank
 *   statements too (CHECKLIST_WAS_BANK_NOTE);
 * - found: those that are, or will be, in the collection; one that will not
 *   (Only me) is found, not added, and not missing either; what is missing
 *   said in words;
 * - **by its title** (0.9.0): a line that names no kind, or whose kind
 *   finds nothing at all, is looked for by its `title_words` in the titles
 *   of the same documents — each word whole, folded (case, accents, a
 *   possessive), singular or plural alike — still its person's, of its
 *   years (an issue date's, a tax year's, or one its title names) and not
 *   run out if it says "current". One found, for a line that asks for
 *   one, is offered ticked (by the rules above: never Only me in a
 *   collection others see), and the line is said back as "Found by its
 *   title: <its title>"; several, or one for a line that asks for more,
 *   are offered unticked, to choose; none leaves the line as it was (Not
 *   understood, for one with no kind). A line whose person is still to
 *   choose is not looked for.
 */
export function checkItem(
  item: ChecklistReadItem,
  docs: readonly ChecklistDoc[] | ChecklistDocs,
  opts: ChecklistMatchOptions,
): ChecklistItemCheck {
  const prepared = 'byKind' in docs ? docs : prepareChecklistDocs(docs);
  return checkOne(item, prepared, opts, () => true);
}

/** An item by its kind, then, where that finds nothing, by its title, while `mayLook` allows. */
function checkOne(
  item: ChecklistReadItem,
  prepared: ChecklistDocs,
  opts: ChecklistMatchOptions,
  mayLook: () => boolean,
): ChecklistItemCheck {
  const byKind = checkByKind(item, prepared, opts);
  if (!looksByTitle(byKind) || !mayLook()) return byKind;
  return checkByTitle(item, byKind, prepared, opts) ?? byKind;
}

/** A match as it is offered. */
function matchOf(
  d: ChecklistDoc,
  chosen: boolean,
  note: string | null,
  onlyMe: boolean,
): ChecklistMatch {
  return {
    document_id: d.id,
    title: d.title,
    type_key: d.type_key,
    owner_member_id: d.owner_member_id,
    visibility: d.visibility,
    issued: d.issued,
    added_at: d.created_at,
    ticked: chosen && !d.in_collection && !onlyMe,
    chosen,
    in_collection: d.in_collection,
    note: onlyMe ? CHECKLIST_ONLY_ME_NOTE : note,
  };
}

/**
 * Whether an item, as its kind left it, is looked for by its title: words
 * to look for, nobody still to choose, and no kind — or a kind that found
 * nothing at all.
 */
function looksByTitle(c: ChecklistItemCheck): boolean {
  return (
    !c.skipped &&
    (c.title_words?.length ?? 0) > 0 &&
    !c.unresolved &&
    (c.problem === 'kind' || (c.problem === null && c.matches.length === 0))
  );
}

/** An item by the words of its title (see `checkItem`); null when no title has them all. */
function checkByTitle(
  item: ChecklistReadItem,
  byKind: ChecklistItemCheck,
  prepared: ChecklistDocs,
  opts: ChecklistMatchOptions,
): ChecklistItemCheck | null {
  const want = [
    ...new Set(
      (item.title_words ?? [])
        .slice(0, CHECKLIST_TITLE_WORDS_MAX)
        .flatMap((w) => foldWords(w))
        .map(titleKey),
    ),
  ];
  if (want.length === 0 || want.length > CHECKLIST_TITLE_WORDS_MAX) return null;
  const hits: Prepared[] = [];
  for (const t of prepared.titled()) {
    if (hits.length >= CHECKLIST_MATCHES_MAX) break;
    const d = t.p.doc;
    if (
      want.every((w) => t.words.has(w)) &&
      (item.member_id === null || d.owner_member_id === item.member_id) &&
      (item.years.length === 0 || t.years.some((y) => item.years.includes(y))) &&
      (!item.current || !d.expires || d.expires.date >= opts.today)
    ) {
      hits.push(t.p);
    }
  }
  const first = hits[0]?.doc;
  if (!first) return null;
  const onlyMe = (d: ChecklistDoc) => opts.audience !== 'only_me' && d.visibility === 'private';
  // One found, for a line that asks for one: chosen. Otherwise each is offered, to choose.
  const one = hits.length === 1;
  const sure = one && byKind.wanted === 1;
  const addable = sure && (first.in_collection || !onlyMe(first));
  return {
    ...byKind,
    understood: true,
    problem: null,
    summary: one
      ? `${CHECKLIST_BY_TITLE_NOTE}: ${first.title ?? ''}`
      : `${CHECKLIST_BY_TITLE_NOTE}: ${hits.length} to choose from`,
    found: addable ? 1 : 0,
    found_not_added: sure && !addable ? 1 : 0,
    // None chosen: what the kind said is missing still is.
    missing: sure ? [] : byKind.missing,
    matches: hits.map((p) => matchOf(p.doc, sure, CHECKLIST_BY_TITLE_NOTE, onlyMe(p.doc))),
    by_title: true,
  };
}

/** An item by its kind (see `checkItem`). */
function checkByKind(
  item: ChecklistReadItem,
  prepared: ChecklistDocs,
  opts: ChecklistMatchOptions,
): ChecklistItemCheck {
  const summary = checklistSummary(item, opts);
  const wanted = checklistWanted(item);
  const base = { ...item, summary, wanted };
  if (item.skipped || !item.understood || !item.type_key) {
    return { ...base, found: 0, found_not_added: 0, missing: [], matches: [] };
  }
  const shared = opts.audience !== 'only_me';
  const onlyMe = (d: ChecklistDoc) => shared && d.visibility === 'private';
  const addable = (d: ChecklistDoc) => d.in_collection || !onlyMe(d);
  const all = (prepared.byKind.get(item.type_key) ?? []).filter(
    (p) =>
      (item.member_id === null || p.doc.owner_member_id === item.member_id) &&
      (!item.current || !p.doc.expires || p.doc.expires.date >= opts.today),
  );
  // A form named: those whose title names it may be ticked; those naming
  // none, offered to check; those naming another, not this.
  const unsaid = new Set<Prepared>();
  let fitting = all;
  if (item.form) {
    const form = item.form;
    fitting = all.filter((p) => p.forms.includes(form));
    for (const p of all) if (p.forms.length === 0) unsaid.add(p);
  }
  const dated = fitting.filter((p) => p.date !== null);
  const undated = [...fitting.filter((p) => p.date === null), ...unsaid];
  const kind = opts.types.find((t) => t.key === item.type_key);
  const one = kindWord(kind, item.form);
  const whose = whoseWords(item, opts.people).replace(/^, /, '');
  const say = (what: string) => (whose && whose !== 'anyone’s' ? `${what}, ${whose}` : what);
  const missing: string[] = [];
  let chosen: Prepared[] = [];
  let found = 0;
  let covered = 0;
  const inMonths = item.in_months ?? [];

  /** Each of `keys` with a chosen document in it: by what goes in, and by all. */
  const cover = <K>(
    keys: readonly K[],
    has: (p: Prepared, k: K) => boolean,
    missingOf: (k: K) => string,
  ) => {
    for (const k of keys) {
      const any = chosen.filter((p) => has(p, k));
      if (any.some((p) => addable(p.doc))) found += 1;
      if (any.length > 0) covered += 1;
      else missing.push(say(missingOf(k)));
    }
  };
  /** N asked for: what is chosen, and what is short of it ("2 more pay statements"). */
  const short = (n: number, onlyOne: string) => {
    found = chosen.filter((p) => addable(p.doc)).length;
    covered = chosen.length;
    if (covered < n) {
      const more = n - covered;
      missing.push(say(n === 1 ? onlyOne : `${more} more ${more === 1 ? one : plural(one)}`));
    }
  };

  if (inMonths.length > 0) {
    chosen = dated
      .filter((p) => p.month !== null && inMonths.includes(p.month))
      .slice(0, CHECKLIST_MATCHES_MAX);
    cover(
      inMonths,
      (p, k) => p.month === k,
      (k) => `${one} for ${monthWord(k)}`,
    );
  } else if (item.years.length > 0) {
    const yearsOf = (p: Prepared) => p.years.some((y) => item.years.includes(y));
    const ofYears = dated.filter(yearsOf);
    if (item.count !== null) {
      chosen = ofYears.slice(0, item.count);
      found = chosen.filter((p) => addable(p.doc)).length;
      covered = chosen.length;
      if (covered < item.count) {
        const more = item.count - covered;
        missing.push(
          say(`${more} more ${more === 1 ? one : plural(one)} from ${yearsWords(item.years)}`),
        );
      }
    } else {
      chosen = ofYears.slice(0, CHECKLIST_MATCHES_MAX);
      cover(
        item.years,
        (p, y) => p.years.includes(y),
        (y) => `${one} for ${y}`,
      );
    }
  } else if (item.within) {
    const from = monthsBack(opts.today, item.within);
    const n = item.count ?? 1;
    chosen = dated.filter((p) => (p.month as string) >= from).slice(0, n);
    short(
      n,
      `a ${one} dated within the last ${item.within === 1 ? 'month' : `${item.within} months`}`,
    );
  } else if (item.months !== null) {
    const from = monthsBack(opts.today, item.months);
    const now = opts.today.slice(0, 7);
    chosen = dated
      .filter((p) => (p.month as string) >= from && (p.month as string) <= now)
      .slice(0, Math.min(CHECKLIST_MATCHES_MAX, item.months * 3));
    const months: string[] = [];
    for (let i = item.months - 1; i >= 0; i -= 1) months.push(monthsBack(opts.today, i + 1));
    const before = missing.length;
    cover(
      months,
      (p, k) => p.month === k,
      () => '',
    );
    // Said once, as how many months are missing.
    const lacking = missing.length - before;
    missing.splice(before);
    if (lacking > 0) {
      missing.push(say(`${one} for ${lacking} more ${lacking === 1 ? 'month' : 'months'}`));
    }
  } else {
    const n = item.count ?? 1;
    chosen = dated.slice(0, n);
    short(n, `${item.current ? 'a current' : 'the most recent'} ${one}`);
  }

  const chosenSet = new Set(chosen);
  const others: Array<[Prepared, string | null]> = [];
  for (const p of dated) {
    if (others.length >= CHECKLIST_OTHERS_MAX) break;
    if (!chosenSet.has(p)) others.push([p, null]);
  }
  for (const p of undated) {
    if (others.length >= CHECKLIST_OTHERS_MAX * 2) break;
    others.push([
      p,
      unsaid.has(p) && p.date !== null ? CHECKLIST_FORM_UNSAID_NOTE : CHECKLIST_NO_DATE_NOTE,
    ]);
  }
  // An investment's statements were bank statements until 0.9.0 (0077).
  if (item.type_key === 'investment_statement') {
    let n = 0;
    for (const p of prepared.byKind.get('bank_statement') ?? []) {
      if (n >= CHECKLIST_OTHERS_MAX) break;
      if (item.member_id !== null && p.doc.owner_member_id !== item.member_id) continue;
      others.push([p, CHECKLIST_WAS_BANK_NOTE]);
      n += 1;
    }
  }
  const matches = [
    ...chosen.map((p) => matchOf(p.doc, true, null, onlyMe(p.doc))),
    ...others.map(([p, note]) => matchOf(p.doc, false, note, onlyMe(p.doc))),
  ].slice(0, CHECKLIST_MATCHES_MAX);
  found = Math.min(found, wanted);
  return {
    ...base,
    found,
    found_not_added: Math.max(0, Math.min(covered, wanted) - found),
    missing: missing.filter((m) => m !== ''),
    matches,
  };
}

/**
 * Every item matched against the same documents, read once; at most
 * CHECKLIST_TITLE_LINES_MAX of them looked for by their titles (0.9.0), in
 * `titleDocs` and `docs` (`prepareChecklistDocs`).
 */
export function checkChecklist(
  items: readonly ChecklistReadItem[],
  docs: readonly ChecklistDoc[],
  opts: ChecklistMatchOptions,
  titleDocs?: readonly ChecklistDoc[],
): ChecklistItemCheck[] {
  const prepared = prepareChecklistDocs(docs, titleDocs);
  let looked = 0;
  const mayLook = () => {
    looked += 1;
    return looked <= CHECKLIST_TITLE_LINES_MAX;
  };
  return items.map((i) => checkOne(i, prepared, opts, mayLook));
}

/**
 * Whether a checklist matched against some documents looks for a line by
 * its title (0.9.0): then the API matches it again with every document the
 * reader can see that has a title (`checkChecklist`'s `titleDocs`).
 */
export function checklistLooksByTitle(items: readonly ChecklistItemCheck[]): boolean {
  return items.some((i) => i.by_title === true || looksByTitle(i));
}

/** What every missing item asks for, as the lines of a request for them ("Ask for the missing ones"). */
export function checklistMissing(items: readonly ChecklistItemCheck[]): string[] {
  return items.flatMap((i) => (i.skipped || !i.understood ? [] : i.missing));
}

/** A saved item, as kept: what was understood, or as the person set it — and nothing else. */
export function savedItem(i: ChecklistItem): ChecklistItem {
  return {
    line: i.line,
    heading: i.heading,
    type_key: i.type_key,
    member_id: i.member_id,
    count: i.count,
    months: i.months,
    years: [...i.years],
    current: i.current,
    // A form is a tax form's or a return's: changed to another kind, it goes.
    form: isTaxKind(i.type_key) ? i.form : null,
    skipped: i.skipped,
    // Whose is still to choose only while nobody is chosen.
    unresolved: i.member_id === null ? (i.unresolved ?? null) : null,
    in_months: [...(i.in_months ?? [])],
    within: i.within ?? null,
    // What it is looked for by in titles (0.9.0), kept to look again as the page opens.
    ...(i.title_words && i.title_words.length > 0
      ? { title_words: i.title_words.slice(0, CHECKLIST_TITLE_WORDS_MAX) }
      : {}),
  };
}

/**
 * A saved or edited item read again for what it still lacks: a kind, and a
 * person who is somebody the reader may choose (a teen: only themselves) —
 * or, while nobody is chosen, the person its heading left to choose.
 */
export function itemAgain(
  i: ChecklistItem & { person_choices?: string[] | undefined },
  ctx: Pick<ChecklistContext, 'types' | 'people'>,
): ChecklistReadItem {
  const kindKnown =
    i.type_key !== null && ctx.types.some((t) => t.key === i.type_key && t.key !== 'other');
  const personKnown = i.member_id === null || ctx.people.some((p) => p.id === i.member_id);
  const kept = savedItem(i);
  const problem: ChecklistProblem | null = !kindKnown
    ? 'kind'
    : !personKnown
      ? 'person_unknown'
      : (kept.unresolved ?? null);
  return {
    ...kept,
    // A person the reader may not choose is nobody to them: never named
    // back, and still to choose.
    member_id: personKnown ? i.member_id : null,
    unresolved: personKnown ? kept.unresolved : 'person_unknown',
    understood: problem === null,
    problem,
    // Whom a shared name could mean, of those the reader may choose.
    person_choices:
      problem === 'person_shared'
        ? (i.person_choices ?? []).filter((id) => ctx.people.some((p) => p.id === id))
        : [],
    note: null,
  };
}

/** What the web sends back of an item: its fields, and whom a shared name could mean. */
export function sentItem(
  i: ChecklistItem & { person_choices?: string[] | undefined },
): ChecklistItem & { person_choices?: string[] } {
  return {
    ...savedItem(i),
    ...(i.person_choices && i.person_choices.length > 0
      ? { person_choices: [...i.person_choices] }
      : {}),
  };
}

// ------------------------------------------------------------------ the wire

/**
 * A collection's checklist as the API answers it (0.9.0, C1;
 * `features.collection_checklist`): `POST /collections/{id}/checklist` (read
 * and matched, nothing kept), `PUT` (kept), and `GET` (kept, matched again
 * as the reader opens the page).
 */
export interface CollectionChecklist {
  /** When it was kept, or null: not kept (a POST's answer, or none kept yet). */
  saved_at: string | null;
  items: ChecklistItemCheck[];
  /** What is still missing, as the lines of a request for it ("Ask for the missing ones"). */
  missing: string[];
  /** Matches ticked, not in the collection: what "Add all found" adds. */
  to_add: number;
  /** Lines or items past the limits, left out. */
  left_out: number;
  /** The reader may change it and add from it: the collection's maker, in its audience. */
  mine: boolean;
}

/** `POST /collections/{id}/checklist`: a list to read, or items as the person set them. */
export interface ChecklistInput {
  text?: string;
  items?: ChecklistItem[];
}

/** Why a document chosen from a checklist was not put in. */
export type ChecklistSkip = 'in_collection' | 'not_found';

/** `POST /collections/{id}/checklist/add`: what was put in, what was not, and why. */
export interface ChecklistAdded {
  added: string[];
  skipped: Array<{ document_id: string; why: ChecklistSkip }>;
  /** Who else will now see them (5.33), in the vault's words. */
  warnings: string[];
  /** The collection's first page, as POST /collections/{id}/items answers it. */
  collection: CollectionDetail;
}

/** "Already in the collection", "No longer there to add": a skip in words. */
export function checklistSkipWords(why: ChecklistSkip): string {
  return why === 'in_collection'
    ? 'already in the collection'
    : 'no longer there to add: in the Trash, or not yours to see';
}

/** Who reads a collection's checklist, said to its maker: the family who see the collection. */
export function checklistReadersWords(audience: string): string {
  switch (audience) {
    case 'everyone':
    case 'teens':
      return 'Everyone in the family who can see this collection — teens too — can read its checklist. Viewers, guests and links never can.';
    case 'adults':
      return 'The adults who can see this collection can read its checklist. Viewers, guests and links never can.';
    default:
      return 'Only you can read this checklist.';
  }
}
