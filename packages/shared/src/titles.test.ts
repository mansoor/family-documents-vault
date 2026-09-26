import { describe, expect, it } from 'vitest';
import { autoTitle } from './capture.js';
import { documentLine, issuerNoun, namedForIssuer, shortTypeLabel } from './titles.js';

/**
 * A type's short name and the noun after its issuer. Since 0.5.6 the vault
 * says them for each type, a household's own included; a vault older than
 * that says neither, and the built-ins' words in code stand in.
 */
describe("a type's words for itself", () => {
  const statement = { key: 'bank_statement', label: 'Bank / investment statement' };
  const own = {
    key: 'h_abcdefghij',
    label: 'Pension statement from a former employer',
    short_label: 'Pension statement',
    issuer_noun: 'pension statement',
  };

  it("the vault's words come first, then the built-in's, then the label", () => {
    expect(shortTypeLabel(own)).toBe('Pension statement');
    expect(shortTypeLabel({ ...statement, short_label: 'Statement' })).toBe('Statement');
    // An older vault says nothing: the built-in's word, as before.
    expect(shortTypeLabel(statement)).toBe('Bank statement');
    expect(shortTypeLabel({ ...statement, short_label: null })).toBe('Bank statement');
    expect(shortTypeLabel({ key: 'h_bcdefghijk', label: 'Immigration case' })).toBe(
      'Immigration case',
    );
    // Blank is nothing.
    expect(shortTypeLabel({ ...own, short_label: '  ' })).toBe(own.label);
  });

  it("a household's own type can be named for its issuer, as the built-ins are", () => {
    expect(issuerNoun(own)).toBe('pension statement');
    expect(namedForIssuer(own)).toBe(true);
    expect(issuerNoun(statement)).toBe('statement');
    expect(namedForIssuer({ key: 'h_bcdefghijk', issuer_noun: null })).toBe(false);
    expect(namedForIssuer(null)).toBe(false);
    expect(
      autoTitle(own, null, {
        issued_by: 'Acme Pensions',
        issued: { date: '2026-04-30', precision: 'month' },
      }),
    ).toBe('Acme Pensions pension statement, April 2026');
    expect(documentLine({ type: own, issued_by: 'Acme Pensions', issued: null })).toBe(
      'Pension statement · Acme Pensions',
    );
  });
});
