/**
 * Characters OCR reads for digits, put right in dates and sums of money
 * (0.9.0, R3): "2O26" is 2026, "l2/05/2026" is 12/05/2026, "£1O4.50" is
 * £104.50. Only inside a token that, so corrected, is a date or a sum — a
 * day, a month and a year that are one, or a currency sign and an amount —
 * and that has digits of its own: never a word, a name, a postcode, a
 * reference or any other number. Each character is replaced by one, so a
 * place in the text is the same place after.
 *
 * What was corrected is said (`corrected`): a date read from a corrected
 * token is offered less sure (proposals.ts), so it is Check, never Ready,
 * on its own strength. Only `proposeDetails` reads the text so corrected:
 * a page's shape (R1, `pageText`) is read as OCR gave it, so a corrected
 * date never becomes what a sender's layout teaches.
 */

/**
 * What OCR reads for each digit, and the digit: only the confusions a date
 * suffers. B and Z are left alone — a seat "1B", a plate's letters.
 */
const DIGIT: Readonly<Record<string, string>> = {
  O: '0',
  o: '0',
  l: '1',
  I: '1',
  '|': '1',
  S: '5',
};
/** A digit, or a character OCR reads for one. */
const D = '[0-9OolI|S]';
/**
 * The words a two-digit year's date follows on its line ("Expiry date
 * 3l.l2.26"): without one, "O1.O2.O3" is a sort code or a phone number's.
 */
const DATE_LABEL =
  /\b(?:date|issued?|expir\w*|valid|due|until|birth|born|dob|dated)\b[^\n]{0,24}$/i;
/** Not a digit or a letter — or a separator another digit could follow. */
const EDGE_BEFORE = '(?<![\\p{L}\\p{N}/.,\\-|])';
const EDGE_AFTER = '(?![\\p{L}\\p{N}|]|[/.,\\-]\\p{N})';

const MONTH_NAME =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const realDigits = (s: string) => (s.match(/[0-9]/g) ?? []).length;
const asDigits = (s: string) => s.replace(/[OolI|S]/g, (c) => DIGIT[c] ?? c);
/** Each part with a digit of its own: "IS/O5/2O26" is no date put right, but a guess. */
const eachHasDigit = (...parts: string[]) => parts.every((p) => realDigits(p) >= 1);

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isDay = (y: number, m: number, d: number) =>
  y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
const fullYear = (y: string) =>
  y.length === 2 ? (Number(y) < 70 ? 2000 : 1900) + Number(y) : Number(y);

/** "12/05/2026", "O1.06.2O27", "3l-l2-2026": day and month either way round. */
const NUMERIC = new RegExp(
  `${EDGE_BEFORE}(${D}{1,2})([/.,\\-])(${D}{1,2})([/.,\\-])(${D}{4}|${D}{2})${EDGE_AFTER}`,
  'gu',
);
/** "l2 May 2O26", "14th June 2O26". */
const DAY_MONTH = new RegExp(
  `${EDGE_BEFORE}(${D}{1,2})((?:st|nd|rd|th)?[ .\\-/]{0,3}${MONTH_NAME}\\.?[ .\\-/,]{0,3})(${D}{4})${EDGE_AFTER}`,
  'giu',
);
/** "May l2, 2O26". */
const MONTH_DAY = new RegExp(
  `(?<![\\p{L}])(${MONTH_NAME}\\.? ?)(${D}{1,2})((?:st|nd|rd|th)?,? {1,3})(${D}{4})${EDGE_AFTER}`,
  'giu',
);
/** "£1O4.50", "$ l,2O0.00": a currency sign, then an amount with its pence. */
const MONEY = new RegExp(
  `([£$€] ?)(${D}{1,3}(?:,${D}{3})*|${D}{1,7})([.,])(${D}{2})${EDGE_AFTER}`,
  'gu',
);

export interface ConfusionFix {
  /** The text, each confusion inside a date or a sum put right; as long as it was. */
  text: string;
  /** Each token put right, as it reads now, in lower case. */
  corrected: string[];
}

/** The most tokens looked at, of each kind: a page has a few dozen dates. */
const MAX_TOKENS = 2_000;

export function fixConfusions(text: string): ConfusionFix {
  const chars = text.split('');
  const corrected: string[] = [];
  /** `token` at `at`, as `fixed` (as long), if it was not already right. */
  const put = (at: number, token: string, fixed: string) => {
    if (fixed === token || fixed.length !== token.length) return;
    for (let i = 0; i < fixed.length; i += 1) chars[at + i] = fixed[i] as string;
    corrected.push(fixed.toLowerCase());
  };
  const each = (re: RegExp, fix: (m: RegExpMatchArray) => string | null) => {
    let n = 0;
    for (const m of text.matchAll(re)) {
      if (++n > MAX_TOKENS) break;
      const fixed = fix(m);
      if (fixed !== null) put(m.index ?? 0, m[0], fixed);
    }
  };

  each(NUMERIC, (m) => {
    const [, a = '', s1 = '', b = '', s2 = '', y = ''] = m;
    if (realDigits(a + b + y) < 3 || !eachHasDigit(a, b, y)) return null;
    // The year's own digits at least half of it: "2O26", never "OO".
    if (realDigits(y) < y.length / 2) return null;
    const [da, db, dy] = [asDigits(a), asDigits(b), asDigits(y)];
    const year = fullYear(dy);
    if (!isDay(year, Number(db), Number(da)) && !isDay(year, Number(da), Number(db))) return null;
    // A comma read for a point, between two points or two slashes' worth: "12,05.2026".
    const sep = (x: string, other: string) => (x === ',' ? (other === ',' ? '.' : other) : x);
    const left = sep(s1, s2);
    const right = sep(s2, s1);
    if (left !== right) return null;
    // Two-digit years only with points or slashes as a date writes them,
    // and only after a date's label on its line: else a sort code, a phone's.
    if (y.length === 2 && left === '-') return null;
    const at = m.index ?? 0;
    if (y.length === 2 && !DATE_LABEL.test(text.slice(Math.max(0, at - 40), at))) return null;
    return `${da}${left}${db}${right}${dy}`;
  });
  each(DAY_MONTH, (m) => {
    const [, d = '', middle = '', y = ''] = m;
    if (realDigits(d) < 1 || realDigits(y) < 2) return null;
    const month = /[a-z]{3}/i.exec(middle)?.[0].toLowerCase() ?? '';
    const mm =
      ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
        month,
      ) + 1;
    if (!isDay(Number(asDigits(y)), mm, Number(asDigits(d)))) return null;
    return `${asDigits(d)}${middle}${asDigits(y)}`;
  });
  each(MONTH_DAY, (m) => {
    const [, month = '', d = '', middle = '', y = ''] = m;
    if (realDigits(d) < 1 || realDigits(y) < 2) return null;
    const mm =
      ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
        month.slice(0, 3).toLowerCase(),
      ) + 1;
    if (!isDay(Number(asDigits(y)), mm, Number(asDigits(d)))) return null;
    return `${month}${asDigits(d)}${middle}${asDigits(y)}`;
  });
  each(MONEY, (m) => {
    const [, sign = '', whole = '', point = '', pence = ''] = m;
    if (realDigits(whole + pence) < 2 || !eachHasDigit(whole, pence)) return null;
    return `${sign}${asDigits(whole)}${point}${asDigits(pence)}`;
  });
  return { text: chars.join(''), corrected };
}
