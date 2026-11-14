import { describe, expect, it } from 'vitest';
import { addDays } from './reminders.js';
import {
  isChildRelationship,
  keepsOwnSensitive,
  linkShowsTitle,
  sensitiveCollectionShareConfirm,
  sensitiveNotFollowed,
  sensitiveStartingVisibility,
  UNTITLED_ON_LINK,
} from './sensitive.js';

/** Today, as the household's calendar says it, for the rule. */
const TODAY = new Date().toISOString().slice(0, 10);
/** Born `years` years before today, to the day: that old today. */
const aged = (years: number) =>
  `${String(Number(TODAY.slice(0, 4)) - years).padStart(4, '0')}${TODAY.slice(4)}`;

describe('whose own sensitive papers start as Only me (0.9.0, H1a)', () => {
  it('a teen, by role or by age; a grown-up child by age and relationship; nobody else', () => {
    const cases: Array<[string, Parameters<typeof keepsOwnSensitive>[0], boolean]> = [
      ['a teen, no date of birth', { role: 'teen' }, true],
      ['a teen, 15', { role: 'teen', date_of_birth: aged(15) }, true],
      ['13 today, any role', { role: 'adult', date_of_birth: aged(13) }, true],
      ['17, the day before 18', { role: 'adult', date_of_birth: addDays(aged(18), 1) }, true],
      ['18 today, a son', { role: 'adult', date_of_birth: aged(18), relationship: 'Son' }, true],
      [
        '30, a daughter',
        { role: 'owner', date_of_birth: aged(30), relationship: 'daughter' },
        true,
      ],
      ['22, a child', { role: 'adult', date_of_birth: aged(22), relationship: 'Child' }, true],
      ['22, “our son”', { role: 'adult', date_of_birth: aged(22), relationship: 'our son' }, true],
      ['22, no relationship', { role: 'adult', date_of_birth: aged(22) }, false],
      ['45, Mum', { role: 'adult', date_of_birth: aged(45), relationship: 'Mum' }, false],
      ['22, a stepson', { role: 'adult', date_of_birth: aged(22), relationship: 'stepson' }, false],
      // No date of birth: a child of the family who signs in as an adult is grown.
      ['a son of no known age, an adult', { role: 'adult', relationship: 'son' }, true],
      ['an adopted son of no known age', { role: 'adult', relationship: 'Adopted son' }, true],
      ['a daughter of no known age, an owner', { role: 'owner', relationship: 'daughter' }, false],
      ['a son of no known age, a viewer', { role: 'viewer', relationship: 'son' }, false],
      ['a stepson of no known age, an adult', { role: 'adult', relationship: 'stepson' }, false],
      [
        '25, eldest daughter',
        { role: 'adult', date_of_birth: aged(25), relationship: 'eldest daughter' },
        true,
      ],
      [
        '25, son-in-law',
        { role: 'adult', date_of_birth: aged(25), relationship: 'son-in-law' },
        false,
      ],
      ['12, a child (no sign-in of their own)', { role: 'adult', date_of_birth: aged(12) }, false],
      ['an owner, nothing said', { role: 'owner' }, false],
    ];
    expect(cases.map(([what, who]) => [what, keepsOwnSensitive(who, TODAY)])).toEqual(
      cases.map(([what, , want]) => [what, want]),
    );
  });

  it('the relationships that make one a child of the family', () => {
    for (const r of [
      'child',
      'Son',
      ' DAUGHTER ',
      'my son',
      'our  daughter',
      'the child',
      'adopted son',
      'Eldest daughter',
      'son (Ali)',
      'foster child',
    ]) {
      expect(isChildRelationship(r), r).toBe(true);
    }
    for (const r of [
      null,
      undefined,
      '',
      'sons',
      'grandson',
      'son-in-law',
      'daughter in law',
      'stepson',
      'step daughter',
      'Step-child',
      'godson',
      'god daughter',
      'godchild',
      'nephew',
      'Mum',
      'Sonia',
    ]) {
      expect(isChildRelationship(r), String(r)).toBe(false);
    }
  });

  it('only narrows: Only me for one’s own sensitive paper when the rule keeps it so; else as it was', () => {
    for (const base of ['household', 'adults', 'private'] as const) {
      expect(sensitiveStartingVisibility(base, { sensitive: true, own: true, keeps: true })).toBe(
        'private',
      );
      for (const o of [
        { sensitive: false, own: true, keeps: true },
        { sensitive: true, own: false, keeps: true },
        { sensitive: true, own: true, keeps: false },
      ]) {
        expect(sensitiveStartingVisibility(base, o), JSON.stringify(o)).toBe(base);
      }
    }
  });
});

describe('a link’s page and its words (0.9.0, H1a)', () => {
  it('shows a title as its sharer chose; nothing chosen, not a sensitive one’s', () => {
    expect(linkShowsTitle(true, true)).toBe(true);
    expect(linkShowsTitle(false, false)).toBe(false);
    expect(linkShowsTitle(null, true)).toBe(false);
    expect(linkShowsTitle(undefined, false)).toBe(true);
  });

  it('says how many are sensitive, and what a batch kept in the family', () => {
    expect(sensitiveCollectionShareConfirm(1)).toMatch(/^One of the documents ticked is sensitive/);
    expect(sensitiveCollectionShareConfirm(3)).toMatch(/^3 of the documents ticked are sensitive/);
    expect(sensitiveNotFollowed('Will')).toMatch(/^“Will” is sensitive/);
    expect(sensitiveNotFollowed(null)).toMatch(/^A document is sensitive/);
    expect(UNTITLED_ON_LINK).toBe('A document');
  });
});
