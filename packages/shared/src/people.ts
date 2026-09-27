/**
 * The family's names, as the screens show them (5.17c): the letters in an
 * avatar with no photo, and the short name under it.
 *
 * Both are worked out for the whole family at once, because what tells two
 * people apart depends on who else there is: Aisha is "A" until Ahmed
 * joins, and then Aisha and Ahmed are "Ai" and "Ah". A letter is what a
 * reader sees as one — a grapheme cluster, from `Intl.Segmenter` — so an
 * accent, a vowel sign or a conjunct is never split from its letter.
 */

export interface Named {
  id: string;
  display_name: string;
}

const graphemes =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/**
 * A word's letters, each as a reader sees it: "सीमा" is "सी" and "मा", never
 * "स" and a vowel sign on its own. Where the platform has no Intl.Segmenter,
 * a letter keeps the marks that follow it.
 */
export function graphemesOf(word: string): string[] {
  if (graphemes) return Array.from(graphemes.segment(word), (s) => s.segment);
  return word.match(/\P{M}\p{M}*/gu) ?? [];
}

/** A name's words, spaces tidied and letters composed ("e" and "¨" are "ë"). */
function words(name: string): string[] {
  return name.normalize('NFC').trim().split(/\s+/).filter(Boolean);
}

/** A letter as a capital, where its script has them, and still one letter ("ß" stays "ß"). */
const upper = (g: string) => {
  const u = g.toLocaleUpperCase();
  return graphemesOf(u).length === 1 ? u : g;
};
const lower = (g: string) => {
  const l = g.toLocaleLowerCase();
  return graphemesOf(l).length === 1 ? l : g;
};
/** Letters compared as a reader tells them apart: "Ak" and "AK" are the same two. */
const fold = (s: string) => s.toLocaleLowerCase();

interface Person {
  first: string[];
  others: string[][];
  code: string;
  /** The letters the first three steps gave them. */
  natural: string;
}

/**
 * The places, in order, that the letters after the first are taken from.
 * Each gives a person's letter there, or null where they have none. The
 * first two are the long-standing steps; the rest are only asked where
 * those left two people the same.
 */
function places(people: Person[]): Array<(p: Person) => string | null> {
  const most = (n: (p: Person) => number) => Math.max(0, ...people.map(n));
  const out: Array<(p: Person) => string | null> = [
    // The first name's second letter: Aisha and Ahmed, "Ai" and "Ah".
    (p) => (p.first[1] === undefined ? null : lower(p.first[1])),
    // The last name's first letter: Sam Khan and Sam Malik, "SK" and "SM".
    // A one-word name has none, and keeps its two.
    (p) => {
      const last = p.others[p.others.length - 1];
      return last?.[0] === undefined ? null : upper(last[0]);
    },
  ];
  // The first name's letter where two first names part: Sara and Sam Khan,
  // "Sr" and "Sm"; Hassan and Hasan Khan, "Hs" and "Ha".
  for (let k = 2; k < most((p) => p.first.length); k++) {
    out.push((p) => (p.first[k] === undefined ? null : lower(p.first[k] as string)));
  }
  // A middle name's first letter, where first names are the same: Muhammad
  // Ali Khan and Muhammad Umar Khan, "MA" and "MU".
  for (let j = 0; j < most((p) => p.others.length - 1); j++) {
    out.push((p) =>
      j < p.others.length - 1 && p.others[j]?.[0] !== undefined
        ? upper(p.others[j]?.[0] as string)
        : null,
    );
  }
  // Last of all, the other names' other letters.
  for (let j = 0; j < most((p) => p.others.length); j++) {
    for (let k = 1; k < most((p) => p.others[j]?.length ?? 0); k++) {
      out.push((p) => {
        const letter = p.others[j]?.[k];
        return letter === undefined ? null : lower(letter);
      });
    }
  }
  return out;
}

/**
 * Each person's letters, by id: at most two, and different for different
 * people wherever their names allow it. One letter, unless somebody else's
 * starts the same; then the first two letters of their first name (Aisha
 * and Ahmed Khan: "Ai" and "Ah"); where those are shared too, the first
 * letters of their first and last names (Sam Khan and Sam Malik: "SK" and
 * "SM"; a one-word name keeps its two). Where that still leaves two the
 * same, their first letter and the letter where their first names part
 * (Sara and Sam Khan: "Sr" and "Sm"), then a middle name's (Muhammad Ali
 * and Muhammad Umar Khan: "MA" and "MU"). Somebody whose name runs out
 * first keeps the letters the first steps gave them (Ali and Alia: "Al"
 * and "Aa").
 *
 * Letters are told apart as a reader tells them, whatever their case: "Ak"
 * and "AK" are never two people's. Only people with the same name share
 * letters (their photo, or their name beside it, tells them apart), and
 * the rare two whose letters could never differ are written the same.
 */
export function initialsFor(members: ReadonlyArray<Named>): Map<string, string> {
  // One entry for each name: however it is spaced or cased, the same name
  // has nothing in its letters to tell its people apart.
  const byName = new Map<string, Person>();
  const whose = new Map<string, Person>();
  for (const m of members) {
    const w = words(m.display_name);
    const key = fold(w.join(' '));
    let p = byName.get(key);
    if (!p) {
      const first = graphemesOf(w[0] ?? '');
      const code = first[0] === undefined ? '?' : upper(first[0]);
      p = { first, others: w.slice(1).map(graphemesOf), code, natural: code };
      byName.set(key, p);
    }
    whose.set(m.id, p);
  }
  const people = [...byName.values()];
  const clashes = (p: Person) => people.some((q) => q !== p && fold(q.code) === fold(p.code));

  // Everybody sharing their letters takes the next place's letter, together,
  // until each is somebody's alone.
  let open = people.filter(clashes);
  const at = places(people);
  at.forEach((letterAt, i) => {
    if (open.length === 0) return;
    for (const p of open) {
      const letter = letterAt(p);
      if (letter !== null) p.code = `${upper(p.first[0] as string)}${letter}`;
      // Run out after the first steps: the letters those gave.
      else if (i >= 2) p.code = p.natural;
      if (i === 1) p.natural = p.code;
    }
    open = open.filter(clashes);
  });

  // Rarely, somebody's letters are still somebody else's: a name that ran
  // out landed on a code another took further on (Ann Ali and Anna Ali, Sam
  // Ali and Sam Alia; the 5.17c review). A last pass gives each person
  // letters of their own wherever the family's names allow it, choosing, in
  // order, the letters they have now, the first steps', then their first
  // letter with each place's letter of theirs, then their first letter
  // alone: a matching, so one person's choice never takes the only letters
  // another could have (whose letters were already their own keep them
  // unless that is the only way).
  if (people.some(clashes)) {
    const choices = (p: Person): string[] => {
      const initial = p.first[0] === undefined ? null : upper(p.first[0]);
      const list = [p.code, p.natural];
      if (initial !== null) {
        for (const letterAt of at) {
          const letter = letterAt(p);
          if (letter !== null) list.push(`${initial}${letter}`);
        }
        list.push(initial);
      }
      const seen = new Set<string>();
      return list.filter((c) => !seen.has(fold(c)) && Boolean(seen.add(fold(c))));
    };
    const holder = new Map<string, Person>();
    const chosen = new Map<Person, string>();
    const take = (p: Person, tried: Set<string>): boolean => {
      for (const c of choices(p)) {
        const key = fold(c);
        if (tried.has(key)) continue;
        tried.add(key);
        const other = holder.get(key);
        if (!other || take(other, tried)) {
          holder.set(key, p);
          chosen.set(p, c);
          return true;
        }
      }
      return false;
    };
    // Whose letters are their own first, so they keep them.
    for (const p of [...people.filter((q) => !clashes(q)), ...people.filter(clashes)]) {
      take(p, new Set());
    }
    for (const p of people) p.code = chosen.get(p) ?? p.code;
  }

  // The same letters, however cased, are written the same.
  const written = new Map<string, string>();
  for (const p of people) {
    const as = written.get(fold(p.code));
    if (as === undefined) written.set(fold(p.code), p.code);
    else p.code = as;
  }
  const out = new Map<string, string>();
  for (const [id, p] of whose) out.set(id, p.code);
  return out;
}

/**
 * Each person's name as a chip or a pill says it, by id: their first name,
 * or their whole name where somebody else has the same first name (Sam Khan
 * and Sam Malik are not both "Sam").
 */
export function shortName(members: ReadonlyArray<Named>): Map<string, string> {
  const firsts = members.map((m) => ({
    id: m.id,
    full: words(m.display_name).join(' '),
    first: words(m.display_name)[0] ?? '',
  }));
  const out = new Map<string, string>();
  for (const p of firsts) {
    const same = firsts.filter((q) => fold(q.first) === fold(p.first)).length;
    out.set(p.id, same > 1 ? p.full : p.first);
  }
  return out;
}
