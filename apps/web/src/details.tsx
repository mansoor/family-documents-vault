import {
  checkDetail,
  formatDate,
  parseDateInput,
  wellFormedDate,
  type AttributeKind,
  type CoreField,
  type CoreFieldRule,
  type DateOrder,
  type DateValue,
  type DocumentAttributeView,
  type DocumentTypeView,
  type TypeField,
} from '@fdv/shared';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useApp } from './app-context.js';
import { Field, Select, Switch, TextArea } from './ui.js';

/**
 * A type's details on the web (5.10): what the card asks for and the
 * document's page shows. The card holds each detail as it is typed; these
 * turn a kept value into that and back, the same rules the vault keeps
 * (@fdv/shared, details.ts).
 */

/** The kinds this app can ask for. A kind added later is left alone. */
const KINDS: ReadonlyArray<AttributeKind> = [
  'text',
  'long_text',
  'date',
  'year',
  'number',
  'money',
  'choice',
  'yes_no',
];

/** One of a type's own fields that the card knows how to ask for. */
export const asksFor = (f: TypeField): boolean => KINDS.includes(f.kind);

/** How a type asks for one of the fixed fields; a vault before 0.5.6 has no rules. */
export function coreRule(
  type: Pick<DocumentTypeView, 'core'> | null | undefined,
  key: CoreField,
): CoreFieldRule {
  const rule = type?.core?.[key];
  return {
    shown: rule?.shown !== false,
    required: rule?.shown !== false && rule?.required === true,
    label: rule?.label?.trim() || null,
  };
}

/** A detail as the card holds it: text as typed, or a yes or no (null: not answered). */
export type DetailInput = string | boolean | null;

/** A date as every date is kept: { date, precision }. */
const isDate = (v: unknown): v is DateValue =>
  typeof v === 'object' && v !== null && wellFormedDate(v as DateValue);

const moneyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** A kept value as the card shows it, to be typed over: "March 2031", "12.50", true. */
export function detailInput(kind: AttributeKind | undefined, value: unknown): DetailInput {
  if (value === null || value === undefined) return kind === 'yes_no' ? null : '';
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return kind === 'money' ? moneyText(value) : String(value);
  if (typeof value === 'string') return value;
  if (isDate(value)) return formatDate(value);
  return '';
}

/** Every detail a document keeps, as the card starts with them. */
export function detailInputs(
  extra: Record<string, unknown>,
  fields: ReadonlyArray<TypeField>,
): Record<string, DetailInput> {
  const out: Record<string, DetailInput> = {};
  for (const [key, value] of Object.entries(extra)) {
    out[key] = detailInput(fields.find((f) => f.key === key)?.kind, value);
  }
  return out;
}

/** Nothing typed, or no answer given. */
export const blankInput = (v: DetailInput | undefined): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * What the card typed, as the vault keeps it: `null` for nothing, or the
 * words for why it cannot be read. The last word is the vault's own rules
 * (checkDetail), so the card never sends what would be refused.
 */
export function readDetail(
  field: Pick<TypeField, 'key' | 'label' | 'kind' | 'choices'>,
  input: DetailInput | undefined,
  order: DateOrder,
): { value: unknown } | { message: string } {
  if (blankInput(input)) return { value: null };
  const name = field.label || field.key;
  let value: unknown = typeof input === 'string' ? input.trim() : input;
  if (typeof value === 'string') {
    switch (field.kind) {
      case 'date': {
        const d = parseDateInput(value, { order });
        if (!d) return { message: `${name}: try 14 Mar 2031, March 2031, or just 2031.` };
        value = d;
        break;
      }
      case 'year':
        if (!/^\d{4}$/.test(value)) return { message: `${name}: write a year, such as 2026.` };
        value = Number(value);
        break;
      case 'number': {
        const n = value.replace(/[\s,]/g, '');
        if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(n)) {
          return { message: `${name}: write a number, such as 3.` };
        }
        value = Number(n);
        break;
      }
      case 'money': {
        const n = value.replace(/[\s,£$€]/g, '');
        if (!/^-?(\d+(\.\d{1,2})?|\.\d{1,2})$/.test(n)) {
          return { message: `${name}: write an amount, such as 12.50.` };
        }
        value = Number(n);
        break;
      }
      default:
        break;
    }
  }
  const checked = checkDetail(field, value);
  return 'message' in checked ? checked : { value: checked.value };
}

/** A kept value in words, for the document's page: "Yes", "March 2031", "1,200.00". */
export function detailText(kind: AttributeKind | undefined, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    return kind === 'money'
      ? value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : String(value);
  }
  if (typeof value === 'string') return value;
  if (isDate(value)) return formatDate(value);
  return JSON.stringify(value) ?? '';
}

/** "Passport number", "Passport number and Expires", "A, B and C". */
export function andList(words: ReadonlyArray<string>): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] as string}`;
}

/**
 * The attribute library (GET /document-attributes), asked for only when
 * something needs it: a choice field whose answers are the library's, or a
 * detail its type no longer asks for, named as the library names it.
 * Without it, the card and the page still work.
 */
export function useAttributes(wanted: boolean): DocumentAttributeView[] | null {
  const { withToken } = useApp();
  const [items, setItems] = useState<DocumentAttributeView[] | null>(null);
  useEffect(() => {
    if (!wanted || items) return;
    let cancelled = false;
    withToken((t) => api.documentAttributes(t))
      .then((r) => {
        if (!cancelled && r) setItems(r.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wanted, items, withToken]);
  return items;
}

/** A choice field's answers: its own, or the library's for its key. */
export function choicesOf(
  field: Pick<TypeField, 'key' | 'choices'>,
  library: ReadonlyArray<DocumentAttributeView> | null,
): string[] {
  if (field.choices?.length) return field.choices;
  return library?.find((a) => a.key === field.key)?.choices ?? [];
}

/** The longest text detail, and the longest long one: as the vault keeps them. */
const TEXT_MAX = 500;
const LONG_TEXT_MAX = 10_000;

/**
 * One of a type's own fields on the card, with the input its kind asks for:
 * a line of text, a box of it, a date as a person writes one, a number, an
 * amount, a pick-list or a yes/no switch.
 */
export function DetailField(props: {
  id: string;
  field: TypeField;
  /** A choice field's answers, its own or the library's. */
  choices: string[];
  value: DetailInput | undefined;
  invalid: boolean;
  onChange: (v: DetailInput) => void;
}) {
  const { id, field, value, invalid, onChange } = props;
  const text = typeof value === 'string' ? value : '';
  const common = {
    id,
    label: field.label,
    requiredMark: field.required === true,
    invalid,
  };
  switch (field.kind) {
    case 'long_text':
      return <TextArea {...common} value={text} maxLength={LONG_TEXT_MAX} onChange={onChange} />;
    case 'choice': {
      // A value kept from before its answers changed is still shown as it is.
      const answers =
        text && !props.choices.includes(text) ? [...props.choices, text] : props.choices;
      return (
        <Select
          {...common}
          value={text}
          onChange={onChange}
          options={[
            { value: '', label: 'Not chosen' },
            ...answers.map((c) => ({ value: c, label: c })),
          ]}
        />
      );
    }
    case 'yes_no':
      return (
        <Switch
          id={id}
          label={field.label}
          requiredMark={common.requiredMark}
          checked={value === true}
          onChange={onChange}
        />
      );
    case 'date':
      return (
        <Field
          {...common}
          value={text}
          onChange={onChange}
          required={false}
          placeholder="14 Mar 2031"
          hint="A date, a month (March 2031) or a year"
        />
      );
    case 'year':
      return (
        <Field
          {...common}
          value={text}
          onChange={onChange}
          required={false}
          inputMode="numeric"
          maxLength={4}
          placeholder="2026"
        />
      );
    case 'number':
      return (
        <Field {...common} value={text} onChange={onChange} required={false} inputMode="decimal" />
      );
    case 'money':
      return (
        <Field
          {...common}
          value={text}
          onChange={onChange}
          required={false}
          inputMode="decimal"
          placeholder="12.50"
        />
      );
    default:
      return (
        <Field {...common} value={text} onChange={onChange} required={false} maxLength={TEXT_MAX} />
      );
  }
}
