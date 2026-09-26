import type { DateValue, DocumentTypeView } from './documents.js';

/**
 * How a document is named and described in a line — the same words on the
 * web and the phone (0.4.10). Several bank statements, bills and letters
 * from the same months are told apart by who issued them:
 * "Bank statement · Barclays · Sep 2026".
 */

/**
 * Each type's short name, where its full label names several things. Since
 * 0.5.6 the vault says it for each type (`short_label`), a household's own
 * types included; these are the built-ins' words for an older vault.
 */
const SHORT_LABELS: Record<string, string> = {
  national_id: 'National ID',
  visa: 'Visa',
  marriage_certificate: 'Marriage certificate',
  will: 'Will',
  property_deed: 'Property deed',
  vehicle_registration: 'Vehicle registration',
  tax_form: 'Tax form',
  bank_statement: 'Bank statement',
  loan: 'Loan',
  medical_record: 'Medical record',
  diploma: 'Diploma',
  employment_contract: 'Employment contract',
  utility_bill: 'Bill',
  warranty: 'Warranty',
  pet_record: 'Pet record',
};

/**
 * "Bank statement" for 'Bank / investment statement': the type's own short
 * name, then the built-in's, then the label as it is.
 */
export function shortTypeLabel(
  type: Pick<DocumentTypeView, 'key' | 'label' | 'short_label'>,
): string {
  return type.short_label?.trim() || SHORT_LABELS[type.key] || type.label;
}

/**
 * What the issuer is called for this type: "Bank", "Provider", "Insurer"…
 * as the type says, or "Issued by".
 */
export function issuedByLabel(
  type: { issued_by_label?: string | null } | null | undefined,
): string {
  return type?.issued_by_label?.trim() || 'Issued by';
}

/**
 * The noun a named document takes after its issuer: "Barclays statement",
 * "British Gas bill", "Aviva policy". Types not listed here are named for
 * their person instead ("Aisha's passport"). Since 0.5.6 the vault says it
 * for each type (`issuer_noun`); these are the built-ins' for an older one.
 */
const ISSUER_NOUNS: Record<string, string> = {
  bank_statement: 'statement',
  utility_bill: 'bill',
  insurance_policy: 'policy',
  tax_form: 'tax form',
  tax_return: 'tax return',
  loan: 'loan statement',
  employment_contract: 'contract',
  warranty: 'receipt',
};

/** True when documents of this type are named for their issuer, not their person. */
export function namedForIssuer(
  type: Pick<DocumentTypeView, 'key' | 'issuer_noun'> | null | undefined,
): boolean {
  return type ? issuerNoun(type) !== undefined : false;
}

/**
 * The noun that follows the issuer in a name, for types named that way: the
 * type's own, then the built-in's.
 */
export function issuerNoun(
  type: Pick<DocumentTypeView, 'key' | 'issuer_noun'>,
): string | undefined {
  return type.issuer_noun?.trim() || ISSUER_NOUNS[type.key];
}

const MONTHS = [
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

/** "September 2026" or "2026", from an issued date: the month it covers. */
export function monthYear(d: DateValue | null | undefined, short = false): string | null {
  if (!d) return null;
  const [y, m] = d.date.split('-').map(Number) as [number, number];
  if (d.precision === 'year') return String(y);
  const name = MONTHS[m - 1];
  if (!name) return null;
  return `${short ? name.slice(0, 3) : name} ${y}`;
}

/**
 * The line under a document's name in a list: its short type, who issued
 * it and the month it was issued, whichever are known.
 * "Bank statement · Barclays · Sep 2026".
 */
export function documentLine(parts: {
  type?: Pick<DocumentTypeView, 'key' | 'label' | 'short_label'> | null;
  issued_by?: string | null;
  issued?: DateValue | null;
}): string {
  return [
    parts.type ? shortTypeLabel(parts.type) : null,
    parts.issued_by?.trim() || null,
    monthYear(parts.issued, true),
  ]
    .filter(Boolean)
    .join(' · ');
}
