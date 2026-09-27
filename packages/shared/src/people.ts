/**
 * The family's names, as the screens show them (5.17c): the letters in an
 * avatar with no photo, and the short name under it.
 *
 * Both are worked out for the whole family at once, because what tells two
 * people apart depends on who else there is: Aisha is "A" until Ahmed
 * joins, and then Aisha and Ahmed are "Ai" and "Ah". Letters are taken with
 * `Array.from`, so a name in any script gives whole characters, never half
 * of one.
 */

export interface Named {
  id: string;
  display_name: string;
}

/** A name's words, spaces tidied. */
function words(name: string): string[] {
  return name.trim().split(/\s+/).filter(Boolean);
}

const upper = (s: string) => s.toLocaleUpperCase();
const lower = (s: string) => s.toLocaleLowerCase();

/** The first `n` characters of a word, as whole characters. */
const head = (word: string | undefined, n: number) =>
  Array.from(word ?? '')
    .slice(0, n)
    .join('');

/**
 * Each person's letters, by id. One letter, unless somebody else's starts
 * the same; then the first two letters of their first name (Aisha and Ahmed
 * Khan: "Ai" and "Ah"); where those are shared too, the first letters of
 * their first and last names (Sam Khan and Sam Malik: "SK" and "SM"). A
 * one-word name has no last name, and keeps its two letters.
 */
export function initialsFor(members: ReadonlyArray<Named>): Map<string, string> {
  const people = members.map((m) => {
    const w = words(m.display_name);
    const first = w[0] ?? '';
    const one = upper(head(first, 1));
    const two = `${one}${lower(Array.from(first).slice(1, 2).join(''))}`;
    const last = w.length > 1 ? w[w.length - 1] : undefined;
    const both = last ? `${one}${upper(head(last, 1))}` : two;
    return { id: m.id, one, two, both };
  });
  const count = (key: 'one' | 'two', value: string, among: typeof people) =>
    among.filter((p) => p[key] === value).length;
  const out = new Map<string, string>();
  for (const p of people) {
    if (count('one', p.one, people) <= 1) {
      out.set(p.id, p.one || '?');
      continue;
    }
    const sharing = people.filter((q) => q.one === p.one);
    out.set(p.id, count('two', p.two, sharing) <= 1 ? p.two : p.both);
  }
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
    const same = firsts.filter((q) => lower(q.first) === lower(p.first)).length;
    out.set(p.id, same > 1 ? p.full : p.first);
  }
  return out;
}
