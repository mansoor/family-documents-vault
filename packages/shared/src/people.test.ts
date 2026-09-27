import { describe, expect, it } from 'vitest';
import { initialsFor, shortName } from './people.js';

const family = (...names: string[]) =>
  names.map((display_name, i) => ({ id: `m-${i}`, display_name }));
const lettersOf = (...names: string[]) => [...initialsFor(family(...names)).values()];

describe('the letters in an avatar (5.17c)', () => {
  it('two people with the same surname and first letter get different initials: Aisha and Ahmed Khan are Ai and Ah; Sam Khan and Sam Malik are SK and SM; an unshared letter stays one letter', () => {
    expect(lettersOf('Mansoor Seikh', 'Aisha Khan', 'Ahmed Khan', 'Sam Khan', 'Sam Malik')).toEqual(
      ['M', 'Ai', 'Ah', 'SK', 'SM'],
    );
    // Alone, a letter is enough.
    expect(lettersOf('Aisha Khan', 'Mansoor Seikh')).toEqual(['A', 'M']);
    // Whoever else shares the letter decides it, whatever the case they wrote it in.
    expect(lettersOf('aisha', 'Ahmed')).toEqual(['Ai', 'Ah']);
    // Two letters shared too: first and last names, and a one-word name keeps its two.
    expect(lettersOf('Sam Khan', 'Sam Malik', 'Sara')).toEqual(['SK', 'SM', 'Sa']);
  });

  it('takes whole characters, in any script', () => {
    // Two astral characters: each is one letter, never half of a pair.
    expect(lettersOf('𝒜li', '𝒜dam')).toEqual(['𝒜l', '𝒜d']);
    expect(lettersOf('Ωmega', 'Łukasz')).toEqual(['Ω', 'Ł']);
    expect(lettersOf('   ')).toEqual(['?']);
  });
});

describe('the short name under an avatar', () => {
  it('is the first name, or the whole name where two first names match', () => {
    const names = shortName(family('Mansoor Seikh', 'Sam Khan', 'sam  Malik', 'Aisha'));
    expect([...names.values()]).toEqual(['Mansoor', 'Sam Khan', 'sam Malik', 'Aisha']);
  });
});
