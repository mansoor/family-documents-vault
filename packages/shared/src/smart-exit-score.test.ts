import { describe, expect, it } from 'vitest';
import { scoreItem, summarise, type SmartEntry, type SmartSeen } from './testdata/index.js';

/**
 * How the Smart exit scores a card (0.8.0, S5; testdata/smart-exit.ts):
 * what needs typing, what is a wrong Ready, and what is neither.
 */

const entry = (
  truth: Partial<SmartEntry['truth']>,
  more: Partial<SmartEntry> = {},
): SmartEntry => ({
  path: 'Bills/2026/energy.pdf',
  paper: 'bill-energy',
  set: 'tune',
  mode: 'text',
  blank: false,
  duplicate_of: null,
  rescan_of: null,
  misfiled: false,
  folder: 'Bills/2026',
  truth: {
    kind: 'utility_bill',
    person: 'olivia',
    issued: '2026-09-14',
    expires: '2026-10-01',
    number: '8820 4417 3391',
    issuer: 'Brightwater Energy',
    ...truth,
  },
  ...more,
});
const seen = (s: Partial<SmartSeen>): SmartSeen => ({
  level: 'ready',
  duplicate: false,
  failure: null,
  kind: 'utility_bill',
  person: 'olivia',
  issued: '2026-09-14',
  expires: '2026-10-01',
  number: '882044173391',
  issuer: 'Brightwater Energy Ltd',
  ...s,
});
const EXPIRING = new Set(['utility_bill', 'vehicle_registration', 'passport']);
const expiring = (k: string) => EXPIRING.has(k);

describe('scoring the Smart exit', () => {
  it('a card with everything right needs nothing typed, Ready or Check', () => {
    expect(scoreItem(entry({}), seen({}), expiring)).toMatchObject({
      manual: false,
      wrongReady: false,
      readyDetailWrong: [],
    });
    expect(scoreItem(entry({}), seen({ level: 'check' }), expiring).manual).toBe(false);
  });

  it('a kind, a person or an expiry missing or wrong needs typing; at Ready it is a wrong Ready', () => {
    expect(scoreItem(entry({}), seen({ level: 'check', person: null }), expiring)).toMatchObject({
      manual: true,
      misses: ['person'],
      wrongReady: false,
    });
    expect(scoreItem(entry({}), seen({ expires: '2026-10-02' }), expiring)).toMatchObject({
      manual: true,
      misses: ['expiry'],
      wrongReady: true,
    });
    expect(
      scoreItem(entry({}), seen({ level: 'unrecognised', kind: null }), expiring).misses,
    ).toEqual(['kind']);
    // Somebody offered for a paper that is nobody's.
    expect(scoreItem(entry({ person: null }), seen({}), expiring).misses).toEqual(['person']);
  });

  it('an expiry the paper does not give, and none offered, is counted apart', () => {
    const logbook = entry({ kind: 'vehicle_registration', expires: null });
    const s = scoreItem(
      logbook,
      seen({ kind: 'vehicle_registration', expires: null, level: 'check' }),
      expiring,
    );
    expect(s).toMatchObject({ manual: false, expiryNotOnPaper: true });
    // One offered anyway is wrong.
    expect(
      scoreItem(logbook, seen({ kind: 'vehicle_registration', expires: '2030-01-01' }), expiring),
    ).toMatchObject({ manual: true, wrongReady: true, misses: ['expiry'] });
  });

  it('a paper of no kind is right Not recognised, or as Something else; any other kind is wrong', () => {
    const menu = entry({ kind: null, person: null, expires: null });
    expect(scoreItem(menu, seen({ level: 'unrecognised', kind: null }), expiring).manual).toBe(
      false,
    );
    expect(scoreItem(menu, seen({ level: 'check', kind: 'other' }), expiring).manual).toBe(false);
    expect(scoreItem(menu, seen({ level: 'check', kind: 'warranty' }), expiring).misses).toEqual([
      'kind',
    ]);
  });

  it('a blank page or a copy the vault calls a Problem needs nothing', () => {
    const blank = entry({ kind: null, person: null, expires: null }, { blank: true });
    expect(scoreItem(blank, seen({ level: 'problem', kind: null }), expiring).manual).toBe(false);
    expect(scoreItem(blank, seen({ level: 'check', kind: 'warranty' }), expiring).manual).toBe(
      true,
    );
    const copy = entry({}, { duplicate_of: 'Bills/2026/energy.pdf' });
    expect(
      scoreItem(copy, seen({ level: 'problem', duplicate: true, person: null }), expiring).manual,
    ).toBe(false);
  });

  it('a Ready card with another detail wrong is counted beside, not as a wrong Ready', () => {
    const s = scoreItem(
      entry({}),
      seen({ issued: '2026-09-15', issuer: 'Somebody Else' }),
      expiring,
    );
    expect(s).toMatchObject({
      manual: false,
      wrongReady: false,
      readyDetailWrong: ['issued', 'issuer'],
    });
  });

  it('sums by level, set, mode and kind', () => {
    const rows = [
      { entry: entry({}), seen: seen({}) },
      {
        entry: entry({}, { set: 'held-out', mode: 'scan' }),
        seen: seen({ level: 'check', person: null }),
      },
    ].map((r) => ({ ...r, score: scoreItem(r.entry, r.seen, expiring) }));
    const s = summarise(rows);
    expect(s.all).toMatchObject({ files: 2, ready: 1, check: 1, manual: 1, wrong_ready: 0 });
    expect(s.held_out).toMatchObject({ files: 1, manual: 1 });
    expect(s.scan).toMatchObject({ files: 1, manual: 1 });
    expect(s.by_kind.utility_bill).toEqual({ files: 2, kind_right: 2, no_typing: 1 });
    expect(s.manual).toEqual([
      { path: 'Bills/2026/energy.pdf', set: 'held-out', misses: ['person'], level: 'check' },
    ]);
  });
});
