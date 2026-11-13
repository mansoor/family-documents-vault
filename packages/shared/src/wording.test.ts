import { describe, expect, it } from 'vitest';
import {
  myWordingNeedsStepUp,
  neutralUnder,
  rulesFor,
  rulesInEffect,
  wordingExamples,
  wordingNeedsStepUp,
  type MyWording,
  type NeutralWording,
} from './wording.js';

/**
 * Neutral wording (H2): the choices are sets of documents — Off none,
 * Health the Medical ones, Sensitive the sensitive ones, All every one —
 * and Health and Sensitive overlap without either holding the other.
 */

const DOCS = {
  neither: { sensitive: false, health: false },
  health: { sensitive: false, health: true },
  sensitive: { sensitive: true, health: false },
  both: { sensitive: true, health: true },
};

describe('which household changes ask the owner to confirm it’s them', () => {
  // from → to: whether some document left unnamed before is named after.
  const TABLE: Array<[NeutralWording, NeutralWording, boolean]> = [
    ['off', 'off', false],
    ['off', 'health', false],
    ['off', 'sensitive', false],
    ['off', 'all', false],
    ['health', 'off', true],
    ['health', 'health', false],
    ['health', 'sensitive', true],
    ['health', 'all', false],
    ['sensitive', 'off', true],
    ['sensitive', 'health', true],
    ['sensitive', 'sensitive', false],
    ['sensitive', 'all', false],
    ['all', 'off', true],
    ['all', 'health', true],
    ['all', 'sensitive', true],
    ['all', 'all', false],
  ];
  it.each(TABLE)('%s → %s: %s', (from, to, asks) => {
    expect(wordingNeedsStepUp(from, to)).toBe(asks);
    // The same, worked out from the documents themselves.
    const named = Object.values(DOCS).some(
      (d) => neutralUnder([from], d) && !neutralUnder([to], d),
    );
    expect(named).toBe(asks);
  });
});

describe('a person’s own choice: the union with the household’s', () => {
  const RULES: NeutralWording[] = ['off', 'health', 'sensitive', 'all'];
  const MINE: MyWording[] = ['household', 'health', 'sensitive', 'all'];

  it('never names what the household’s choice hides', () => {
    for (const household of RULES) {
      for (const mine of MINE) {
        for (const d of Object.values(DOCS)) {
          if (neutralUnder([household], d)) {
            expect(neutralUnder(rulesFor(household, mine), d), `${household}/${mine}`).toBe(true);
          }
        }
      }
    }
  });

  it('says what is in effect simply', () => {
    expect(rulesInEffect('off', 'household')).toEqual(['off']);
    expect(rulesInEffect('health', 'sensitive')).toEqual(['health', 'sensitive']);
    expect(rulesInEffect('sensitive', 'health')).toEqual(['health', 'sensitive']);
    expect(rulesInEffect('all', 'health')).toEqual(['all']);
    expect(rulesInEffect('off', 'all')).toEqual(['all']);
    expect(rulesInEffect('sensitive', 'sensitive')).toEqual(['sensitive']);
  });

  it('asks them to confirm it’s them only when what they are sent would name more', () => {
    // As the household says, from Health under Sensitive: Medical documents named again.
    expect(myWordingNeedsStepUp('sensitive', 'health', 'household')).toBe(true);
    expect(myWordingNeedsStepUp('sensitive', 'household', 'health')).toBe(false);
    // The household's All already hides everything: nothing more is named.
    expect(myWordingNeedsStepUp('all', 'health', 'household')).toBe(false);
    expect(myWordingNeedsStepUp('off', 'all', 'sensitive')).toBe(true);
    expect(myWordingNeedsStepUp('off', 'sensitive', 'all')).toBe(false);
    expect(myWordingNeedsStepUp('health', 'sensitive', 'health')).toBe(true);
    expect(myWordingNeedsStepUp('health', 'household', 'health')).toBe(false);
    // Checked against the documents, every way.
    for (const household of RULES) {
      for (const from of MINE) {
        for (const to of MINE) {
          const named = Object.values(DOCS).some(
            (d) =>
              neutralUnder(rulesFor(household, from), d) &&
              !neutralUnder(rulesFor(household, to), d),
          );
          expect(myWordingNeedsStepUp(household, from, to), `${household}: ${from}→${to}`).toBe(
            named,
          );
        }
      }
    }
  });

  it('the examples say each document as the choices would', () => {
    expect(wordingExamples(['health'])).toEqual({
      sensitive: 'Sara’s passport — Expires: 20 Nov, in 7 days',
      health: 'A reminder about a document — Due in 7 days',
      ordinary: 'Car insurance — Expires: 20 Nov, in 7 days',
    });
    expect(Object.values(wordingExamples(['all']))).toEqual(
      Array(3).fill('A reminder about a document — Due in 7 days'),
    );
    expect(wordingExamples(['health', 'sensitive']).ordinary).toMatch(/^Car insurance/);
  });
});
