import { STATUS_ORDER, type Visibility } from '@fdv/shared';
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
}

/** How many values one filter may hold. */
export const FILTER_VALUES_MAX = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VISIBILITIES: readonly string[] = ['household', 'adults', 'private'];

const refuse = (detail: string, message: string): never => {
  throw new ApiError(422, 'validation_failed', message, { detail });
};

/** A comma-separated filter as its values; none when it was not asked for. */
export function valuesOf(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const values = [
    ...new Set(
      raw
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== ''),
    ),
  ];
  return values.length > 0 ? values : undefined;
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

/** The raw query's filters, as their values: each checked as the filter of one value always was. */
export interface RawFilters {
  member_id?: string | undefined;
  type_key?: string | undefined;
  category?: string | undefined;
  status?: string | undefined;
  visibility?: string | undefined;
  added_from?: string | undefined;
  added_to?: string | undefined;
  issued_from?: string | undefined;
  issued_to?: string | undefined;
  expires_from?: string | undefined;
  expires_to?: string | undefined;
}

/**
 * One value each where one was asked for — the singular field, read as it
 * always was — and the list where several were. A person's filter may name
 * nobody's documents (`none`), which only a column sort takes.
 */
export function filtersOf(raw: RawFilters): {
  single: {
    member_id?: string | undefined;
    type_key?: string | undefined;
    category?: string | undefined;
    status?: string | undefined;
    visibility?: Visibility | undefined;
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
      if (m !== 'none' && !UUID.test(m)) refuse('member_id', 'That is not a person in this vault.');
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
      if (!VISIBILITIES.includes(v)) refuse('visibility', 'That is not who can see a document.');
    if (visibilities.length === 1) single.visibility = visibilities[0] as Visibility;
    else many.visibilities = visibilities as Visibility[];
  }
  for (const d of ['added', 'issued', 'expires'] as const) {
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
 * the people (`none` for nobody's), kinds, categories and who-can-see, and
 * the date ranges. A status is worked out, not stored: `statusAllowed`.
 */
export function filterClauses(f: DocumentFilters, table = 'd'): RawBuilder<unknown>[] {
  const c = (column: string) => sql.ref(`${table}.${column}`);
  const parts: RawBuilder<unknown>[] = [];
  if (f.member_ids) {
    const people = f.member_ids.filter((m) => m !== 'none');
    const nobody = f.member_ids.includes('none');
    const any = [
      ...(people.length > 0 ? [sql`${c('owner_member_id')} = any(${people}::uuid[])`] : []),
      ...(nobody ? [sql`${c('owner_member_id')} is null`] : []),
    ];
    parts.push(sql`(${sql.join(any, sql` or `)})`);
  }
  if (f.type_keys) parts.push(sql`${c('type_key')} = any(${f.type_keys}::text[])`);
  if (f.categories) parts.push(sql`${c('category')} = any(${f.categories}::text[])`);
  if (f.visibilities) parts.push(sql`${c('visibility')}::text = any(${f.visibilities}::text[])`);
  // Added: the day it was made, on the database's calendar, both ends included.
  if (f.added_from) parts.push(sql`${c('created_at')} >= ${f.added_from}::date`);
  if (f.added_to) parts.push(sql`${c('created_at')} < (${f.added_to}::date + 1)`);
  if (f.issued_from) parts.push(sql`${c('issued_on')} >= ${f.issued_from}::date`);
  if (f.issued_to) parts.push(sql`${c('issued_on')} <= ${f.issued_to}::date`);
  if (f.expires_from) parts.push(sql`${c('expires_on')} >= ${f.expires_from}::date`);
  if (f.expires_to) parts.push(sql`${c('expires_on')} <= ${f.expires_to}::date`);
  return parts;
}

/** The conditions above as one, or none: for a statement that adds `and …`. */
export function andFilters(f: DocumentFilters, table = 'd'): RawBuilder<unknown> {
  const parts = filterClauses(f, table);
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
  },
  many: DocumentFilters,
): DocumentFilters {
  return {
    ...many,
    ...(single.type_key ? { type_keys: [single.type_key] } : {}),
    ...(single.status ? { statuses: [single.status] } : {}),
    ...(single.visibility ? { visibilities: [single.visibility] } : {}),
  };
}
