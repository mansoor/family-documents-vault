import { randomBytes } from 'node:crypto';
import { withPrincipal, type Db } from '@fdv/db';
import {
  drawCabinet,
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
} from '@fdv/shared';
import { sql } from 'kysely';
import { parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { ApiError, notFound } from '../errors.js';
import { datedSql } from '../documents/filters.js';
import { folderQuery, listQueryOf } from '../documents/list-query.js';
import { seenDocument, type DocumentService, type ListQuery } from '../documents/service.js';
import { documentCounts, documentMatches } from '../documents/table.js';

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
  async save(p: Principal, layout: CabinetLayout, version: number): Promise<CabinetView> {
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
           where ${seenDocument(p)} and d.deleted_at is null
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
      const questions = shown.map((s) => questionOf(s.folder));
      const asked = questions.flatMap((q, i) => (q ? [{ q, i }] : []));
      const got = await documentCounts(
        trx,
        p,
        asked.map((a) => a.q),
      );
      const counts: Record<string, number | null> = {};
      for (const s of shown) counts[s.folder.id] = null;
      asked.forEach(({ i }, n) => {
        counts[(shown[i] as Placed).folder.id] = got[n] ?? null;
      });
      return { version: row.version, counts };
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
          select d.id from document d where d.id = ${id}::uuid and ${seenDocument(p)}`.execute(trx)
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
      return {
        items: asked
          .filter((_, n) => matches[n])
          .map(({ s }) => ({ id: s.folder.id, name: s.folder.name, path: s.path })),
      };
    });
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
