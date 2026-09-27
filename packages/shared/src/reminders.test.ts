import { describe, expect, it } from 'vitest';
import {
  aboutDate,
  addDays,
  addMonths,
  derivedFireDates,
  lapsed,
  localHour,
  localToday,
  nextOccurrence,
  parseRecurrence,
  reminderAbout,
  reminderLabel,
} from './reminders.js';

describe('date arithmetic', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });
  it('adds months clamping to the last day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 3)).toBe('2026-04-30');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });
});

describe('recurrence', () => {
  it('parses the four forms', () => {
    expect(parseRecurrence('monthly')).toBe(1);
    expect(parseRecurrence('quarterly')).toBe(3);
    expect(parseRecurrence('annual')).toBe(12);
    expect(parseRecurrence('every:6m')).toBe(6);
    expect(parseRecurrence('weekly')).toBeNull();
    expect(parseRecurrence(null)).toBeNull();
  });
  it('finds the next occurrence strictly after a date', () => {
    expect(nextOccurrence('2026-01-28', 'monthly', '2026-09-22')).toBe('2026-09-28');
    expect(nextOccurrence('2026-01-28', 'monthly', '2026-09-28')).toBe('2026-10-28');
    expect(nextOccurrence('2025-11-12', 'annual', '2026-09-22')).toBe('2026-11-12');
    expect(nextOccurrence('2026-09-22', 'monthly', '2026-09-22')).toBe('2026-10-22');
  });
});

describe('derived reminders', () => {
  it('one per lead, largest lead first, from the end of the expiry period', () => {
    expect(derivedFireDates('2031-03-31', [180, 270, 180])).toEqual([
      { lead: 270, fire_at: '2030-07-04' },
      { lead: 180, fire_at: '2030-10-02' },
    ]);
  });
});

describe('local calendar', () => {
  it('today and the hour follow the household time zone', () => {
    const at = new Date('2026-09-22T23:30:00Z');
    expect(localToday('UTC', at)).toBe('2026-09-22');
    expect(localToday('Asia/Kolkata', at)).toBe('2026-09-23');
    expect(localToday('America/Los_Angeles', at)).toBe('2026-09-22');
    expect(localHour('Asia/Kolkata', at)).toBe(5);
    expect(localHour('America/Los_Angeles', at)).toBe(16);
    expect(localToday('Not/AZone', at)).toBe('2026-09-22');
  });
});

describe('what a reminder is about (0.5.15)', () => {
  it('reminderAbout says today, tomorrow, in 7 days, in 9 months, 3 days ago', () => {
    const today = '2026-10-03';
    expect(reminderAbout('Due date', '2026-10-03', today)).toBe('Due date: 3 Oct, today');
    expect(reminderAbout('Due date', '2026-10-04', today)).toBe('Due date: 4 Oct, tomorrow');
    expect(reminderAbout('Due date', '2026-10-10', today)).toBe('Due date: 10 Oct, in 7 days');
    expect(reminderAbout('Expires', '2027-06-30', today)).toBe('Expires: 30 Jun 2027, in 9 months');
    expect(reminderAbout('MOT', '2026-09-30', today)).toBe('MOT: 30 Sept, 3 days ago');
    expect(reminderAbout('Review by', '2026-10-02', today)).toBe('Review by: 2 Oct, yesterday');
    expect(reminderAbout('Expires', '2031-03-14', today)).toBe('Expires: 14 Mar 2031, in 4 years');
  });

  it('a derived reminder is about its day plus its lead time; it has lapsed once that has passed', () => {
    const late = { kind: 'derived', fire_at: '2026-10-03', lead_days: 7 };
    expect(aboutDate(late)).toBe('2026-10-10');
    // A 7-day reminder, late, for a bill due in 5 days: not lapsed.
    expect(lapsed(late, '2026-10-05')).toBe(false);
    expect(lapsed(late, '2026-10-11')).toBe(true);
    // A manual reminder is about nothing but its own day.
    const manual = { kind: 'manual', fire_at: '2026-10-03', lead_days: null };
    expect(aboutDate(manual)).toBeNull();
    expect(lapsed(manual, '2026-10-04')).toBe(true);
  });
});

describe('labels', () => {
  it('reads like the prototype', () => {
    expect(reminderLabel('2026-10-02', '2026-09-20', 'due', null)).toBe('In 12 days · 2 Oct');
    expect(reminderLabel('2026-09-20', '2026-09-20', 'due', null)).toBe('Due today');
    expect(reminderLabel('2026-09-17', '2026-09-20', 'due', null)).toBe('Overdue by 3 days');
    expect(reminderLabel('2026-09-17', '2026-09-20', 'snoozed', '2026-10-17')).toBe(
      'Later · 17 Oct',
    );
  });
});
