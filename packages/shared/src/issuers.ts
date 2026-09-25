/**
 * Who issued a document (iteration 4.3c) — "Barclays", "British Gas",
 * "NHS" — suggested from the text OCR read off its pages and from the name
 * of the file it arrived in.
 *
 * A suggestion is a question, not an answer: the card asks "From
 * Barclays?" and fills the field only when someone taps. Even so, a wrong
 * guess costs more than no guess, because people soon stop reading a
 * question that is often wrong. So every rule here leans towards silence:
 * the addressee block, addresses, dates and amounts are thrown out before
 * anything is scored; a line has to look like an organisation and sit where
 * letterheads sit before it is offered; and the household's own issuers,
 * spelt the household's way, come before anything read off the page.
 *
 * Everything is pure and deterministic — no clock, no locale, no I/O — so
 * the phone can suggest offline and the server after OCR, and both say the
 * same thing.
 */
import { matchText, words } from './text-search.js';

/** An issuer the household has used before. */
export interface KnownIssuer {
  /** As the household wrote it, and offered back exactly so. */
  value: string;
  /** How many of the household's documents carry it. */
  count: number;
  /** The kinds of document it has been used with. */
  typeKeys?: readonly string[];
}

export interface IssuerCandidate {
  value: string;
  /** The household's own list, the page, or the name of the file. */
  source: 'known' | 'page' | 'file';
}

export interface IssuerOptions {
  /** The issuers the household has used before. */
  known: readonly KnownIssuer[];
  /** What the document is, when that is already known. */
  typeKey?: string | null | undefined;
  /** The household's members and the household's own name: never an issuer. */
  people: readonly string[];
}

/** OCR text beyond this is the small print of a long document; it names nobody new. */
const MAX_TEXT = 60_000;
const MAX_SUGGESTIONS = 3;
/** The longest issuer kept, like a title. */
const MAX_VALUE = 200;
/** A letterhead lives in the first dozen lines of the first page… */
const TOP_WINDOW = 12;
/** …and the name itself, usually, in the first three. */
const TOP_LINES = 3;
/** What a line read off the page must score before it is offered. */
const OFFER_AT = 4;

/** Accents folded, so "Société Générale" and "Societe Generale" are one issuer. */
function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '');
}

/** A set from lines of space-separated words, which read better than a column of quotes. */
function wordSet(...lines: string[]): Set<string> {
  return new Set(lines.join(' ').split(' '));
}

/** Code-unit order, lower case first: the same on every device, whatever its locale. */
function compareText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const LEAD = /^[^\p{L}\p{N}(]+/u;
const LEAD_BARE = /^[^\p{L}\p{N}]+/u;
const KEEP_END = /[\p{L}\p{N}?!)]/u;
const KEEP_END_BARE = /[\p{L}\p{N}?!]/u;

/** Drops the characters at the end that `keep` does not match, in one pass. */
function trimEnd(s: string, keep: RegExp): string {
  const chars = Array.from(s);
  let end = chars.length;
  while (end > 0 && !keep.test(chars[end - 1] ?? '')) end -= 1;
  return end === chars.length ? s : chars.slice(0, end).join('');
}

/**
 * Bullets, rules and stray punctuation at either end go; "Which?" and
 * "Yahoo!" keep theirs, and a bracket stays only when it has its partner.
 * One pass from each end: OCR can read a line of a thousand brackets, and
 * this runs inside a request.
 */
function trimEdges(s: string): string {
  const t = trimEnd(s.replace(LEAD, ''), KEEP_END);
  // With no "(" anywhere, every ")" is unpartnered, and so is what it uncovers.
  if (!t.includes('(')) return trimEnd(t, KEEP_END_BARE);
  // With no ")" anywhere, the same goes for every "(" at the start.
  if (!t.includes(')')) return t.replace(LEAD_BARE, '');
  return t;
}

/**
 * The legal form at the end of a name. It says how a company is registered,
 * not who it is, and people do not say it: nobody's bank is "Barclays Bank
 * UK PLC". Dotted N.A. and S.A. only, so a name that happens to end in "Na"
 * or "Sa" is left alone.
 */
const LEGAL_SUFFIX =
  /(?:^|[\s,]+)(?:p\.?\s?l\.?\s?c|ltd|limited|l\.?l\.?p|l\.?l\.?c|inc|incorporated|corp|corporation|gmbh|n\.\s?a|s\.\s?a|&\s*co)\.?$/iu;

function withoutLegalSuffix(name: string): string {
  let s = trimEdges(name);
  for (;;) {
    const next = trimEdges(s.replace(LEGAL_SUFFIX, ''));
    if (next === s) return s;
    s = next; // "Foo & Co. Ltd" carries two
  }
}

/**
 * A key for comparing issuers: lower case, accents folded, punctuation and
 * the legal form gone, and a leading "The" dropped. "Barclays Bank UK PLC"
 * and "BARCLAYS BANK UK" are the same issuer; so are "The Co-operative
 * Bank" and "Co-operative Bank". Empty when nothing useful is left.
 */
export function issuerKey(name: string): string {
  const w = words(withoutLegalSuffix(fold(name)));
  if (w.length > 1 && w[0] === 'the') w.shift();
  return w.join(' ');
}

/** Short words kept in capitals, although they have vowels. */
const ACRONYMS = wordSet(
  'aa aarp aib aig axa boi dvla dvsa ea edf ee eon eu fca fdic fos hm hmpo ibm ico ing irs isa',
  'itv ni pra rac rsa ssa sse ubs uk ups us usa usaa usps',
);
/** Short words without vowels that are abbreviations, not acronyms. */
const NOT_ACRONYMS = wordSet('dr mr mrs ms mx rd sq st');
/** Words that stay lower case inside a name. */
const CONNECTORS = wordSet('of and the for in on at by to upon de du des la le y');

function titleWord(part: string, first: boolean): string {
  const letters = part.replace(/[^\p{L}]/gu, '');
  if (!letters || /\p{N}/u.test(part)) return part; // O2, 3i: as printed
  if (/\p{L}[&.]\p{L}/u.test(part)) return part; // M&S, AT&T, E.ON
  const lower = fold(letters).toLowerCase();
  if (!first && CONNECTORS.has(lower)) return part.toLowerCase();
  if (ACRONYMS.has(lower)) return part;
  // NHS, HMRC, BT, DMV: a short word with no vowel is spelt out, not said.
  if (letters.length <= 4 && !/[aeiouy]/.test(lower) && !NOT_ACRONYMS.has(lower)) return part;
  return part.toLowerCase().replace(/\p{L}/u, (c) => c.toUpperCase());
}

/** "BANK OF SCOTLAND" → "Bank of Scotland"; "HM REVENUE & CUSTOMS" → "HM Revenue & Customs". */
function titleCase(s: string): string {
  let first = true;
  return s
    .split(' ')
    .map((word) =>
      word
        .split('-')
        .map((part) => {
          const out = titleWord(part, first);
          if (/\p{L}/u.test(part)) first = false;
          return out;
        })
        .join('-'),
    )
    .join(' ');
}

function isAllCaps(s: string): boolean {
  return /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s);
}

/**
 * An issuer as people should see it: trimmed, the legal form gone, and a
 * name printed in capitals (as letterheads and footers often are) written
 * the way a person would — except the short acronyms that are said letter
 * by letter: NHS, HMRC, DVLA, BT, EE, IRS, DMV. A name that already has
 * lower-case letters is the issuer's own styling and is left alone.
 */
export function cleanIssuer(raw: string): string {
  let s = withoutLegalSuffix(raw.replace(/\s+/g, ' '));
  if (isAllCaps(s)) s = titleCase(s);
  if (s.length <= MAX_VALUE) return s;
  s = s.slice(0, MAX_VALUE);
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1); // never half a character
  return s.trimEnd();
}

/**
 * Words that say what kind of body wrote a letter. Having one is half of
 * looking like an organisation; "Riverside Surgery" has one, "Riverside"
 * does not.
 */
const ORG_NOUNS = [
  'bank, banking, building society, insurance, assurance, energy, water, council, nhs, trust',
  'surgery, clinic, hospital, university, college, school, vets, veterinary, hmrc, irs, dvla',
  'dmv, credit union, mortgage, mortgages, telecom, broadband, practice, medical centre',
  'medical center, health centre, health center, dental, pharmacy, revenue, customs, agency',
  'authority, pensions, solicitors, police, borough, passport office, home office, post office',
  'land registry, finance, government, ministry',
]
  .join(', ')
  .split(', ');

/**
 * Words that say what something is without saying whose it is. A line made
 * only of these — "Home Insurance", "Building Society", "Car Finance" — is
 * a heading, however much it looks like a name.
 */
const GENERIC = wordSet(
  'bank banking building society insurance assurance energy water council trust surgery clinic',
  'hospital university college school vets veterinary credit union mortgage mortgages telecom',
  'broadband practice medical centre center health dental pharmacy revenue customs agency',
  'authority pensions pension solicitors police borough passport office home post land registry',
  'finance financial government ministry account accounts annual business buildings car card',
  'cards city contents county cover current direct district electric electricity gas group house',
  'life loan loans local mobile motor online parish personal pet plan policy savings service',
  'services tax town travel van vehicle uk gb us usa',
);
/** Names made of generic words that are nonetheless one body's name. */
const NAMED_BODIES = ['home office', 'post office', 'passport office', 'land registry'];

function hasPhrase(key: string, phrases: readonly string[]): boolean {
  const padded = ` ${key} `;
  return phrases.some((p) => padded.includes(` ${p} `));
}

function distinctive(key: string): boolean {
  if (hasPhrase(key, NAMED_BODIES)) return true;
  return key.split(' ').some((w) => !GENERIC.has(w) && !CONNECTORS.has(w));
}

const HONORIFIC = /^(?:mr|mrs|ms|miss|mx|dr|prof)\b/i;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
const US_STATE_ZIP = /\b[A-Z]{2},?\s+\d{5}(?:-\d{4})?\b/;
const STREET =
  /^\d+[a-z]?\b.*\b(?:road|rd|street|st|lane|ln|avenue|ave|close|drive|dr|way|court|ct|place|pl|crescent|grove|gardens|terrace|square|mews|walk|row|hill|park|parade|boulevard|blvd|highway|hwy)\b/i;
/** A street without its number, as a named house's address has: "College Road", "School Lane". */
const STREET_NAME = /\b(?:road|rd|street|lane|avenue|ave|drive|crescent|grove|terrace|mews)\.?$/i;
const FLAT = /^(?:flat|apartment|apt|unit|suite)\s*\d/i;
const PO_BOX = /\bp\.?\s?o\.?\s*box\b/i;
const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_IN_WORDS = new RegExp(
  `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b|\\b${MONTH}\\.?\\s+\\d{1,4}\\b`,
  'i',
);
const DATE_IN_NUMBERS = /\b\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}\b/;
const MONEY = /[£$€¥]|\d\.\d{2}\b/;
const PAGE = /\bpage\s+\d+/i;
/**
 * The words on a document's own lines — what it is, who it is to, how to
 * reply — that never appear in the name of whoever sent it.
 */
const STOP_WORDS = [
  'statements?|invoices?|bills?|policy schedule|account (?:number|no)|sort code|references?|ref',
  'customers?|dear|private (?:&|and) confidential|balances?|tel|telephone|phone|fax|e-?mail|vat',
  'registered in|registered office',
  // A sentence or a heading, not a name.
  'you|your|yours|number|date|thank|please|certificate|notice|schedule|summary|confirmation',
  'renewal|letter|report|application|form|agreement|contract|terms|conditions|receipt|quotation',
  'quote|estimate|results|appointment|notification|reminder|request|details|information',
];
const STOP = new RegExp(`\\b(?:${STOP_WORDS.join('|')})\\b`, 'i');
const WEB = /www\.|https?:|@|\.(?:co\.uk|org\.uk|gov\.uk|nhs\.uk|com|org|net|gov|uk)\b/i;
const NOT_A_NAME = [
  UK_POSTCODE,
  US_STATE_ZIP,
  STREET,
  STREET_NAME,
  FLAT,
  PO_BOX,
  DATE_IN_WORDS,
  DATE_IN_NUMBERS,
  MONEY,
  PAGE,
  STOP,
  WEB,
];

/** Words in a household's names that are not anybody's name. */
const NOT_NAMES = wordSet('the and family household house home');

/** Every word of three letters or more in the household's names. */
function peopleWords(people: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const name of people) {
    for (const w of words(fold(name))) {
      if (w.length >= 3 && !NOT_NAMES.has(w) && !/^\d+$/.test(w)) out.add(w);
    }
  }
  return out;
}

/**
 * Lines that cannot be an issuer however they score: the addressee block
 * (anyone in the household, or anyone with a title), addresses, dates,
 * amounts, page numbers, and the document's own headings.
 */
function rejected(segment: string, people: ReadonlySet<string>): boolean {
  if (segment.length < 3 || segment.length > 60) return true;
  const visible = segment.replace(/\s+/g, '');
  if (visible.replace(/\D+/g, '').length * 4 > visible.length) return true;
  if (!/\p{L}.*\p{L}/u.test(segment)) return true;
  if (HONORIFIC.test(segment)) return true;
  if (words(fold(segment)).some((w) => people.has(w))) return true;
  return NOT_A_NAME.some((re) => re.test(segment));
}

/**
 * Title Case or ALL CAPS, allowing "of" and "and": a letterhead, not a
 * sentence. "eBay" counts; "your energy account" does not.
 */
function looksLikeName(segment: string): boolean {
  let capitalised = false;
  for (const token of segment.split(' ')) {
    if (!/\p{L}/u.test(token) || CONNECTORS.has(token)) continue;
    if (!/^[^\p{L}]*(?:\p{Lu}|\p{Ll}{1,2}\p{Lu})/u.test(token)) return false;
    capitalised = true;
  }
  return capitalised;
}

/** Where a legal form sits in a line: the end of a registered name. */
const LEGAL_FORM_AT =
  /(?<=^|[\s,])(?:p\.?l\.?c|ltd|limited|llp|llc|inc|corp|corporation|gmbh|n\.a|s\.a)\.?(?![\p{L}\p{N}])/giu;
const LEGAL_FORM = /^(?:p\.?l\.?c|ltd|limited|llp|llc|inc|corp|corporation|gmbh|n\.a|s\.a)\.?$/iu;
/** Longer than the longest name a line may hold (60), so a cut word is never kept. */
const LEGAL_NAME_REACH = 100;
const OPENING = /^[(["'“‘]+/u;
const CLOSING = /[.,;:!?)\]"”’]$/u;

/**
 * Registered names in a line, legal form and all: "Barclays Bank UK PLC"
 * from "…Barclays Bank UK PLC. Authorised by the Prudential Regulation
 * Authority…", and "British Gas Services Limited" from "British Gas is a
 * trading name of British Gas Services Limited". Footers say who the
 * company really is, and say it on every page. The walk goes back from the
 * legal form over capitalised words, and stops at a lower-case word or the
 * end of an earlier sentence.
 */
function legalNames(segment: string): string[] {
  const out: string[] = [];
  for (const m of segment.matchAll(LEGAL_FORM_AT)) {
    // A name longer than a line may be is refused anyway, so the walk never
    // needs more than this much of what came before — and a long footer
    // full of legal forms costs no more than a short one.
    const at = m.index ?? 0;
    const tokens = segment
      .slice(Math.max(0, at - LEGAL_NAME_REACH), at)
      .replace(/[\s,]+$/, '')
      .split(' ');
    const run: string[] = [];
    for (let i = tokens.length - 1; i >= 0 && run.length < 8; i--) {
      const token = tokens[i] ?? '';
      const t = token.replace(OPENING, '');
      if (!t || CLOSING.test(t) || LEGAL_FORM.test(t)) break; // an earlier name ended here
      if (t === '&' || CONNECTORS.has(t)) run.unshift(t);
      else if (/^(?:\p{Lu}|\p{Ll}{1,2}\p{Lu})/u.test(t)) run.unshift(t);
      else break;
      if (t !== token) break; // "(Barclays": the name started at the bracket
    }
    while (run.length > 0 && (run[0] === '&' || CONNECTORS.has(run[0] ?? ''))) run.shift();
    if (run.length > 0) out.push(`${run.join(' ')} ${m[0]}`);
  }
  return out;
}

/** Domains whose registered name sits one label further in. */
const SECOND_LEVEL = wordSet(
  'co.uk org.uk gov.uk ac.uk nhs.uk ltd.uk plc.uk me.uk net.uk sch.uk police.uk mod.uk',
  'com.au net.au org.au gov.au co.nz org.nz co.za co.in com.sg',
);
/** Endings that make a bare "x.tld" a web address rather than an abbreviation. */
const TLDS = wordSet(
  'com org net uk us gov edu ie eu io info biz ca au nz de fr nl es it be ch in',
);
const DOMAIN = /^([^@]*@|https?:\/\/)?(www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=$|[/:?#.!])/;

/**
 * The names in the web and email addresses a document prints:
 * "www.barclays.co.uk" and "help@email.britishgas.co.uk" give "barclays"
 * and "britishgas". An issuer's address is the one spelling of its name
 * that OCR cannot mistake for anything else. Text is split into tokens
 * first, so no pattern ever runs over a long unbroken line.
 */
function domainLabels(text: string): Set<string> {
  const labels = new Set<string>();
  const tokens = fold(text)
    .toLowerCase()
    .split(/[\s<>()[\],;"'“”‘’]+/);
  for (const token of tokens) {
    if (token.length > 200 || !token.includes('.')) continue;
    const m = DOMAIN.exec(token);
    if (!m) continue;
    const parts = (m[3] ?? '').split('.');
    const tld = parts[parts.length - 1] ?? '';
    if (!m[1] && !m[2] && !TLDS.has(tld)) continue; // "e.g.", "St.James", "No.9740322"
    const cut = SECOND_LEVEL.has(parts.slice(-2).join('.')) ? 2 : 1;
    const rest = parts.slice(0, -cut).filter((p) => p !== 'www');
    // "www.nhs.uk": the name is the ending itself.
    const label = (rest[rest.length - 1] ?? (cut === 2 ? parts[0] : undefined))?.replace(/-/g, '');
    if (label && label.length >= 2) labels.add(label);
  }
  return labels;
}

/**
 * How many of a key's leading words, run together, make one of the
 * document's web addresses: 1 for "barclays bank uk" and barclays.co.uk,
 * 2 for "british gas services" and britishgas.co.uk, 0 when none do.
 */
function brandLength(key: string, labels: ReadonlySet<string>): number {
  const ws = key.split(' ');
  let joined = '';
  for (let k = 1; k <= ws.length; k++) {
    joined += ws[k - 1] ?? '';
    if (labels.has(joined)) return k;
  }
  return 0;
}

/**
 * A registered name cut down to the brand its web address uses: "Barclays
 * Bank UK" becomes "Barclays" when the page says barclays.co.uk, because
 * that is what the household calls it.
 */
function asBrand(
  key: string,
  value: string,
  labels: ReadonlySet<string>,
): { key: string; value: string } {
  const keyWords = key.split(' ').length;
  const k = brandLength(key, labels);
  if (k === 0 || k >= keyWords) return { key, value };
  const tokens = [...value.matchAll(/[\p{L}\p{N}]+/gu)];
  const skip = Math.max(0, tokens.length - keyWords); // a leading "The"
  const last = tokens[skip + k - 1];
  if (!last || last.index === undefined) return { key, value };
  const brand = cleanIssuer(value.slice(0, last.index + last[0].length));
  const brandKey = issuerKey(brand);
  return brandKey ? { key: brandKey, value: brand } : { key, value };
}

/** One sighting of a name on the page. */
interface Sighting {
  key: string;
  value: string;
  /** Read from capitals, so the case is ours, not the issuer's. */
  guessed: boolean;
  /** A registered name (S2), or a letterhead line (S3) with its score. */
  legal: boolean;
  score: number;
}

function sighting(
  raw: string,
  people: ReadonlySet<string>,
): Omit<Sighting, 'legal' | 'score'> | null {
  if (rejected(raw, people)) return null;
  const value = cleanIssuer(raw);
  const key = issuerKey(value);
  if (!key || !distinctive(key)) return null;
  return { key, value, guessed: isAllCaps(raw) };
}

/**
 * A letterhead line's score (S3): 2 for saying what kind of body it is, 2
 * for being in the first three lines, and 1 for being set as a name. Only
 * a line with both of the first two clears the bar on its own.
 */
function letterheadScore(key: string, line: number): number {
  return 1 + (hasPhrase(key, ORG_NOUNS) ? 2 : 0) + (line < TOP_LINES ? 2 : 0);
}

/**
 * A statement's own lines — a date first, or an amount last — name its
 * payees, not whoever sent it: "02 Sep SAINSBURYS SUPERMARKETS LTD 45.20"
 * four times over is the week's shopping, not four footers.
 */
const LEADING_DATE = new RegExp(
  `^\\W*(?:\\d{1,4}(?:st|nd|rd|th)?[\\s/.-]+(?:${MONTH}|\\d{1,2})\\b|${MONTH}\\.?\\s+\\d{1,2}\\b)`,
  'i',
);
const TRAILING_AMOUNT = /(?:\d\.\d{2}|[£$€¥]\s?\d[\d,]*)(?:\s?(?:cr|dr))?$/i;

function statementLine(line: string): boolean {
  return LEADING_DATE.test(line) || TRAILING_AMOUNT.test(line.trimEnd());
}

/** The addressee block runs from the name to the postcode, and never further than this. */
const ADDRESS_LINES = 5;

/** Every name the page offers, in reading order. */
function sightings(lines: readonly string[], people: ReadonlySet<string>): Sighting[] {
  const out: Sighting[] = [];
  // The addressee block's last line. A named house and its street — "The
  // Old School House", "College Road" — look just like a letterhead.
  let addressee = -1;
  lines.forEach((line, index) => {
    if (statementLine(line)) return;
    const inAddress = index <= addressee;
    if (inAddress && (UK_POSTCODE.test(line) || US_STATE_ZIP.test(line))) addressee = index;
    // OCR keeps columns on one line, several spaces apart.
    for (const part of line.split(/\t|\s{3,}|\s\|\s/)) {
      const segment = trimEdges(part.replace(/\s+/g, ' '));
      if (!segment) continue;
      if (HONORIFIC.test(segment) || words(fold(segment)).some((w) => people.has(w))) {
        addressee = Math.max(addressee, index + ADDRESS_LINES);
      }
      if (index < TOP_WINDOW && !inAddress && looksLikeName(segment)) {
        const s = sighting(segment, people);
        if (s) out.push({ ...s, legal: false, score: letterheadScore(s.key, index) });
      }
      for (const name of legalNames(segment)) {
        const s = sighting(name, people);
        if (s) out.push({ ...s, legal: true, score: 0 });
      }
    }
  });
  return out;
}

/** The sightings of one issuer, added up. */
interface Tally {
  key: string;
  value: string;
  guessed: boolean;
  /** Where on the page it was first seen, for breaking ties in reading order. */
  first: number;
  legal: number;
  letterhead: number;
}

function tallies(found: readonly Sighting[], labels: ReadonlySet<string>): Tally[] {
  const byKey = new Map<string, Tally>();
  for (const [first, s] of found.entries()) {
    const { key, value } = asBrand(s.key, s.value, labels);
    const t = byKey.get(key);
    if (!t) {
      byKey.set(key, {
        key,
        value,
        guessed: s.guessed,
        first,
        legal: s.legal ? 1 : 0,
        letterhead: s.legal ? 0 : s.score,
      });
      continue;
    }
    if (t.guessed && !s.guessed) {
      t.value = value; // the issuer's own capitals beat ours
      t.guessed = false;
    }
    if (s.legal) t.legal += 1;
    else t.letterhead = Math.max(t.letterhead, s.score);
  }
  return [...byKey.values()];
}

/**
 * S2 and S3 together: 3 for a registered name and 1 more for each time it
 * is repeated (footers repeat on every page), up to 3 more; plus the best
 * letterhead line.
 */
function pageScore(t: Tally): number {
  return (t.legal > 0 ? 3 + Math.min(t.legal - 1, 3) : 0) + t.letterhead;
}

/** A known issuer, once per key. */
interface Known {
  value: string;
  key: string;
  words: string[];
  count: number;
  typeKeys: Set<string>;
}

/** The household's issuers, one per key: the most used spelling wins. */
function distinctKnown(known: readonly KnownIssuer[]): Known[] {
  const byKey = new Map<string, Known>();
  for (const k of known) {
    const value = k.value.trim();
    const key = issuerKey(value);
    if (!key) continue;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { value, key, words: key.split(' '), count: k.count, typeKeys: new Set() });
    } else if (k.count > seen.count) {
      seen.value = value;
      seen.count = k.count;
    }
    for (const t of k.typeKeys ?? []) byKey.get(key)?.typeKeys.add(t);
  }
  return [...byKey.values()];
}

function startsWith(long: readonly string[], short: readonly string[]): boolean {
  return short.length <= long.length && short.every((w, i) => long[i] === w);
}

/**
 * The known issuer a name read off the page means, if any: one whose key
 * begins with the page's, or the page's with its — "Barclays Bank UK" is
 * the household's "Barclays", and "Aviva" is its "Aviva Insurance".
 */
function knownFor(key: string, known: readonly Known[]): Known | undefined {
  const ws = key.split(' ');
  let best: Known | undefined;
  for (const k of known) {
    if (k.key === key) return k;
    if (!startsWith(ws, k.words) && !startsWith(k.words, ws)) continue;
    if (!best || k.count > best.count || (k.count === best.count && k.value < best.value)) {
      best = k;
    }
  }
  return best;
}

/** Whether a sentence, a line or a column starts at `at`, give or take a quote or a bullet. */
function sentenceStart(text: string, at: number): boolean {
  for (let i = at - 1; i >= 0 && i >= at - 8; i -= 1) {
    const c = text.charAt(i);
    if (c === '\n' || c === '.' || c === '!' || c === '?' || c === ':') return true;
    if (!/[\s"'“‘(•*-]/u.test(c)) return false;
  }
  return true;
}

/** The word after a name, on the same line. */
const NEXT_WORD = /^[^\S\n]*([\p{L}\p{N}]+)/u;

/**
 * Whether a known issuer appears on the page as a name — capitalised, or as
 * the page's own web address — and not only as an ordinary word: "Next"
 * the shop is not in "your next payment". A sentence gives its first word
 * a capital whatever it is, so a one-word name there counts only when the
 * sentence does not simply go on: "Three things you need to know" and
 * "NEXT STEPS" are not from Three or Next; "Barclays, Aviva and…" and a
 * letterhead's "NEXT" are.
 */
function namedOnPage(text: string, k: Known, labels: ReadonlySet<string>): boolean {
  if (brandLength(k.key, labels) > 0) return true;
  const phrase = k.words.join('[^\\p{L}\\p{N}]+');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${phrase}(?![\\p{L}\\p{N}])`, 'giu');
  for (const m of text.matchAll(re)) {
    if (!/^\p{Lu}/u.test(m[0])) continue;
    const at = m.index ?? 0;
    if (k.words.length > 1 || !sentenceStart(text, at)) return true;
    const end = at + m[0].length;
    const next = NEXT_WORD.exec(text.slice(end, end + 40))?.[1];
    if (!next) return true;
    if (/^\p{Ll}/u.test(next) || (isAllCaps(m[0]) && isAllCaps(next))) continue;
    return true;
  }
  return false;
}

interface Scored {
  value: string;
  key: string;
  source: 'known' | 'page';
  score: number;
  count: number;
  first: number;
}

/** The place of an issuer found only by S1, after everything read off the page. */
const UNSEEN = Number.MAX_SAFE_INTEGER;

/**
 * Who might have issued a document, from its OCR text: at most three
 * suggestions, one per issuer, best first — or none, which is the usual
 * right answer for a page with no letterhead.
 *
 * - The household's own issuers found on the page (S1) come first, in the
 *   household's spelling: 10, plus 1 for each mention up to 5, plus 3 when
 *   the household has used it for this kind of document. Lines with an
 *   amount on them are not read for this — on a bank statement they are
 *   the payees, not the bank.
 * - Registered names anywhere (S2) and letterhead lines at the top (S3)
 *   are scored as above, and gain 2 when the page's web address agrees
 *   (S4); one that names a known issuer becomes that issuer.
 * - A name read off the page is offered only at 4 or more: a letterhead
 *   line needs a kind of body and a place in the first three lines, or a
 *   web address that agrees, or a registered name behind it.
 */
export function issuerCandidates(text: string, opts: IssuerOptions): IssuerCandidate[] {
  const body = text.slice(0, MAX_TEXT);
  const lines = body.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const people = peopleWords(opts.people);
  const labels = domainLabels(body);
  const known = distinctKnown(opts.known);
  const typeKey = opts.typeKey;

  // S1: the household's issuers, where the page names them.
  const readable = fold(lines.filter((l) => !MONEY.test(l)).join('\n'));
  const present = new Set(words(readable));
  const onPage = new Map<
    Known,
    { mentions: number; page: number; brand: boolean; first: number }
  >();
  const entry = (k: Known) => {
    const e = onPage.get(k) ?? { mentions: 0, page: 0, brand: false, first: UNSEEN };
    onPage.set(k, e);
    return e;
  };
  for (const k of known) {
    if (k.words.every((w) => people.has(w))) continue; // a person is never an issuer
    if (!k.words.every((w) => present.has(w))) continue;
    const match = matchText(readable, { groups: [[k.key]], exclude: [] });
    if (!match || !namedOnPage(readable, k, labels)) continue;
    entry(k).mentions = match.hits;
  }

  // S2–S4: what the page says of itself.
  const scored: Scored[] = [];
  for (const t of tallies(sightings(lines, people), labels)) {
    const brand = brandLength(t.key, labels) > 0;
    const k = knownFor(t.key, known);
    if (k) {
      const e = entry(k);
      e.page += pageScore(t);
      e.brand ||= brand;
      e.first = Math.min(e.first, t.first);
      continue;
    }
    const score = pageScore(t) + (brand ? 2 : 0);
    if (score >= OFFER_AT) {
      scored.push({ value: t.value, key: t.key, source: 'page', score, count: 0, first: t.first });
    }
  }
  for (const [k, e] of onPage) {
    const page = e.page + (e.brand || brandLength(k.key, labels) > 0 ? 2 : 0);
    if (e.mentions === 0 && page < OFFER_AT) continue;
    const s1 = e.mentions > 0 ? 10 + Math.min(e.mentions, 5) : 0;
    const boost = typeKey && k.typeKeys.has(typeKey) ? 3 : 0;
    const score = s1 + page + boost;
    scored.push({
      value: k.value,
      key: k.key,
      source: 'known',
      score,
      count: k.count,
      first: e.first,
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.source === b.source ? 0 : a.source === 'known' ? -1 : 1) ||
      b.count - a.count ||
      a.first - b.first ||
      compareText(a.value, b.value),
  );
  const seen = new Set<string>();
  const out: IssuerCandidate[] = [];
  for (const s of scored) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    out.push({ value: s.value, source: s.source });
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

/**
 * The household's issuers named in a file's name — "barclays_estatement_
 * 2026-09.pdf" is Barclays — for the moment before OCR has run. It only
 * ever recognises; a file name is too short to be read for new names.
 * Every word of the issuer must be there, so "gas-bill.pdf" is not
 * British Gas. Most used first, at most three.
 */
export function issuerFromFilename(
  filename: string,
  known: readonly KnownIssuer[],
): IssuerCandidate[] {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[^.\s]{1,8}$/, '');
  const found = new Set<string>();
  for (const m of fold(base).matchAll(/[\p{L}\p{N}]+/gu)) {
    found.add(m[0].toLowerCase());
    // "BritishGasBill", "barclays2026": camel case and digits split words too.
    for (const part of m[0].split(
      /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u,
    )) {
      found.add(part.toLowerCase());
    }
  }
  return distinctKnown(known)
    .filter((k) => k.words.every((w) => found.has(w)))
    .sort((a, b) => b.count - a.count || compareText(a.value, b.value))
    .slice(0, MAX_SUGGESTIONS)
    .map((k) => ({ value: k.value, source: 'file' as const }));
}

/**
 * The household's issuers in the order the chips show them: those used
 * with this kind of document first, most used first; then the rest, most
 * used first; then alphabetically. Ties keep their order.
 */
export function rankKnownIssuers(
  known: readonly KnownIssuer[],
  typeKey?: string | null,
): KnownIssuer[] {
  const usedFor = (k: KnownIssuer) => (typeKey && k.typeKeys?.includes(typeKey) ? 0 : 1);
  return known
    .map((k, i) => ({ k, i, group: usedFor(k) }))
    .sort(
      (a, b) =>
        a.group - b.group ||
        b.k.count - a.k.count ||
        compareText(a.k.value, b.k.value) ||
        a.i - b.i,
    )
    .map(({ k }) => k);
}
