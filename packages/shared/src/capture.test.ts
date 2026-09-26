import { describe, expect, it } from 'vitest';
import {
  autoTitle,
  CAPTURE_FIELDS,
  checkCaptureMetadata,
  effectiveVisibility,
  reminderSentence,
  type CaptureContext,
} from './capture.js';
import { parseDateInput } from './documents.js';

const ME = 'm-me';
const AISHA = 'm-aisha';
const passport = {
  key: 'passport',
  label: 'Passport',
  expiry_driver: 'expires_on',
  default_visibility: 'household' as const,
  reminder_leads: [270, 180],
};
const bill = {
  key: 'utility_bill',
  label: 'Utility bill',
  expiry_driver: null,
  default_visibility: 'household' as const,
  reminder_leads: [],
};
const ctx = (role: CaptureContext['me']['role'] = 'owner'): CaptureContext => ({
  me: { member_id: ME, role },
  members: [{ id: ME }, { id: AISHA }],
  types: [passport, bill],
});

describe('dates as people type them', () => {
  it.each([
    ['2031-03-14', { date: '2031-03-14', precision: 'day' }],
    ['14 Mar 2031', { date: '2031-03-14', precision: 'day' }],
    ['14 March 2031', { date: '2031-03-14', precision: 'day' }],
    ['14th March 2031', { date: '2031-03-14', precision: 'day' }],
    ['March 14, 2031', { date: '2031-03-14', precision: 'day' }],
    ['  14   march   2031 ', { date: '2031-03-14', precision: 'day' }],
    ['1 Sept 2031', { date: '2031-09-01', precision: 'day' }],
    ['Mar 2031', { date: '2031-03-31', precision: 'month' }],
    ['March 2031', { date: '2031-03-31', precision: 'month' }],
    ['February 2032', { date: '2032-02-29', precision: 'month' }],
    ['2031-03', { date: '2031-03-31', precision: 'month' }],
    ['03/2031', { date: '2031-03-31', precision: 'month' }],
    ['2031', { date: '2031-12-31', precision: 'year' }],
  ])('%s', (typed, want) => {
    expect(parseDateInput(typed)).toEqual(want);
  });

  it('a numeric date is read in the order the reader uses, and only then', () => {
    expect(parseDateInput('14/03/2031', { order: 'dmy' })).toEqual({
      date: '2031-03-14',
      precision: 'day',
    });
    expect(parseDateInput('03/14/2031', { order: 'mdy' })).toEqual({
      date: '2031-03-14',
      precision: 'day',
    });
    expect(parseDateInput('14.03.2031', { order: 'dmy' })).toEqual({
      date: '2031-03-14',
      precision: 'day',
    });
    // 03/04/2031 is 3 April or 4 March: without an order it is neither.
    expect(parseDateInput('03/04/2031')).toBeNull();
    expect(parseDateInput('14/03/2031', { order: 'mdy' })).toBeNull();
  });

  it.each(['31 Feb 2031', '2031-13-01', '2031-02-30', 'Smarch 2031', '14 2031', 'soon', ''])(
    '%s is not a date',
    (typed) => {
      expect(parseDateInput(typed)).toBeNull();
    },
  );
});

describe('the rules a capture keeps', () => {
  it('a document can be filed with every field', () => {
    expect(
      checkCaptureMetadata(
        {
          type_key: 'passport',
          title: "Aisha's passport",
          owner_member_id: AISHA,
          visibility: 'adults',
          issued: { date: '2021-03-14', precision: 'day' },
          expires: { date: '2031-03-31', precision: 'month' },
          identifier: '563914782',
          physical_location: 'Bedroom safe',
          is_essential: true,
          tags: ['travel'],
          notes: null,
        },
        ctx(),
      ),
    ).toBeNull();
    expect(checkCaptureMetadata({}, ctx())).toBeNull();
    expect(CAPTURE_FIELDS).toContain('visibility');
  });

  it('a teen never files a document as Adults only, which they could not then see', () => {
    expect(checkCaptureMetadata({ visibility: 'adults' }, ctx('teen'))).toMatchObject({
      field: 'visibility',
      status: 403,
    });
    const medical = { ...passport, key: 'medical_record', default_visibility: 'adults' as const };
    expect(effectiveVisibility({}, medical, 'teen')).toBe('household');
    expect(effectiveVisibility({}, medical, 'adult')).toBe('adults');
    expect(effectiveVisibility({ visibility: 'private' }, medical, 'teen')).toBe('private');
  });

  it('text fits the limits the server keeps', () => {
    expect(checkCaptureMetadata({ title: 'x'.repeat(201) }, ctx())).toMatchObject({
      field: 'title',
    });
    expect(checkCaptureMetadata({ notes: 'x'.repeat(10_001) }, ctx())).toMatchObject({
      field: 'notes',
    });
    expect(checkCaptureMetadata({ tags: ['x'.repeat(41)] }, ctx())).toMatchObject({
      field: 'tags',
    });
    expect(checkCaptureMetadata({ title: 'x'.repeat(200) }, ctx())).toBeNull();
  });

  it('a teen files documents for themselves only', () => {
    expect(checkCaptureMetadata({ owner_member_id: AISHA }, ctx('teen'))).toMatchObject({
      field: 'owner_member_id',
      status: 403,
    });
    // Their own, named or not, is fine: unnamed means theirs.
    expect(checkCaptureMetadata({ owner_member_id: ME }, ctx('teen'))).toBeNull();
    expect(checkCaptureMetadata({ visibility: 'private' }, ctx('teen'))).toBeNull();
  });

  it('Only me is for documents that are yours', () => {
    expect(
      checkCaptureMetadata({ visibility: 'private', owner_member_id: AISHA }, ctx()),
    ).toMatchObject({
      field: 'visibility',
      status: 422,
    });
    expect(checkCaptureMetadata({ visibility: 'private' }, ctx())).toMatchObject({
      field: 'visibility',
    });
    expect(checkCaptureMetadata({ visibility: 'private', owner_member_id: ME }, ctx())).toBeNull();
  });

  it('a type that is private by default is held to the same rule', () => {
    const c = ctx();
    const secret = { ...passport, key: 'therapy', default_visibility: 'private' as const };
    expect(
      checkCaptureMetadata(
        { type_key: 'therapy', owner_member_id: AISHA },
        { ...c, types: [secret] },
      ),
    ).toMatchObject({ field: 'visibility' });
  });

  it('the person is in the family, and the type is one the vault knows', () => {
    expect(checkCaptureMetadata({ owner_member_id: 'm-stranger' }, ctx())).toMatchObject({
      field: 'owner_member_id',
      status: 422,
    });
    expect(checkCaptureMetadata({ type_key: 'spaceship' }, ctx())).toMatchObject({
      field: 'type_key',
      status: 422,
    });
  });

  it('an expiry date needs a type that expires', () => {
    const expires = { date: '2031-03-31', precision: 'month' as const };
    expect(checkCaptureMetadata({ type_key: 'utility_bill', expires }, ctx())).toMatchObject({
      field: 'expires',
      message: "This kind of document doesn't expire, so it has no expiry date.",
    });
    expect(checkCaptureMetadata({ expires }, ctx())).toMatchObject({
      field: 'expires',
      message: 'Choose what it is before giving it an expiry date.',
    });
  });

  it('a date is a real day, with a precision it agrees with', () => {
    for (const issued of [
      { date: '2021-02-30', precision: 'day' as const },
      { date: '2021-03-01', precision: 'month' as const },
      { date: '2021-06-30', precision: 'year' as const },
      { date: '2021-03-14', precision: 'week' as never },
    ]) {
      expect(checkCaptureMetadata({ issued }, ctx())).toMatchObject({
        field: 'issued',
        status: 422,
      });
    }
  });

  it("a type's details are its own, each of its kind, checked before the scan is queued (0.5.7)", () => {
    const car = {
      ...bill,
      key: 'vehicle_registration',
      fields: [
        { key: 'vin', label: 'VIN', kind: 'text' as const },
        { key: 'plate', label: 'Registration plate', kind: 'text' as const, required: true },
      ],
    };
    const withCar: CaptureContext = { ...ctx(), types: [passport, bill, car] };
    const vin = { type_key: 'vehicle_registration', extra: { vin: 'JM1BK32F781234567' } };
    // A required one left out is not a problem: it is Needs info until given.
    expect(checkCaptureMetadata(vin, withCar)).toBeNull();
    expect(checkCaptureMetadata({ ...vin, extra: { vin: 'JM1', colour: 'Red' } }, withCar)).toEqual(
      {
        field: 'extra',
        key: 'colour',
        message: 'This kind of document has no detail called "colour".',
        status: 422,
      },
    );
    expect(
      checkCaptureMetadata({ ...vin, extra: { vin: 'V'.repeat(501) } }, withCar),
    ).toMatchObject({ field: 'extra', key: 'vin', status: 422 });
    // No type, no details; a type queued with no fields to hand, the server's to judge.
    expect(checkCaptureMetadata({ extra: { vin: 'JM1' } }, withCar)).toMatchObject({
      key: 'vin',
    });
    expect(checkCaptureMetadata({ type_key: 'utility_bill', extra: { vin: 'JM1' } }, ctx())).toBe(
      null,
    );
    expect(CAPTURE_FIELDS).toContain('extra');
  });
});

describe('what the card writes for you', () => {
  it('the name uses the person chosen, not the one filing it', () => {
    expect(autoTitle(passport, { display_name: 'Aisha Seikh' })).toBe("Aisha's passport");
    expect(autoTitle(passport, { display_name: 'James' })).toBe("James's passport");
    expect(autoTitle(passport, null)).toBe('Passport');
  });

  it('the reminder sentence says when, in months or days', () => {
    expect(reminderSentence(passport)).toBe(
      "We'll remind you 9 months and 6 months before it expires.",
    );
    expect(reminderSentence({ expiry_driver: 'x', reminder_leads: [30] })).toBe(
      "We'll remind you 30 days before it expires.",
    );
    expect(reminderSentence({ expiry_driver: 'x', reminder_leads: [180, 365, 30] })).toBe(
      "We'll remind you 12 months, 6 months and 30 days before it expires.",
    );
    expect(reminderSentence({ expiry_driver: 'review_on', reminder_leads: [0] })).toBe(
      "We'll remind you on the day it's due for review.",
    );
    expect(reminderSentence({ expiry_driver: 'expires_on', reminder_leads: [30, 0] })).toBe(
      "We'll remind you 30 days before it expires, and on the day.",
    );
    expect(reminderSentence(bill)).toBeNull();
    expect(reminderSentence(null)).toBeNull();
  });
});
