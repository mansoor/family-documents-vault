import { describe, expect, it } from 'vitest';
import { checkDetail, checkExtra, extraBytes, EXTRA_MAX_BYTES } from './details.js';
import type { TypeField } from './documents.js';

const fields: TypeField[] = [
  { key: 'vin', label: 'VIN', kind: 'text' },
  { key: 'terms', label: 'Terms', kind: 'long_text' },
  { key: 'renewed', label: 'Renewed', kind: 'date' },
  { key: 'first_year', label: 'First year', kind: 'year' },
  { key: 'claims', label: 'Claims', kind: 'number' },
  { key: 'cover', label: 'Cover', kind: 'money' },
  { key: 'band', label: 'Band', kind: 'choice', choices: ['Basic', 'Lifetime'] },
  { key: 'direct', label: 'Direct debit', kind: 'yes_no' },
];
const field = (key: string) => fields.find((f) => f.key === key) as TypeField;

describe("a type's details (0.5.7)", () => {
  it('each kind takes its own kind of value, and says so otherwise', () => {
    expect(checkDetail(field('vin'), '  JM1BK32F781234567 ')).toEqual({
      value: 'JM1BK32F781234567',
    });
    expect(checkDetail(field('vin'), '   ')).toEqual({ value: null });
    expect(checkDetail(field('vin'), 'V'.repeat(501))).toEqual({
      message: 'VIN is too long: 500 characters at most.',
    });
    expect(checkDetail(field('terms'), 'x'.repeat(10_000))).toHaveProperty('value');
    expect(checkDetail(field('terms'), 'x'.repeat(10_001))).toEqual({
      message: 'Terms is too long: 10,000 characters at most.',
    });
    expect(checkDetail(field('renewed'), { date: '2026-03-31', precision: 'month' })).toEqual({
      value: { date: '2026-03-31', precision: 'month' },
    });
    expect(checkDetail(field('renewed'), 'next week')).toEqual({
      message: 'Renewed must be a date: a day, a month or a year, with its precision.',
    });
    expect(checkDetail(field('first_year'), 2019)).toEqual({ value: 2019 });
    expect(checkDetail(field('first_year'), 19)).toHaveProperty('message');
    expect(checkDetail(field('claims'), -2.5)).toEqual({ value: -2.5 });
    expect(checkDetail(field('claims'), Number.NaN)).toHaveProperty('message');
    expect(checkDetail(field('cover'), 12.5)).toEqual({ value: 12.5 });
    expect(checkDetail(field('cover'), 12.345)).toEqual({
      message: 'Cover must be an amount, such as 12.50.',
    });
    expect(checkDetail(field('band'), 'Basic')).toEqual({ value: 'Basic' });
    expect(checkDetail(field('band'), 'basic')).toEqual({
      message: 'Band must be one of: Basic, Lifetime.',
    });
    expect(checkDetail(field('direct'), false)).toEqual({ value: false });
    expect(checkDetail(field('direct'), 'no')).toEqual({
      message: 'Direct debit must be yes or no.',
    });
    // A kind this code does not know is the server's to judge.
    expect(
      checkDetail({ key: 'x', label: 'X', kind: 'colour' as TypeField['kind'] }, '#fff'),
    ).toEqual({ value: '#fff' });
  });

  it('an unknown key is refused and named; null takes a key away', () => {
    expect(checkExtra({ vin: 'JM1', colour: 'Red' }, fields)).toEqual({
      problem: { key: 'colour', message: 'This kind of document has no detail called "colour".' },
    });
    expect(checkExtra({ vin: 'JM1', band: null }, fields, { band: 'Basic', vin: 'OLD' })).toEqual({
      set: { vin: 'JM1' },
      remove: ['band'],
    });
    // Null for a key it does not hold is nothing to do; blank text is null.
    expect(checkExtra({ colour: null, vin: ' ' }, fields, { vin: 'OLD' })).toEqual({
      set: {},
      remove: ['vin'],
    });
    // "constructor" is a key like any other, not something every object has.
    expect(checkExtra({ constructor: null }, fields)).toEqual({ set: {}, remove: [] });
    expect(checkExtra({ constructor: 'x' }, fields)).toHaveProperty('problem.key', 'constructor');
  });

  it('a value sent back as it is kept is left alone, whatever the type says now', () => {
    const held = { retired: 7, renewed: { date: '2026-03-31', precision: 'month' } };
    // An older phone sends the whole object back, keys in any order.
    expect(
      checkExtra(
        { retired: 7, renewed: { precision: 'month', date: '2026-03-31' }, vin: 'JM1' },
        fields,
        held,
      ),
    ).toEqual({ set: { vin: 'JM1' }, remove: [] });
    expect(checkExtra({ retired: 8 }, fields, held)).toHaveProperty('problem.key', 'retired');
  });

  it('16 KB is the most, and only an edit that grows it past that is refused', () => {
    // Past a long text's own limit only with more than one: two fields' worth.
    const two: TypeField[] = [...fields, { key: 'more', label: 'More', kind: 'long_text' }];
    const first = 'x'.repeat(9_000);
    const bare = extraBytes({ terms: first, more: '' });
    const big = { terms: first, more: 'y'.repeat(EXTRA_MAX_BYTES - bare) };
    expect(extraBytes(big)).toBe(EXTRA_MAX_BYTES);
    expect(checkExtra(big, two)).toEqual({ set: big, remove: [] });
    const over = { ...big, more: `${big.more}y` };
    expect(checkExtra(over, two)).toEqual({
      problem: { key: 'more', message: 'The details are too long: 16 KB at most, all together.' },
    });
    // Multi-byte characters count as their bytes.
    expect(extraBytes({ a: 'é' })).toBe(10);
    // Already over (kept from before there was a limit): smaller is fine.
    const huge = { old: 'z'.repeat(20_000) };
    expect(checkExtra({ vin: 'JM1' }, fields, huge)).toHaveProperty('problem');
    expect(checkExtra({ old: null }, fields, huge)).toEqual({ set: {}, remove: ['old'] });
  });
});
