import { describe, expect, it } from 'vitest';
import {
  canShareToView,
  pagesNotSharedNote,
  shareEndProblem,
  shareEndWords,
  sharePagesNote,
  shareQuickPicks,
  shareUses,
  zonedParts,
  zonedTime,
} from './shares.js';

/** A link's options (5.18): the rules and the words every client says them in. */
describe("a link's options", () => {
  it('reads a time on the household clock, across a change of the clocks', () => {
    // London in summer is an hour ahead of UTC, and in winter it is not.
    expect(zonedTime('2026-10-02', '17:00', 'Europe/London')?.toISOString()).toBe(
      '2026-10-02T16:00:00.000Z',
    );
    expect(zonedTime('2026-11-06', '17:00', 'Europe/London')?.toISOString()).toBe(
      '2026-11-06T17:00:00.000Z',
    );
    expect(zonedTime('2026-10-02', '17:00', 'America/New_York')?.toISOString()).toBe(
      '2026-10-02T21:00:00.000Z',
    );
    expect(zonedTime('2026-10-02', '17:00', 'Not/AZone')?.toISOString()).toBe(
      '2026-10-02T17:00:00.000Z',
    );
    expect(zonedTime('Friday', '17:00', 'UTC')).toBeNull();
    const at = new Date('2026-09-27T23:30:00Z');
    expect(zonedParts(at, 'Europe/London')).toEqual({
      date: '2026-09-28',
      time: '00:30',
      weekday: 1,
    });
    expect(zonedParts(at, 'UTC')).toEqual({ date: '2026-09-27', time: '23:30', weekday: 0 });
  });

  it('offers Tonight, Friday 5 pm and In a week, each still ahead', () => {
    // Sunday 27 September 2026, 10:00 in London.
    const sunday = new Date('2026-09-27T09:00:00Z');
    expect(
      shareQuickPicks('Europe/London', sunday).map((p) => [p.label, p.at.toISOString()]),
    ).toEqual([
      ['Tonight', '2026-09-27T22:00:00.000Z'],
      ['Friday 5 pm', '2026-10-02T16:00:00.000Z'],
      ['In a week', '2026-10-04T09:00:00.000Z'],
    ]);
    // Friday at six: tonight still, but this Friday's five o'clock has gone.
    const friday = new Date('2026-10-02T17:00:00Z');
    expect(
      shareQuickPicks('Europe/London', friday).map((p) => [p.key, p.at.toISOString()]),
    ).toEqual([
      ['tonight', '2026-10-02T22:00:00.000Z'],
      ['friday', '2026-10-09T16:00:00.000Z'],
      ['week', '2026-10-09T17:00:00.000Z'],
    ]);
    // Five to eleven at night: too late for Tonight.
    const late = new Date('2026-09-27T21:57:00Z');
    expect(shareQuickPicks('Europe/London', late).map((p) => p.key)).toEqual(['friday', 'week']);
  });

  it('refuses an end in the past, under 5 minutes, or past the longest', () => {
    const now = new Date('2026-09-27T09:00:00Z');
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(shareEndProblem(at(-1), { now })).toMatch(/at least 5 minutes/);
    expect(shareEndProblem(at(4 * 60_000), { now })).toMatch(/at least 5 minutes/);
    expect(shareEndProblem(at(5 * 60_000), { now })).toBeNull();
    expect(shareEndProblem(at(90 * 864e5), { now })).toBeNull();
    expect(shareEndProblem(at(90 * 864e5 + 1), { now })).toBe('A link can last 90 days at most.');
    expect(shareEndProblem(at(15 * 864e5), { now, maxDays: 14 })).toBe(
      'A link can last 14 days at most.',
    );
    expect(shareEndProblem(new Date('nonsense'), { now })).toMatch(/not a date/);
  });

  it('says an end on the household clock', () => {
    const at = new Date('2026-10-02T16:00:00Z');
    expect(shareEndWords(at, 'Europe/London')).toBe('Friday 2 October at 17:00');
    expect(shareEndWords(at, 'UTC', { weekday: false })).toBe('2 October at 16:00');
  });

  it('shares to view only what the vault can draw', () => {
    for (const mime of ['application/pdf', 'image/jpeg', 'image/heic']) {
      expect(canShareToView(mime), mime).toBe(true);
    }
    for (const mime of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      null,
    ]) {
      expect(canShareToView(mime), String(mime)).toBe(false);
    }
  });

  it('counts uses the way the family reads them', () => {
    expect(shareUses({ open_count: 2, max_opens: 5, downloads_used: 3 })).toBe(
      'Opened 2 of 5 times; 3 downloads',
    );
    expect(shareUses({ open_count: 0, downloads_used: 0 })).toBe('Not opened yet');
    expect(shareUses({ open_count: 1, downloads_used: 0 })).toBe('Opened once; not downloaded yet');
    expect(shareUses({ open_count: 3, downloads_used: 1, max_downloads: 2 })).toBe(
      'Opened 3 times; 1 of 2 downloads',
    );
    expect(shareUses({ open_count: 1, max_opens: 1, permission: 'view' })).toBe(
      'Opened 1 of 1 time; to view only',
    );
    // A legacy link, or an older vault's, counts no downloads.
    expect(shareUses({ open_count: 4, flow: 'legacy', downloads_used: 0 })).toBe('Opened 4 times');
    expect(shareUses({ open_count: 4 })).toBe('Opened 4 times');
  });

  it('tells the sharer and the recipient about a long document', () => {
    expect(sharePagesNote({ state: 'ready', shown: 30, total: 42 })).toBe(
      'They will see the first 30 of 42 pages.',
    );
    expect(sharePagesNote({ state: 'drawing', shown: 30, total: 42 })).toBe(
      'They will see the first 30 of 42 pages. The pages are still being drawn; the link works in a minute.',
    );
    expect(sharePagesNote({ state: 'drawing', shown: null, total: null })).toBe(
      'The pages are still being drawn; the link works in a minute.',
    );
    expect(sharePagesNote({ state: 'ready', shown: 3, total: 3 })).toBeNull();
    expect(sharePagesNote({ state: 'failed', shown: 0, total: 2 })).toMatch(/could not draw/);
    expect(sharePagesNote(null)).toBeNull();
    expect(pagesNotSharedNote({ state: 'ready', shown: 30, total: 42 })).toBe(
      'Pages after 30 were not shared.',
    );
    expect(pagesNotSharedNote({ state: 'ready', shown: 3, total: 3 })).toBeNull();
  });
});
