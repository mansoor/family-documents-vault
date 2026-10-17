/**
 * Tags (Phase 1; details, bulk and management in 0.9.0, T1): short words a
 * person writes on a document — "travel", "house" — and, since 0.9.0,
 * detail tags for a one-off fact that does not deserve a field of its own:
 * "locker: 12", "policy holder: Ahmed", "agent: Sam Lee".
 *
 * The rule, everywhere — the vault, its SQL (0073's `fdv_tag_keys` and
 * `fdv_tag_labels`), the web and the phone:
 *
 *  - Spaces are tidied: trimmed, and a run of them is one.
 *  - The first `: ` splits a detail tag's label from its value. Both must
 *    be there, or it is a plain tag ("locker:" and ": 12" are plain).
 *  - A plain tag is kept in lower case, as tags always have been. A detail
 *    tag's label is too, and its value as it was written: "Ahmed", not
 *    "ahmed".
 *  - Two tags on one document that differ only in case are one, and the
 *    first spelling is the one kept.
 *  - Tags are compared by `tagKey` (all of it in lower case), and labels by
 *    `tagLabelKey`.
 *
 * A detail tag is a tag: kept, shown and searched as every tag is, for
 * everybody who can see its document, an Only me one's for its owner alone.
 * Nothing about it is sealed — which is why the field says to keep
 * passwords and PINs in an Only me note, and why a label that looks like a
 * secret is said to before it is saved.
 */

/**
 * The longest a tag may be, once its spaces are tidied: 40, as it has been
 * since Phase 1 — room for "policy holder: Ahmed Khan", and what a phone
 * released before 0.9.0 checks a capture's tags against.
 */
export const TAG_MAX = 40;
/** The most tags one document may carry, as since Phase 1. */
export const TAGS_MAX = 50;

/** Said by every field that takes tags. */
export const TAGS_SEEN_NOTE =
  'Everyone who can see this document can see and search its tags; keep passwords and PINs in an Only me note.';

/** Spaces tidied: trimmed, and a run of them one. */
function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** A detail tag's two halves, as written (the label not yet in lower case). */
export interface TagDetail {
  label: string;
  value: string;
}

/** A detail tag's label and value; null for a plain tag. */
export function tagDetail(tag: string): TagDetail | null {
  const s = tidy(tag);
  const at = s.indexOf(': ');
  if (at <= 0) return null;
  const label = s.slice(0, at).trim();
  const value = s.slice(at + 2).trim();
  return label && value ? { label, value } : null;
}

/**
 * A tag as the vault keeps it: spaces tidied; a plain tag in lower case; a
 * detail tag as `label: value`, its label in lower case and its value as
 * written. Empty for nothing.
 */
export function normaliseTag(tag: string): string {
  const d = tagDetail(tag);
  return d ? `${d.label.toLowerCase()}: ${d.value}` : tidy(tag).toLowerCase();
}

/** What two tags are compared by: the same tag, whatever the case. */
export function tagKey(tag: string): string {
  return normaliseTag(tag).toLowerCase();
}

/** What two labels are compared by: "Locker", " locker " and "locker:" are one. */
export function tagLabelKey(label: string): string {
  return tidy(label.replace(/:\s*$/, '')).toLowerCase();
}

/**
 * A document's tags as the vault keeps them: each normalised, each once
 * whatever its case (the first spelling kept), nothing empty.
 */
export function normaliseTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = normaliseTag(raw);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** A tag too long to say in full in a refusal: its start. */
function startOf(tag: string): string {
  return tag.length > 24 ? `${tag.slice(0, 24)}…` : tag;
}

/**
 * Why tags cannot be kept, in words, or null: one longer than `TAG_MAX`,
 * or more than `TAGS_MAX` of them. Checked once they are normalised.
 */
export function tagsProblem(tags: readonly string[]): string | null {
  const kept = normaliseTags(tags);
  const long = kept.find((t) => t.length > TAG_MAX);
  if (long) {
    return `A tag can be ${TAG_MAX} characters at most: “${startOf(long)}” is ${long.length}.`;
  }
  if (kept.length > TAGS_MAX) {
    return `A document can carry ${TAGS_MAX} tags at most: this would be ${kept.length}.`;
  }
  return null;
}

/** "Locker", from "locker". */
function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** How a tag is shown: "Locker · 12", and read aloud as "Locker: 12". */
export interface TagWords {
  /** On the chip. */
  text: string;
  /** For a screen reader. */
  spoken: string;
  /** A detail tag's label, as shown ("Locker"); null for a plain tag. */
  label: string | null;
  /** A detail tag's value; null for a plain tag. */
  value: string | null;
}

export function tagWords(tag: string): TagWords {
  const d = tagDetail(tag);
  if (!d) {
    const text = tidy(tag);
    return { text, spoken: text, label: null, value: null };
  }
  const label = capitalise(d.label);
  return { text: `${label} · ${d.value}`, spoken: `${label}: ${d.value}`, label, value: d.value };
}

/**
 * Words in a label that holds a secret, each a word of its own, once the
 * label is in words (`secretWords`): a password, a PIN or a PUK, a passcode,
 * a passphrase, a security code or answer, a card's CVV, a login, a
 * recovery or backup code, a seed phrase, the alarm's, the door's or the
 * gate's code, the safe's combination.
 */
const SECRET = new RegExp(
  `(?:^| )(?:${[
    'pass ?words?',
    'passwd',
    'pwd?',
    'pass ?phrases?',
    'pins?',
    'pin (?:codes?|numbers?)',
    'puks?',
    'puk codes?',
    'pass ?codes?',
    'security (?:codes?|numbers?|questions?|answers?)',
    'cvv',
    'cvc',
    'logins?',
    'log ins?',
    '(?:recovery|backup) (?:codes?|keys?|phrases?|words?)',
    'seed (?:phrases?|words?)',
    '(?:alarm|door|gate|garage|entry|lock|key ?safe|key ?box) (?:codes?|pins?|numbers?)',
    'safe (?:combinations?|codes?)',
    'combinations?',
  ].join('|')})(?= |$)`,
);

/**
 * A label as words: camelCase split ("wifiPassword"), `_`, `/`, `.`, `-`,
 * `:` and `|` as spaces, in lower case; and "safety pin", which holds no PIN,
 * left out.
 */
function secretWords(label: string): string {
  return label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_/\\.\-:|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/(?:^| )safety pins?(?= |$)/g, ' ')
    .trim();
}

/**
 * Whether a tag looks like it holds a secret: a detail tag whose label
 * names a password, a PIN, a passcode, a login or a code ("wifi password:
 * …", "alarm_code: …") — or a plain tag of more than one word that does
 * ("pin 4821"). Said, before it is saved or renamed to; never refused.
 */
export function looksSecret(tag: string): boolean {
  const d = tagDetail(tag);
  const words = secretWords(d ? d.label : tidy(tag));
  return SECRET.test(words) && (d !== null || words.includes(' '));
}

/** What is said of a tag that looks like a secret, before it is saved. */
export function secretTagWarning(tag: string): string {
  const said = tagWords(tag).label ?? tagWords(tag).text;
  return `“${said}” looks like a secret. Everyone who can see this document can see and search its tags: keep passwords and PINs in an Only me note instead.`;
}

/** A tag in the list of tags (GET /tags), as far as this matters here. */
export interface KnownTag {
  tag: string;
  count: number;
}

/**
 * What the tag field offers as somebody types (0.9.0, T1): after
 * "locker: ", the values already used for that label; otherwise the tags
 * that start with what is typed, or whose label does — most used first,
 * never one the document has already.
 */
export function tagSuggestions(
  typed: string,
  known: readonly KnownTag[],
  have: readonly string[],
  limit = 8,
): string[] {
  const had = new Set(have.map(tagKey));
  const start = typed.replace(/\s+/g, ' ').replace(/^ /, '').toLowerCase();
  if (!start) return [];
  const at = start.indexOf(': ');
  const label = at > 0 ? tagLabelKey(start.slice(0, at)) : null;
  const valueStart = at > 0 ? start.slice(at + 2).trim() : '';
  const fits = (t: KnownTag) => {
    if (had.has(tagKey(t.tag))) return false;
    if (label !== null) {
      const d = tagDetail(t.tag);
      return (
        d !== null &&
        tagLabelKey(d.label) === label &&
        d.value.toLowerCase().startsWith(valueStart) &&
        d.value.toLowerCase() !== valueStart
      );
    }
    return tagKey(t.tag).startsWith(start.trim());
  };
  return [...known]
    .filter(fits)
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit)
    .map((t) => t.tag);
}

/** A label of the household's detail tags, with the values it has (Settings → Tags). */
export interface TagLabelGroup {
  /** As shown: "Locker". */
  label: string;
  /** What it is compared and filtered by: "locker". */
  key: string;
  /** Its detail tags, most used first. */
  tags: KnownTag[];
  /** How many documents carry it, with any value (each document once per tag). */
  count: number;
}

/**
 * Tags as Settings → Tags lists them: plain tags, and detail tags grouped
 * by their label — each group's tags most used first.
 */
export function groupTags<T extends KnownTag>(
  known: readonly T[],
): { plain: T[]; labels: Array<TagLabelGroup & { tags: T[] }> } {
  const plain: T[] = [];
  const groups = new Map<string, TagLabelGroup & { tags: T[] }>();
  for (const t of known) {
    const d = tagDetail(t.tag);
    if (!d) {
      plain.push(t);
      continue;
    }
    const key = tagLabelKey(d.label);
    const g = groups.get(key) ?? { label: capitalise(d.label), key, tags: [], count: 0 };
    g.tags.push(t);
    g.count += t.count;
    groups.set(key, g);
  }
  const byUse = (a: KnownTag, b: KnownTag) => b.count - a.count || a.tag.localeCompare(b.tag);
  return {
    plain: plain.sort(byUse),
    labels: [...groups.values()]
      .map((g) => ({ ...g, tags: g.tags.sort(byUse) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

/**
 * A tag in GET /tags: how many of the documents the reader can see carry it
 * (out of the Trash), and since 0.9.0 (`features.tag_details`) its label
 * and value when it is a detail tag, and how many of those documents the
 * reader may change — what a rename or a delete of it would touch.
 */
export interface TagView extends KnownTag {
  /** A detail tag's label, in lower case; null for a plain tag. Absent from older vaults. */
  label?: string | null;
  /** A detail tag's value, as written; null for a plain tag. Absent from older vaults. */
  value?: string | null;
  /** How many of the documents counted the reader may change. Absent from older vaults. */
  changeable?: number;
}

/**
 * What a rename, a merge or a delete of a tag came to (0.9.0,
 * `features.tag_management`): on how many documents it was changed — the
 * reader's to change, in the Trash too — and on how many they can see but
 * may not change it stays. Documents they cannot see are never counted.
 */
export interface TagChangeResult {
  changed: number;
  kept: number;
  /** A rename into a tag the reader's documents carried already. */
  merged: boolean;
  /** Of those changed, how many are in the Trash. */
  in_trash?: number;
}
