import { randomBytes } from 'node:crypto';
import { withPrincipal, type Db } from '@fdv/db';
import {
  drawCabinet,
  DIVIDER_YEARS,
  dividerMode,
  dividersProblemOf,
  OTHER_YEARS,
  resolvedRanges,
  PIN_IN_TRASH,
  PIN_LIMITS,
  rangesNewestFirst,
  TOO_MANY_PINS,
  CABINET_CHANGED,
  CABINET_LIMITS,
  CABINET_TOO_BIG,
  HOUSEHOLD_MEMBER_FILTER,
  layoutProblemOf,
  layoutSize,
  LOCATION_SORT_REFUSAL,
  maySortByLocation,
  NOBODY_MEMBER_FILTER,
  NOT_SURE_YET,
  NOTE_KIND,
  shortName,
  THE_HOUSEHOLD,
  type AlsoIn,
  type ArrangeBy,
  type CabinetCounts,
  type CabinetFolder,
  type CabinetGroup,
  type CabinetLayout,
  type CabinetPreview,
  type CabinetView,
  type DocumentPage,
  type FolderContents,
  type FolderDivider,
  type PinsMoved,
} from '@fdv/shared';
import { sql } from 'kysely';
import { parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { ApiError, notFound } from '../errors.js';
import { datedSql } from '../documents/filters.js';
import { folderQuery, listQueryOf } from '../documents/list-query.js';
import {
  readDocument,
  type CabinetConditions,
  type DaySpan,
  type DocumentService,
  type ListQuery,
} from '../documents/service.js';
import {
  documentCounts,
  documentMatches,
  documentYears,
  refusedForCabinet,
} from '../documents/table.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A folder shown, with where it is: hidden ones, and those in a hidden drawer or cabinet, are not. */
interface Placed {
  folder: CabinetFolder;
  path: [string, string, string];
}

function shownFolders(layout: CabinetLayout): Placed[] {
  // Only a saved layout is read, and only one the API checked is saved;
  // anything else holds no folders rather than failing.
  if (!Array.isArray(layout?.cabinets)) return [];
  return layout.cabinets
    .filter((c) => !c.hidden)
    .flatMap((c) =>
      c.drawers
        .filter((d) => !d.hidden)
        .flatMap((d) =>
          d.folders
            .filter((f) => !f.hidden)
            .map((folder): Placed => ({ folder, path: [c.name, d.name, folder.name] })),
        ),
    );
}

/** Every folder of a layout, shown or hidden: what a pin may be put in. */
function everyFolder(layout: CabinetLayout): CabinetFolder[] {
  if (!Array.isArray(layout?.cabinets)) return [];
  return layout.cabinets.flatMap((c) => c.drawers.flatMap((d) => d.folders));
}

/** A divider's question: one of a folder's, the folder's pins left out. */
interface DividerAsk {
  divider: Omit<FolderDivider, 'count'>;
  cabinet: CabinetConditions;
}

/**
 * The dividers a folder is drawn with (C2), each with what it asks beside
 * the folder's question: a year's days, a range's, or none of the ranges'
 * (Other years) — so that, its pins left out, every paper of the folder is
 * behind exactly one of them. Years are those the folder's papers are about.
 */
async function dividerAsks(
  trx: Db,
  p: Principal,
  folder: CabinetFolder,
  q: ListQuery,
): Promise<DividerAsk[]> {
  const except = q.cabinet?.except;
  const dividers = dividersOf(folder);
  const ask = (divider: Omit<FolderDivider, 'count'>, more: CabinetConditions): DividerAsk => ({
    divider,
    cabinet: { ...(except ? { except } : {}), ...more },
  });
  switch (dividerMode(dividers)) {
    case 'none':
      return [ask({ key: 'all', kind: 'all', name: '', from: null, to: null }, {})];
    case 'years': {
      // A year of four figures has its divider; any other is behind Other years.
      const years = (await documentYears(trx, p, q)).filter(
        (y) => y >= DIVIDER_YEARS.first && y <= DIVIDER_YEARS.last,
      );
      return [
        ...years.map((y) => {
          const span: DaySpan = { from: `${y}-01-01`, to: `${y}-12-31` };
          return ask(
            { key: `year:${y}`, kind: 'year', name: String(y), ...span },
            { within: span },
          );
        }),
        ask(
          { key: 'other', kind: 'other', name: OTHER_YEARS, from: null, to: null },
          { outside: [EVERY_YEAR] },
        ),
      ];
    }
    case 'ranges': {
      const ranges = rangesNewestFirst(dividers);
      const spans = ranges.map(({ range }): DaySpan => ({ from: range.from, to: range.to }));
      return [
        ...ranges.map(({ key, range }) =>
          ask(
            { key, kind: 'range', name: range.name, from: range.from, to: range.to },
            { within: { from: range.from, to: range.to } },
          ),
        ),
        ask(
          { key: 'other', kind: 'other', name: OTHER_YEARS, from: null, to: null },
          { outside: spans },
        ),
      ];
    }
  }
}

/** The years that have a divider of their own: four figures, as Postgres and the vault take a day. */
const EVERY_YEAR: DaySpan = {
  from: `${DIVIDER_YEARS.first}-01-01`,
  to: `${DIVIDER_YEARS.last}-12-31`,
};

/**
 * A folder's dividers, as they may be asked: a layout is checked as it is
 * saved, but one that would no longer pass (saved by a build before the
 * checks) is divided by year rather than asked what Postgres cannot read.
 */
function dividersOf(folder: CabinetFolder) {
  return folder.dividers && dividersProblemOf(folder.dividers) === null
    ? folder.dividers
    : undefined;
}

/** What one divider of a folder asks beside its question, by its key; null for none of its. */
function dividerOf(folder: CabinetFolder, key: string): CabinetConditions | null {
  const dividers = dividersOf(folder);
  const mode = dividerMode(dividers);
  if (mode === 'none') return key === 'all' ? {} : null;
  if (mode === 'years') {
    if (key === 'other') return { outside: [EVERY_YEAR] };
    const year = /^year:(\d{4})$/.exec(key);
    const y = Number(year?.[1]);
    return year && y >= DIVIDER_YEARS.first && y <= DIVIDER_YEARS.last
      ? { within: { from: `${year[1]}-01-01`, to: `${year[1]}-12-31` } }
      : null;
  }
  const spans = resolvedRanges(dividers);
  if (key === 'other') return { outside: spans };
  const at = /^range:(\d{1,2})$/.exec(key);
  const r = at ? spans[Number(at[1])] : undefined;
  return r ? { within: r } : null;
}

/**
 * A saved folder's question, as the list reads it; or null for one it
 * would no longer take (a layout saved by an older release, say): such a
 * folder holds nothing to tell, never more.
 */
function questionOf(f: CabinetFolder): ListQuery | null {
  try {
    return listQueryOf(parse(folderQuery, f.filter));
  } catch {
    return null;
  }
}

/**
 * My cabinet (0.9.0, C1): each person's own layout of cabinets, drawers and
 * folders (`cabinet_layout`, 0097, theirs alone by the database's rules),
 * and what its folders hold — worked out as the Documents table works it
 * out (table.ts: `documentCounts`, `documentMatches`), for whoever asks,
 * every time. A folder's question is the list's own parameters, read by the
 * list's own parser; it only narrows what its person may see already.
 */
export class CabinetService {
  constructor(
    private readonly db: Db,
    private readonly docs: DocumentService,
  ) {}

  /** GET /cabinet: the caller's layout; none until they save one. */
  async get(p: Principal): Promise<CabinetView> {
    return withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('cabinet_layout')
        .select(['layout', 'version', 'updated_at'])
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      return row
        ? {
            layout: row.layout as CabinetLayout,
            version: row.version,
            updated_at: row.updated_at.toISOString(),
          }
        : { layout: null, version: 0, updated_at: null };
    });
  }

  /**
   * PUT /cabinet: the whole layout, made to the version the caller last
   * read (0 for none yet) — else `409 conflict`, nothing saved. Its shape
   * and size are checked, and each folder's question by the list's own
   * parser: a folder never asks what the list would refuse its person.
   */
  async save(
    p: Principal,
    layout: CabinetLayout,
    version: number,
    pinsMoved: PinsMoved[] = [],
  ): Promise<CabinetView> {
    checkLayout(p, layout);
    const json = JSON.stringify(layout);
    return withPrincipal(this.db, p, async (trx) => {
      const write = () =>
        version === 0
          ? trx
              .insertInto('cabinet_layout')
              .values({ household_id: p.householdId, member_id: p.memberId, layout: json })
              .onConflict((oc) => oc.columns(['household_id', 'member_id']).doNothing())
              .returning(['version', 'updated_at'])
              .executeTakeFirst()
          : trx
              .updateTable('cabinet_layout')
              .set({
                layout: json,
                version: sql<number>`version + 1`,
                updated_at: sql<Date>`now()`,
              })
              .where('household_id', '=', p.householdId)
              .where('member_id', '=', p.memberId)
              .where('version', '=', version)
              .returning(['version', 'updated_at'])
              .executeTakeFirst();
      let saved: Awaited<ReturnType<typeof write>>;
      try {
        saved = await write();
      } catch (e) {
        // The database's own floor for a layout's size (0097): never reached
        // past checkLayout's, but a refusal in words if it ever is.
        const pg = e as { code?: string; constraint?: string };
        if (pg.code === '23514' && pg.constraint === 'cabinet_layout_size') {
          throw new ApiError(422, 'cabinet_too_big', CABINET_TOO_BIG, { detail: 'layout' });
        }
        throw e;
      }
      if (!saved) {
        throw new ApiError(409, 'conflict', CABINET_CHANGED, {
          detail: `version ${version} is not the cabinet's`,
        });
      }
      await keepPins(trx, p, layout, pinsMoved);
      return { layout, version: saved.version, updated_at: saved.updated_at.toISOString() };
    });
  }

  /**
   * POST /cabinet/preview: a layout drawn from what the caller can see,
   * not saved. Counted by the database with the rules every list keeps:
   * the caller's own, out of the Trash, notes left out; a person named as
   * the caller is given them, a kind as `types()` gives it.
   */
  async preview(p: Principal, by: ArrangeBy): Promise<CabinetPreview> {
    const kinds = new Map(
      (await this.docs.types(p, { all: true })).map((t) => [t.key, t.label] as const),
    );
    const { groups, people } = await withPrincipal(this.db, p, async (trx) => {
      const rows = (
        await sql<{
          owner_member_id: string | null;
          household_owned: boolean;
          category: string | null;
          type_key: string | null;
          year: number;
          n: number;
        }>`
          select d.owner_member_id, d.household_owned, d.category, d.type_key,
                 extract(year from ${datedSql('d')})::int as year, count(*)::int as n
            from document d
           where ${readDocument(p)} and d.deleted_at is null
             and d.type_key is distinct from ${NOTE_KIND}
           group by 1, 2, 3, 4, 5`.execute(trx)
      ).rows;
      const people = await trx.selectFrom('member').select(['id', 'display_name']).execute();
      return {
        people,
        groups: rows.map((r): CabinetGroup => ({
          person: r.household_owned
            ? HOUSEHOLD_MEMBER_FILTER
            : (r.owner_member_id ?? NOBODY_MEMBER_FILTER),
          category: r.category,
          type_key: r.type_key,
          year: r.year,
          n: r.n,
        })),
      };
    });
    const short = shortName(people);
    const full = new Map(people.map((m) => [m.id, m.display_name] as const));
    const personName = (id: string) =>
      id === HOUSEHOLD_MEMBER_FILTER
        ? THE_HOUSEHOLD
        : id === NOBODY_MEMBER_FILTER
          ? NOT_SURE_YET
          : (short.get(id) ?? 'Someone in the family');
    // The caller first; then the family by name; the household's; Not sure yet last.
    const rank = (id: string) =>
      id === p.memberId
        ? 0
        : id === HOUSEHOLD_MEMBER_FILTER
          ? 2
          : id === NOBODY_MEMBER_FILTER
            ? 3
            : 1;
    const drawn = drawCabinet(
      by,
      groups,
      {
        person: personName,
        kind: (key) => kinds.get(key) ?? 'Another kind',
        personOrder: (a, b) =>
          rank(a) - rank(b) ||
          (full.get(a) ?? '').localeCompare(full.get(b) ?? '') ||
          a.localeCompare(b),
      },
      () => randomBytes(6).toString('base64url'),
    );
    const problem = layoutProblemOf(drawn.layout);
    if (problem !== null) {
      throw new ApiError(422, problem.code, problem.message, { detail: by });
    }
    return drawn;
  }

  /**
   * GET /cabinet/counts: how many documents each shown folder holds for the
   * caller, each exactly the total the Documents table would give them for
   * its question; null for one they may no longer ask.
   */
  async counts(p: Principal): Promise<CabinetCounts> {
    return withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('cabinet_layout')
        .select(['layout', 'version'])
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      if (!row) return { version: 0, counts: {} };
      const shown = shownFolders(row.layout as CabinetLayout);
      // Each folder's pins the caller may still open, counted once: its
      // question counts what it holds besides them (C2).
      const pins = await livePins(trx, p);
      const questions = shown.map((s) => {
        const q = questionOf(s.folder);
        const pinned = pins.get(s.folder.id);
        return q && pinned ? { ...q, cabinet: { except: pinned } } : q;
      });
      const asked = questions.flatMap((q, i) => (q ? [{ q, i }] : []));
      const got = await documentCounts(
        trx,
        p,
        asked.map((a) => a.q),
      );
      const counts: Record<string, number | null> = {};
      for (const s of shown) counts[s.folder.id] = null;
      asked.forEach(({ i }, n) => {
        const id = (shown[i] as Placed).folder.id;
        const held = got[n];
        counts[id] =
          held === null || held === undefined ? null : held + (pins.get(id)?.length ?? 0);
      });
      // Every folder's live pins, hidden ones too: what saving a new
      // arrangement would let go of, said before it is (C2 review).
      const pinsOf: Record<string, number> = {};
      for (const [folder, docs] of pins) pinsOf[folder] = docs.length;
      return { version: row.version, counts, pins: pinsOf };
    });
  }

  /**
   * GET /documents/{id}/also-in: the caller's shown folders that document
   * `id` is in, by the same rules — a document they may not see is not
   * there (404), and one in the Trash is in none.
   */
  async alsoIn(p: Principal, id: string): Promise<AlsoIn> {
    if (!UUID.test(id)) throw notFound('That document');
    return withPrincipal(this.db, p, async (trx) => {
      const seen = (
        await sql<{ id: string }>`
          select d.id from document d where d.id = ${id}::uuid and ${readDocument(p)}`.execute(trx)
      ).rows[0];
      if (!seen) throw notFound('That document');
      const row = await trx
        .selectFrom('cabinet_layout')
        .select('layout')
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .executeTakeFirst();
      if (!row) return { items: [] };
      const shown = shownFolders(row.layout as CabinetLayout);
      const asked = shown.flatMap((s) => {
        const q = questionOf(s.folder);
        return q ? [{ q, s }] : [];
      });
      const matches = await documentMatches(
        trx,
        p,
        id,
        asked.map((a) => a.q),
      );
      const matched = new Set(asked.filter((_, n) => matches[n]).map(({ s }) => s.folder.id));
      // Pinned there too (C2): only while it may be opened, out of the Trash.
      const pinnedIn = new Set((await livePins(trx, p, { document: id })).keys());
      return {
        items: shown
          .filter((s) => matched.has(s.folder.id) || pinnedIn.has(s.folder.id))
          .map((s) => ({
            id: s.folder.id,
            name: s.folder.name,
            path: s.path,
            ...(pinnedIn.has(s.folder.id) ? { pinned: true } : {}),
          })),
      };
    });
  }

  /**
   * GET /cabinet/folders/{id} (C2): one of the caller's shown folders,
   * opened — its pinned papers they may still open, then its dividers
   * newest first, each counted by the table's own conditions, the pinned
   * left out of them; `total` exactly GET /cabinet/counts's for it.
   */
  async folder(p: Principal, folderId: string): Promise<FolderContents> {
    const found = await withPrincipal(this.db, p, async (trx) => {
      const { folder, version } = await shownFolder(trx, p, folderId);
      const pinned = (await livePins(trx, p, { folder: folderId })).get(folderId) ?? [];
      const q = questionOf(folder);
      if (!q || refusedForCabinet(p, q)) return { version, pinned, dividers: null };
      const asks = await dividerAsks(trx, p, folder, { ...q, cabinet: { except: pinned } });
      const got = await documentCounts(
        trx,
        p,
        asks.map((a) => ({ ...q, cabinet: a.cabinet })),
      );
      const dividers = asks
        .map((a, i): FolderDivider => ({ ...a.divider, count: got[i] ?? 0 }))
        // A year a status leaves nothing behind is no divider; a range of the
        // folder's own is one, empty or not; Other years, only with something.
        .filter((d) => d.count > 0 || d.kind === 'range' || d.kind === 'all');
      return { version, pinned, dividers };
    });
    const pinned =
      found.pinned.length === 0
        ? []
        : (
            await this.docs.table(p, {
              cabinet: { only: found.pinned },
              sort: 'dated',
              direction: 'desc',
              limit: PIN_LIMITS.folder,
            })
          ).items;
    return {
      folder_id: folderId,
      version: found.version,
      total:
        found.dividers === null
          ? null
          : pinned.length + found.dividers.reduce((n, d) => n + d.count, 0),
      pinned,
      dividers: found.dividers ?? [],
    };
  }

  /**
   * GET /cabinet/folders/{id}/documents (C2): the papers behind one of a
   * folder's dividers, newest first, a page at a time — the table's own
   * listing of the folder's question, its pinned papers left out (they are
   * shown above the dividers). A divider it does not have is 404.
   */
  async folderDocuments(
    p: Principal,
    folderId: string,
    q: { divider: string; cursor?: string | undefined; limit?: number | undefined },
  ): Promise<DocumentPage> {
    const asked = await withPrincipal(this.db, p, async (trx) => {
      const { folder } = await shownFolder(trx, p, folderId);
      const question = questionOf(folder);
      const more = dividerOf(folder, q.divider);
      if (!question || refusedForCabinet(p, question) || more === null) {
        throw notFound('That divider');
      }
      const pinned = (await livePins(trx, p, { folder: folderId })).get(folderId) ?? [];
      return { ...question, cabinet: { except: pinned, ...more } };
    });
    return this.docs.table(p, {
      ...asked,
      sort: 'dated',
      direction: 'desc',
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    });
  }

  /**
   * POST /cabinet/folders/{id}/pins (C2): papers pinned into one of the
   * caller's folders — their own arrangement, never a change to a paper.
   * Each must be one they may open (else nothing is pinned: 404), out of
   * the Trash (422). Pinning one pinned already is nothing new. A folder
   * holds at most 200, a person 2,000; pins of papers they may no longer
   * open are let go first, before a cap refuses.
   */
  async pin(p: Principal, folderId: string, documentIds: string[]): Promise<{ pinned: number }> {
    const ids = [...new Set(documentIds.map((i) => i.toLowerCase()))];
    if (ids.length === 0 || ids.some((i) => !UUID.test(i))) throw notFound('That document');
    return withPrincipal(this.db, p, async (trx) => {
      // Their layout's row, held: one person's pins and saves go one at a time.
      const row = await trx
        .selectFrom('cabinet_layout')
        .select('layout')
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .forUpdate()
        .executeTakeFirst();
      // A shown folder of theirs: a hidden one is not offered, and not taken (C2 review).
      if (
        !row ||
        !shownFolders(row.layout as CabinetLayout).some((s) => s.folder.id === folderId)
      ) {
        throw notFound('That folder');
      }
      const seen = (
        await sql<{ id: string; in_trash: boolean }>`
          select d.id, d.deleted_at is not null as in_trash
            from document d
           where d.id = any(${ids}::uuid[]) and ${readDocument(p)}`.execute(trx)
      ).rows;
      if (seen.length !== ids.length) throw notFound('That document');
      if (seen.some((d) => d.in_trash)) {
        throw new ApiError(422, 'cabinet_pin_in_trash', PIN_IN_TRASH);
      }
      await sql`
        insert into cabinet_pin (household_id, member_id, folder_id, document_id)
        select ${p.householdId}::uuid, ${p.memberId}::uuid, ${folderId}, x
          from unnest(${ids}::uuid[]) as x
        on conflict do nothing`.execute(trx);
      const over = async () => {
        const n = (
          await sql<{ here: number; every: number }>`
            select (count(*) filter (where folder_id = ${folderId}))::int as here,
                   count(*)::int as every
              from cabinet_pin
             where household_id = ${p.householdId}::uuid
               and member_id = ${p.memberId}::uuid`.execute(trx)
        ).rows[0];
        return (n?.here ?? 0) > PIN_LIMITS.folder || (n?.every ?? 0) > PIN_LIMITS.total;
      };
      if (await over()) {
        // Room first, from pins of papers they may no longer open: never shown.
        await sql`
          delete from cabinet_pin cp
           where cp.household_id = ${p.householdId}::uuid
             and cp.member_id = ${p.memberId}::uuid
             and not exists (
               select 1 from document d where d.id = cp.document_id and ${readDocument(p)})`.execute(
          trx,
        );
        if (await over()) {
          throw new ApiError(422, 'cabinet_too_many_pins', TOO_MANY_PINS, {
            detail: `at most ${PIN_LIMITS.folder} a folder, ${PIN_LIMITS.total} in all`,
          });
        }
      }
      return { pinned: ids.length };
    });
  }

  /**
   * DELETE /cabinet/folders/{id}/pins/{documentId} (C2): unpinned — the
   * caller's own row taken away, whatever the paper: `204` for any id, so
   * somebody who may no longer open a paper can still let its pin go, and
   * the answer says nothing of whether there was one, or such a paper.
   */
  async unpin(p: Principal, folderId: string, documentId: string): Promise<void> {
    if (!UUID.test(documentId)) return;
    await withPrincipal(this.db, p, async (trx) => {
      await trx
        .deleteFrom('cabinet_pin')
        .where('household_id', '=', p.householdId)
        .where('member_id', '=', p.memberId)
        .where('folder_id', '=', folderId)
        .where('document_id', '=', documentId)
        .execute();
    });
  }
}

/** One of the caller's shown folders, and their layout's version; else 404. */
async function shownFolder(
  trx: Db,
  p: Principal,
  folderId: string,
): Promise<{ folder: CabinetFolder; version: number }> {
  const row = await trx
    .selectFrom('cabinet_layout')
    .select(['layout', 'version'])
    .where('household_id', '=', p.householdId)
    .where('member_id', '=', p.memberId)
    .executeTakeFirst();
  const placed = row
    ? shownFolders(row.layout as CabinetLayout).find((s) => s.folder.id === folderId)
    : undefined;
  if (!row || !placed) throw notFound('That folder');
  return { folder: placed.folder, version: row.version };
}

/**
 * The caller's pins, by folder, of papers they may still open, out of the
 * Trash, oldest pin first — read only joined to the document under the
 * reader's own rules, so a pin never says more than they may see. One
 * folder's, or one paper's, when asked.
 */
async function livePins(
  trx: Db,
  p: Principal,
  only: { folder?: string; document?: string } = {},
): Promise<Map<string, string[]>> {
  const rows = (
    await sql<{ folder_id: string; document_id: string }>`
      select cp.folder_id, cp.document_id
        from cabinet_pin cp
        join document d on d.id = cp.document_id
       where cp.household_id = ${p.householdId}::uuid
         and cp.member_id = ${p.memberId}::uuid
         ${only.folder !== undefined ? sql`and cp.folder_id = ${only.folder}` : sql``}
         ${only.document !== undefined ? sql`and cp.document_id = ${only.document}::uuid` : sql``}
         and ${readDocument(p)} and d.deleted_at is null
       order by cp.pinned_at, cp.document_id`.execute(trx)
  ).rows;
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.folder_id, [...(out.get(r.folder_id) ?? []), r.document_id]);
  return out;
}

/**
 * A layout saved (C2): the pins of folders merged into others moved with
 * them, then those of folders it no longer has let go. Only a folder the
 * layout no longer has moves: a move from one it keeps would copy its pins.
 * A folder over its cap of pins, or a person over theirs, is refused,
 * nothing saved — counting only the pins they may still open, out of the
 * Trash, so a refusal never says a pin they cannot see is there.
 */
async function keepPins(
  trx: Db,
  p: Principal,
  layout: CabinetLayout,
  moved: PinsMoved[],
): Promise<void> {
  const ids = everyFolder(layout).map((f) => f.id);
  // In the order they were made: B into A, then A into Z, takes B's to Z too.
  const target = new Map<string, string>();
  for (const m of moved.filter((x) => !ids.includes(x.from))) {
    for (const [from, to] of target) if (to === m.from) target.set(from, m.to);
    if (!target.has(m.from)) target.set(m.from, m.to);
  }
  const moves = [...target]
    .map(([from, to]) => ({ from, to }))
    .filter((m) => m.from !== m.to && ids.includes(m.to));
  if (moves.length > 0) {
    await sql`
      insert into cabinet_pin (household_id, member_id, folder_id, document_id, pinned_at)
      select cp.household_id, cp.member_id, m.to_id, cp.document_id, cp.pinned_at
        from cabinet_pin cp
        join unnest(${moves.map((m) => m.from)}::text[], ${moves.map((m) => m.to)}::text[])
               as m(from_id, to_id) on m.from_id = cp.folder_id
       where cp.household_id = ${p.householdId}::uuid and cp.member_id = ${p.memberId}::uuid
      on conflict do nothing`.execute(trx);
  }
  await sql`
    delete from cabinet_pin
     where household_id = ${p.householdId}::uuid and member_id = ${p.memberId}::uuid
       and not (folder_id = any(${ids}::text[]))`.execute(trx);
  const live = await livePins(trx, p);
  const every = [...live.values()].reduce((n, docs) => n + docs.length, 0);
  const fullest = Math.max(0, ...[...live.values()].map((docs) => docs.length));
  if (fullest > PIN_LIMITS.folder || every > PIN_LIMITS.total) {
    throw new ApiError(422, 'cabinet_too_many_pins', TOO_MANY_PINS, { detail: 'merged folders' });
  }
}

/**
 * A layout as it may be saved: within its sizes, every node named and with
 * an id of its own, and every folder's question the list's own — read by
 * its parser, small, and nothing the list would refuse this person (where
 * originals are kept, to whoever may not see one). Each refusal names the
 * folder.
 */
function checkLayout(p: Principal, layout: CabinetLayout): void {
  // By its bytes, as Postgres keeps it: a name in Chinese is three a character.
  if (Buffer.byteLength(JSON.stringify(layout)) > CABINET_LIMITS.layout_bytes) {
    throw new ApiError(422, 'cabinet_too_big', CABINET_TOO_BIG, { detail: 'layout' });
  }
  const problem = layoutProblemOf(layout);
  if (problem !== null) {
    throw new ApiError(422, problem.code, problem.message, {
      detail: JSON.stringify(layoutSize(layout)),
    });
  }
  for (const c of layout.cabinets) {
    for (const d of c.drawers) {
      for (const f of d.folders) {
        const refuse = (message: string, detail: string): never => {
          throw new ApiError(422, 'validation_failed', `The folder “${f.name}”: ${message}`, {
            detail: `folder ${f.id}: ${detail}`,
          });
        };
        if (Buffer.byteLength(JSON.stringify(f.filter)) > CABINET_LIMITS.filter_bytes) {
          refuse('it asks for too much at once.', 'filter too big');
        }
        let q: ListQuery;
        try {
          q = listQueryOf(parse(folderQuery, f.filter));
        } catch (e) {
          if (e instanceof ApiError) refuse(e.message, e.options.detail ?? e.code);
          throw e;
        }
        if (q.location !== undefined && !maySortByLocation(p.role)) {
          refuse(LOCATION_SORT_REFUSAL, 'location');
        }
      }
    }
  }
}
