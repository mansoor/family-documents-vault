import { describe, expect, it } from 'vitest';
import { deriveStatus, formatDate, parseDateInput } from './documents.js';

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
