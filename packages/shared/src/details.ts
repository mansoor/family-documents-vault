import { wellFormedDate, type DateValue, type TypeField } from './documents.js';

/**
 * A type's details (0.5.7): what a document keeps in `extra`, one value per
 * field of its type, each checked by the field's kind. The same rules on
 * the phone (before a scan is queued, offline) and on the server.
 *
 *   text       a string, up to 500 characters
 *   long_text  a string, up to 10,000 characters, as a note is
 *   date       a date as every date is sent: { date, precision }
 *   year       a whole year, such as 2026
 *   number     a number
 *   money      an amount, with no more than two places after the point
 *   choice     one of the field's own answers, as written
 *   yes_no     true or false
 *
 * Text is kept trimmed, and blank text is no value at all. The whole object
 * is at most 16 KB, so `extra` cannot become a store of its own.
 */

/** The longest a text detail may be, in characters. */
export const DETAIL_TEXT_MAX = 500;
/** The longest a long text detail may be: as long as a note. */
export const DETAIL_LONG_TEXT_MAX = 10_000;
/** The most a document's details may hold, as JSON in UTF-8. */
export const EXTRA_MAX_BYTES = 16 * 1024;

/** Why a detail was refused: its key, and words for the person. */
export interface DetailProblem {
  key: string;
  message: string;
}

/** The bytes of a string as UTF-8, counted without an encoder (the phone may have none). */
function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** How big a document's details are, as the 16 KB limit counts them. */
export function extraBytes(extra: Record<string, unknown>): number {
  return utf8Bytes(JSON.stringify(extra));
}

/** A key an object holds itself, not one every object inherits ("constructor"). */
const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** The same value, whatever order an object's keys came in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * One value for one field: the value as it is kept (text trimmed; blank
 * text is null, no value), or the words for why it cannot be. A kind this
 * code does not know is left for the server to judge.
 */
export function checkDetail(
  field: Pick<TypeField, 'key' | 'label' | 'kind' | 'choices'>,
  value: unknown,
): { value: unknown } | { message: string } {
  const name = field.label || field.key;
  switch (field.kind) {
    case 'text':
    case 'long_text': {
      if (typeof value !== 'string') return { message: `${name} must be written as text.` };
      const max = field.kind === 'text' ? DETAIL_TEXT_MAX : DETAIL_LONG_TEXT_MAX;
      const kept = value.trim();
      if (kept.length > max) {
        const words = field.kind === 'text' ? '500' : '10,000';
        return { message: `${name} is too long: ${words} characters at most.` };
      }
      return { value: kept || null };
    }
    case 'date':
      return wellFormedDate(value as DateValue)
        ? { value: { date: (value as DateValue).date, precision: (value as DateValue).precision } }
        : { message: `${name} must be a date: a day, a month or a year, with its precision.` };
    case 'year':
      return Number.isInteger(value) && (value as number) >= 1000 && (value as number) <= 9999
        ? { value }
        : { message: `${name} must be a year, such as 2026.` };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { value }
        : { message: `${name} must be a number.` };
    case 'money':
      return typeof value === 'number' &&
        Number.isFinite(value) &&
        Math.round(value * 100) / 100 === value
        ? { value }
        : { message: `${name} must be an amount, such as 12.50.` };
    case 'choice': {
      const choices = field.choices ?? [];
      return typeof value === 'string' && choices.includes(value)
        ? { value }
        : {
            message: choices.length
              ? `${name} must be one of: ${choices.join(', ')}.`
              : `${name} has no answers to choose from yet.`,
          };
    }
    case 'yes_no':
      return typeof value === 'boolean' ? { value } : { message: `${name} must be yes or no.` };
    default:
      return { value };
  }
}

/**
 * A document's details as a capture or an edit sends them, checked against
 * its type's fields: what to keep, what to take away, or the first problem.
 *
 * An edit is a merge: a key left out is left as it is, and `null` takes it
 * away (any key, one the type no longer asks for included). `held` is what
 * the document keeps now: a value sent back exactly as it is kept is left
 * alone, whatever the type says today — an older phone sends the whole
 * object back, and must never fail on what it did not change. The 16 KB
 * limit refuses only an edit that makes the details bigger than that.
 */
export function checkExtra(
  sent: Record<string, unknown>,
  fields: ReadonlyArray<Pick<TypeField, 'key' | 'label' | 'kind' | 'choices'>>,
  held: Record<string, unknown> = {},
): { set: Record<string, unknown>; remove: string[] } | { problem: DetailProblem } {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [key, value] of Object.entries(sent)) {
    if (value === null || value === undefined) {
      if (has(held, key)) remove.push(key);
      continue;
    }
    if (has(held, key) && canonical(value) === canonical(held[key])) continue;
    const field = fields.find((f) => f.key === key);
    if (!field) {
      return {
        problem: { key, message: `This kind of document has no detail called "${key}".` },
      };
    }
    const checked = checkDetail(field, value);
    if ('message' in checked) return { problem: { key, message: checked.message } };
    if (checked.value === null) {
      if (has(held, key)) remove.push(key);
    } else {
      set[key] = checked.value;
    }
  }
  const kept: Record<string, unknown> = { ...held };
  for (const key of remove) delete kept[key];
  const size = extraBytes({ ...kept, ...set });
  if (size > EXTRA_MAX_BYTES && size > extraBytes(held)) {
    // Named by the value that took it over, as they were sent.
    let over = Object.keys(set)[0] ?? '';
    for (const [key, value] of Object.entries(set)) {
      kept[key] = value;
      if (extraBytes(kept) > EXTRA_MAX_BYTES) {
        over = key;
        break;
      }
    }
    return {
      problem: { key: over, message: 'The details are too long: 16 KB at most, all together.' },
    };
  }
  return { set, remove };
}
