import { describe, expect, it } from 'vitest';
import {
  deriveStatus,
  formatDate,
  missingFields,
  parseDateInput,
  withSealed,
} from './documents.js';

const passport = { key: 'passport', expiry_driver: 'expires_on', reminder_leads: [270, 180] };
const birth = { key: 'birth_certificate', expiry_driver: null, reminder_leads: [] };

describe('parseDateInput', () => {
  it('keeps full dates, and rounds partial ones to the end of the period', () => {
    expect(parseDateInput('2031-03-14')).toEqual({ date: '2031-03-14', precision: 'day' });
    expect(parseDateInput('2031-03')).toEqual({ date: '2031-03-31', precision: 'month' });
    expect(parseDateInput('2028-02')).toEqual({ date: '2028-02-29', precision: 'month' });
    expect(parseDateInput('2031')).toEqual({ date: '2031-12-31', precision: 'year' });
  });
  it('rejects impossible dates', () => {
    expect(parseDateInput('2031-02-30')).toBeNull();
    expect(parseDateInput('2031-13')).toBeNull();
    // Words are read since 0.4.9 (capture.test.ts); a month that is not one is not.
    expect(parseDateInput('Marchember 2031')).toBeNull();
  });
});

describe('formatDate', () => {
  it('renders to the precision the document stated', () => {
    expect(formatDate({ date: '2031-03-14', precision: 'day' })).toBe('14 Mar 2031');
    expect(formatDate({ date: '2031-03-31', precision: 'month' })).toBe('March 2031');
    expect(formatDate({ date: '2031-12-31', precision: 'year' })).toBe('2031');
  });
});

describe('deriveStatus', () => {
  const today = '2026-09-22';
  it('needs info before it has a type, a person, or a required date', () => {
    expect(deriveStatus({ type: null, owner_member_id: 'm', expires: null }, today).value).toBe(
      'needs_info',
    );
    expect(
      deriveStatus({ type: passport, owner_member_id: null, expires: null }, today).value,
    ).toBe('needs_info');
    expect(deriveStatus({ type: passport, owner_member_id: 'm', expires: null }, today).label).toBe(
      'Needs an expiry date',
    );
  });
  it('is valid with no expiry concept', () => {
    expect(deriveStatus({ type: birth, owner_member_id: 'm', expires: null }, today)).toEqual({
      value: 'valid',
      label: '',
    });
  });
  it('is active, expiring soon inside the first lead window, or expired', () => {
    const at = (date: string) =>
      deriveStatus(
        { type: passport, owner_member_id: 'm', expires: { date, precision: 'day' } },
        today,
      );
    expect(at('2031-03-14')).toEqual({ value: 'active', label: 'Valid for 4 years 5 months' });
    expect(at('2027-06-19').value).toBe('expiring_soon'); // 270 days out
    expect(at('2027-06-20').value).toBe('active'); // 271 days out
    expect(at('2026-09-22')).toEqual({ value: 'expiring_soon', label: 'Expires today' });
    expect(at('2026-01-12')).toEqual({ value: 'expired', label: 'Expired 12 Jan 2026' });
  });
  it('a superseded version reads as such regardless of dates', () => {
    expect(
      deriveStatus({ type: passport, owner_member_id: 'm', expires: null, superseded: true }, today)
        .value,
    ).toBe('superseded');
  });
});

describe('what a document needs (0.5.7)', () => {
  const today = '2026-09-22';
  const later = { date: '2031-03-14', precision: 'day' as const };
  /** A passport as 0032 ships it: its number, by that name, and its expiry required. */
  const rules = {
    expiry_driver: 'expires_on',
    core: {
      identifier: { shown: true, required: true, label: 'Passport number' },
      issued_by: { shown: true, required: false, label: 'Issuing country' },
      expires: { shown: true, required: true, label: null },
    },
    fields: [],
  };
  const status = (missing: ReturnType<typeof missingFields>, expires = later) =>
    deriveStatus({ type: passport, owner_member_id: 'm', expires, missing }, today);

  it('names the missing field: "Needs a passport number"', () => {
    const missing = missingFields(rules, { expires: later });
    expect(missing).toEqual([{ key: 'identifier', label: 'Passport number' }]);
    expect(status(missing)).toEqual({ value: 'needs_info', label: 'Needs a passport number' });
    expect(status(missingFields(rules, { identifier: ' 563914782 ', expires: later })).value).toBe(
      'active',
    );
    // Blank is no value.
    expect(missingFields(rules, { identifier: '   ', expires: later })).toHaveLength(1);
  });

  it('asks in the order the card does, and says how many more', () => {
    const car = {
      expiry_driver: 'expires_on',
      core: { issued_by: { shown: true, required: true, label: 'Insurer' } },
      fields: [
        { key: 'plate', label: 'Registration plate', required: true },
        { key: 'vin', label: 'VIN', required: true },
        { key: 'colour', label: 'Colour', required: false },
      ],
    };
    const none = missingFields(car, {});
    expect(none.map((m) => m.key)).toEqual(['issued_by', 'expires', 'plate', 'vin']);
    expect(status(none, null as never).label).toBe('Needs an insurer and 3 more details');
    const two = missingFields(car, {
      issued_by: 'Aviva',
      expires: later,
      extra: { plate: 'AB12' },
    });
    expect(status(two).label).toBe('Needs a VIN');
    expect(
      status(missingFields(car, { expires: later, extra: { plate: 'AB12', vin: '' } })).label,
    ).toBe('Needs an insurer and a VIN');
    // A no is an answer.
    const yesNo = {
      expiry_driver: null,
      fields: [{ key: 'direct', label: 'Direct debit', required: true }],
    };
    expect(missingFields(yesNo, { extra: { direct: false } })).toEqual([]);
  });

  it('a field is required only where the type shows it; an expiry always, if it expires', () => {
    const hidden = {
      expiry_driver: null,
      core: { notes: { shown: false, required: true, label: null } },
    };
    expect(missingFields(hidden, {})).toEqual([]);
    expect(missingFields({ expiry_driver: 'expires_on' }, {})).toEqual([
      { key: 'expires', label: null },
    ]);
    // In the app's own words when the type has none.
    const words = {
      expiry_driver: null,
      core: { identifier: { required: true }, issued: { required: true } },
    };
    expect(
      deriveStatus(
        { type: birth, owner_member_id: 'm', expires: null, missing: missingFields(words, {}) },
        today,
      ).label,
    ).toBe('Needs a number and an issue date');
  });

  it('an expiry that has passed or is close still comes first', () => {
    const missing = missingFields(rules, {});
    expect(status(missing, { date: '2026-01-12', precision: 'day' })).toEqual({
      value: 'expired',
      label: 'Expired 12 Jan 2026',
    });
    expect(status(missing, { date: '2026-10-01', precision: 'day' }).value).toBe('expiring_soon');
    // Without its person or its type, those are asked first, as before.
    expect(
      deriveStatus({ type: passport, owner_member_id: null, expires: later, missing }, today).label,
    ).toBe('Needs a person');
  });

  it('says "a" or "an" as it is spoken', () => {
    const one = (label: string) =>
      deriveStatus(
        {
          type: birth,
          owner_member_id: 'm',
          expires: null,
          missing: [{ key: 'x', label }],
        },
        today,
      ).label;
    expect(one('Insurer')).toBe('Needs an insurer');
    expect(one('VIN')).toBe('Needs a VIN');
    expect(one('MOT certificate')).toBe('Needs an MOT certificate');
    expect(one('NHS number')).toBe('Needs an NHS number');
    expect(one('Unique reference')).toBe('Needs a unique reference');
    expect(one('Umbrella policy')).toBe('Needs an umbrella policy');
  });
});

describe('what an Only me document needs, its notes and details sealed (0.5.8)', () => {
  const car = {
    expiry_driver: null,
    core: { notes: { shown: true, required: true, label: 'Where the keys are' } },
    fields: [
      { key: 'plate', label: 'Registration plate', required: true },
      { key: 'vin', label: 'VIN', required: false },
    ],
  };

  it('a sealed value counts as given, and one never written is still asked for', () => {
    // Sealed, the columns a list reads are empty: every one looks missing.
    expect(missingFields(car, { notes: null, extra: {} }).map((m) => m.key)).toEqual([
      'notes',
      'plate',
    ]);
    const sealed = withSealed({ notes: null, extra: {} }, { notes: true, details: ['plate'] });
    expect(missingFields(car, sealed)).toEqual([]);
    // What its owner never wrote is not made up.
    const noPlate = withSealed({ notes: null, extra: {} }, { notes: true, details: ['vin'] });
    expect(missingFields(car, noPlate)).toEqual([{ key: 'plate', label: 'Registration plate' }]);
    // A document with nothing sealed is left as it is.
    const plain = { notes: 'In the drawer', extra: { plate: 'KX19 ZLT' } };
    expect(withSealed(plain, { notes: false, details: [] })).toBe(plain);
    expect(withSealed(plain, null)).toBe(plain);
  });
});
