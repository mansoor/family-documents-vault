import {
  CABINET_FILTER_KEYS,
  DOCUMENT_PAGE_MAX,
  DOCUMENT_SORTS,
  OLDER_DOCUMENT_SORTS,
  SORT_DIRECTIONS,
} from '@fdv/shared';
import { z } from 'zod';
import { FILTER_VALUES_MAX, filtersOf } from './filters.js';
import type { ListQuery } from './service.js';

/**
 * What GET /documents takes, and how it is read: one parser, for the list
 * itself and for every folder of somebody's cabinet (0.9.0, C1), whose
 * saved question is the list's own parameters — so a folder never asks
 * for more than the list allows.
 */

/**
 * A filter of keys: one value, or several — each given once (0.9.0-dev.92,
 * `features.multi_filters`), or comma-separated as since V1, or both —
 * checked as it is read (filters.ts).
 */
export const values = z
  .union([z.string().max(4000), z.array(z.string().max(4000)).max(FILTER_VALUES_MAX)])
  .optional();
/** One value, or several comma-separated, never given twice: what a folder's question holds. */
const oneString = z.string().max(4000).optional();
/** A tag, or several: the field given once for each (11 Nov 2026), any of them. */
export const tagValues = z
  .union([z.string().max(400), z.array(z.string().max(400)).max(FILTER_VALUES_MAX)])
  .optional();
/**
 * Words of one value each, where a comma is a part of them: the field given
 * once for each. An empty one is left out, as every filter's is
 * (0.9.0-dev.92): `tag_label=` alone is any.
 */
const textValue = z.string().trim().min(1).max(200);
const textValues = z
  .union([z.string().max(200), z.array(z.string().max(200)).max(FILTER_VALUES_MAX)])
  .optional();
/** A collection, or none of them, as a folder asks it: one. */
const oneCollection = z.union([z.string().uuid(), z.literal('none')]).optional();
/** Notes left out (11 Nov 2026): what the Documents tab and table keep to. */
export const notesFilter = z.enum(['exclude']).optional();
/** A day, `YYYY-MM-DD` (V1): checked as it is read. */
const day = z.string().max(10).optional();
export const dates = {
  added_from: day,
  added_to: day,
  issued_from: day,
  issued_to: day,
  expires_from: day,
  expires_to: day,
  // The date a paper is about: issued, else added (0.9.0, C1).
  dated_from: day,
  dated_to: day,
};

export const listQuery = z.object({
  // A person's id; or, with a column sort (R2), `none`: nobody's. Several since V1.
  member_id: values,
  category: values,
  issued_by: z.string().trim().min(1).max(200).optional(),
  // Who issued it, by the vault's issuer key and the household's "Same as"
  // list (0.9.0-dev.91): keys, comma-separated, or `_none` for none given.
  issuer: values,
  type_key: values,
  tag: tagValues,
  notes: notesFilter,
  // Sensitive, all said: yes, no, or both (0.9.0, AIR2).
  sensitive: values,
  // A detail tag's label, any value (0.9.0, T1): every document with a
  // locker. Several since 0.9.0-dev.92, each given once: a label may hold a comma.
  tag_label: textValues,
  visibility: values,
  essential: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  status: values,
  deleted: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  // 5.24: those an owner has asked to remove for good (in the Trash), or not.
  purge_requested: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  updated_since: z.string().datetime().optional(),
  // The older sorts, and since R2 the table's columns (document-table.ts in
  // @fdv/shared); the table's additions below go with a column sort only.
  sort: z.enum([...OLDER_DOCUMENT_SORTS, ...DOCUMENT_SORTS]).optional(),
  direction: z.enum(SORT_DIRECTIONS).optional(),
  // In this collection (one the caller may see), or in none of theirs; any
  // of several since 0.9.0-dev.92 (filters.ts).
  collection_id: values,
  // Kept there, whatever the case: only for whoever sees locations (5.41).
  location: z.string().trim().min(1).max(500).optional(),
  // In a place in a cabinet, whatever the case (0.9.0, C3): its names joined
  // by " › ", the whole path or its leading part; as `location`, only for
  // whoever sees where originals are kept.
  original_place: z.string().trim().min(1).max(620).optional(),
  // Came from this folder, exactly, whatever the case (0.9.0, C4): as
  // `location`, only for whoever sees where originals are kept.
  source_folder: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(DOCUMENT_PAGE_MAX).optional(),
  // Room for the longest key a table's cursor can carry (the review's
  // R2-API-4): a location of 500 characters, each as JSON writes the worst
  // of them (a control character, \u0001: 6 bytes), is 3,000 bytes; with
  // the rest at most 3,200, as base64 about 4,270, and its tag 44 more.
  cursor: z.string().max(8192).optional(),
  ...dates,
});

/**
 * A cabinet folder's saved question (0.9.0, C1): the list's own filters,
 * each read by the list's own rule, and nothing else — nothing that sorts,
 * pages, or reaches the Trash or what an owner asked to remove. A key the
 * list does not take, or one of those, is refused. Each filter is one
 * string, as a folder has always kept it (several keys comma-separated; a
 * tag, several), never a list: every app reads a folder's question so.
 */
export const folderQuery = listQuery
  .pick(
    Object.fromEntries(CABINET_FILTER_KEYS.map((k) => [k, true])) as {
      [K in (typeof CABINET_FILTER_KEYS)[number]]: true;
    },
  )
  .extend({
    member_id: oneString,
    category: oneString,
    issuer: oneString,
    type_key: oneString,
    sensitive: oneString,
    visibility: oneString,
    status: oneString,
    tag_label: textValue.optional(),
    collection_id: oneCollection,
  })
  .strict();

/**
 * The list's parameters as the service reads them: one value as it always
 * was, several as a list, and the days (V1, filters.ts) — every value
 * checked, a refusal (422) naming the one that is wrong.
 */
export function listQueryOf(raw: z.infer<typeof listQuery>): ListQuery {
  const { single, many } = filtersOf(raw);
  // Sensitive is read as a list (AIR2), never as the words sent.
  const { sensitive: _sensitive, ...asked } = raw;
  void _sensitive;
  return {
    ...asked,
    member_id: single.member_id,
    type_key: single.type_key,
    category: single.category,
    status: single.status,
    visibility: single.visibility,
    tag: single.tag,
    tag_label: single.tag_label,
    collection_id: single.collection_id,
    ...many,
  };
}
