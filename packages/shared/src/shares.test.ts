import { describe, expect, it } from 'vitest';
import { sharedOutsideWords } from './collections.js';
import {
  canShareToView,
  collectionShareItem,
  COLLECTION_SHARE_REASONS,
  defaultShareEnd,
  withinCollectionAudience,
  latestShareEnd,
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

  it("offers only the picks within the vault's longest, and says what that is (5.18 review)", () => {
    const sunday = new Date('2026-09-27T09:00:00Z');
    expect(shareQuickPicks('Europe/London', sunday, 3).map((p) => p.key)).toEqual(['tonight']);
    expect(shareQuickPicks('Europe/London', sunday, 7).map((p) => p.key)).toEqual([
      'tonight',
      'friday',
      'week',
    ]);
    // The longest end, to the minute below it: always one the vault takes.
    const latest = latestShareEnd('Europe/London', sunday, 3);
    expect(latest).toEqual({ date: '2026-09-30', time: '10:00', weekday: 3 });
    const at = zonedTime(latest.date, latest.time, 'Europe/London') as Date;
    expect(shareEndProblem(at, { now: sunday, maxDays: 3 })).toBeNull();
  });

  it('starts a link safely inside the longest, even the night the clocks go back (second review)', () => {
    const at = (p: { date: string; time: string }) =>
      zonedTime(p.date, p.time, 'Europe/London') as Date;
    // Three days on from here is 01:30 on the night British Summer Time
    // ends, a time that happens twice: the very edge, read back, is the
    // second, an hour past the longest.
    const before = new Date('2026-10-22T00:30:00Z');
    const edge = latestShareEnd('Europe/London', before, 3);
    expect(edge).toMatchObject({ date: '2026-10-25', time: '01:30' });
    expect(shareEndProblem(at(edge), { now: before, maxDays: 3 })).toBe(
      'A link can last 3 days at most.',
    );
    // The default is on the hour, and inside it.
    const start = defaultShareEnd('Europe/London', before, 3);
    expect(start).toEqual({ date: '2026-10-25', time: '00:00' });
    expect(shareEndProblem(at(start), { now: before, maxDays: 3 })).toBeNull();
    // On an ordinary day: the hour below a quarter of an hour inside it.
    const sunday = new Date('2026-09-27T09:40:00Z');
    expect(defaultShareEnd('Europe/London', sunday, 3)).toEqual({
      date: '2026-09-30',
      time: '10:00',
    });
    expect(defaultShareEnd('Europe/London', new Date('2026-09-27T09:50:00Z'), 3)).toEqual({
      date: '2026-09-30',
      time: '10:00',
    });
    // Where a week is allowed, a week.
    expect(defaultShareEnd('Europe/London', sunday, 90)).toEqual({
      date: '2026-10-04',
      time: '10:40',
    });
    // Where the longest is exactly a week, a week is its very edge: the
    // hour safely inside it instead (the third review).
    const seven = defaultShareEnd('Europe/London', sunday, 7);
    expect(seven).toEqual({ date: '2026-10-04', time: '10:00' });
    const limit = sunday.getTime() + 7 * 864e5;
    expect(at(seven).getTime()).toBeLessThanOrEqual(limit - 15 * 60_000);
    expect(shareEndProblem(at(seven), { now: sunday, maxDays: 7 })).toBeNull();
    // The vault lets a few minutes past the longest through, for a clock that
    // is ahead; a client checks with none.
    const late = new Date(sunday.getTime() + 3 * 864e5 + 3 * 60_000);
    expect(shareEndProblem(late, { now: sunday, maxDays: 3 })).not.toBeNull();
    expect(shareEndProblem(late, { now: sunday, maxDays: 3, graceMinutes: 5 })).toBeNull();
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

/** Sharing a collection (5.19): what the sheet ticks, and what a following link sends. */
describe('sharing a collection', () => {
  it('ticks what the whole audience may see, and a private one never', () => {
    for (const audience of ['everyone', 'teens']) {
      expect(withinCollectionAudience(audience, 'household')).toBe(true);
      expect(withinCollectionAudience(audience, 'adults')).toBe(false);
      expect(withinCollectionAudience(audience, 'private')).toBe(false);
    }
    expect(withinCollectionAudience('adults', 'household')).toBe(true);
    expect(withinCollectionAudience('adults', 'adults')).toBe(true);
    expect(withinCollectionAudience('adults', 'private')).toBe(false);
    // Only me is never shared, and what the code has never heard of is nobody's.
    expect(withinCollectionAudience('only_me', 'household')).toBe(false);
    expect(withinCollectionAudience('public', 'household')).toBe(false);
    expect(withinCollectionAudience('everyone', 'secret')).toBe(false);

    expect(collectionShareItem('everyone', { visibility: 'household', has_file: true })).toEqual({
      ticked: true,
      lock: null,
    });
    expect(collectionShareItem('everyone', { visibility: 'adults', has_file: true })).toEqual({
      ticked: false,
      lock: 'adults',
    });
    expect(collectionShareItem('adults', { visibility: 'private', has_file: true })).toEqual({
      ticked: false,
      lock: 'private',
    });
    expect(collectionShareItem('everyone', { visibility: 'household', has_file: false })).toEqual({
      ticked: false,
      lock: 'no_file',
    });
    expect(COLLECTION_SHARE_REASONS.adults).toBe('Adults only — include anyway?');
    expect(COLLECTION_SHARE_REASONS.private).toBe('Only you can see this. It is private.');
  });

  it('warns that a collection is shared, with whom, and whether what goes in goes too', () => {
    expect(sharedOutsideWords({ with: ['Jane Smith'], following: false })).toBe(
      'This collection is shared with Jane Smith. What you put in it now is not sent.',
    );
    expect(
      sharedOutsideWords({ with: ['Jane Smith', 'the bank', 'Dr Rao'], following: true }),
    ).toBe(
      'This collection is shared with Jane Smith, the bank and Dr Rao. What you put in it goes to them too, if everybody the collection is for may see it.',
    );
    expect(sharedOutsideWords({ with: [], following: true })).toMatch(
      /^This collection is shared outside the family\. What you put in it goes to them too/,
    );
  });
});
