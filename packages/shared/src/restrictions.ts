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
  /**
   * Whether it names people, or kinds, at all (0054): named, and every one
   * of them deleted since, they give nothing — never "anybody's" or "any
   * kind". Absent, as many as are counted.
   */
  limits_people?: boolean;
  limits_types?: boolean;
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
  // As the rule reads them (doc_in_grant, 0054): people, or kinds, are named
  // when the restriction says so or any is counted; named with none left,
  // they match nothing.
  const namesPeople = r.limits_people === true || r.people > 0;
  const namesTypes = r.limits_types === true || r.types > 0;
  const peopleGone = namesPeople && r.people === 0;
  const typesGone = namesTypes && r.types === 0;
  const kinds = r.types > 0 ? ` of ${plural(r.types, 'kind', 'kinds')}` : '';
  const parts: string[] = [];
  // Nothing by person or kind once every kind named is gone.
  if (!typesGone) {
    if (r.people > 0) {
      parts.push(`${plural(r.people, "person's", "people's")} documents${kinds}`);
    } else if (!namesPeople && r.types > 0) {
      parts.push(`everyone's documents${kinds}`);
    }
    // Of the same kinds, when kinds are named: "… of 3 kinds and those that
    // belong to no one".
    if (r.include_no_person_docs) {
      parts.push(
        r.types > 0 && parts.length > 0
          ? 'those that belong to no one'
          : `documents${kinds} that belong to no one`,
      );
    }
  }
  if (r.collections > 0) parts.push(plural(r.collections, 'collection', 'collections'));
  const sees =
    parts.length === 0
      ? 'Restricted: sees nothing of anyone else’s.'
      : `Restricted: sees ${listed(parts)}.`;
  // Said, so that nobody reads a deleted kind or person as "any" (the 5.32
  // review, N532T-01).
  const gone = typesGone
    ? ' Every kind it named has been deleted, so it gives no documents by person or kind.'
    : peopleGone
      ? ' Everyone it named has been removed, so it gives none of their documents.'
      : '';
  const adults = r.include_adults_only ? ' Adults-only documents included.' : '';
  const ends = until ? ` Until ${shareEndWords(until, timezone)}.` : '';
  return `${sees}${gone}${adults}${ends}`;
}

// ------------------------------------------------- limits on the wire (5.33)

/**
 * What a viewer is given (5.33): PUT /members/{id}/access, an invitation's
 * `restriction`, and GET /members/{id}/access/preview. Whose documents
 * (`people`, member ids), of which kinds (`types`, type keys) — the two
 * narrow together (A56) — and which collections (`collections`, ids; only
 * one for Everyone, A17), a separate way in. Documents that belong to no
 * one only with `include_no_person_docs` (A57); Adults only ones only with
 * `include_adults_only`, an owner's alone (D6, A27). Their own documents
 * always; nothing at all after `expires_at`.
 */
export interface AccessGrant {
  people: string[];
  types: string[];
  collections: string[];
  include_adults_only: boolean;
  include_no_person_docs: boolean;
  expires_at: string | null;
}

/** How many of each an `AccessGrant` may name. */
export const ACCESS_GRANT_MAX = { people: 100, types: 200, collections: 100 } as const;

const NARROWER: Record<string, string> = {
  teens: 'Teens and up',
  adults: 'Adults',
  only_me: 'its maker alone',
};

/**
 * Said of a collection that is not for Everyone, refused in a grant (A17,
 * 5.33): only an Everyone collection is ever given to a viewer.
 */
export const onlyEveryone = (name: string, audience: string): string =>
  `“${name}” is for ${NARROWER[audience] ?? 'fewer people than everyone'}, so it cannot be given to a viewer. Only a collection for Everyone in the family can be.`;

/**
 * Somebody's limits as an owner sees them (5.33): PUT /members/{id}/access,
 * and `MemberAccount.access`.
 */
export interface MemberAccess extends AccessGrant {
  member_id: string;
  /** `restrictionSummary`'s sentence: "Restricted: sees 1 person's documents of 2 kinds." */
  summary: string;
  /**
   * Their sign-in was given back, or moved onto them, since an owner last
   * confirmed these limits (0054): an owner confirms them again by putting
   * the same grant. Null when nothing waits.
   */
  reconfirm_since: string | null;
  /** They keep Only me documents, and an owner confirmed limiting them anyway (A59). */
  private_confirmed: boolean;
  updated_at: string;
}

/**
 * "They will see 14 documents" (5.33, GET /members/{id}/access/preview): a
 * grant not yet saved, counted now, as the rule (0054) will give it.
 */
export interface AccessPreview {
  /**
   * The documents they would see — out of the Trash, every one the grant
   * gives — but for their own Only me documents, whose number nobody else
   * is told.
   */
  documents: number;
  /** They keep Only me documents, which they go on seeing too (A59). */
  keeps_private: boolean;
}

/**
 * `/me.restriction` (5.33): what a restricted viewer is given, in their own
 * words — the people, kinds and collections named, each as the vault gives
 * it to them (one deleted since is not named). Null for anybody not
 * restricted.
 */
export interface MyRestriction {
  /** "You can see: Tax return documents for Ahmed, and your own." */
  summary: string;
  people: Array<{ id: string; display_name: string }>;
  types: Array<{ key: string; label: string }>;
  collections: Array<{ id: string; name: string }>;
  include_adults_only: boolean;
  include_no_person_docs: boolean;
  expires_at: string | null;
}

/** What `youCanSee` is told: the names, and whether people and kinds are named at all. */
export interface NamedGrant {
  people: Array<{ display_name: string }>;
  types: Array<{ label: string }>;
  collections: Array<{ name: string }>;
  include_no_person_docs: boolean;
  expires_at: Date | string | null;
  /** It names people, or kinds, at all (0054): named, and every one gone since, they give nothing. */
  limits_people?: boolean;
  limits_types?: boolean;
}

/**
 * A restricted viewer's Home, in a sentence (5.33): "You can see: Tax
 * return documents for Ahmed, the collection “For the accountant” and your
 * own." What the rule gives (0054, doc_in_grant): their own always; the
 * people and the kinds together; a collection separately; nothing at all
 * once it has ended.
 */
export function youCanSee(r: NamedGrant, timezone: string, now: number = Date.now()): string {
  const until = r.expires_at === null ? null : new Date(r.expires_at);
  if (until && until.getTime() <= now) {
    return 'An owner limited what you can see, and it has ended: you see nothing for now.';
  }
  const namesPeople = r.limits_people === true || r.people.length > 0;
  const namesTypes = r.limits_types === true || r.types.length > 0;
  // Kinds named, and every one deleted since: nothing by person or kind;
  // people named and all gone: no person's, nobody's still with the
  // checkbox (R532-01, as doc_in_grant reads them).
  const typesGone = namesTypes && r.types.length === 0;
  const kinds = r.types.length > 0 ? `${listed(r.types.map((t) => t.label))} documents` : null;
  const parts: string[] = [];
  if (!typesGone) {
    if (r.people.length > 0) {
      parts.push(`${kinds ?? 'documents'} for ${listed(r.people.map((p) => p.display_name))}`);
    } else if (!namesPeople && kinds) {
      parts.push(kinds);
    }
    if (r.include_no_person_docs) {
      parts.push(`${kinds ?? 'documents'} that belong to no one`);
    }
  }
  if (r.collections.length > 0) {
    const names = listed(r.collections.map((c) => `“${c.name}”`));
    parts.push(r.collections.length === 1 ? `the collection ${names}` : `the collections ${names}`);
  }
  const ends = until ? ` Until ${shareEndWords(until, timezone)}.` : '';
  if (parts.length === 0) return `You can see: only your own documents.${ends}`;
  return `You can see: ${listed([...parts, 'your own'])}.${ends}`;
}
