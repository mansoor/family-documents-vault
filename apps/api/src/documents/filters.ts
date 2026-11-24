import {
  FILTER_VALUES_MAX,
  isIssuerKey,
  NO_ISSUER,
  storedIssuerKey,
  sensitiveOf,
  SENSITIVE_FILTER_VALUES,
  HOUSEHOLD_MEMBER_FILTER,
  NOBODY_MEMBER_FILTER,
  NOTE_KIND,
  STATUS_ORDER,
  type Visibility,
} from '@fdv/shared';
import { serverZone } from '@fdv/db';
import { sql, type RawBuilder } from 'kysely';
import { ApiError } from '../errors.js';

/**
 * Filters of several values and of dates (V1, 0.9.0, `features.document_filters`;
 * the owner's phone redesign of 10 Nov 2026): the phone's filter panel asks
 * for documents of Sam or Leo, passports or licences, expiring in the next
 * 90 days — on GET /documents and GET /search alike.
 *
 * A filter's values come comma-separated (`member_id=a,b`). One value is
 * the filter as it always was; several, any of them. Tags stay one at a
 * time: a tag may hold a comma. Dates are days, `YYYY-MM-DD`, both ends
 * included; a document without that date is not within any range.
 *
 * Since the owner's tidy-up of 11 Nov 2026 (`features.tag_filters`,
 * `features.notes_apart`): several tags, the `tag` field given once for
 * each (`tag=a&tag=b`, any of them, a comma being part of a tag); and
 * `notes=exclude`, documents without the notes, which the phone's
 * Documents tab and the web's Documents table keep to (notes have their
 * own place on both).
 *
 * Since 0.9.0-dev.92 (`features.multi_filters`, the web's Documents filters
 * of several choices): every filter that takes values takes several, each
 * given once (`member_id=a&member_id=b`) — the one way that holds for every
 * value, a comma in a tag or a label too. The filters of keys (ids, kinds,
 * statuses, `yes`/`no`, issuer keys) still take them comma-separated as
 * well, as since V1, and the two together; words (a tag, a detail's label)
 * are never split. A collection (`collection_id`) and a detail's label
 * (`tag_label`) take several too. Each value is one that filter takes, and
 * each only narrows what the reader may read already: the readability rule
 * is the same `and` on every statement, whatever the filters ask.
 */

/** Any of these, and within these dates: what a list or a search is narrowed by. */
export interface DocumentFilters {
  member_ids?: string[] | undefined;
  type_keys?: string[] | undefined;
  categories?: string[] | undefined;
  statuses?: string[] | undefined;
  visibilities?: Visibility[] | undefined;
  added_from?: string | undefined;
  added_to?: string | undefined;
  issued_from?: string | undefined;
  issued_to?: string | undefined;
  expires_from?: string | undefined;
  expires_to?: string | undefined;
  /**
   * The date a paper is about — issued, else added — within these days
   * (0.9.0, C1): what a cabinet's year folder asks (`datedSql`).
   */
  dated_from?: string | undefined;
  dated_to?: string | undefined;
  /** Any of these tags, whatever their case (several since 11 Nov 2026). */
  tags?: string[] | undefined;
  /** Notes left out (`notes=exclude`). */
  without_notes?: boolean | undefined;
  /**
   * Any of these issuers (0.9.0-dev.91): issuer keys, each with every key
   * the household said is the same issuer; `_none` (`NO_ISSUER`) for papers
   * with no issuer given.
   */
  issuers?: string[] | undefined;
  /**
   * Sensitive, all said, or not (0.9.0, AIR2: `sensitive=yes`, `no`,
   * or both, which is every document).
   */
  sensitive?: boolean[] | undefined;
  /** Any of these details' labels, whatever their case (0.9.0-dev.92). */
  tag_labels?: string[] | undefined;
  /**
   * In any of these collections the reader may see, or (`none`) in none of
   * theirs (0.9.0-dev.92): the table's, which asks it with the reader (table.ts).
   */
  collection_ids?: string[] | undefined;
}

/** How many values one filter may hold (`@fdv/shared`, so the web offers no more). */
export { FILTER_VALUES_MAX };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VISIBILITIES: readonly string[] = ['household', 'adults', 'private'];

/** The person filter's values that are not a person: Not sure yet, and the household's (0.9.0). */
export const NOT_A_PERSON: readonly string[] = [NOBODY_MEMBER_FILTER, HOUSEHOLD_MEMBER_FILTER];

const refuse = (detail: string, message: string): never => {
  throw new ApiError(422, 'validation_failed', message, { detail });
};

/**
 * A filter of keys as its values: each given, each split at its commas;
 * none when it was not asked for.
 */
export function valuesOf(raw: string | readonly string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const values = [
    ...new Set(
      (typeof raw === 'string' ? [raw] : raw)
        .flatMap((one) => one.split(','))
        .map((v) => v.trim())
        .filter((v) => v !== ''),
    ),
  ];
  return values.length > 0 ? values : undefined;
}

/** A filter of words as its values: each given once, never split (a comma is a part of it). */
function wordsOf(raw: string | readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  return [
    ...new Set((typeof raw === 'string' ? [raw] : raw).map((x) => x.trim()).filter((x) => x)),
  ];
}

/** A day as the filter takes it, or a refusal that names the filter. */
function dayOf(name: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // A day that is on the calendar: 2026-02-30 is not, nor 2026-13-01.
  const at = new Date(`${raw}T00:00:00Z`);
  if (!DAY.test(raw) || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== raw) {
    return refuse(name, 'A date is a day, written as 2026-11-10.');
  }
  return raw;
}

/** Given once, or several times (0.9.0-dev.92). */
type Given = string | readonly string[];

/** The raw query's filters, as their values: each checked as the filter of one value always was. */
export interface RawFilters {
  member_id?: Given | undefined;
  type_key?: Given | undefined;
  category?: Given | undefined;
  status?: Given | undefined;
  visibility?: Given | undefined;
  added_from?: string | undefined;
  added_to?: string | undefined;
  issued_from?: string | undefined;
  issued_to?: string | undefined;
  expires_from?: string | undefined;
  expires_to?: string | undefined;
  dated_from?: string | undefined;
  dated_to?: string | undefined;
  /** A tag, or several: the field given once for each. */
  tag?: Given | undefined;
  notes?: 'exclude' | undefined;
  /** `yes`, `no`, or both comma-separated (0.9.0, AIR2). */
  sensitive?: Given | undefined;
  /** Issuer keys, or `_none`, comma-separated (0.9.0-dev.91). */
  issuer?: Given | undefined;
  /** A detail's label, or several, each given once (0.9.0-dev.92): the list's. */
  tag_label?: Given | undefined;
  /** A collection's id or `none`, or several (0.9.0-dev.92): the table's. */
  collection_id?: Given | undefined;
}

/**
 * One value each where one was asked for — the singular field, read as it
 * always was — and the list where several were. A person's filter may name
 * nobody's documents (`none`: Not sure yet since 0.9.0) or the household's
 * (`household`, 0.9.0), which a column sort and search take.
 */
export function filtersOf(raw: RawFilters): {
  single: {
    member_id?: string | undefined;
    type_key?: string | undefined;
    category?: string | undefined;
    status?: string | undefined;
    visibility?: Visibility | undefined;
    tag?: string | undefined;
    tag_label?: string | undefined;
    collection_id?: string | undefined;
  };
  many: DocumentFilters;
} {
  const single: ReturnType<typeof filtersOf>['single'] = {};
  const many: DocumentFilters = {};
  const tooMany = (name: string, v: string[]) =>
    v.length > FILTER_VALUES_MAX && refuse(name, `At most ${FILTER_VALUES_MAX} at once.`);

  const members = valuesOf(raw.member_id);
  if (members) {
    tooMany('member_id', members);
    for (const m of members)
      if (!NOT_A_PERSON.includes(m) && !UUID.test(m))
        refuse('member_id', 'That is not a person in this vault.');
    if (members.length === 1) single.member_id = members[0];
    else many.member_ids = members;
  }
  const types = valuesOf(raw.type_key);
  if (types) {
    tooMany('type_key', types);
    if (types.length === 1) single.type_key = types[0];
    else many.type_keys = types;
  }
  const categories = valuesOf(raw.category);
  if (categories) {
    tooMany('category', categories);
    if (categories.length === 1) single.category = categories[0];
    else many.categories = categories;
  }
  const statuses = valuesOf(raw.status);
  if (statuses) {
    for (const s of statuses) {
      if (!(STATUS_ORDER as readonly string[]).includes(s))
        refuse('status', 'That is not a status a document can have.');
    }
    if (statuses.length === 1) single.status = statuses[0];
    else many.statuses = statuses;
  }
  const visibilities = valuesOf(raw.visibility);
  if (visibilities) {
    for (const v of visibilities)
      if (!VISIBILITIES.includes(v))
        refuse('visibility', 'That is not a visibility a document can have.');
    if (visibilities.length === 1) single.visibility = visibilities[0] as Visibility;
    else many.visibilities = visibilities as Visibility[];
  }
  // Tags are never split: a tag may hold a comma. One is the filter as it always was.
  const tags = wordsOf(raw.tag);
  if (tags.length > 0) {
    tooMany('tag', tags);
    if (tags.length === 1) single.tag = tags[0];
    else many.tags = tags;
  }
  // Nor a detail's label (0.9.0-dev.92): one is the filter as it always was.
  const labels = wordsOf(raw.tag_label);
  if (labels.length > 0) {
    tooMany('tag_label', labels);
    if (labels.length === 1) single.tag_label = labels[0];
    else many.tag_labels = labels;
  }
  // A collection's id, or none of the reader's (0.9.0-dev.92: several).
  const collections = valuesOf(raw.collection_id);
  if (collections) {
    tooMany('collection_id', collections);
    for (const c of collections) {
      if (c !== 'none' && !UUID.test(c)) refuse('collection_id', 'That is not a collection here.');
    }
    if (collections.length === 1) single.collection_id = collections[0];
    else many.collection_ids = collections;
  }
  if (raw.notes === 'exclude') many.without_notes = true;
  // Sensitive, all said (0.9.0, AIR2): new, so always a list.
  const sensitive = valuesOf(raw.sensitive);
  if (sensitive) {
    for (const v of sensitive) {
      if (!(SENSITIVE_FILTER_VALUES as readonly string[]).includes(v))
        refuse('sensitive', 'Sensitive is yes or no.');
    }
    many.sensitive = sensitive.map((v) => v === 'yes');
  }
  // Who issued it, by key (0.9.0-dev.91): new, so always a list.
  const issuers = valuesOf(raw.issuer);
  if (issuers) {
    tooMany('issuer', issuers);
    for (const v of issuers) {
      if (v !== NO_ISSUER && !isIssuerKey(v)) {
        refuse('issuer', 'That is not who issued a document, as the vault keys it.');
      }
    }
    many.issuers = issuers;
  }
  for (const d of ['added', 'issued', 'expires', 'dated'] as const) {
    const from = dayOf(`${d}_from`, raw[`${d}_from`]);
    const to = dayOf(`${d}_to`, raw[`${d}_to`]);
    if (from && to && from > to) refuse(`${d}_from`, 'The first day is after the last.');
    if (from) many[`${d}_from`] = from;
    if (to) many[`${d}_to`] = to;
  }
  return { single, many };
}

/**
 * The filters that SQL can answer, as conditions on `d` (document): any of
 * the people (`none` for Not sure yet, `household` for the household's),
 * kinds, categories and who-can-see, and the date ranges. A status is worked out, not stored: `statusAllowed`.
 */
export function filterClauses(
  f: DocumentFilters,
  table = 'd',
  /** Who reads: what the issuer filter (0.9.0-dev.91) expands keys by. */
  seen?: IssuerReader,
): RawBuilder<unknown>[] {
  const c = (column: string) => sql.ref(`${table}.${column}`);
  const parts: RawBuilder<unknown>[] = [];
  if (f.member_ids) {
    const people = f.member_ids.filter((m) => !NOT_A_PERSON.includes(m));
    const nobody = f.member_ids.includes(NOBODY_MEMBER_FILTER);
    const household = f.member_ids.includes(HOUSEHOLD_MEMBER_FILTER);
    const any = [
      ...(people.length > 0 ? [sql`${c('owner_member_id')} = any(${people}::uuid[])`] : []),
      // Not sure yet: nobody, and not the household's (0.9.0).
      ...(nobody ? [sql`(${c('owner_member_id')} is null and not ${c('household_owned')})`] : []),
      ...(household ? [sql`${c('household_owned')}`] : []),
    ];
    parts.push(sql`(${sql.join(any, sql` or `)})`);
  }
  if (f.type_keys) parts.push(sql`${c('type_key')} = any(${f.type_keys}::text[])`);
  if (f.categories) parts.push(sql`${c('category')} = any(${f.categories}::text[])`);
  if (f.visibilities) parts.push(visibilitySql(f.visibilities, table));
  // Any of the tags, keyed by the database as one tag is (tagFilter, 0073).
  if (f.tags) {
    parts.push(
      sql`${c('tag_keys')} && array(select fdv_tag_key(x) from unnest(${f.tags}::text[]) as x)::text[]`,
    );
  }
  // Any of the details' labels, keyed as one label is (tagLabelFilter, 0073).
  if (f.tag_labels) {
    parts.push(
      sql`${c('tag_labels')} && array(select fdv_tag_label_key(x) from unnest(${f.tag_labels}::text[]) as x)::text[]`,
    );
  }
  if (f.without_notes) parts.push(sql`${c('type_key')} is distinct from ${NOTE_KIND}`);
  // Any of these issuers, each with those the household says are the same
  // (0.9.0-dev.91); or none given.
  if (f.issuers) {
    if (!seen) throw new Error('The issuer filter is asked with its reader.');
    parts.push(issuersSql(f.issuers, seen, table));
  }
  // Sensitive or not, all said (0.9.0, AIR2); both is every document.
  const sensitive = [...new Set(f.sensitive ?? [])];
  if (sensitive.length === 1) {
    parts.push(sql`${sensitiveSql(table)} = ${sensitive[0] === true}`);
  }
  // Added: the day it was made, on the database's calendar, both ends included.
  if (f.added_from) parts.push(sql`${c('created_at')} >= ${f.added_from}::date`);
  if (f.added_to) parts.push(sql`${c('created_at')} < (${f.added_to}::date + 1)`);
  if (f.issued_from) parts.push(sql`${c('issued_on')} >= ${f.issued_from}::date`);
  if (f.issued_to) parts.push(sql`${c('issued_on')} <= ${f.issued_to}::date`);
  if (f.expires_from) parts.push(sql`${c('expires_on')} >= ${f.expires_from}::date`);
  if (f.expires_to) parts.push(sql`${c('expires_on')} <= ${f.expires_to}::date`);
  // The date it is about: issued, else added (0.9.0, C1).
  if (f.dated_from) parts.push(sql`${datedSql(table)} >= ${f.dated_from}::date`);
  if (f.dated_to) parts.push(sql`${datedSql(table)} <= ${f.dated_to}::date`);
  return parts;
}

/**
 * The day a paper is about, as SQL (0.9.0, C1): when it was issued, else
 * the day it was added on the family's own calendar — the household's time
 * zone, else the server's (FDV_TIMEZONE) — so a paper added late on New
 * Year's Eve in Auckland is that year's. What the `dated_` filters ask, and
 * what Arrange by draws a cabinet's years from: one expression, so a folder
 * holds exactly what its drawing counted. (The `added_` filters read the
 * database's calendar, as they always have.)
 */
export function datedSql(table = 'd'): RawBuilder<string> {
  const c = (column: string) => sql.ref(`${table}.${column}`);
  return sql<string>`coalesce(${c('issued_on')},
    (${c('created_at')} at time zone coalesce(
       (select h.timezone from household h where h.id = ${c('household_id')}),
       ${serverZone()}))::date)`;
}

/**
 * "The reader may read document `alias`" (`readDocument` in service.ts), as
 * the issuer filters ask it of a paper other than the one being listed.
 */
export type IssuerReader = (alias: string) => RawBuilder<boolean>;

/**
 * Issuer keys as one household names them, for this reader (0.9.0-dev.91):
 * each key asked; and, for each the reader can read a paper of, every key of
 * its group — the key the household's "Same as" list says it is the same
 * as, and every key said to be the same as that. A key they can read no
 * paper of is only itself, so what is listed is the same whether or not it
 * is in the list: the filter never says what the reader may not know. One
 * array, worked out once for the whole statement (it asks nothing of the
 * paper listed), so the listing itself reads `document_issuer_key_idx`.
 */
export function issuerKeysSql(keys: readonly string[], seen: IssuerReader): RawBuilder<string[]> {
  return sql<string[]>`array(
    with asked(k) as (select unnest(${[...keys]}::text[])),
         roots(r) as (
           select coalesce(ia.to_key, a.k)
             from asked a
             left join issuer_alias ia on ia.household_id = app_household() and ia.from_key = a.k
            where exists (select 1 from document seen
                           where seen.issuer_key = a.k and seen.deleted_at is null
                             and ${seen('seen')}))
    select k from asked
    union select r from roots
    union select ib.from_key from issuer_alias ib
           where ib.household_id = app_household() and ib.to_key in (select r from roots))`;
}

/** Any of these issuer keys, each as the household names it (`issuerKeysSql`), or `_none` for none given. */
export function issuersSql(
  keys: readonly string[],
  seen: IssuerReader,
  table = 'd',
): RawBuilder<boolean> {
  const column = sql.ref(`${table}.issuer_key`);
  const given = keys.filter((k) => k !== NO_ISSUER);
  const any = [
    ...(given.length > 0 ? [sql`${column} = any(${issuerKeysSql(given, seen)})`] : []),
    ...(keys.includes(NO_ISSUER) ? [sql`${column} is null`] : []),
  ];
  return sql<boolean>`(${sql.join(any, sql` or `)})`;
}

/**
 * The Who issued it filter (`issued_by`), as SQL: the issuer as written,
 * whatever its case, as it always was; and since 0.9.0-dev.91 every paper
 * the household names the same, for this reader (`issuerKeysSql`) — by its
 * issuer key, so "BARCLAYS BANK UK PLC" finds "Barclays Bank UK", and by the
 * "Same as" list, so "Barclays" finds "Barclays Bank UK" once somebody said
 * they are one.
 */
export function issuedBySql(value: string, seen: IssuerReader, table = 'd'): RawBuilder<boolean> {
  const c = (column: string) => sql.ref(`${table}.${column}`);
  const asWritten = sql`lower(${c('issued_by')}) = lower(${value.trim()})`;
  const key = storedIssuerKey(value);
  return key === null
    ? sql<boolean>`${asWritten}`
    : sql<boolean>`(${asWritten} or ${c('issuer_key')} = any(${issuerKeysSql([key], seen)}))`;
}

/**
 * Whether a document is sensitive, all said, as SQL (0.9.0, AIR2): only
 * so the Documents table and search can filter by it a page at a time.
 * `sensitiveOf` (@fdv/shared) is the rule; this mirrors it, its last
 * answer taken from it, and sensitive.test.ts holds the two to the same
 * answers for every case — its own choice; else its
 * kind's Sensitive by default as its household has it (a built-in's
 * setting, else the release's; a household's own kind's row); else, with no
 * kind, yes. Worked out here, never written down, so a kind's default
 * changed changes every document left on "as its kind says".
 */
export function sensitiveSql(table = 'd'): RawBuilder<boolean> {
  const c = (column: string) => sql.ref(`${table}.${column}`);
  return sql<boolean>`coalesce(${c('sensitive')},
    (select coalesce(cs.sensitive_default, ct.sensitive_default)
       from document_type ct
       left join document_type_setting cs
         on ct.household_id is null and cs.type_key = ct.key
        and cs.household_id = ${c('household_id')}
      where ct.key = ${c('type_key')}),
    ${sensitiveOf(null, null)})`;
}

/**
 * Who can see it, as a list or a search asks it: any of these. Only me is
 * the caller's own Only me (0.9.0, the C2 review) — never somebody else's
 * paper they read only as its person's caregiver (H1b), which is that
 * person's Only me, not theirs. `app_member()` is the caller signed in.
 */
export function visibilitySql(values: readonly string[], table = 'd'): RawBuilder<boolean> {
  const c = (column: string) => sql.ref(`${table}.${column}`);
  return sql<boolean>`(${c('visibility')}::text = any(${[...values]}::text[])
    and (${c('visibility')} <> 'private' or ${c('owner_member_id')} = app_member()))`;
}

/** The conditions above as one, or none: for a statement that adds `and …`. */
export function andFilters(
  f: DocumentFilters,
  table = 'd',
  seen?: IssuerReader,
): RawBuilder<unknown> {
  const parts = filterClauses(f, table, seen);
  return parts.length > 0 ? sql`and ${sql.join(parts, sql` and `)}` : sql``;
}

/** Whether a worked-out status is one asked for: any of several, the one, or any at all. */
export function statusAllowed(
  f: DocumentFilters,
  one: string | undefined,
): (status: string) => boolean {
  const wanted = f.statuses ?? (one ? [one] : null);
  return wanted ? (status) => wanted.includes(status) : () => true;
}

/** Whether any status is asked for: then every row is read and its status worked out. */
export const asksStatus = (f: DocumentFilters, one: string | undefined) => !!f.statuses || !!one;

/**
 * Every filter as a list, the one-value ones too: what a search narrows by
 * with them, and what its second pass is told (`sealed-token.ts`).
 */
export function asLists(
  single: {
    type_key?: string | undefined;
    status?: string | undefined;
    visibility?: Visibility | undefined;
    tag?: string | undefined;
  },
  many: DocumentFilters,
): DocumentFilters {
  return {
    ...many,
    ...(single.type_key ? { type_keys: [single.type_key] } : {}),
    ...(single.status ? { statuses: [single.status] } : {}),
    ...(single.visibility ? { visibilities: [single.visibility] } : {}),
    ...(single.tag ? { tags: [single.tag] } : {}),
  };
}
