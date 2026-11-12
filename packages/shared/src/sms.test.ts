import { describe, expect, it } from 'vitest';
import {
  ALERT_TEXTS,
  clockTime,
  firstName,
  inQuietHours,
  isAlertTextKind,
  localMinute,
  minuteOfDay,
  quietHoursEnd,
  remindersText,
  shareOpenedText,
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

/** Notifications by text (0.9.0, SMS2): quiet hours on the family's clock, and what a text says. */
describe('quiet hours', () => {
  it('may run past midnight, and the same time for both is none', () => {
    const at = (t: string) => minuteOfDay(t);
    expect(inQuietHours(at('22:00'), '21:00', '08:00')).toBe(true);
    expect(inQuietHours(at('03:00'), '21:00', '08:00')).toBe(true);
    expect(inQuietHours(at('08:00'), '21:00', '08:00')).toBe(false);
    expect(inQuietHours(at('20:59'), '21:00', '08:00')).toBe(false);
    expect(inQuietHours(at('13:30'), '13:00', '14:00')).toBe(true);
    expect(inQuietHours(at('14:00'), '13:00', '14:00')).toBe(false);
    expect(inQuietHours(at('03:00'), '07:00', '07:00')).toBe(false);
    expect(minuteOfDay('21:30:00')).toBe(21 * 60 + 30);
    expect(clockTime('08:00:00')).toBe('08:00');
  });

  it('end at their own time on the family’s clock, across a change of the clocks too', () => {
    // 22:15 in London in November (GMT): quiet until 08:00 tomorrow.
    expect(
      quietHoursEnd('Europe/London', '21:00', '08:00', new Date('2026-11-12T22:15:30Z')),
    ).toEqual(new Date('2026-11-13T08:00:00Z'));
    // Not quiet: null.
    expect(quietHoursEnd('Europe/London', '21:00', '08:00', new Date('2026-11-12T12:00:00Z'))).toBe(
      null,
    );
    // Auckland (UTC+13 in November): 23:00 there is 10:00 UTC.
    expect(localMinute('Pacific/Auckland', new Date('2026-11-12T10:00:00Z'))).toBe(23 * 60);
    expect(
      quietHoursEnd('Pacific/Auckland', '21:00', '08:00', new Date('2026-11-12T10:00:00Z')),
    ).toEqual(new Date('2026-11-12T19:00:00Z'));
    // The night the clocks go back in London (25 Oct 2026, 02:00 BST to
    // 01:00 GMT): 08:00 is still 08:00, an hour later by UTC than BST's.
    expect(
      quietHoursEnd('Europe/London', '21:00', '08:00', new Date('2026-10-24T22:00:00Z')),
    ).toEqual(new Date('2026-10-25T08:00:00Z'));
  });
});

describe('what a text says (SMS2)', () => {
  it('the day’s reminders: a count, and never anything else of them', () => {
    expect(remindersText(2)).toBe(
      'Family Vault: 2 documents need attention today. Open the app to see them.',
    );
    expect(remindersText(1)).toBe(
      'Family Vault: 1 document needs attention today. Open the app to see it.',
    );
    expect(remindersText(3, false)).toBe(
      'Family Vault: 3 things need attention today. Open the app to see them.',
    );
  });

  it('a link opened: whom it was for, on one short line, or someone', () => {
    expect(shareOpenedText('the letting agent')).toBe(
      'Family Vault: the link you shared for the letting agent was opened.',
    );
    expect(shareOpenedText(null)).toBe('Family Vault: the link you shared for someone was opened.');
    expect(shareOpenedText(' \n\t ')).toBe(
      'Family Vault: the link you shared for someone was opened.',
    );
    expect(shareOpenedText(`Dr\nSmith ${'x'.repeat(100)}`)).toMatch(
      /^Family Vault: the link you shared for Dr Smith x{51} was opened\.$/,
    );
  });

  it('an alert: a headline, no link, and urgent only about their own sign-in', () => {
    for (const { text } of Object.values(ALERT_TEXTS)) {
      expect(text).toMatch(/^Family Vault: /);
      expect(text).not.toMatch(/https?:|www\./);
      expect(text.length).toBeLessThanOrEqual(160);
    }
    expect(ALERT_TEXTS.news.urgent).toBe(false);
    expect(ALERT_TEXTS.new_device).toEqual({
      text: 'Family Vault: a new device signed in to your account.',
      urgent: true,
    });
    expect(isAlertTextKind('locked')).toBe(true);
    expect(isAlertTextKind('toString')).toBe(false);
    expect(isAlertTextKind(undefined)).toBe(false);
  });
});
