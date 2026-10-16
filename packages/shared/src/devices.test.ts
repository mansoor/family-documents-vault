import { describe, expect, it } from 'vitest';
import { nextLocalMidnight } from './devices.js';

describe('when a computer’s day starts again (0.8.0, D1)', () => {
  it('is the next midnight on the household’s clock', () => {
    // 23:30 on 12 October in New York: midnight is 30 minutes away.
    expect(
      nextLocalMidnight('America/New_York', new Date('2026-10-13T03:30:00Z')).toISOString(),
    ).toBe('2026-10-13T04:00:00.000Z');
    // Just after midnight there: the next one is a day away.
    expect(
      nextLocalMidnight('America/New_York', new Date('2026-10-13T04:00:01Z')).toISOString(),
    ).toBe('2026-10-14T04:00:00.000Z');
    expect(nextLocalMidnight('UTC', new Date('2026-10-13T12:00:00Z')).toISOString()).toBe(
      '2026-10-14T00:00:00.000Z',
    );
  });

  it('keeps to the household’s clock across a change of the clocks', () => {
    // London on summer time on 24 October; on winter time from 25 October.
    expect(nextLocalMidnight('Europe/London', new Date('2026-10-24T12:00:00Z')).toISOString()).toBe(
      '2026-10-24T23:00:00.000Z',
    );
    expect(nextLocalMidnight('Europe/London', new Date('2026-10-25T12:00:00Z')).toISOString()).toBe(
      '2026-10-26T00:00:00.000Z',
    );
  });
});
