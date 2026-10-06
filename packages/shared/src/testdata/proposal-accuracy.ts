/**
 * How `proposeDetails` does on a set of fixtures, field by field (5.37):
 * proposed and right, proposed and wrong, and silent where the document
 * says something. A field the document has no value for is right when
 * nothing is proposed for it.
 */
import { issuerKey } from '../issuers.js';
import { proposeDetails, type DetailProposal } from '../proposals.js';
import {
  FIXTURE_HOUSEHOLD,
  FIXTURE_ISSUERS,
  FIXTURE_KINDS,
  FIXTURE_PEOPLE,
  type ProposalFixture,
} from './proposal-fixtures.js';

export type FixtureField = keyof ProposalFixture['truth'];
export const FIXTURE_FIELDS: FixtureField[] = [
  'type_key',
  'owner',
  'issued',
  'expires',
  'identifier',
  'issued_by',
];

export interface FieldScore {
  /** Fixtures where the field has a value. */
  said: number;
  /** …and the value proposed. */
  right: number;
  /** A value proposed that is not the document's — or one it does not have. */
  wrong: number;
  /** Fixtures where the field has no value, and nothing was proposed. */
  quiet: number;
  /** Fixtures where the field has no value. */
  unsaid: number;
}

export const proposeFor = (f: ProposalFixture, dateOrder?: 'dmy' | 'mdy'): DetailProposal =>
  proposeDetails(f.text, {
    types: FIXTURE_KINDS,
    people: FIXTURE_PEOPLE,
    issuers: FIXTURE_ISSUERS,
    household: FIXTURE_HOUSEHOLD,
    dateOrder,
  });

/** The proposal's value for a fixture field, as the truth writes it. */
export function proposedValue(p: DetailProposal, field: FixtureField): string | null {
  switch (field) {
    case 'type_key':
      return p.type_key?.value ?? null;
    case 'owner':
      return p.owner_member_id?.value ?? null;
    case 'issued':
      return p.issued?.value.date ?? null;
    case 'expires':
      return p.expires?.value.date ?? null;
    case 'identifier':
      return p.identifier?.value ?? null;
    case 'issued_by':
      return p.issued_by?.value ?? null;
  }
}

/**
 * Whether a proposal is the truth: exactly, but for an issuer, which is
 * right when one name begins with the other ("Barclays Bank UK" for
 * "Barclays", "Sainsburys Supermarkets" for "Sainsbury's"), and a number,
 * which ignores spaces.
 */
export function matches(field: FixtureField, got: string, want: string): boolean {
  if (field === 'issued_by') {
    const bare = (v: string) => issuerKey(v).replace(/[^a-z0-9]/g, '');
    const a = bare(got);
    const b = bare(want);
    return a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a));
  }
  if (field === 'identifier') return got.replace(/\s/g, '') === want.replace(/\s/g, '');
  return got === want;
}

export function score(
  fixtures: readonly ProposalFixture[],
  dateOrder?: 'dmy' | 'mdy',
): Record<FixtureField, FieldScore> {
  const out = Object.fromEntries(
    FIXTURE_FIELDS.map((f) => [f, { said: 0, right: 0, wrong: 0, quiet: 0, unsaid: 0 }]),
  ) as Record<FixtureField, FieldScore>;
  for (const fixture of fixtures) {
    const p = proposeFor(fixture, dateOrder);
    for (const field of FIXTURE_FIELDS) {
      const want = fixture.truth[field];
      const got = proposedValue(p, field);
      const s = out[field];
      if (want === null) {
        s.unsaid += 1;
        if (got === null) s.quiet += 1;
        else s.wrong += 1;
      } else {
        s.said += 1;
        if (got !== null && matches(field, got, want)) s.right += 1;
        else if (got !== null) s.wrong += 1;
      }
    }
  }
  return out;
}
