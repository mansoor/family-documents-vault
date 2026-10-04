import { shareEndWords } from './shares.js';

/**
 * A restriction on what a viewer sees (5.32, A56–A59), as counted from the
 * database: how many people, kinds and collections it names, and its
 * checkboxes. 5.33 gives owners the screens to make and change one; until
 * then it is shown, read-only, where an owner confirms a sign-in after a
 * restore (A55).
 */
export interface RestrictionCounts {
  people: number;
  types: number;
  collections: number;
  include_adults_only: boolean;
  include_no_person_docs: boolean;
  expires_at: Date | string | null;
}

/** A restriction as an owner is shown it beside a paused sign-in (A55): a sentence. */
export interface RestrictionSummary {
  summary: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "a, b and c" */
function listed(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The restriction in a sentence, for an owner: "Restricted: sees 2 people's
 * documents of 3 kinds, and 1 collection. Adults-only documents included.
 * Until Monday 5 October at 09:00." What the database gives within it is
 * the rule (0054): their own documents always, the people and the kinds
 * together, a granted collection separately; nothing at all once it has run
 * out. It counts; it never names a person, a kind or a collection.
 */
export function restrictionSummary(
  r: RestrictionCounts,
  timezone: string,
  now: number = Date.now(),
): string {
  const until = r.expires_at === null ? null : new Date(r.expires_at);
  if (until && until.getTime() <= now) {
    return `Restricted, and ended ${shareEndWords(until, timezone)}: sees nothing.`;
  }
  const kinds = r.types > 0 ? ` of ${plural(r.types, 'kind', 'kinds')}` : '';
  const parts: string[] = [];
  if (r.people > 0) {
    parts.push(`${plural(r.people, "person's", "people's")} documents${kinds}`);
  } else if (r.types > 0) {
    parts.push(`everyone's documents${kinds}`);
  }
  // Of the same kinds, when kinds are named: "… of 3 kinds and those that
  // belong to no one".
  if (r.include_no_person_docs) {
    parts.push(r.types > 0 ? 'those that belong to no one' : 'documents that belong to no one');
  }
  if (r.collections > 0) parts.push(plural(r.collections, 'collection', 'collections'));
  const sees =
    parts.length === 0
      ? 'Restricted: sees nothing of anyone else’s.'
      : `Restricted: sees ${listed(parts)}.`;
  const adults = r.include_adults_only ? ' Adults-only documents included.' : '';
  const ends = until ? ` Until ${shareEndWords(until, timezone)}.` : '';
  return `${sees}${adults}${ends}`;
}
