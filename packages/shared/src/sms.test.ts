import { describe, expect, it } from 'vitest';
import {
  firstName,
  isPhoneCountry,
  maskPhone,
  parsePhone,
  phoneChangedText,
  phoneCodeText,
  phoneTail,
} from './sms.js';

/** A number as somebody types it, and the words a text says (0.9.0, SMS1). */
describe('mobile numbers', () => {
  it('reads a number as E.164, in the household’s country when it has no +', () => {
    expect(parsePhone('07700 900123')).toBe('+447700900123');
    expect(parsePhone('07700-900-123', 'GB')).toBe('+447700900123');
    expect(parsePhone('+44 (0)7700 900123', 'GB')).toBe('+447700900123');
    expect(parsePhone('00447700900123', 'GB')).toBe('+447700900123');
    expect(parsePhone('+1 415 555 2671', 'GB')).toBe('+14155552671');
    expect(parsePhone('(415) 555-2671', 'US')).toBe('+14155552671');
    expect(parsePhone('06 12 34 56 78', 'FR')).toBe('+33612345678');
  });

  it('refuses what cannot be a phone number', () => {
    for (const typed of [
      '',
      '   ',
      '12',
      '123',
      'abc',
      '07700 900123 ext 4',
      '+0 123 456',
      'x'.repeat(41),
    ]) {
      expect(parsePhone(typed, 'GB'), typed).toBeNull();
    }
  });

  it('knows a country by its two capitals', () => {
    expect(isPhoneCountry('GB')).toBe(true);
    expect(isPhoneCountry('FR')).toBe(true);
    expect(isPhoneCountry('gb')).toBe(false);
    expect(isPhoneCountry('ZZ')).toBe(false);
    expect(isPhoneCountry('GBR')).toBe(false);
  });

  it('shows only the last three digits', () => {
    expect(maskPhone('+447700900123')).toBe('•••• •••123');
    expect(phoneTail('+447700900123')).toBe('123');
  });

  it('says a code and a change in the words of a text: a first name, and never a link', () => {
    expect(phoneCodeText('123456', 'Sana Khan')).toBe(
      'Family Vault code: 123456. It confirms this number for Sana. It ends in 10 minutes.',
    );
    expect(phoneChangedText('  Sana Khan')).toBe(
      'Family Vault: the mobile number for Sana was changed.',
    );
    expect(firstName('   ')).toBe('somebody');
  });
});
