import { describe, expect, it } from 'vitest';
import { levelItem, type LevelKind } from './batch-levels.js';
import { deriveStatus, EXPIRY_OPTIONAL_KINDS, expiryOptional, missingFields } from './documents.js';

/**
 * An expiry the family adds, never one asked for (0.8.0, S5, the owner's
 * decision of 16 Oct 2026): a will's review date, a logbook's, a contract's
 * and a deed's. Each still shows Expires; nothing is missing without it,
 * on a document's card, in Needs attention or on a batch's card.
 */

const kind = (key: string, expiry_driver: string | null, extra: Partial<LevelKind> = {}) =>
  ({
    key,
    label: key,
    default_visibility: 'household',
    expiry_driver,
    fields: [],
    ...extra,
  }) as LevelKind;

describe('an expiry the family adds (S5)', () => {
  it('is the will’s, the logbook’s, the contract’s and the deed’s, and no other kind’s', () => {
    expect([...EXPIRY_OPTIONAL_KINDS].sort()).toEqual([
      'employment_contract',
      'property_deed',
      'vehicle_registration',
      'will',
    ]);
    expect(expiryOptional({ key: 'will' })).toBe(true);
    expect(expiryOptional({ key: 'passport' })).toBe(false);
    // A household's own kind is never one: its key is its own.
    expect(expiryOptional({ key: 'h_abcdefghij' })).toBe(false);
    expect(expiryOptional(null)).toBe(false);
  });

  it('is never missing; every other kind that expires still asks for it', () => {
    for (const [key, driver] of [
      ['will', 'review_on'],
      ['vehicle_registration', 'expires_on'],
      ['employment_contract', 'expires_on'],
      ['property_deed', 'expires_on'],
    ] as const) {
      expect(missingFields({ key, expiry_driver: driver }, {})).toEqual([]);
    }
    expect(missingFields({ key: 'passport', expiry_driver: 'expires_on' }, {})).toEqual([
      { key: 'expires', label: null },
    ]);
    expect(missingFields({ key: 'h_abcdefghij', expiry_driver: 'expires_on' }, {})).toEqual([
      { key: 'expires', label: null },
    ]);
    // What else the kind requires still is: a logbook's plate.
    expect(
      missingFields(
        {
          key: 'vehicle_registration',
          expiry_driver: 'expires_on',
          fields: [{ key: 'plate', label: 'Plate', required: true }],
        },
        {},
      ),
    ).toEqual([{ key: 'plate', label: 'Plate' }]);
  });

  it('a document of one is valid without it, and reminds once somebody adds it', () => {
    const status = (key: string, expires: { date: string; precision: 'day' } | null) =>
      deriveStatus(
        {
          type: { key, expiry_driver: 'expires_on', reminder_leads: [90] },
          owner_member_id: 'm-1',
          expires,
          missing: [],
        },
        '2026-10-16',
      );
    expect(status('will', null)).toEqual({ value: 'valid', label: '' });
    expect(status('property_deed', null).value).toBe('valid');
    expect(status('passport', null)).toEqual({
      value: 'needs_info',
      label: 'Needs an expiry date',
    });
    // One added counts as any other: soon, and then gone by.
    expect(status('vehicle_registration', { date: '2026-11-01', precision: 'day' }).value).toBe(
      'expiring_soon',
    );
    expect(status('will', { date: '2026-01-01', precision: 'day' }).value).toBe('expired');
  });

  it('a will read surely, with no review date on its pages, is Ready', () => {
    const level = (k: LevelKind) =>
      levelItem({
        state: 'waiting',
        reading: 'read',
        failure: null,
        proposal: {
          type_key: { value: k.key, confidence: 0.95, cue: 'kind_words' },
          owner_member_id: { value: 'm-1', confidence: 0.9, cue: 'name_labelled' },
        },
        duplicate: null,
        defaults: {
          owner_member_id: null,
          type_key: null,
          visibility: null,
          physical_location: null,
          collection_id: null,
          tags: [],
          is_essential: false,
        },
        types: [k],
        people: [{ id: 'm-1', name: 'Sara' }],
        role: 'owner',
        me: 'm-1',
      });
    expect(level(kind('will', 'review_on')).level).toBe('ready');
    // A passport without its expiry is still to be checked.
    const passport = level(kind('passport', 'expires_on'));
    expect(passport.level).toBe('check');
    expect(passport.tags.map((t) => t.code)).toContain('missing');
  });
});
