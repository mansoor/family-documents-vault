import { describe, expect, it } from 'vitest';
import { graphemesOf, initialsFor, shortName } from './people.js';

const family = (...names: string[]) =>
  names.map((display_name, i) => ({ id: `m-${i}`, display_name }));
const lettersOf = (...names: string[]) => [...initialsFor(family(...names)).values()];
/** No two people's letters the same, told apart as a reader tells them. */
const allApart = (letters: string[]) =>
  expect(new Set(letters.map((l) => l.toLocaleLowerCase())).size).toBe(letters.length);

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

  it('keeps going until the people differ: where the first names part, then a middle name', () => {
    // The three steps left each of these pairs the same (the 5.17c review).
    expect(lettersOf('Sara Khan', 'Sam Khan')).toEqual(['Sr', 'Sm']);
    expect(lettersOf('Hassan Khan', 'Hasan Khan')).toEqual(['Hs', 'Ha']);
    expect(lettersOf('Muhammad Ali Khan', 'Muhammad Umar Khan')).toEqual(['MA', 'MU']);
    // A name that runs out first keeps the letters the first steps gave it.
    expect(lettersOf('Ali', 'Alia')).toEqual(['Al', 'Aa']);
    expect(lettersOf('Sam Khan', 'Samuel Khan')).toEqual(['SK', 'Su']);
    expect(lettersOf('Muhammad Khan', 'Muhammad Ali Khan')).toEqual(['MK', 'MA']);
    // With somebody who needed no more than the first steps, as well.
    expect(lettersOf('Hassan', 'Hasan Khan')).toEqual(['Ha', 'HK']);
    expect(lettersOf('Aisha', 'Ali', 'Alia', 'Alex')).toEqual(['Ai', 'Al', 'Aa', 'Ae']);
  });

  it('never gives two people the same two letters in different cases', () => {
    // Ali Khan's "AK" would read as Akbar's "Ak".
    const letters = lettersOf('Akbar', 'Ali Khan', 'Alia Khan', 'Aisha');
    allApart(letters);
    expect(letters).toEqual(['Ak', 'Ah', 'Aa', 'Ai']);
    for (const l of letters) expect(graphemesOf(l).length).toBeLessThanOrEqual(2);
    // A family that tells nobody apart by the first steps: all still apart.
    allApart(
      lettersOf('Sam Khan', 'Sam Kazmi', 'Sara Khan', 'Samuel Khan', 'Sana Khan', 'Saleem Khan'),
    );
  });

  it('only people with the same name share letters', () => {
    expect(lettersOf('Sam Khan', 'sam  khan', 'Sara')).toEqual(['SK', 'SK', 'Sa']);
    expect(lettersOf('Sam Khan', 'Sam Khan')).toEqual(['S', 'S']);
  });

  it('never splits a letter, and tells apart names in other scripts', () => {
    // Seema and Sita: "सी" is one letter, a consonant and its vowel sign.
    // Split by code point, both were "सी" (the vowel sign taken as the
    // second letter); whole, their second letters differ.
    expect(lettersOf('सीमा', 'सीता')).toEqual(['सीमा', 'सीता']);
    // A conjunct is one letter too: Kshama and Kamala start differently.
    expect(lettersOf('क्षमा', 'कमला')).toEqual(['क्ष', 'क']);
    expect(graphemesOf('सीमा')).toEqual(['सी', 'मा']);
    // An accent typed as a mark of its own is part of its letter.
    expect(lettersOf('Zoë', 'Zoa')).toEqual(['Zë', 'Za']);
    // Greek, Cyrillic, Chinese and Arabic families.
    expect(lettersOf('Γιώργος', 'Γιάννης')).toEqual(['Γώ', 'Γά']);
    expect(lettersOf('Александр Иванов', 'Алексей Иванов')).toEqual(['Аа', 'Ае']);
    expect(lettersOf('王小明', '王小红')).toEqual(['王明', '王红']);
    expect(lettersOf('محمد علي', 'محمد عمر')).toEqual(['مل', 'مم']);
  });
});

describe('the short name under an avatar', () => {
  it('is the first name, or the whole name where two first names match', () => {
    const names = shortName(family('Mansoor Seikh', 'Sam Khan', 'sam  Malik', 'Aisha'));
    expect([...names.values()]).toEqual(['Mansoor', 'Sam Khan', 'sam Malik', 'Aisha']);
  });
});
