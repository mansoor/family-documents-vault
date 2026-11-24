import type { Db } from '@fdv/db';
import {
  cabinetName,
  drawnCabinets,
  PLACE_NOT_IN_CABINET,
  seesLocation,
  type CabinetLayout,
  type OriginalPlace,
} from '@fdv/shared';
import { sql, type RawBuilder } from 'kysely';
import type { Principal } from '../auth/service.js';
import { ApiError } from '../errors.js';

/**
 * Where the original is, as a place in somebody's cabinet (0.9.0, C3): the
 * columns of 0104, read and written here for the document's edit, many at
 * once, and a layout saved.
 *
 * The place is a household's fact, kept as its names; the reference to its
 * setter's folder is kept beside them only so that the names may follow the
 * folder while it is theirs. Nobody but its setter is ever told the folder's
 * id — another person's layout says nothing to anybody else.
 */

/** A folder of a layout that is shown, with the names of where it is. */
export interface PlacedFolder {
  id: string;
  path: [string, string, string];
}

/** Every folder of a layout, shown or hidden, with its path: what the names follow. */
export function foldersWithPaths(
  layout: CabinetLayout | null | undefined,
): Array<PlacedFolder & { shown: boolean }> {
  // Only a layout the API checked is saved; anything else holds no folders,
  // nor does a cabinet not drawn by its levels (0.9.0-dev.94).
  return drawnCabinets(layout).flatMap((c) =>
    c.drawers.flatMap((d) =>
      d.folders.map((f) => {
        // As a save keeps a name (trimmed, at most 80): a layout saved
        // before that never puts a name the database would refuse.
        const path = [cabinetName(c.name), cabinetName(d.name), cabinetName(f.name)] as [
          string,
          string,
          string,
        ];
        return {
          id: f.id,
          path,
          shown: !c.hidden && !d.hidden && !f.hidden && path.every((n) => n !== ''),
        };
      }),
    ),
  );
}

/**
 * Changed since (`updated_since`): an edit, or its place in a cabinet (C3)
 * — set, cleared, or its names following a rename, which is nobody's edit
 * and moves no updated_at. As `greatest(updated_at, place_changed_at)`,
 * written so each half may use its own index.
 */
export function touchedSince(since: string, alias = 'document'): RawBuilder<boolean> {
  const at = new Date(since);
  return sql<boolean>`(${sql.ref(`${alias}.updated_at`)} > ${at}
    or ${sql.ref(`${alias}.place_changed_at`)} > ${at})`;
}

/**
 * A document's place as the vault answers it to somebody who sees where
 * originals are kept. Its folder's id only to whoever it is theirs, and only
 * while it is a folder of their cabinet as it reads (`folders`, 0.9.0-dev.94):
 * never a way to a folder that is not there.
 */
export function placeView(
  p: Pick<Principal, 'memberId'>,
  row: {
    original_place: string[] | null;
    original_place_by: string | null;
    original_place_folder: string | null;
  },
  folders?: ReadonlySet<string>,
): OriginalPlace | null {
  const names = row.original_place;
  if (!names || names.length !== 3) return null;
  const id = row.original_place_folder;
  return {
    path: [names[0] as string, names[1] as string, names[2] as string],
    // Only to whoever it is theirs: nobody else's folder id, ever.
    folder_id:
      row.original_place_by !== null &&
      row.original_place_by === p.memberId &&
      id !== null &&
      (folders === undefined || folders.has(id))
        ? id
        : null,
  };
}

/** Whether a place's folder id would be given to its reader: theirs, asking for their folders. */
export function placeIsOwn(
  p: Pick<Principal, 'memberId'>,
  row: { original_place_by: string | null; original_place_folder: string | null },
): boolean {
  return row.original_place_by === p.memberId && row.original_place_folder !== null;
}

/** Each reader's folders, read once a transaction however many papers a list gives. */
const OWN_FOLDERS = new WeakMap<object, Map<string, Promise<Set<string>>>>();

/**
 * The ids of every folder of the caller's cabinet as it reads, hidden or
 * shown (0.9.0-dev.94: the cabinets drawn by its levels alone): what a
 * place's folder id must be one of to be given.
 */
export function ownFolderIds(trx: Db, p: Pick<Principal, 'householdId' | 'memberId'>) {
  const byReader = OWN_FOLDERS.get(trx) ?? new Map<string, Promise<Set<string>>>();
  OWN_FOLDERS.set(trx, byReader);
  const key = `${p.householdId}:${p.memberId}`;
  let ids = byReader.get(key);
  if (!ids) {
    ids = trx
      .selectFrom('cabinet_layout')
      .select('layout')
      .where('household_id', '=', p.householdId)
      .where('member_id', '=', p.memberId)
      .executeTakeFirst()
      .then((row) => new Set(foldersWithPaths(row?.layout as CabinetLayout).map((f) => f.id)));
    byReader.set(key, ids);
  }
  return ids;
}

/** The columns a place is written as; none clears all three. Either way, the place changed now. */
export function placeColumns(place: PlacedFolder | null, p: Pick<Principal, 'memberId'>) {
  const now = { place_changed_at: sql<Date>`now()` };
  return place
    ? {
        original_place: place.path,
        original_place_by: p.memberId,
        original_place_folder: place.id,
        ...now,
      }
    : { original_place: null, original_place_by: null, original_place_folder: null, ...now };
}

/**
 * A place the database refused as it holds one (0104's checks: three names
 * of 1–200 characters, a whole reference): said as a refusal in words, never
 * a server error. Anything else is thrown on.
 */
export function placeRefused(e: unknown): never {
  const pg = e as { code?: string; constraint?: string };
  if (pg.code === '23514' && pg.constraint?.startsWith('document_original_place')) {
    throw new ApiError(
      422,
      'validation_failed',
      'That folder’s names can’t be kept as a place: rename it, and try again.',
      { detail: 'original_place' },
    );
  }
  throw e;
}

/**
 * One of the caller's own shown folders, with its names, read from their
 * layout and held for a share (FOR SHARE) until the transaction ends: a
 * rename saved meanwhile waits for this write, and then finds it — so the
 * names written are never left behind a rename that raced them. Read before
 * any document is held, as a layout's save holds its layout before them:
 * one order, no deadlock. Not theirs, or hidden: 422.
 */
export async function placeOf(trx: Db, p: Principal, folderId: string): Promise<PlacedFolder> {
  const row = await trx
    .selectFrom('cabinet_layout')
    .select('layout')
    .where('household_id', '=', p.householdId)
    .where('member_id', '=', p.memberId)
    .forShare()
    .executeTakeFirst();
  const found = foldersWithPaths(row?.layout as CabinetLayout | undefined).find(
    (f) => f.id === folderId && f.shown,
  );
  if (!found) {
    throw new ApiError(422, 'validation_failed', PLACE_NOT_IN_CABINET, {
      detail: 'original_place',
    });
  }
  return { id: found.id, path: found.path };
}

/**
 * A layout saved (C3): the documents placed in its folders keep up with it.
 * A folder renamed, or moved to another drawer or cabinet, gives them its
 * new names; a folder it no longer has lets their reference go, and they
 * keep the names they had, as words. Only the setter's own references —
 * every other person's places are theirs. Nobody's edit: no document's
 * updated_at moves, and nothing goes in the activity log (the names are
 * the setter's own words for their own folder, said again).
 *
 * Somebody else's Only me document is not written by them (it may be one
 * they read only as a caregiver, which the database keeps read-only): its
 * place keeps the names it had, and its reference, until it is seen again.
 * Nor does somebody who no longer sees where originals are kept (an adult
 * made a viewer) write any: their places keep the names they had.
 */
export async function followLayout(trx: Db, p: Principal, layout: CabinetLayout): Promise<void> {
  if (!seesLocation(p.role)) return;
  // Only a shown folder is followed: one hidden — or in a hidden drawer or
  // cabinet — is let go as one taken out, its last shown names kept, so a
  // name nobody is shown is never written on the household's documents.
  const shown = foldersWithPaths(layout).filter((f) => f.shown);
  const theirs = sql`not (d.visibility = 'private' and d.owner_member_id is distinct from ${p.memberId}::uuid)`;
  // The documents to write, held first in id order (FOR UPDATE): the order
  // an edit of one and POST /documents/original-place hold them in, so a
  // save racing them waits rather than deadlocks.
  const held = (
    await sql<{ id: string }>`
      select d.id from document d
       where d.household_id = ${p.householdId}::uuid
         and d.original_place_by = ${p.memberId}::uuid
         and ${theirs}
       order by d.id
         for update`.execute(trx)
  ).rows.map((r) => r.id);
  if (held.length === 0) return;
  if (shown.length > 0) {
    await sql`
      update document d
         set original_place = array[f.cabinet, f.drawer, f.folder], place_changed_at = now()
        from unnest(${shown.map((f) => f.id)}::text[],
                    ${shown.map((f) => f.path[0])}::text[],
                    ${shown.map((f) => f.path[1])}::text[],
                    ${shown.map((f) => f.path[2])}::text[])
               as f(id, cabinet, drawer, folder)
       where d.id = any(${held}::uuid[])
         and d.original_place_folder = f.id
         and d.original_place is distinct from array[f.cabinet, f.drawer, f.folder]`.execute(trx);
  }
  await sql`
    update document d
       set original_place_by = null, original_place_folder = null, place_changed_at = now()
     where d.id = any(${held}::uuid[])
       and not (d.original_place_folder = any(${shown.map((f) => f.id)}::text[]))`.execute(trx);
}
