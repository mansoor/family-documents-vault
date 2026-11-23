/**
 * Who issued it, as one household names it (0.9.0-dev.91): what a cabinet
 * is arranged by, and what the Documents table's Who issued it filter finds.
 *
 * `issued_by` is free text, so "Barclays", "BARCLAYS BANK UK PLC" and
 * "Barclays Bank UK" were three issuers. The vault keeps each paper's issuer
 * key beside it (`issuerKey`: case, accents, punctuation, the legal form and
 * a leading "The" gone), which makes the last two one. And the household
 * keeps a "Same as" list: someone says once that "Barclays Bank UK" is
 * "Barclays", and it is, for cabinets, the filter and the dividers alike.
 * No paper is changed.
 *
 *  - One level only: a key is said to be the same as a key that is nobody
 *    else's alias (its group's own key). Joining a group into another moves
 *    every key of it, and remembers what it moved (`AliasRow.path`):
 *    separating a key that brought others puts its group back as it was.
 *  - Never merged silently: keys whose words begin with another's ("Barclays
 *    Bank UK" and "Barclays") are only suggested (`sameAsSuggestions`), and
 *    the person says Same or Separate. Two said to be separate are not
 *    suggested again.
 *  - A group's name is its own key's most used spelling — the one chosen
 *    when the two were joined — else the most used spelling among its keys.
 *  - Everything here is worked out from the papers the reader can read:
 *    a key on nobody's paper they can read is in no group of theirs, and is
 *    never told to them. A group is known to them by its own key where they
 *    can read a paper of it, else by the one of its keys they have most
 *    papers of (`IssuerGroup.key`).
 */

import { issuerKey } from './issuers.js';

/**
 * The folder question's value for papers with no issuer given: never an
 * issuer key (`storedIssuerKey` never gives it).
 */
export const NO_ISSUER = '_none';
/** What papers with no issuer given are behind, as a folder, a drawer or a divider. */
export const NO_ISSUER_GIVEN = 'No issuer given';

/**
 * The longest key the vault keeps or takes, in characters. An issuer is at
 * most 200 characters, but folding a character can make several (a
 * ligature, a sign), so a key is cut here: never too long for its index.
 */
export const ISSUER_KEY_MAX = 400;

/** A key's text as it is kept: lower case, no commas (they separate a filter's keys), one space apart. */
const tidyKey = (s: string) => s.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The key the vault keeps beside a paper's `issued_by`: `issuerKey`'s; where
 * that leaves nothing to compare ("Ltd", "—"), the text itself, tidied, so a
 * paper that says who issued it is never filed as if it said nobody; at most
 * `ISSUER_KEY_MAX` characters. Null for no issuer at all.
 */
export function storedIssuerKey(issuedBy: string | null | undefined): string | null {
  if (!issuedBy || issuedBy.trim() === '') return null;
  const key = issuerKey(issuedBy) || tidyKey(issuedBy) || '-';
  const chars = Array.from(key);
  return chars.length <= ISSUER_KEY_MAX ? key : chars.slice(0, ISSUER_KEY_MAX).join('').trimEnd();
}

/**
 * Whether `v` may be an issuer key as the vault keeps one: some text, lower
 * case, no comma, single spaces between words and none at either end, at
 * most `ISSUER_KEY_MAX` characters — and never `NO_ISSUER`.
 */
export function isIssuerKey(v: string): boolean {
  return v !== '' && v !== NO_ISSUER && Array.from(v).length <= ISSUER_KEY_MAX && v === tidyKey(v);
}

/** One key, its most used spelling, and how many papers carry it, as the reader can read them. */
export interface IssuerName {
  key: string;
  name: string;
  count: number;
}

/**
 * An issuer as the household sees it: the key the reader knows it by — its
 * own where they can read a paper of it, else the one of its keys they have
 * most papers of — its name, how many of the reader's papers it holds, and
 * its other keys they can read papers of (`members`, the most used first;
 * none for an issuer joined to nothing).
 */
export interface IssuerGroup {
  key: string;
  name: string;
  count: number;
  members: IssuerName[];
}

/**
 * Two issuers that look like one: `from`'s papers would join `to`, the one
 * with more of them. Offered, never done.
 */
export interface IssuerSameAs {
  from: IssuerName;
  to: IssuerName;
}

/** GET /issuers/groups: the household's issuers, as the reader can read them. */
export interface IssuerGroups {
  items: IssuerGroup[];
  /** Issuers that look like one, never said separate: the most papers first. */
  same_as: IssuerSameAs[];
  /** Whether the reader may join and separate them: owners and adults. */
  may_change: boolean;
}

/**
 * POST /issuers/same: `from`'s issuer is the same as `to`'s — its whole group
 * joins `to`'s. POST /issuers/separate: `from` no longer is (or, never
 * joined, is never to be suggested as) the same as `to`.
 */
export interface IssuerChange {
  from: string;
  to: string;
}

/** The most suggestions given at once. */
export const SAME_AS_MOST = 50;

/** Code-unit order, lower case first: the same on every device, whatever its locale. */
export function compareIssuerNames(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The key a key is said to be the same as, or itself. */
export function issuerRoot(key: string, aliases: ReadonlyMap<string, string>): string {
  return aliases.get(key) ?? key;
}

/**
 * The reader's issuers in groups: each key (`names`, as their papers carry
 * it) under the key it is said to be the same as (`aliases`, from → to), or
 * its own. A group's key and name are its own key's, where the reader has a
 * paper of it, else its most used key's: a key they can read no paper of is
 * never given. In name order.
 */
export function issuerGroupsOf(
  names: readonly IssuerName[],
  aliases: ReadonlyMap<string, string>,
): IssuerGroup[] {
  const byRoot = new Map<string, IssuerName[]>();
  for (const n of names) {
    const root = issuerRoot(n.key, aliases);
    byRoot.set(root, [...(byRoot.get(root) ?? []), n]);
  }
  const most = (a: IssuerName, b: IssuerName) =>
    b.count - a.count || compareIssuerNames(a.name, b.name) || compareIssuerNames(a.key, b.key);
  return [...byRoot]
    .flatMap(([root, list]): IssuerGroup[] => {
      const sorted = [...list].sort(most);
      const known = list.find((n) => n.key === root) ?? sorted[0];
      if (!known) return [];
      return [
        {
          key: known.key,
          name: known.name,
          count: list.reduce((s, n) => s + n.count, 0),
          members: sorted.filter((n) => n.key !== known.key),
        },
      ];
    })
    .sort((a, b) => compareIssuerNames(a.name, b.name) || compareIssuerNames(a.key, b.key));
}

/** A pair of keys as it is kept apart: in order, so either way round is the same pair. */
export function apartPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Issuers that look like one (the leading-words rule): two groups where a
 * key of one is the first words of a key of the other — "Barclays" and
 * "Barclays Bank UK", "Aviva" and "Aviva Insurance". Never two said to be
 * separate (`apart`): by the keys that matched, or by the groups' own keys
 * (`aliases` says which those are, whether or not the reader can read them).
 * The smaller joins the bigger (`from` joins `to`); the most papers first.
 */
export function sameAsSuggestions(
  groups: readonly IssuerGroup[],
  apart: ReadonlyArray<readonly [string, string]> = [],
  aliases: ReadonlyMap<string, string> = new Map(),
  most = SAME_AS_MOST,
): IssuerSameAs[] {
  const root = (k: string) => issuerRoot(k, aliases);
  const kept = new Set(apart.map(([a, b]) => apartPair(a, b).join('\n')));
  const keptRoots = new Set(apart.map(([a, b]) => apartPair(root(a), root(b)).join('\n')));
  const isApart = (a: string, b: string) =>
    kept.has(apartPair(a, b).join('\n')) || keptRoots.has(apartPair(root(a), root(b)).join('\n'));
  const groupOf = new Map<string, IssuerGroup>();
  for (const g of groups) {
    groupOf.set(g.key, g);
    for (const m of g.members) groupOf.set(m.key, g);
  }
  const pairs = new Map<string, IssuerSameAs & { n: number }>();
  for (const [key, g] of groupOf) {
    const words = key.split(' ');
    for (let i = 1; i < words.length; i += 1) {
      const lead = words.slice(0, i).join(' ');
      const other = groupOf.get(lead);
      if (!other || other === g) continue;
      if (isApart(lead, key) || isApart(g.key, other.key)) continue;
      const [to, from] =
        g.count > other.count ||
        (g.count === other.count && compareIssuerNames(g.name, other.name) < 0)
          ? [g, other]
          : [other, g];
      const id = apartPair(from.key, to.key).join('\n');
      if (pairs.has(id)) continue;
      pairs.set(id, {
        from: { key: from.key, name: from.name, count: from.count },
        to: { key: to.key, name: to.name, count: to.count },
        n: from.count + to.count,
      });
    }
  }
  return [...pairs.values()]
    .sort(
      (a, b) =>
        b.n - a.n ||
        compareIssuerNames(a.to.name, b.to.name) ||
        compareIssuerNames(a.from.name, b.from.name),
    )
    .slice(0, most)
    .map(({ from, to }) => ({ from, to }));
}

/**
 * One row of the household's "Same as" list: `from` is the same issuer as
 * `to`, and before a join moved it, it was the same as each of `path`, the
 * nearest first.
 */
export interface AliasRow {
  from: string;
  to: string;
  path: string[];
}

/** The list as a map, from → to. */
export const aliasMap = (rows: readonly AliasRow[]): Map<string, string> =>
  new Map(rows.map((r) => [r.from, r.to] as const));

/**
 * The list after `from` is said to be the same as `to` (one level only):
 * `from`'s group — its own key and every key said to be the same as it —
 * now points at `to`'s own key, each row that moved remembering the key it
 * followed. Unchanged where they are one already.
 */
export function joinAliases(rows: readonly AliasRow[], from: string, to: string): AliasRow[] {
  const map = aliasMap(rows);
  const fromRoot = issuerRoot(from, map);
  const toRoot = issuerRoot(to, map);
  if (fromRoot === toRoot) return rows.map((r) => ({ ...r, path: [...r.path] }));
  return [
    ...rows.map((r) =>
      r.to === fromRoot ? { from: r.from, to: toRoot, path: [fromRoot, ...r.path] } : { ...r },
    ),
    { from: fromRoot, to: toRoot, path: [] },
  ];
}

/**
 * The list after `leaving` is separated from its group: its own row goes,
 * and every row it brought with it when it was joined — those that followed
 * it once, however many joins moved them since (it is in their path) —
 * follows it again, remembering only what it followed before `leaving`
 * (the rest of its path, nearest first). So separating HSBC, joined to
 * Barclays with HSBC UK, brings HSBC UK back with it; and where A joined B,
 * B joined C and C joined D, separating B brings A back with B, separating
 * C brings A and B back with C.
 */
export function separateAliases(rows: readonly AliasRow[], leaving: string): AliasRow[] {
  return rows
    .filter((r) => r.from !== leaving)
    .map((r) =>
      r.path.includes(leaving)
        ? { from: r.from, to: leaving, path: r.path.slice(r.path.indexOf(leaving) + 1) }
        : { ...r, path: [...r.path] },
    );
}

/**
 * Which of two keys of one group leaves it when they are said to be
 * separate: the one said to be the same as the other's group — `a` where
 * both are, `b` where only it is. Null where they are not one.
 */
export function leavingKey(
  aliases: ReadonlyMap<string, string>,
  a: string,
  b: string,
): string | null {
  if (issuerRoot(a, aliases) !== issuerRoot(b, aliases)) return null;
  return aliases.has(a) ? a : b;
}
