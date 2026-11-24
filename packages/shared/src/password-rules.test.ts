import { describe, expect, it } from 'vitest';
import {
  isPasswordMinLength,
  PASSWORD_RULES_DEFAULT,
  passwordForms,
  passwordIsPersonal,
  passwordLacks,
  passwordLength,
  passwordRefusalWords,
  passwordRulesOf,
  passwordRulesWeaker,
  passwordRulesWords,
  type PasswordRules,
} from './password-rules.js';

const rules = (r: Partial<PasswordRules> = {}): PasswordRules => ({
  ...PASSWORD_RULES_DEFAULT,
  ...r,
});
const ALL_MIX = { needs_upper: true, needs_lower: true, needs_number: true, needs_symbol: true };

describe('password rules', () => {
  it('start at 10 characters, common passwords refused, no mix asked for', () => {
    expect(PASSWORD_RULES_DEFAULT).toEqual({
      min_length: 10,
      refuse_common: true,
      needs_upper: false,
      needs_lower: false,
      needs_number: false,
      needs_symbol: false,
    });
    expect([9, 10, 64, 65, 12.5, '12'].map(isPasswordMinLength)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('count characters as a person does', () => {
    expect(passwordLength('abc')).toBe(3);
    expect(passwordLength('🐧🐧🐧')).toBe(3);
  });

  it('say what a password lacks for the length and each switch, in order', () => {
    expect(passwordLacks('ten chars!', rules())).toEqual([]);
    expect(passwordLacks('nine char', rules())).toEqual(['length']);
    expect(passwordLacks('short', rules({ min_length: 12, ...ALL_MIX }))).toEqual([
      'length',
      'upper',
      'number',
      'symbol',
    ]);
    expect(passwordLacks('ALL UPPER 1', rules(ALL_MIX))).toEqual(['lower']);
    expect(passwordLacks('Écrire2024!', rules(ALL_MIX))).toEqual([]);
    // A space is a symbol; so is an emoji.
    expect(passwordLacks('Two Words1', rules({ needs_symbol: true }))).toEqual([]);
    expect(passwordLacks('Penguin🐧12', rules({ needs_symbol: true }))).toEqual([]);
    expect(passwordLacks('NoSymbolHere1', rules({ needs_symbol: true }))).toEqual(['symbol']);
    // A switch that is off asks nothing.
    expect(passwordLacks('lowercase only', rules())).toEqual([]);
  });

  it('say everything missing in one sentence', () => {
    const r = rules({ min_length: 12, needs_number: true, needs_symbol: true });
    expect(passwordRefusalWords(['length', 'number', 'symbol'], r)).toBe(
      'Use at least 12 characters, with a number and a symbol.',
    );
    expect(passwordRefusalWords(['length'], r)).toBe('Use at least 12 characters.');
    expect(passwordRefusalWords(['upper'], r)).toBe('Add an uppercase letter.');
    expect(passwordRefusalWords(['upper', 'lower', 'number'], r)).toBe(
      'Add an uppercase letter, a lowercase letter and a number.',
    );
    expect(passwordRefusalWords([], r, 'common')).toBe(
      'That password is too common: choose another.',
    );
    expect(passwordRefusalWords(['number'], r, 'common')).toBe(
      'Add a number. That password is too common: choose another.',
    );
    expect(passwordRefusalWords([], r, 'personal')).toBe(
      'That password is your own email address or name: choose another.',
    );
    expect(passwordRefusalWords([], r)).toBe('');
  });

  it('put the rules in a line for under a password field', () => {
    expect(passwordRulesWords(PASSWORD_RULES_DEFAULT)).toBe(
      'At least 10 characters. Not a common password, nor your name or email address.',
    );
    expect(
      passwordRulesWords(
        rules({ min_length: 12, refuse_common: false, needs_upper: true, needs_number: true }),
      ),
    ).toBe('At least 12 characters, with an uppercase letter and a number.');
  });

  it('make an answer whole, an older vault’s none the default', () => {
    expect(passwordRulesOf(undefined)).toEqual(PASSWORD_RULES_DEFAULT);
    expect(passwordRulesOf({ min_length: 3, needs_number: true })).toEqual({
      ...PASSWORD_RULES_DEFAULT,
      needs_number: true,
    });
  });

  it('know looser from stricter', () => {
    const base = rules({ min_length: 12, needs_number: true });
    expect(passwordRulesWeaker(base, rules({ min_length: 14, needs_number: true }))).toBe(false);
    expect(passwordRulesWeaker(base, { ...base, needs_symbol: true })).toBe(false);
    expect(passwordRulesWeaker(base, { ...base, min_length: 11 })).toBe(true);
    expect(passwordRulesWeaker(base, { ...base, needs_number: false })).toBe(true);
    expect(passwordRulesWeaker(base, { ...base, refuse_common: false })).toBe(true);
    // Stricter one way and looser another is looser.
    expect(passwordRulesWeaker(base, { ...base, min_length: 20, needs_number: false })).toBe(true);
  });

  it('search a list for a password as it is, and without what dresses it up', () => {
    expect(passwordForms('Dragon2024!')).toEqual(['dragon2024!', 'dragon']);
    expect(passwordForms('Correct Horse')).toEqual(['correcthorse']);
    expect(passwordForms('1234567890')).toEqual(['1234567890']);
    // Seven or more digits and symbols at the ends are the password's own: kept whole.
    expect(passwordForms('monkey 739284615023')).toEqual(['monkey739284615023']);
    expect(passwordForms('!dragon2024!')).toEqual(['!dragon2024!', 'dragon']);
    expect(passwordForms('!!dragon20245!')).toEqual(['!!dragon20245!']);
  });

  it('know a password that is just the person’s own email address or name', () => {
    const who = { email: 'Ada.Lovelace@example.test', name: 'Ada Lovelace' };
    for (const p of [
      'ada.lovelace@example.test',
      'Ada.Lovelace',
      'adalovelace',
      'Ada Lovelace',
      'Lovelace1815!',
      '!!lovelace',
    ]) {
      expect(passwordIsPersonal(p, who), p).toBe(true);
    }
    for (const p of ['Ada likes engines', 'lovelace-engine', 'difference engine']) {
      expect(passwordIsPersonal(p, who), p).toBe(false);
    }
    expect(passwordIsPersonal('ada1234567', who)).toBe(true);
    // A word of the name too short to mean anything is no match.
    expect(passwordIsPersonal('jo12345678', { name: 'Jo March' })).toBe(false);
    expect(passwordIsPersonal('anything at all', {})).toBe(false);
  });
});
