/**
 * What a document's pages say about it (5.37): its kind, whose it is, when
 * it was issued and when it runs out, its number and who issued it — each
 * proposed with a confidence from 0 to 1 and the cue it came from, and
 * never filled in. A person taps a proposal before anything is kept (A44).
 *
 * The rules lean towards silence. The classification spike (2.6) was right
 * on only four in ten documents it had not been written for, and confidently
 * wrong on none, because of two rules this keeps:
 *
 * - **No cue, no answer.** A kind with no words of its own on the page, a
 *   date with no label saying what it is, a name with nothing saying it is
 *   the holder's: nothing is proposed.
 * - **No date without a confident kind.** Dates and numbers are read only
 *   for a kind the document already has, or one proposed above its bar —
 *   and then only the dates that kind keeps.
 *
 * Anything below its field's threshold (`PROPOSAL_THRESHOLDS`) is left
 * out, and so is every field the document already has a value for.
 *
 * Pure and deterministic — no clock, no locale, no I/O — and fed only by
 * its context: the household's kinds, the family's names and the issuers
 * the household has used. So the server proposes from a filed document's
 * text, and a later reader (Phase 6's inbox, a phone that read the page
 * itself) proposes from any text, the same way. English only (A46).
 */
import type { CoreField, DateValue, DocumentTypeView } from './documents.js';
import { scoredIssuers, type KnownIssuer } from './issuers.js';

/** The fields a document's pages can propose, by the document's own names for them. */
export const PROPOSAL_FIELDS = [
  'type_key',
  'owner_member_id',
  'issued',
  'expires',
  'identifier',
  'issued_by',
] as const;
export type ProposalField = (typeof PROPOSAL_FIELDS)[number];

/**
 * Where a proposal came from: a short reason, never the page's own words,
 * so a proposal can be shown, logged or kept without carrying the text.
 */
export const PROPOSAL_CUES = [
  'kind_words',
  'machine_lines',
  'name_labelled',
  'name_on_page',
  'issue_label',
  'expiry_label',
  'due_label',
  'period_start',
  'period_end',
  'number_label',
  'known_issuer',
  'letterhead',
  'issuing_body',
] as const;
export type ProposalCue = (typeof PROPOSAL_CUES)[number];

/** Each cue in words, for the mark beside a proposal ("suggested · 92%"). */
export const CUE_WORDS: Readonly<Record<ProposalCue, string>> = {
  kind_words: 'The words this kind of document carries',
  machine_lines: 'The machine-readable lines, with their check digits right',
  name_labelled: 'A name in the family, where the page names its holder',
  name_on_page: "A family member's full name on the page",
  issue_label: 'A date the page calls its issue date',
  expiry_label: 'A date the page calls its expiry date',
  due_label: 'A date the page says payment is due',
  period_start: 'The first day of the period the page covers',
  period_end: 'The last day of the period the page covers',
  number_label: 'A number the page labels as this kind’s number',
  known_issuer: 'One of your issuers, named on the page',
  letterhead: 'The name the page gives itself',
  issuing_body: 'The body that issues this kind of document, named on the page',
};

/** One proposal: the value, how sure, and why. */
export interface Proposed<T> {
  value: T;
  /** From 0 to 1, rounded to hundredths; never below the field's threshold. */
  confidence: number;
  cue: ProposalCue;
}

/** What the pages propose: only the fields above their threshold, and only empty ones. */
export interface DetailProposal {
  type_key?: Proposed<string>;
  owner_member_id?: Proposed<string>;
  issued?: Proposed<DateValue>;
  expires?: Proposed<DateValue>;
  identifier?: Proposed<string>;
  issued_by?: Proposed<string>;
}

/** Below these, nothing is proposed for the field. */
export const PROPOSAL_THRESHOLDS: Readonly<Record<ProposalField, number>> = {
  type_key: 0.75,
  owner_member_id: 0.75,
  issued: 0.7,
  expires: 0.7,
  identifier: 0.75,
  issued_by: 0.7,
};

/**
 * The spike's bar for a kind (2.6): its cues score 5 or more, and 2 more
 * than the next kind's. A kind under it is not proposed, and no date or
 * number is read for it.
 */
export const KIND_MIN_SCORE = 5;
export const KIND_MIN_LEAD = 2;

/** A kind of document as the household keeps it: GET /document-types' view, or enough of it. */
export type ProposalKind = Pick<DocumentTypeView, 'key' | 'label' | 'fields' | 'expiry_driver'> &
  Partial<Pick<DocumentTypeView, 'short_label' | 'hidden' | 'core'>>;

/** Somebody in the family, by the name the household knows them by. */
export interface ProposalPerson {
  id: string;
  name: string;
}

/** What a document already holds: a field with a value here is never proposed. */
export interface CurrentDetails {
  type_key?: string | null | undefined;
  owner_member_id?: string | null | undefined;
  issued?: DateValue | null | undefined;
  expires?: DateValue | null | undefined;
  identifier?: string | null | undefined;
  issued_by?: string | null | undefined;
}

export interface ProposalContext {
  /** The household's kinds; a hidden one is never proposed. */
  types: readonly ProposalKind[];
  /** The family, never a guest: whose a document is, matched by name. */
  people: readonly ProposalPerson[];
  /** The issuers the household has used (GET /issuers). */
  issuers?: readonly KnownIssuer[] | undefined;
  /** The household's own name: never an issuer, never a person. */
  household?: string | null | undefined;
  /** What the document already holds; its kind, if any, is the kind dates are read for. */
  current?: CurrentDetails | undefined;
  /**
   * How a date written in numbers with both parts 12 or under is read:
   * 03/04/2031 is 3 April ('dmy') or March 4 ('mdy'). Unsaid, such a date
   * is not read at all.
   */
  dateOrder?: 'dmy' | 'mdy' | undefined;
}

/** Text beyond this is the small print of a long document; the details are on its first pages. */
const MAX_TEXT = 60_000;

const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;

/**
 * The page's text with one character for each of the text's, so a place in
 * one is the same place in the other: ASCII letters in lower case, curly
 * quotes straight, tabs and no-break spaces as spaces.
 */
function fold(text: string): string {
  return text
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/[\u2019\u2018`\u00b4]/g, "'")
    .replace(/[\t\u00a0]/g, ' ');
}

/** A rule shown unless the kind says otherwise, as the card shows it. */
function shows(kind: ProposalKind, field: CoreField): boolean {
  return kind.core?.[field]?.shown !== false;
}

/** Whether a kind keeps an expiry: it is driven by one, and shows it. */
function expires(kind: ProposalKind): boolean {
  return kind.expiry_driver !== null && shows(kind, 'expires');
}

// ------------------------------------------------------------------ kinds

type Cue = readonly [weight: number, re: RegExp];

/**
 * The words each of the vault's own kinds carries, UK and US. Weight 3 is
 * "almost nothing else says this", 2 "strong", 1 "suggestive"; each cue
 * counts once however often it is said. Written for the wording of the
 * documents themselves — including the spike's misses: "driving licence"
 * as well as "driver's license", a council tax demand notice, a tenancy
 * agreement, a vaccination certificate, a guarantee.
 */
const KIND_CUES: Readonly<Record<string, readonly Cue[]>> = {
  passport: [
    [3, /\bpassport\b/],
    [2, /\bnationality\b/],
    [2, /place of birth/],
    [1, /\bsurname\b|given names?/],
    [1, /\bauthority\b|department of state|passport office/],
  ],
  drivers_licence: [
    [3, /\bdriv(?:ing|er'?s?)\s+licen[cs]e\b/],
    [
      3,
      /\bdvla\b|department of motor vehicles|\bdmv\b|motor vehicles? (?:commission|division|administration)|driver services/,
    ],
    [2, /\bendorsements?\b/],
    [2, /\brestrictions?\b|\brstr\b/],
    [2, /\b4a\b[\s\S]{0,120}\b4b\b/],
    [1, /\bclass\b|\bcategor(?:y|ies)\b/],
    [1, /\bdl\b|\bdln\b|organ donor/],
  ],
  vehicle_registration: [
    [
      3,
      /vehicle registration|certificate of (?:title|registration)|registration certificate|\bv5c?\b|log ?book|vehicle title/,
    ],
    [
      3,
      /registration (?:mark|number|no\b)|licen[cs]e plate|plate (?:number|no\b)|registered keeper/,
    ],
    [2, /\bvin\b|vehicle identification number|\bchassis\b/],
    [1, /\bmake\b|\bmodel\b|\bcolou?r\b|body type|\bfuel\b/],
  ],
  insurance_policy: [
    [
      3,
      /\binsurance\b[^\n]{0,30}\b(?:policy|certificate|schedule)\b|certificate of (?:motor )?insurance|schedule of cover|policy schedule|declarations? page/,
    ],
    [2, /policy (?:number|no\b|period|ref)|period of (?:cover|insurance)|policy term/],
    [2, /\bpremium\b|\bdeductible\b|\bexcess\b/],
    [1, /\bcover(?:age)?\b|\binsured\b|\bpolicyholder\b|\binsurer\b|underwritten/],
  ],
  utility_bill: [
    [
      3,
      /amount due|payment due|total due|balance due|amount to pay|total to pay|please pay|council tax (?:bill|demand)|demand notice/,
    ],
    [
      2,
      /billing period|bill(?:ing)? date|meter reading|\bkwh\b|units used|standing charge|\btariff\b|instal?ments?/,
    ],
    [2, /account (?:number|no\b)|customer (?:number|reference)|reference number/],
    [
      1,
      /\belectric(?:ity)?\b|\bgas\b|\bwater\b|broadband|\benergy\b|council tax|\bsewer|\butility\b/,
    ],
  ],
  bank_statement: [
    [
      3,
      /(?:bank|account|monthly|checking|current account|savings) statement|statement of account|your statement|(?:checking|savings) summary/,
    ],
    [
      2,
      /opening balance|closing balance|balance brought forward|balance carried forward|beginning balance|ending balance/,
    ],
    [2, /money in|money out|paid in|paid out|\bdeposits\b|\bwithdrawals\b/],
    [1, /sort code|routing number|statement period|interest (?:paid|earned)|\boverdraft\b/],
  ],
  loan: [
    [
      3,
      /mortgage statement|loan statement|mortgage offer|loan agreement|mortgage account|credit agreement/,
    ],
    [
      3,
      /principal balance|outstanding balance|original principal|amount borrowed|loan amount|outstanding principal/,
    ],
    [2, /interest rate|maturity date|\bapr\b|monthly payment|term of (?:the )?loan/],
    [1, /\blender\b|\bescrow\b|\bborrower\b|loan (?:number|account)/],
  ],
  birth_certificate: [
    [3, /certificate of (?:live )?birth|birth certificate|entry of birth|birth registration/],
    [2, /name of child|\bregistrar\b|registration district|\binformant\b/],
    [2, /vital (?:records|statistics)|general register office|department of health/],
    [1, /place of birth|date of birth|\bmother\b|\bfather\b/],
  ],
  marriage_certificate: [
    [
      3,
      /certificate of marriage|marriage certificate|marriage licen[cs]e|entry of marriage|decree absolute|certificate of divorce|civil partnership/,
    ],
    [3, /\bbride\b|\bgroom\b|condition at time of marriage|\bspouses?\b/],
    [2, /date of marriage|\bsolemni[sz]ed\b|place of marriage/],
    [1, /\bofficiant\b|\bwitness(?:es)?\b/],
  ],
  tax_return: [
    [3, /income tax return|form 1040|\b1040\b|self assessment|\bsa100\b|tax return/],
    [2, /adjusted gross income|total tax|taxable income|\bhmrc\b|internal revenue service/],
    [1, /filing status|tax year|unique taxpayer reference|\butr\b/],
  ],
  tax_form: [
    [
      3,
      /wage and tax statement|form w-?2\b|\bw-2\b|\b1099\b|\bp60\b|\bp45\b|\bp11d\b|end of year certificate/,
    ],
    [
      2,
      /federal income tax withheld|social security wages|pay and income tax details|tax deducted|national insurance contributions/,
    ],
    [1, /\bemployer\b|\bein\b|\bpaye\b|tax code/],
  ],
  prescription: [
    [3, /\bprescription\b|\brx\b|\bfp10\b/],
    [2, /\brefills?\b|take (?:one|two|1|2|a) (?:tablet|capsule)|by mouth|times a day/],
    [2, /\bprescriber\b|\bpharmacy\b|\bnpi\b|\bdispens/],
    [1, /\bpatient\b|\bmg\b|\bdose\b|\bqty\b|\bquantity\b/],
  ],
  medical_record: [
    [
      3,
      /immuni[sz]ation|vaccination (?:record|certificate|history)|certificate of vaccination|discharge summary|medical record|clinic letter|childhood vaccin/,
    ],
    [2, /\bmmr\b|\bdtap\b|\btdap\b|\bbooster\b|\bvaccines?\b|\bhpv\b|\bmenacwy\b/],
    [2, /nhs number|\bgp\b|\bsurgery\b|\bhospital\b|\bclinic\b|\bconsultant\b|medical practice/],
    [1, /\bpatient\b|\bprovider\b|\bdiagnosis\b|date of service/],
  ],
  employment_contract: [
    [
      3,
      /offer of employment|employment (?:contract|agreement)|contract of employment|statement of (?:main )?terms|terms and conditions of employment|offer letter/,
    ],
    [
      2,
      /annual salary|\bsalary\b|notice period|probation(?:ary)? period|hours of work|holiday entitlement/,
    ],
    [2, /at[- ]will/],
    [1, /\bposition\b|job title|reporting to|\bemployer\b|\bemployee\b/],
  ],
  property_deed: [
    [
      3,
      /warranty deed|quitclaim deed|\bthis deed\b|title deed|tenancy agreement|lease agreement|assured shorthold|rental agreement|deed of transfer/,
    ],
    [3, /\bgrantor\b|\bgrantee\b|\blandlord\b|\btenants?\b|\blessor\b|\blessee\b/],
    [2, /\bconsideration\b|land registry|title number|\brent\b|\bdeposit\b/],
    [1, /\beasements?\b|\bpremises\b|the property|\btenancy\b/],
  ],
  will: [
    [
      3,
      /last will and testament|lasting power of attorney|power of attorney|declaration of trust|living trust/,
    ],
    [3, /\bexecutors?\b|\btestat(?:or|rix)\b/],
    [2, /residue of my estate|per stirpes|\bbeneficiar(?:y|ies)\b|\bbequeath\b/],
    [1, /revoke all (?:former|previous|earlier) wills|\bguardians?\b|\battorneys?\b/],
  ],
  diploma: [
    [
      3,
      /bachelor of|master of|doctor of|\bdiploma\b|degree of|\btranscript\b|certificate of (?:achievement|completion)|\bgcse\b/,
    ],
    [
      2,
      /is awarded|has been awarded|\bconferred\b|admitted to the degree|has completed|with honou?rs/,
    ],
    [2, /\buniversity\b|\bcollege\b|school of|examinations? board|awarding body/],
    [1, /course of study|\bgrade\b|\bgpa\b|\bcredits\b/],
  ],
  visa: [
    [
      3,
      /residence permit|\bvisa\b|biometric residence|permanent resident|green card|leave to remain|work permit|employment authori[sz]ation/,
    ],
    [2, /valid (?:until|from)|type of permit|\bremarks\b|category of leave|\bentries\b/],
    [2, /\bsponsor\b|work permitted|no work|no recourse to public funds|\bnrpf\b/],
    [1, /\bconditions?\b|\bimmigration\b/],
  ],
  warranty: [
    [3, /\bwarranty\b|\bguarantee\b/],
    [2, /proof of purchase|purchase (?:price|date)|date of purchase|retain this|keep this receipt/],
    [2, /\bmodel\b|\bserial\b/],
    [1, /\bpurchased\b|\bretailer\b|\bproduct\b/],
  ],
  national_id: [
    [
      3,
      /national insurance (?:number|card)|social security (?:card|number|administration)|identity card|national identity|\bid card\b/,
    ],
    [1, /date of birth|\bsex\b/],
  ],
};

/** Words in a field's or kind's name that say nothing of it. */
const PLAIN_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'number', 'no', 'date', 'name']);

/** A phrase as a whole-words pattern over the folded text, or null for one too plain to look for. */
function phrase(name: string | null | undefined): RegExp | null {
  const words = fold(name ?? '')
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 0);
  if (words.length === 0 || words.every((w) => PLAIN_WORDS.has(w) || w.length < 3)) return null;
  const body = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join("[\\s'/-]+");
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`);
}

/**
 * A kind of the household's own: its name says what it is (3), and its
 * fields' names on the page say a little more (1 each, up to 2). So a kind
 * is proposed only where its own name and two of its fields are there.
 */
function ownCues(kind: ProposalKind): Cue[] {
  const cues: Cue[] = [];
  const names = [phrase(kind.label), phrase(kind.short_label)].filter((r): r is RegExp => !!r);
  if (names.length > 0) {
    cues.push([3, new RegExp(names.map((r) => r.source).join('|'))]);
  }
  for (const f of kind.fields.slice(0, 12)) {
    const re = phrase(f.label);
    if (re) cues.push([1, re]);
  }
  return cues;
}

interface KindScore {
  kind: ProposalKind;
  score: number;
  mrz: boolean;
}

function scoreKinds(hay: string, types: readonly ProposalKind[], mrz: Mrz | null): KindScore[] {
  const out: KindScore[] = [];
  for (const kind of types) {
    if (kind.hidden) continue;
    const own = KIND_CUES[kind.key];
    let score = 0;
    if (own) {
      for (const [weight, re] of own) if (re.test(hay)) score += weight;
    } else {
      let fields = 0;
      for (const [weight, re] of ownCues(kind)) {
        if (!re.test(hay)) continue;
        if (weight === 1) {
          if (fields === 2) continue;
          fields += 1;
        }
        score += weight;
      }
    }
    // A passport's machine-readable lines, their check digits right.
    const fromMrz = kind.key === 'passport' && mrz !== null;
    if (fromMrz) score += 4;
    out.push({ kind, score, mrz: fromMrz });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------- machine lines

/** A passport's machine-readable zone (ICAO 9303, TD3): what its check digits vouch for. */
interface Mrz {
  number: string | null;
  expires: DateValue | null;
  surname: string;
  given: string[];
}

function mrzValue(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 90) return code - 55;
  return 0;
}

function checkDigit(s: string): number {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i += 1) sum += mrzValue(s.charAt(i)) * (weights[i % 3] as number);
  return sum % 10;
}

/** YYMMDD as a day, in this century: an expiry is never last century's. */
function mrzDate(s: string): DateValue | null {
  if (!/^\d{6}$/.test(s)) return null;
  return dayValue(2000 + Number(s.slice(0, 2)), Number(s.slice(2, 4)), Number(s.slice(4, 6)));
}

function readMrz(body: string): Mrz | null {
  const lines = body
    .split('\n')
    .map((l) => l.toUpperCase().replace(/\s+/g, '').replace(/[«‹]/g, '<'))
    .filter((l) => l.length > 0);
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const top = lines[i] as string;
    const bottom = lines[i + 1] as string;
    if (!/^P[A-Z<][A-Z<]{3}[A-Z<]{30,41}$/.test(top)) continue;
    if (!/^[A-Z0-9<]{9}\d[A-Z<]{3}\d{6}\d[MFX<]\d{6}\d/.test(bottom)) continue;
    const num = bottom.slice(0, 9);
    const exp = bottom.slice(21, 27);
    const numberRight = checkDigit(num) === Number(bottom.charAt(9));
    const expiryRight = checkDigit(exp) === Number(bottom.charAt(27));
    if (!numberRight && !expiryRight) continue;
    const [surname = '', given = ''] = top.slice(5).split('<<');
    return {
      number: numberRight ? num.replace(/</g, '') || null : null,
      expires: expiryRight ? mrzDate(exp) : null,
      surname: surname.replace(/</g, ' ').trim(),
      given: given.split('<').filter((w) => w.length > 0),
    };
  }
  return null;
}

// ----------------------------------------------------------------- dates

const MONTH =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dayValue(y: number, m: number, d: number): DateValue | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  return { date: iso(y, m, d), precision: 'day' };
}

function monthValue(y: number, m: number): DateValue | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12) return null;
  return { date: iso(y, m, daysIn(y, m)), precision: 'month' };
}

const monthOf = (name: string | undefined) => MONTHS[(name ?? '').slice(0, 3)] ?? 0;
/** A two-digit year after a day and a month's name ("02 JUN 19"): this century's up to 69. */
const fullYear = (y: string) =>
  y.length === 2 ? (Number(y) < 70 ? 2000 : 1900) + Number(y) : Number(y);

interface FoundDate {
  at: number;
  end: number;
  value: DateValue;
  line: number;
}

/**
 * Every date written out in the text, where it is. Days first — "14 Mar
 * 2031", "14-Mar-2031", "March 14, 2031", "2031-03-14", "14/03/2031" —
 * then months alone ("March 2031", "03/2031") where no day was found. A
 * date in numbers whose order cannot be told (03/04/2031) is read in the
 * order the document's other dates are written in; failing that, the
 * household's; and not at all when neither says.
 */
function findDates(hay: string, order: 'dmy' | 'mdy' | undefined): FoundDate[] {
  const found: Array<Omit<FoundDate, 'line'>> = [];
  const taken = (at: number, end: number) => found.some((f) => at < f.end && end > f.at);
  const add = (at: number, end: number, value: DateValue | null) => {
    if (value && !taken(at, end)) found.push({ at, end, value });
  };
  const each = (re: RegExp, make: (m: RegExpMatchArray) => DateValue | null) => {
    for (const m of hay.matchAll(re)) {
      const at = m.index ?? 0;
      add(at, at + m[0].length, make(m));
    }
  };
  each(
    new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?[ .\\-/]*${MONTH}\\b\\.?(?: ?/ ?[a-zé]{3,9}\\.?)?[ .\\-/,]*(\\d{4}|\\d{2})\\b`,
      'g',
    ),
    (m) => dayValue(fullYear(m[3] as string), monthOf(m[2]), Number(m[1])),
  );
  each(new RegExp(`\\b${MONTH}\\b\\.? ?(\\d{1,2})(?:st|nd|rd|th)?,? +(\\d{4})\\b`, 'g'), (m) =>
    dayValue(Number(m[3]), monthOf(m[1]), Number(m[2])),
  );
  each(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => dayValue(Number(m[1]), Number(m[2]), Number(m[3])));
  const numeric = /\b(\d{1,2})([/.-])(\d{1,2})\2(\d{4})\b/g;
  // The document's own dates say which order it writes them in: 25/12 is
  // day first, 12/25 month first, and a dotted date is day first.
  let dayFirst = 0;
  let monthFirst = 0;
  for (const m of hay.matchAll(numeric)) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    if (a > 12 && b <= 12) dayFirst += 1;
    else if (b > 12 && a <= 12) monthFirst += 1;
    else if (m[2] === '.') dayFirst += 1;
  }
  const own =
    dayFirst > 0 && monthFirst === 0
      ? 'dmy'
      : monthFirst > 0 && dayFirst === 0
        ? 'mdy'
        : dayFirst === 0 && monthFirst === 0
          ? order
          : undefined;
  each(numeric, (m) => {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const y = Number(m[4]);
    if (a > 12 || a === b) return dayValue(y, b, a);
    if (b > 12) return dayValue(y, a, b);
    if (own === 'dmy') return dayValue(y, b, a);
    if (own === 'mdy') return dayValue(y, a, b);
    return null;
  });
  each(new RegExp(`\\b${MONTH}\\b\\.?,? +(\\d{4})\\b`, 'g'), (m) =>
    monthValue(Number(m[2]), monthOf(m[1])),
  );
  each(/(?<![\d/.-])(\d{1,2})\/(\d{4})\b/g, (m) => monthValue(Number(m[2]), Number(m[1])));
  const lineAt = lineIndex(hay);
  return found.sort((a, b) => a.at - b.at).map((f) => ({ ...f, line: lineAt(f.at) }));
}

/** The line a place in the text is on, counted from 0. */
function lineIndex(text: string): (at: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

type DateRole = 'issued' | 'expires' | 'none';

interface LabelSpec {
  role: DateRole;
  weight: number;
  cue: ProposalCue;
  re: RegExp;
}

/**
 * What a date is, by the label before it. A date of birth, of death or of
 * marriage, or the day a page was printed, is never a document's date: its
 * label stops a stronger one further back from claiming it.
 */
const BLOCKING: LabelSpec = {
  role: 'none',
  weight: 0,
  cue: 'issue_label',
  re: /date of (?:birth|death|marriage|registration)|birth ?date|\bdob\b|\bd\.o\.b\b|\bborn\b|printed on|generated on|statement period|billing period|\bperiod\b|\bpaid\b|\btransactions?\b/g,
};

const GENERIC_LABELS: readonly LabelSpec[] = [
  BLOCKING,
  {
    role: 'issued',
    weight: 4,
    cue: 'issue_label',
    re: /date of issue|issue date|date issued|issued on|\bissued\b|date of grant/g,
  },
  {
    role: 'issued',
    weight: 3,
    cue: 'issue_label',
    re: /^ *(?:date *:|dated\b)/gm,
  },
  {
    role: 'expires',
    weight: 4,
    cue: 'expiry_label',
    re: /date of expir(?:y|ation)|expir(?:y|ation) date|expires on|\bexpires\b|\bexpiry\b|\bexpiration\b|valid until|valid to\b|valid thru|valid through|\bexp\b/g,
  },
];

const label = (role: DateRole, weight: number, cue: ProposalCue, re: RegExp): LabelSpec => ({
  role,
  weight,
  cue,
  re: new RegExp(re.source, 'g'),
});

/** The labels a kind of document gives its own dates, besides everybody's. */
const KIND_LABELS: Readonly<Record<string, readonly LabelSpec[]>> = {
  drivers_licence: [
    label('issued', 4, 'issue_label', /\biss\b|\b4a\b/),
    label('expires', 4, 'expiry_label', /\b4b\b/),
  ],
  insurance_policy: [
    label(
      'issued',
      3,
      'issue_label',
      /start date|effective (?:date|from)|inception date|commencement date|cover (?:starts?|from)/,
    ),
    label('expires', 3, 'expiry_label', /end date|renewal date|cover ends?/),
  ],
  utility_bill: [
    label(
      'issued',
      3,
      'issue_label',
      /bill date|date of (?:this )?bill|invoice date|statement date|bill issued/,
    ),
    label(
      'expires',
      3,
      'due_label',
      /payment due|due date|due by|due on|pay by|payable by|please pay|amount due by|instal?ments?/,
    ),
  ],
  bank_statement: [label('issued', 3, 'issue_label', /statement date|date of statement/)],
  loan: [
    label('issued', 3, 'issue_label', /agreement date|date of (?:loan|agreement|offer)|loan date/),
    label('expires', 3, 'expiry_label', /maturity date|final payment|term ends/),
  ],
  prescription: [
    label('issued', 3, 'issue_label', /date (?:written|prescribed|filled)|prescribed on|filled on/),
    label('expires', 3, 'expiry_label', /do not use after|use by|discard after/),
  ],
  warranty: [
    label(
      'issued',
      3,
      'issue_label',
      /date of purchase|purchase date|purchased on|date purchased|receipt date/,
    ),
    label('expires', 4, 'expiry_label', /(?:warranty|guarantee) (?:expires|ends|end date|until)/),
  ],
  visa: [label('issued', 3, 'issue_label', /valid from|start date/)],
  employment_contract: [
    label('issued', 3, 'issue_label', /start date|commencement date|date of commencement/),
    label('expires', 3, 'expiry_label', /end date|fixed term (?:ends|until)/),
  ],
  property_deed: [
    label(
      'issued',
      3,
      'issue_label',
      /start date|commencement date|term (?:starts|commences|begins)|(?:beginning|commencing|starting) on/,
    ),
    label('expires', 3, 'expiry_label', /end date|term ends|expiry of the term|ending on/),
  ],
};

/** Kinds whose "from … to …" is the document's own life: its start issued, its end expiring. */
const PERIOD_KINDS = new Set([
  'insurance_policy',
  'property_deed',
  'employment_contract',
  'warranty',
  'visa',
]);

interface LabelHit {
  at: number;
  end: number;
  line: number;
  spec: LabelSpec;
}

function labelsFor(kind: ProposalKind): LabelSpec[] {
  const specs = [...GENERIC_LABELS, ...(KIND_LABELS[kind.key] ?? [])];
  // The kind's own words for its dates ("Start date", "Review by").
  for (const [field, role] of [
    ['issued', 'issued'],
    ['expires', 'expires'],
  ] as const) {
    const re = phrase(kind.core?.[field]?.label);
    if (re) specs.push(label(role, 3, role === 'issued' ? 'issue_label' : 'expiry_label', re));
  }
  return specs;
}

function findLabels(hay: string, specs: readonly LabelSpec[], lineAt: (at: number) => number) {
  const hits: LabelHit[] = [];
  for (const spec of specs) {
    for (const m of hay.matchAll(spec.re)) {
      const at = m.index ?? 0;
      hits.push({ at, end: at + m[0].length, line: lineAt(at), spec });
    }
  }
  // Longest first where two start together ("expiry date" over "expiry").
  return hits.sort((a, b) => a.at - b.at || b.end - a.end);
}

interface DateClaim {
  value: DateValue;
  weight: number;
  cue: ProposalCue;
}

/**
 * Each date's role, by its label: the label nearest before it on its own
 * line or the line above, with no other date between them — or, where a
 * line of labels sits over a line of as many dates and nothing else, the
 * label above it in the same place. "From … to …" gives a period kind its
 * start and its end.
 */
function claimDates(
  hay: string,
  kind: ProposalKind,
  order: 'dmy' | 'mdy' | undefined,
): { issued: DateClaim[]; expires: DateClaim[] } {
  const dates = findDates(hay, order);
  const lineAt = lineIndex(hay);
  const labels = findLabels(hay, labelsFor(kind), lineAt);
  const role = new Map<FoundDate, LabelSpec>();

  // A line of labels over a line of dates, as an ID card sets them out.
  const byLine = new Map<number, LabelHit[]>();
  for (const l of labels) {
    const on = byLine.get(l.line) ?? [];
    // One label for each place: a shorter one inside a longer is the same.
    if (!on.some((o) => l.at < o.end && l.end > o.at)) on.push(l);
    byLine.set(l.line, on);
  }
  const datesOn = (line: number) => dates.filter((d) => d.line === line);
  for (const [line, on] of byLine) {
    if (on.length < 2) continue;
    const below = datesOn(line + 1);
    if (below.length === on.length && !byLine.has(line + 1)) {
      below.forEach((d, i) => role.set(d, (on[i] as LabelHit).spec));
    }
  }

  // "From … to …": the start and the end of what the page covers.
  const ranged = new Set<FoundDate>();
  const period: Array<[FoundDate, FoundDate]> = [];
  for (let i = 0; i + 1 < dates.length; i += 1) {
    const a = dates[i] as FoundDate;
    const b = dates[i + 1] as FoundDate;
    if (!/^ *(?:-|–|—|to|until|till|through|thru|and) *$/.test(hay.slice(a.end, b.at))) continue;
    ranged.add(a);
    ranged.add(b);
    period.push([a, b]);
  }

  const issued: DateClaim[] = [];
  const expiring: DateClaim[] = [];
  const claim = (d: FoundDate, spec: LabelSpec) => {
    if (spec.role === 'issued') issued.push({ value: d.value, weight: spec.weight, cue: spec.cue });
    if (spec.role === 'expires') {
      expiring.push({ value: d.value, weight: spec.weight, cue: spec.cue });
    }
  };
  // Labels and dates both in order: each date looks back over a window.
  let from = 0;
  for (const [i, d] of dates.entries()) {
    while (from < labels.length && (labels[from] as LabelHit).at < d.at - 200) from += 1;
    if (ranged.has(d)) continue;
    const set = role.get(d);
    if (set) {
      claim(d, set);
      continue;
    }
    const previous = dates[i - 1];
    let nearest: LabelHit | null = null;
    for (let j = from; j < labels.length; j += 1) {
      const l = labels[j] as LabelHit;
      if (l.at >= d.at) break;
      if (l.end > d.at || d.line - l.line > 1 || d.at - l.end > 80) continue;
      // Another date between the label and this one is the label's.
      if (previous && previous.at >= l.end) continue;
      if (!nearest || l.end > nearest.end || (l.end === nearest.end && l.at < nearest.at)) {
        nearest = l;
      }
    }
    if (nearest) claim(d, nearest.spec);
  }
  if (PERIOD_KINDS.has(kind.key)) {
    for (const [a, b] of period) {
      if (a.value.date >= b.value.date) continue;
      issued.push({ value: a.value, weight: 3, cue: 'period_start' });
      expiring.push({ value: b.value, weight: 3, cue: 'period_end' });
    }
  }
  return { issued, expires: expiring };
}

const DATE_CONFIDENCE: Readonly<Record<number, number>> = { 4: 0.9, 3: 0.82, 2: 0.72 };

/**
 * The best-labelled date of those claimed: when equally well-labelled
 * dates differ, the latest expiry or the earliest issue, less sure.
 */
function bestDate(claims: DateClaim[], latest: boolean): Proposed<DateValue> | null {
  if (claims.length === 0) return null;
  const top = Math.max(...claims.map((c) => c.weight));
  const best = claims.filter((c) => c.weight === top);
  const values = [...new Set(best.map((c) => c.value.date))].sort();
  const pick = latest ? values[values.length - 1] : values[0];
  const chosen = best.find((c) => c.value.date === pick) as DateClaim;
  const base = DATE_CONFIDENCE[top] ?? 0;
  return {
    value: chosen.value,
    confidence: values.length > 1 ? base - 0.1 : base,
    cue: chosen.cue,
  };
}

// ---------------------------------------------------------------- numbers

/** The label each kind gives its own number. */
const NUMBER_LABELS: Readonly<Record<string, RegExp>> = {
  passport: /passport (?:no|number|n[o°º])\b\.?|document (?:no|number)\b\.?/g,
  drivers_licence:
    /licen[cs]e (?:no|number|#)\.?|driver licen[cs]e (?:no|number)|\bdl(?: no\.?| #|#)?(?= )|\bdln\b|(?:^|\n) *5\.(?= )/g,
  visa: /(?:permit|card|visa|document|vignette) (?:no|number)\b\.?/g,
  insurance_policy: /policy (?:no|number|#|ref(?:erence)?)\b\.?|certificate (?:no|number)\b\.?/g,
  utility_bill:
    /account (?:no|number|ref(?:erence)?)\b\.?|customer (?:no|number|reference)\b\.?|reference (?:no|number)\b\.?/g,
  bank_statement: /account (?:no|number)\b\.?/g,
  loan: /(?:loan|mortgage) (?:account )?(?:no|number)\b\.?|account (?:no|number)\b\.?/g,
  // Not the registration mark: that is the kind's own Plate.
  vehicle_registration: /(?:title|document reference) (?:no|number)\b\.?/g,
  prescription: /(?:rx|prescription) ?(?:no|number|#)\.?/g,
};

/**
 * The number after one of the kind's number labels, read off the text as
 * written: one word with two or more digits in it — and, for a number all
 * in digits, the groups of digits after it ("8500 1234 567") — on the
 * label's line or the next. On an identity card, where a row of labels sits
 * over a row of values, the first word on the next line that looks like a
 * document's number, less surely.
 */
function findNumbers(
  body: string,
  hay: string,
  kind: ProposalKind,
): Array<{ value: string; sure: boolean }> {
  const res: RegExp[] = [];
  const own = NUMBER_LABELS[kind.key];
  if (own) res.push(own);
  const named = phrase(kind.core?.identifier?.label);
  if (named) res.push(new RegExp(named.source, 'g'));
  const out: Array<{ value: string; sure: boolean }> = [];
  const fits = (value: string | undefined): value is string =>
    !!value &&
    value.length >= 4 &&
    value.length <= 30 &&
    (value.match(/\d/g) ?? []).length >= 2 &&
    // A date or an amount is not a number of this kind.
    !/^\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(value) &&
    !/^\d+\.\d{2}$/.test(value);
  for (const re of res) {
    for (const m of hay.matchAll(re)) {
      const from = (m.index ?? 0) + m[0].length;
      const rest = body.slice(from, from + 120);
      const v = /^[ :#.\-–]*(?:\n *)?([A-Za-z0-9][A-Za-z0-9/-]*)((?: [0-9][0-9/-]*)*)/.exec(rest);
      const word = v?.[1]?.replace(/[/-]+$/, '');
      const value = word && /^\d+$/.test(word) ? `${word}${v?.[2] ?? ''}` : word;
      if (fits(value)) {
        out.push({ value, sure: true });
        continue;
      }
      if (!ID_CARDS.has(kind.key)) continue;
      const next = /^[^\n]*\n([^\n]*)/.exec(rest)?.[1] ?? '';
      const onCard = /(?<![A-Za-z0-9])([A-Z0-9]{6,12})(?![A-Za-z0-9])/g;
      for (const c of next.matchAll(onCard)) {
        if ((c[1]?.match(/\d/g) ?? []).length >= 2 && fits(c[1])) {
          out.push({ value: c[1], sure: false });
          break;
        }
      }
    }
  }
  return out;
}

/** Kinds that set their details out as a card does: a row of labels over a row of values. */
const ID_CARDS = new Set(['passport', 'drivers_licence', 'visa', 'national_id']);

// ----------------------------------------------------------------- people

/** Words for who somebody is to the family, which no document calls them by. */
const KINSHIP = new Set([
  'granny',
  'grandma',
  'grandpa',
  'grandad',
  'granddad',
  'grandmother',
  'grandfather',
  'nana',
  'nan',
  'gran',
  'mum',
  'mom',
  'mummy',
  'mommy',
  'dad',
  'daddy',
  'papa',
  'mama',
  'auntie',
  'aunty',
  'aunt',
  'uncle',
  'baby',
]);

/**
 * A label that says the name after it is the holder's, the payee's or the
 * addressee's — with at most two words between ("Name: KHAN, SARA"), kept
 * to check they are not somebody else's name.
 */
const NAME_LABEL =
  /\b(?:name|names|full name|given names?|forenames?|first names?|surname|holder|policy ?holder|account (?:holder|name)|patient|insured|named insured|employee|tenants?|dear|mr|mrs|ms|miss|mx|dr|master|re|ln|fn)\b(?:\(s\))?[ .:,/-]*((?:[a-z'-]+[ ,]+){0,2})$/;
/** The same, on the line above a name on a line of its own. */
const NAME_LABEL_ABOVE =
  /\b(?:name|names|given names?|forenames?|surname|holder|policy ?holder|insured|tenants?|patient)\b/;
/** A UK or EU licence's names, by their field numbers: 1. the surname, 2. the given names. */
const NAME_FIELD = /^ *[12]\. *$/;
/** A line naming somebody who is not the document's holder: a parent, a witness, a doctor. */
const NOT_THE_HOLDER =
  /\b(?:father|mother|parents?|informant|spouse|guardians?|witness(?:es)?|next of kin|emergency contact|registrar|prescriber|landlord|agent|signed|signature)\b/;
/** A line of an address: a number and a street, a UK postcode, or a US state and ZIP. */
const ADDRESS =
  /\b\d+[a-z]?,? +(?:[a-z'-]+ +){0,3}(?:road|rd|street|st|lane|ln|avenue|ave|drive|close|way|court|ct|place|crescent|grove|terrace|gardens|boulevard|blvd|mews)\b|\b[a-z]{1,2}\d[a-z\d]? *\d[a-z]{2}\b|\b[a-z]{2},? +\d{5}(?:-\d{4})?\b/;

function nameWords(name: string): string[] {
  return fold(name)
    .split(/[^a-z'-]+/)
    .filter((w) => w.length >= 2 && !KINSHIP.has(w));
}

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface NameSeen {
  at: number;
  end: number;
  line: number;
  score: number;
}

/**
 * Where the page names this person, each place scored: their name where
 * the page names its holder (0.85; 0.9 with the whole name), at the head of
 * an address (as labelled), their whole name anywhere (0.8), their first
 * name alone, unlabelled (0.55: not enough on its own). A name on a line
 * about somebody else — a parent, a witness, a doctor — does not count.
 */
function namesSeen(
  body: string,
  hay: string,
  person: ProposalPerson,
  others: ReadonlySet<string>,
  lineAt: (at: number) => number,
): NameSeen[] {
  const words = nameWords(person.name);
  const first = words[0];
  if (!first || first.length < 3) return [];
  const patterns: Array<[RegExp, boolean]> = [
    [new RegExp(`(?<![a-z])${escape(first)}(?![a-z])`, 'g'), false],
  ];
  if (words.length > 1) {
    patterns.unshift([
      new RegExp(`(?<![a-z])${words.map(escape).join('[ ,]+')}(?![a-z])`, 'g'),
      true,
    ]);
  }
  const out: NameSeen[] = [];
  for (const [re, full] of patterns) {
    for (const m of hay.matchAll(re)) {
      const at = m.index ?? 0;
      // A name is written with a capital: "will" and "grace" are not Will and Grace.
      if (!/[A-Z]/.test(body.charAt(at))) continue;
      const lineStart = hay.lastIndexOf('\n', at - 1) + 1;
      const lineEnd = hay.indexOf('\n', at);
      const line = hay.slice(lineStart, lineEnd < 0 ? hay.length : lineEnd);
      if (NOT_THE_HOLDER.test(line)) continue;
      // What leads up to it on its line: enough for a label and two words.
      const before = hay.slice(Math.max(lineStart, at - 80), at);
      const label = NAME_LABEL.exec(before);
      // "Name: Zain Ahmed Khan" names Zain; Ahmed there is his middle name.
      let labelled =
        (label !== null &&
          !(label[1] ?? '').split(/[ ,]+/).some((w) => w !== '' && others.has(w))) ||
        NAME_FIELD.test(before);
      const leading = before.trim() === '' || /^ *(?:mr|mrs|ms|miss|mx|dr)\.? *$/.test(before);
      if (!labelled && leading) {
        const prevEnd = lineStart - 1;
        const prev = prevEnd > 0 ? hay.slice(hay.lastIndexOf('\n', prevEnd - 1) + 1, prevEnd) : '';
        // The line above says whose name this is, or the lines below are its address.
        const below = hay.slice(lineEnd < 0 ? hay.length : lineEnd + 1).split('\n', 3);
        labelled = NAME_LABEL_ABOVE.test(prev) || below.some((l) => ADDRESS.test(l));
      }
      const score = labelled ? (full ? 0.9 : 0.85) : full ? 0.8 : 0.55;
      out.push({ at, end: at + m[0].length, line: lineAt(at), score });
    }
  }
  return out;
}

/**
 * Whose the document is, when the page says: the one person in the family
 * it names as its holder. Two named as surely, or two named together
 * ("Mr Ahmed Khan and Mrs Sara Khan"), is a document of theirs together,
 * and nobody is proposed.
 */
function proposePerson(
  body: string,
  hay: string,
  people: readonly ProposalPerson[],
  mrz: Mrz | null,
): Proposed<string> | null {
  const lineAt = lineIndex(hay);
  const firsts = new Map(people.map((p) => [p.id, nameWords(p.name)[0] ?? '']));
  const seen = people.map((p) => {
    const others = new Set([...firsts].filter(([id]) => id !== p.id).map(([, f]) => f));
    const places = namesSeen(body, hay, p, others, lineAt);
    const best = places.reduce<NameSeen | null>((b, s) => (!b || s.score > b.score ? s : b), null);
    // A passport's machine-readable lines name its holder.
    const first = firsts.get(p.id);
    const inMrz = !!mrz && !!first && mrz.given[0]?.toLowerCase() === first;
    return { id: p.id, places, best, score: Math.max(best?.score ?? 0, inMrz ? 0.9 : 0) };
  });
  seen.sort((a, b) => b.score - a.score);
  const [top, next] = seen;
  const bar = PROPOSAL_THRESHOLDS.owner_member_id;
  if (!top || top.score < bar) return null;
  if (next && next.score >= bar && top.score - next.score < 0.1) return null;
  const where = top.best;
  if (where) {
    for (const other of seen.slice(1)) {
      for (const p of other.places) {
        if (p.line !== where.line) continue;
        const between = hay.slice(Math.min(where.end, p.end), Math.max(where.at, p.at));
        if (/\band\b|&|[,;/]/.test(between)) return null;
      }
    }
  }
  const confidence = next && next.score >= 0.55 ? top.score - 0.05 : top.score;
  return { value: top.id, confidence, cue: top.score >= 0.85 ? 'name_labelled' : 'name_on_page' };
}

// ----------------------------------------------------------------- issuer

/**
 * The bodies that issue a kind of document, by the names the page gives
 * them — often only initials, which no letterhead rule would offer.
 */
const ISSUING_BODIES: Readonly<Record<string, ReadonlyArray<readonly [RegExp, string]>>> = {
  passport: [
    [/\bhmpo\b|hm passport office|identity (?:and|&) passport service/, 'HM Passport Office'],
    [/department of state/, 'US Department of State'],
  ],
  drivers_licence: [
    [/\bdvla\b|driver (?:and|&) vehicle licensing agency/, 'DVLA'],
    [/\bdva\b|driver (?:and|&) vehicle agency/, 'DVA'],
  ],
  vehicle_registration: [[/\bdvla\b|driver (?:and|&) vehicle licensing agency/, 'DVLA']],
  birth_certificate: [[/general register office/, 'General Register Office']],
  marriage_certificate: [[/general register office/, 'General Register Office']],
  tax_return: [
    [/\bhmrc\b|hm revenue (?:and|&) customs/, 'HMRC'],
    [/internal revenue service/, 'IRS'],
  ],
};

function proposeIssuer(
  body: string,
  hay: string,
  ctx: ProposalContext,
  kindKey: string | null,
): Proposed<string> | null {
  // A kind's issuing body, named: one only, or the page is not saying which.
  const bodies = (ISSUING_BODIES[kindKey ?? ''] ?? []).filter(([re]) => re.test(hay));
  const named = bodies.length === 1 ? bodies[0] : undefined;
  const people = ctx.people.map((p) => p.name);
  if (ctx.household) people.push(ctx.household);
  const [top, next] = scoredIssuers(body, {
    known: ctx.issuers ?? [],
    typeKey: kindKey,
    people,
  });
  if (named && (!top || top.source !== 'known')) {
    return { value: named[1], confidence: 0.85, cue: 'issuing_body' };
  }
  if (!top) return null;
  let confidence =
    top.source === 'known'
      ? Math.min(0.95, 0.6 + 0.02 * top.score)
      : Math.min(0.9, 0.4 + 0.07 * top.score);
  // Two names nearly as likely: the page does not say which.
  if (next && next.score >= top.score - 1) confidence -= 0.1;
  return {
    value: top.value,
    confidence,
    cue: top.source === 'known' ? 'known_issuer' : 'letterhead',
  };
}

// ------------------------------------------------------------------ the lot

const filled = (v: unknown) =>
  v !== null && v !== undefined && (typeof v !== 'string' || v.trim() !== '');

/**
 * What the pages propose for a document: its kind, whose it is, its issue
 * and expiry dates, its number and who issued it, each with a confidence
 * and its cue — only for fields it has no value for yet, and only above
 * each field's threshold. Nothing, often: that is the right answer for a
 * page that does not say.
 */
export function proposeDetails(text: string, ctx: ProposalContext): DetailProposal {
  const body = text.slice(0, MAX_TEXT).replace(/\r\n?/g, '\n');
  const hay = fold(body);
  const current = ctx.current ?? {};
  const out: DetailProposal = {};
  const mrz = readMrz(body);

  // The kind: the document's own, or one the page proposes above the bar.
  let kind: ProposalKind | null = null;
  let kindFactor = 1;
  if (filled(current.type_key)) {
    kind = ctx.types.find((t) => t.key === current.type_key) ?? null;
  } else {
    const [best, next] = scoreKinds(hay, ctx.types, mrz);
    const lead = best ? best.score - (next?.score ?? 0) : 0;
    if (best && best.score >= KIND_MIN_SCORE && lead >= KIND_MIN_LEAD) {
      const confidence = round(Math.min(0.97, 0.5 + 0.04 * best.score + 0.04 * lead));
      if (confidence >= PROPOSAL_THRESHOLDS.type_key) {
        kind = best.kind;
        kindFactor = 0.6 + 0.4 * confidence;
        out.type_key = {
          value: best.kind.key,
          confidence,
          cue: best.mrz ? 'machine_lines' : 'kind_words',
        };
      }
    }
  }

  // Whose it is: the family's names, where the page names its holder.
  if (!filled(current.owner_member_id)) {
    const person = proposePerson(body, hay, ctx.people, mrz);
    if (person) out.owner_member_id = { ...person, confidence: round(person.confidence) };
  }

  // Who issued it.
  if (!filled(current.issued_by) && (!kind || shows(kind, 'issued_by'))) {
    const issuer = proposeIssuer(body, hay, ctx, kind?.key ?? null);
    if (issuer && round(issuer.confidence) >= PROPOSAL_THRESHOLDS.issued_by) {
      out.issued_by = { ...issuer, confidence: round(issuer.confidence) };
    }
  }

  // No date, and no number, without a confident kind.
  if (!kind) return out;
  const mrzFits = mrz !== null && kind.key === 'passport';

  const { issued, expires: expiring } = claimDates(hay, kind, ctx.dateOrder);
  let issuedOn = shows(kind, 'issued') && !filled(current.issued) ? bestDate(issued, false) : null;
  let expiresOn: Proposed<DateValue> | null = null;
  if (expires(kind) && !filled(current.expires)) {
    expiresOn =
      mrzFits && mrz.expires
        ? { value: mrz.expires, confidence: 0.95, cue: 'machine_lines' }
        : bestDate(expiring, true);
  }
  // A document that runs out before it was issued says neither.
  const from = issuedOn?.value.date ?? current.issued?.date ?? null;
  const to = expiresOn?.value.date ?? current.expires?.date ?? null;
  if (from && to && to <= from) {
    issuedOn = null;
    expiresOn = null;
  }
  for (const [field, p] of [
    ['issued', issuedOn],
    ['expires', expiresOn],
  ] as const) {
    if (!p) continue;
    const confidence = round(p.confidence * kindFactor);
    if (confidence >= PROPOSAL_THRESHOLDS[field]) out[field] = { ...p, confidence };
  }

  if (shows(kind, 'identifier') && !filled(current.identifier)) {
    let number: Proposed<string> | null = null;
    if (mrzFits && mrz.number) {
      number = { value: mrz.number, confidence: 0.95, cue: 'machine_lines' };
    } else {
      const found = findNumbers(body, hay, kind);
      const first = found[0];
      if (first) {
        const plain = (v: string) => v.replace(/\s/g, '');
        const differs = found.some((f) => plain(f.value) !== plain(first.value));
        const base = first.sure ? 0.85 : 0.8;
        number = {
          value: first.value,
          confidence: differs ? base - 0.1 : base,
          cue: 'number_label',
        };
      }
    }
    if (number) {
      const confidence = round(number.confidence * kindFactor);
      if (confidence >= PROPOSAL_THRESHOLDS.identifier) out.identifier = { ...number, confidence };
    }
  }
  return out;
}
