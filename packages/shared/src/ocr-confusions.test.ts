import { describe, expect, it } from 'vitest';
import { fixConfusions } from './ocr-confusions.js';
import { proposeDetails, type ProposalContext } from './proposals.js';

/**
 * OCR's confusions put right in dates and sums only (0.9.0, R3), and never
 * in a word, a name or an identifier.
 */
describe('characters OCR reads for digits (R3)', () => {
  it('are put right inside a date or a sum', () => {
    const cases: Array<[string, string]> = [
      ['Renewal date 2O/O6/2O27', 'Renewal date 20/06/2027'],
      ['Payment due l2/05/2026', 'Payment due 12/05/2026'],
      ['Expiry date 3l.l2.2026', 'Expiry date 31.12.2026'],
      ['Valid until 14 May 2O26', 'Valid until 14 May 2026'],
      ['Due by l9th June 2026.', 'Due by 19th June 2026.'],
      ['Due May l4, 2O26', 'Due May 14, 2026'],
      ['Amount due £1O4.5O', 'Amount due £104.50'],
      ['Total £ l,2O9.99', 'Total £ 1,209.99'],
      // A comma read for a point.
      ['Date 12,05.2026', 'Date 12.05.2026'],
      // A two-digit year after a date's label.
      ['Expiry date 3l.l2.26', 'Expiry date 31.12.26'],
      ['issued 0S/04/2O25 and due 2S/04/2025', 'issued 05/04/2025 and due 25/04/2025'],
    ];
    for (const [read, right] of cases) {
      const fixed = fixConfusions(read);
      expect(fixed.text, read).toBe(right);
      expect(fixed.text).toHaveLength(read.length);
      expect(fixed.corrected.length, read).toBeGreaterThan(0);
    }
    expect(fixConfusions('Payment due l2/05/2026').corrected).toEqual(['12/05/2026']);
  });

  it('never change a word, a name or an identifier', () => {
    const untouched = [
      'Mrs Olivia Khan',
      'OLIVER SOLO ISLA BOB IZZY lol',
      'National Insurance number QQ 12 34 56 C',
      'Registration AV22 OJK, AB12 3CD',
      'Driving licence KHAN9811031AR9GW 57',
      'Postcode AV4 7QT, SO15 2BB',
      'Sort code 30-9l-57',
      'Account number 4417 3391 and LF-7730 1185',
      'Policy HX/2O26/l1',
      'Reference SO-1234/2O26',
      'Call O1632 960 220',
      'Room l2/B',
      'OO/OO/OOOO',
      // A day with no digit of its own is a word, not a day.
      'Volume I March 2026, Schedule S May 2026',
      // The R3 review's: a sort code, a phone number, a seat, a book.
      'Sort code: O1.O2.O3',
      'Phone O1.23.45',
      'Seat 1B/12/2028',
      'Book IS/O5/2O26',
      'Version 1.2O.3',
      // Not a date once put right: there is no 35th, nor a 13th month either way.
      'Ref 3S/l3/2026',
      // A date already right is left alone.
      'Statement date 18 August 2026, due 03/09/2026',
    ];
    for (const s of untouched) {
      expect(fixConfusions(s), s).toEqual({ text: s, corrected: [] });
    }
  });

  it('is bounded: a page of nothing but tokens takes no time', () => {
    const page = 'l2/O5/2O26 '.repeat(20_000);
    const started = Date.now();
    const fixed = fixConfusions(page);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fixed.text).toHaveLength(page.length);
  });
});

describe('a date put right is offered unsure (R3)', () => {
  const ctx: ProposalContext = {
    types: [
      {
        key: 'utility_bill',
        label: 'Utility bill',
        fields: [],
        expiry_driver: 'due_date',
      },
    ],
    people: [{ id: 'p1', name: 'Olivia Khan' }],
    dateOrder: 'dmy',
  };
  const bill = (due: string) =>
    [
      'BRIGHTWATER ENERGY',
      'Your electricity bill',
      'Account number    8820 4417 3391',
      'Mrs Olivia Khan',
      'Electricity used    663 kWh',
      'Amount due    £124.97',
      `Payment due by    ${due}`,
    ].join('\n');

  it('read as written, the due date is sure; put right, it is the same date but unsure', () => {
    const right = proposeDetails(bill('29/04/2026'), ctx);
    expect(right.expires?.value.date).toBe('2026-04-29');
    const fixed = proposeDetails(bill('29/O4/2O26'), ctx);
    expect(fixed.expires?.value.date).toBe('2026-04-29');
    expect(fixed.expires?.confidence).toBeLessThan(0.8);
    expect(right.expires?.confidence ?? 0).toBeGreaterThan(fixed.expires?.confidence ?? 1);
  });
});
