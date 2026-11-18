import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { appendAudit, householdZone, readAsApp, withSystem, type Db } from '@fdv/db';
import {
  APP_CHANGES_DEFAULT,
  APP_LIST_DEFAULT,
  APP_PAGE_MAX,
  APP_REFUSALS,
  EXTERNAL_ID_PATTERN,
  appMayDownloadSent,
  appMayRead,
  attachmentDisposition,
  deliveredType,
  localToday,
  nextLocalMidnight,
  recordFileName,
  type AppChange,
  type AppChanges,
  type AppDate,
  type AppDocument,
  type AppDocumentList,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { RequestMeta } from '../auth/service.js';
import type { DocumentService, EffectiveType } from '../documents/service.js';
import { holdForReading, rowStatus } from '../documents/service.js';
import { ApiError } from '../errors.js';
import type { AppCaller } from './service.js';

/**
 * What a connected app reads (0.9.0, APP2): a list, one document, its
 * changes feed and a download — its own documents and what its grants
 * cover, nothing else.
 *
 * Every document an app is answered with is read in the vault's own
 * transaction narrowed to the app (`readAsApp`): the database gives that
 * app the documents its rule allows (migration 0110's
 * connected_app_documents) and their current files, and nothing of any
 * other table. The API then asks its own copy of the rule (`appMayRead`)
 * of each, so a mistake in either is not enough. A document it may not read
 * is 404, exactly as one that does not exist.
 *
 * What it is told of each is the vault's as it is now ("the vault wins"):
 * kind, title, dates, amount, issuer, last 4, period, tax year, status and
 * the current file. Never whose it is, notes, tags, its number, where the
 * paper is kept, collections or other versions.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = 3_600_000;

const notFound = () => new ApiError(404, 'not_found', 'Nothing by that id that this app may see.');
const invalid = (message: string, detail: string) =>
  new ApiError(422, 'validation_failed', message, { detail });
const cursorExpired = () => new ApiError(410, 'cursor_expired', APP_REFUSALS.cursor_expired);
const badRange = () =>
  new ApiError(416, 'range_not_satisfiable', 'That part of the file does not exist.');

/** A document row as the app's transaction is given it. */
interface DocRowLike {
  id: string;
  type_key: string | null;
  title: string | null;
  visibility: string;
  is_essential: boolean;
  sensitive: boolean | null;
  deleted_at: Date | null;
  category: string | null;
  issued_on: string | null;
  issued_precision: string | null;
  expires_on: string | null;
  expires_precision: string | null;
  issued_by: string | null;
  extra: unknown;
  created_at: Date;
  updated_at: Date;
  owner_member_id: string | null;
  household_owned: boolean;
  identifier: string | null;
  physical_location: string | null;
  original_place: string[] | null;
  tags: string[];
  notes: string | null;
  notes_sealed: Buffer | null;
  sealed_details: string[];
  no_longer_needed_at: Date | null;
}

export interface VersionRowLike {
  id: string;
  document_id: string;
  version_no: number;
  filename: string;
  mime: string;
  byte_size: string | number;
  sha256: Buffer;
  storage_key: string;
  vault_id: string;
  wrapped_by_scope: string;
  file_key_wrapped: Buffer;
  uploaded_at: Date;
  file_removed_at: Date | null;
}

/**
 * The columns of a version an app's own send became that are read to serve
 * its bytes again (APP5): its file, its keys and its name — never the
 * details a version keeps of its document.
 */
export const SENT_VERSION_COLUMNS = [
  'id',
  'document_id',
  'version_no',
  'filename',
  'mime',
  'byte_size',
  'sha256',
  'storage_key',
  'vault_id',
  'wrapped_by_scope',
  'file_key_wrapped',
  'uploaded_at',
  'file_removed_at',
] as const;

/** One document the app may read, as it is told of it, and the fingerprint of that. */
export interface Readable1 {
  doc: AppDocument;
  fingerprint: Buffer;
  version: VersionRowLike | null;
  title: string | null;
  /**
   * Its current version is one this app sent (APP3's delete rule): only then
   * may the app delete it, so it never trashes a newer file of the family's.
   */
  currentSent: boolean;
}

/** A date as an app is told it. */
function dateOf(on: string | null, precision: string | null): AppDate | null {
  if (!on) return null;
  const p = precision === 'month' || precision === 'year' ? precision : 'day';
  return { date: on, precision: p };
}

/** A detail's date, as the vault keeps one: `{ date, precision }`, or a plain day. */
function extraDate(v: unknown): AppDate | null {
  if (typeof v === 'string' && DAY_RE.test(v)) return { date: v, precision: 'day' };
  if (v && typeof v === 'object' && typeof (v as { date?: unknown }).date === 'string') {
    const d = (v as { date: string }).date;
    if (!DAY_RE.test(d)) return null;
    return dateOf(d, (v as { precision?: string }).precision ?? 'day');
  }
  return null;
}

/** Whether a YYYY-MM-DD is a real day (as the database's cast would take it). */
function realDay(s: string): boolean {
  if (!DAY_RE.test(s) || Number(s.slice(0, 4)) < 1) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * The date a grant's lookback counts on, as the database's
 * connected_app_paper_date works it out: the issue date, else the due date,
 * else the day it was filed on the household's calendar.
 */
export function paperDate(
  row: Pick<DocRowLike, 'issued_on' | 'extra' | 'created_at'>,
  zone: string,
): string {
  if (row.issued_on) return row.issued_on;
  const extra = (row.extra ?? {}) as Record<string, unknown>;
  const due = extra.due_date;
  const text =
    typeof due === 'string'
      ? due
      : due && typeof due === 'object' && typeof (due as { date?: unknown }).date === 'string'
        ? (due as { date: string }).date
        : null;
  if (text && realDay(text)) return text;
  return localToday(zone, row.created_at);
}

/** An amount as filed ("2,450.10 USD"), with its number and code when it reads as one. */
function amountOf(v: unknown): AppDocument['amount'] {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return { text: String(v), value: String(v), currency: null };
  }
  if (typeof v !== 'string' || !v.trim()) return null;
  const text = v.trim();
  const m = /^(-?[\d,]*\d(?:\.\d+)?)\s+([A-Z]{3})$/.exec(text);
  return m
    ? { text, value: (m[1] as string).replace(/,/g, ''), currency: m[2] as string }
    : { text, value: null, currency: null };
}

const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function yearOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d{4}$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** The fingerprint of what an app is told of a document: every field but when it changed. */
export function fingerprintOfDocument(doc: AppDocument): Buffer {
  const said: Partial<AppDocument> = { ...doc };
  delete said.updated_at;
  return createHash('sha256').update(JSON.stringify(said)).digest();
}

/** A cursor, opaque to the app: base64url of what it holds. */
const encode = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
function decode(c: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(c)) return null;
  return Buffer.from(c, 'base64url').toString('utf8');
}

/** A Range header: one range of bytes, or null for the whole file. */
function parseRange(
  header: string | undefined,
  total: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) throw badRange();
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') throw badRange();
  const r =
    a === ''
      ? { start: Math.max(0, total - Number(b)), end: total - 1 }
      : { start: Number(a), end: b === '' ? total - 1 : Math.min(Number(b), total - 1) };
  if (total === 0 || r.start > r.end || r.start >= total) throw badRange();
  return r;
}

export interface AppReadOptions {
  documents: DocumentService;
  now: () => number;
}

/** The query of `GET /apps/documents`, as sent. */
export interface AppListQuery {
  kind?: string;
  category?: string;
  from?: string;
  to?: string;
  own?: string;
  limit?: string;
  cursor?: string;
}

export class AppReads {
  constructor(
    private readonly db: Db,
    private readonly opts: AppReadOptions,
  ) {}

  /**
   * What the app may read now, by id: read as the app (the database's
   * rule), each held to the API's own copy of the rule, and told as the
   * vault has it. `only` narrows it to some documents. Asked by links and
   * deletes (APP3) too, in their own transaction.
   */
  async readable(
    trx: Db,
    c: AppCaller,
    only: string[] | null = null,
  ): Promise<Map<string, Readable1>> {
    if (only && only.length === 0) return new Map();
    const { person, zone } = await this.appNow(trx, c);
    // Today as the database counts it: its own clock, on the household's calendar.
    const today = localToday(zone, new Date());
    const { docs, versions } = await readAsApp(trx, c.appId, zone, async (t) => {
      let dq = t.selectFrom('document').selectAll();
      if (only) dq = dq.where('id', 'in', only);
      const docs = (await dq.execute()) as unknown as DocRowLike[];
      const ids = docs.map((d) => d.id);
      const versions =
        ids.length === 0
          ? []
          : ((await t
              .selectFrom('document_version')
              .selectAll()
              .where('document_id', 'in', ids)
              .execute()) as unknown as VersionRowLike[]);
      return { docs, versions };
    });
    if (docs.length === 0) return new Map();
    const ids = docs.map((d) => d.id);
    const keys = [...new Set(docs.map((d) => d.type_key).filter((k): k is string => !!k))];
    const kinds = (
      keys.length === 0
        ? []
        : await trx
            .selectFrom('effective_document_type')
            .selectAll()
            .where('key', 'in', keys)
            .execute()
    ) as EffectiveType[];
    const kindBy = new Map(kinds.map((k) => [k.key, k]));
    const grants = await trx
      .selectFrom('connected_app_grant')
      .select(['kind_key', 'category', 'lookback_months', 'sensitive_kinds'])
      .where('app_id', '=', c.appId)
      .execute();
    const own = await trx
      .selectFrom('connected_app_intake')
      .select(['document_id', 'version_id', 'external_id', 'decided_at', 'made_document'])
      .where('app_id', '=', c.appId)
      .where('state', '=', 'filed')
      .where('unlinked_at', 'is', null)
      .where('document_id', 'in', ids)
      .orderBy('decided_at', 'desc')
      .execute();
    const versionBy = new Map<string, VersionRowLike>();
    for (const v of versions) {
      const had = versionBy.get(v.document_id);
      if (!had || had.version_no < v.version_no) versionBy.set(v.document_id, v);
    }
    // Its own: a document it made — a send of its filed as a document, not
    // into one that was there — for as long as it is in the vault, whatever
    // newer versions the family or another app added since (the owner's
    // decision, 18 Nov 2026). A family paper its file was filed into is the
    // family's, read only as a grant allows. Told by the send that made it.
    const ownBy = new Map<string, string>();
    for (const o of own) {
      if (!o.document_id || !o.made_document || ownBy.has(o.document_id)) continue;
      ownBy.set(o.document_id, o.external_id);
    }
    // Which of each document's versions this app sent, by their sends.
    const sentBy = new Map<string, Map<string, string>>();
    for (const o of own) {
      if (!o.document_id || !o.version_id) continue;
      const m = sentBy.get(o.document_id) ?? new Map<string, string>();
      if (!m.has(o.version_id)) m.set(o.version_id, o.external_id);
      sentBy.set(o.document_id, m);
    }
    const out = new Map<string, Readable1>();
    for (const d of docs) {
      const kind = d.type_key ? kindBy.get(d.type_key) : undefined;
      const paper = paperDate(d, zone);
      const ok = appMayRead({
        document: {
          visibility: d.visibility,
          is_essential: d.is_essential,
          sensitive: d.sensitive,
          deleted: d.deleted_at !== null,
          type_key: d.type_key,
          category: d.category,
          paper_date: paper,
        },
        kind: kind
          ? {
              category: kind.category,
              sensitive_default: kind.sensitive_default,
              usually_essential: kind.usually_essential,
            }
          : null,
        role: person.role,
        own: ownBy.has(d.id),
        grants: grants.map((g) => ({
          kind_key: g.kind_key,
          category: g.category,
          lookback_months: g.lookback_months,
          sensitive_kinds: g.sensitive_kinds,
        })),
        today,
      });
      if (!ok || !kind) continue;
      const v = versionBy.get(d.id) ?? null;
      const extra = (d.extra ?? {}) as Record<string, unknown>;
      const status = rowStatus(kind, d as unknown as Parameters<typeof rowStatus>[1], false, today);
      const updated =
        v && v.uploaded_at.getTime() > d.updated_at.getTime() ? v.uploaded_at : d.updated_at;
      const external = ownBy.get(d.id) ?? null;
      const doc: AppDocument = {
        id: d.id,
        kind: { key: kind.key, label: kind.label, category: kind.category },
        title: d.title,
        paper_date: paper,
        issued: dateOf(d.issued_on, d.issued_precision),
        expires: dateOf(d.expires_on, d.expires_precision),
        due_date: extraDate(extra.due_date),
        amount: amountOf(extra.amount),
        issuer: d.issued_by,
        account_last4: textOf(extra.account_last4),
        period: textOf(extra.period),
        tax_year: yearOf(extra.tax_year),
        status: { value: status.value, label: status.label },
        version: v
          ? {
              id: v.id,
              sha256: v.sha256.toString('hex'),
              byte_size: Number(v.byte_size),
              content_type: v.mime,
            }
          : null,
        own: external !== null,
        external_id: external,
        updated_at: updated.toISOString(),
      };
      const sent = sentBy.get(d.id) ?? new Map<string, string>();
      out.set(d.id, {
        doc,
        fingerprint: fingerprintOfDocument(doc),
        version: v,
        title: d.title,
        currentSent: v !== null && sent.has(v.id),
      });
    }
    return out;
  }

  /**
   * The app as it is now: one paused, waiting or removed since its request
   * was let in reads nothing — and is told so, never handed an empty
   * household (whose feed would say every document had gone). Its person's
   * role, and the household's calendar.
   */
  private async appNow(trx: Db, c: AppCaller): Promise<{ person: { role: string }; zone: string }> {
    const person = await trx
      .selectFrom('connected_app as a')
      .innerJoin('account_household as ah', (j) =>
        j
          .onRef('ah.account_id', '=', 'a.account_id')
          .onRef('ah.household_id', '=', 'a.household_id')
          .onRef('ah.member_id', '=', 'a.member_id'),
      )
      .select(['ah.role', 'a.revoked_at', 'a.paused_reason', 'a.approval'])
      .where('a.id', '=', c.appId)
      .executeTakeFirst();
    if (!person || person.revoked_at || !['owner', 'adult'].includes(person.role)) {
      throw new ApiError(401, 'app_revoked', APP_REFUSALS.app_revoked);
    }
    if (person.paused_reason) throw new ApiError(403, 'app_paused', APP_REFUSALS.app_paused);
    if (person.approval !== 'approved') {
      throw new ApiError(403, 'app_not_approved', APP_REFUSALS.app_not_approved);
    }
    const hh = await trx.selectFrom('household').select('timezone').executeTakeFirstOrThrow();
    return { person, zone: householdZone(hh.timezone) };
  }

  /**
   * The versions it sent that it may download again (APP5), by its
   * external ids: read as the app (the database's rule, 0113's
   * connected_app_sent_versions), and each held to the API's own copy of the
   * rule (`appMayDownloadSent`) against the document as the vault has it.
   * The send's version, never another; the document's other files and its
   * details are not read so.
   */
  private async sentVersions(
    trx: Db,
    c: AppCaller,
    externalIds: string[],
  ): Promise<Map<string, VersionRowLike>> {
    const out = new Map<string, VersionRowLike>();
    const { zone } = await this.appNow(trx, c);
    const sends = await trx
      .selectFrom('connected_app_intake')
      .select(['external_id', 'document_id', 'version_id'])
      .where('app_id', '=', c.appId)
      .where('external_id', 'in', externalIds)
      .where('state', '=', 'filed')
      .where('unlinked_at', 'is', null)
      .execute();
    const filed = sends.filter(
      (r): r is { external_id: string; document_id: string; version_id: string } =>
        r.document_id !== null && r.version_id !== null,
    );
    if (filed.length === 0) return out;
    // What serving its bytes needs, and nothing else: an older version
    // carries the document's details as they were, and none of them is ever
    // read here, let alone answered — the route gives the file alone.
    const versions = (await readAsApp(trx, c.appId, zone, (t) =>
      t
        .selectFrom('document_version')
        .select(SENT_VERSION_COLUMNS)
        .where(
          'id',
          'in',
          filed.map((r) => r.version_id),
        )
        .execute(),
    )) as unknown as VersionRowLike[];
    if (versions.length === 0) return out;
    const docs = await trx
      .selectFrom('document')
      .select(['id', 'deleted_at', 'visibility', 'category', 'type_key'])
      .where(
        'id',
        'in',
        versions.map((v) => v.document_id),
      )
      .execute();
    const keys = [...new Set(docs.map((d) => d.type_key).filter((k): k is string => !!k))];
    const kinds =
      keys.length === 0
        ? []
        : await trx
            .selectFrom('effective_document_type')
            .select(['key', 'category'])
            .where('key', 'in', keys)
            .execute();
    const kindBy = new Map(kinds.map((k) => [k.key, k.category]));
    const docBy = new Map(docs.map((d) => [d.id, d]));
    const versionBy = new Map(versions.map((v) => [v.id, v]));
    for (const r of filed) {
      const v = versionBy.get(r.version_id);
      const d = v ? docBy.get(v.document_id) : undefined;
      if (
        v &&
        d &&
        v.document_id === r.document_id &&
        appMayDownloadSent({
          deleted: d.deleted_at !== null,
          visibility: d.visibility,
          file_removed: v.file_removed_at !== null,
          category: d.category,
          kind_category: d.type_key ? (kindBy.get(d.type_key) ?? null) : null,
        })
      ) {
        out.set(r.external_id, v);
      }
    }
    return out;
  }

  /** Which of these sends' own files the app may download again (APP5): its intake's `content_available`. */
  async sentAvailable(c: AppCaller, externalIds: string[]): Promise<Set<string>> {
    const wanted = [...new Set(externalIds.filter((i) => EXTERNAL_ID_PATTERN.test(i)))];
    if (wanted.length === 0) return new Set();
    return withSystem(this.db, c.householdId, async (trx) => {
      return new Set((await this.sentVersions(trx, c, wanted)).keys());
    });
  }

  /** Which of these documents the app may still read (its intake's `filed` or `unavailable`). */
  async stillReadable(c: AppCaller, ids: string[]): Promise<Set<string>> {
    const wanted = [...new Set(ids.filter((i) => UUID.test(i)))];
    if (wanted.length === 0) return new Set();
    return withSystem(this.db, c.householdId, async (trx) => {
      return new Set((await this.readable(trx, c, wanted)).keys());
    });
  }

  /**
   * Reading is one line an hour an app — "looked up documents" — so a list
   * or a feed polled never floods the log.
   */
  private async lookedUp(trx: Db, c: AppCaller, meta: RequestMeta): Promise<void> {
    const due = await trx
      .updateTable('connected_app')
      .set({ looked_line_at: sql<Date>`now()` })
      .where('id', '=', c.appId)
      .where((eb) =>
        eb.or([
          eb('looked_line_at', 'is', null),
          eb('looked_line_at', '<', new Date(this.opts.now() - HOUR)),
        ]),
      )
      .returning('id')
      .executeTakeFirst();
    if (due) {
      await appendAudit(trx, {
        householdId: c.householdId,
        actorAccountId: c.accountId,
        action: 'app.looked_up',
        objectType: 'member',
        objectId: c.memberId,
        detail: { app_id: c.appId, app: c.name },
        ip: meta.ip,
      });
    }
  }

  // ------------------------------------------------------------- the list

  /** `GET /apps/documents`: newest paper first, then by id; paged by an opaque cursor. */
  async list(c: AppCaller, q: AppListQuery, meta: RequestMeta): Promise<AppDocumentList> {
    const kinds = q.kind === undefined ? null : q.kind.split(',').map((k) => k.trim());
    if (kinds && kinds.some((k) => !/^[a-z0-9_]{1,64}$/.test(k))) {
      throw invalid('kind is one or more kind keys, comma-separated.', 'kind');
    }
    if (q.category !== undefined && !/^[a-z0-9_]{1,64}$/.test(q.category)) {
      throw invalid('category is a category key.', 'category');
    }
    for (const k of ['from', 'to'] as const) {
      const v = q[k];
      if (v !== undefined && !realDay(v)) throw invalid(`${k} is YYYY-MM-DD.`, k);
    }
    if (q.own !== undefined && q.own !== 'true' && q.own !== 'false') {
      throw invalid('own is true or false.', 'own');
    }
    const limit = q.limit === undefined ? APP_LIST_DEFAULT : Number(q.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > APP_PAGE_MAX ||
      !/^\d+$/.test(q.limit ?? '1')
    ) {
      throw invalid(`limit is 1 to ${APP_PAGE_MAX}.`, 'limit');
    }
    let after: { paper: string; id: string } | null = null;
    if (q.cursor !== undefined) {
      const raw = decode(q.cursor);
      const m = raw ? /^l1\|(\d{4}-\d{2}-\d{2})\|([0-9a-f-]{36})$/.exec(raw) : null;
      if (!m) throw invalid('That is not a cursor this list gave.', 'cursor');
      after = { paper: m[1] as string, id: m[2] as string };
    }
    return withSystem(this.db, c.householdId, async (trx) => {
      const all = [...(await this.readable(trx, c)).values()].map((r) => r.doc);
      const picked = all
        .filter((d) => !kinds || kinds.includes(d.kind.key))
        .filter((d) => q.category === undefined || d.kind.category === q.category)
        .filter((d) => q.from === undefined || d.paper_date >= q.from)
        .filter((d) => q.to === undefined || d.paper_date <= q.to)
        .filter((d) => q.own === undefined || d.own === (q.own === 'true'))
        .sort((a, b) =>
          a.paper_date !== b.paper_date
            ? a.paper_date < b.paper_date
              ? 1
              : -1
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0,
        );
      const rest = after
        ? picked.filter(
            (d) =>
              d.paper_date < (after as { paper: string }).paper ||
              (d.paper_date === (after as { paper: string }).paper &&
                d.id > (after as { id: string }).id),
          )
        : picked;
      const items = rest.slice(0, limit);
      const last = items[items.length - 1];
      await this.lookedUp(trx, c, meta);
      return {
        items,
        next: rest.length > limit && last ? encode(`l1|${last.paper_date}|${last.id}`) : null,
      };
    });
  }

  /**
   * `GET /apps/documents/{id}`: one document. Its line in the document's own
   * Activity — "read the details of" — at most once an hour an app.
   */
  async document(c: AppCaller, id: string, meta: RequestMeta): Promise<AppDocument> {
    if (!UUID.test(id)) throw notFound();
    const docId = id.toLowerCase();
    return withSystem(this.db, c.householdId, async (trx) => {
      const r = (await this.readable(trx, c, [docId])).get(docId);
      if (!r) throw notFound();
      // Held while its line is written, as any reading is: an Undo of its
      // filing waits, and sees the line.
      await holdForReading(trx, docId);
      const recent = await trx
        .selectFrom('audit_event')
        .select('id')
        .where('object_type', '=', 'document')
        .where('object_id', '=', docId)
        .where('action', '=', 'app.read')
        .where(sql<boolean>`detail->>'app_id' = ${c.appId}`)
        .where('at', '>', new Date(this.opts.now() - HOUR))
        .limit(1)
        .executeTakeFirst();
      if (!recent) {
        await appendAudit(trx, {
          householdId: c.householdId,
          actorAccountId: c.accountId,
          action: 'app.read',
          objectType: 'document',
          objectId: docId,
          detail: { app_id: c.appId, app: c.name },
          ip: meta.ip,
        });
      }
      return r.doc;
    });
  }

  // ------------------------------------------------------------ the feed

  /**
   * `GET /apps/changes`: what changed since the cursor. Worked out as it is
   * asked, the app's feed held while it is: what the app may read now, each
   * with the fingerprint of what it is told, against what it was told
   * before. A document new to it, or changed, is a `changed` line; one it
   * could read and may not any more is `unavailable`, never why. Without a
   * cursor, every document it may read now, as `changed`, then the feed
   * from there.
   */
  async changes(
    c: AppCaller,
    q: { cursor?: string; limit?: string },
    meta: RequestMeta,
  ): Promise<AppChanges> {
    const limit = q.limit === undefined ? APP_CHANGES_DEFAULT : Number(q.limit);
    if (
      !/^\d+$/.test(q.limit ?? '1') ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > APP_PAGE_MAX
    ) {
      throw invalid(`limit is 1 to ${APP_PAGE_MAX}.`, 'limit');
    }
    type Cursor =
      | { kind: 'start' }
      | { kind: 'snapshot'; epoch: string; head: number; after: string }
      | { kind: 'feed'; epoch: string; seq: number };
    let cursor: Cursor = { kind: 'start' };
    if (q.cursor !== undefined) {
      const raw = decode(q.cursor);
      const s = raw ? /^s1\|(\d+)\|(\d+)\|([0-9a-f-]{36})$/.exec(raw) : null;
      const f = raw ? /^c1\|(\d+)\|(\d+)$/.exec(raw) : null;
      if (s)
        cursor = {
          kind: 'snapshot',
          epoch: s[1] as string,
          head: Number(s[2]),
          after: s[3] as string,
        };
      else if (f) cursor = { kind: 'feed', epoch: f[1] as string, seq: Number(f[2]) };
      else throw invalid('That is not a cursor this feed gave.', 'cursor');
    }
    return withSystem(this.db, c.householdId, async (trx) => {
      // One app's feed worked out at a time.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`fdv-app-feed:${c.appId}`}, 0))`.execute(
        trx,
      );
      const app = await trx
        .selectFrom('connected_app')
        .select(['restored_at', 'changes_pruned_to'])
        .where('id', '=', c.appId)
        // Held while the feed is read: the worker's pruning, which notes its
        // cut-off on this row as it lets lines go, waits for it, so a cursor
        // is never handed lines it skipped without a 410.
        .forShare()
        .executeTakeFirstOrThrow();
      // A restore starts the feed again: a cursor from before it is too old.
      const epoch = String(app.restored_at ? app.restored_at.getTime() : 0);
      if (cursor.kind !== 'start' && cursor.epoch !== epoch) throw cursorExpired();
      if (cursor.kind === 'feed' && cursor.seq < Number(app.changes_pruned_to)) {
        throw cursorExpired();
      }
      if (cursor.kind === 'snapshot' && cursor.head < Number(app.changes_pruned_to)) {
        throw cursorExpired();
      }

      const now = await this.readable(trx, c);
      await this.refresh(trx, c, now);
      await this.lookedUp(trx, c, meta);

      const headOf = async () =>
        Number(
          (
            await trx
              .selectFrom('connected_app_change')
              .select((eb) => eb.fn.max('seq').as('head'))
              .where('app_id', '=', c.appId)
              .executeTakeFirst()
          )?.head ?? 0,
        );
      const after = async (seq: number) =>
        (await trx
          .selectFrom('connected_app_change')
          .select('seq')
          .where('app_id', '=', c.appId)
          .where('seq', '>', String(seq))
          .limit(1)
          .executeTakeFirst()) !== undefined;

      if (cursor.kind !== 'feed') {
        // Everything it may read now, by id, a page at a time; then the feed
        // from where it stood when this began.
        const head =
          cursor.kind === 'snapshot'
            ? cursor.head
            : Math.max(await headOf(), Number(app.changes_pruned_to));
        const from = cursor.kind === 'snapshot' ? cursor.after : '';
        const all = [...now.values()]
          .map((r) => r.doc)
          .filter((d) => d.id > from)
          .sort((a, b) => (a.id < b.id ? -1 : 1));
        const page = all.slice(0, limit);
        const changes: AppChange[] = page.map((d) => ({
          change: 'changed',
          at: d.updated_at,
          document: d,
        }));
        const last = page[page.length - 1];
        if (all.length > limit && last) {
          return { changes, cursor: encode(`s1|${epoch}|${head}|${last.id}`), more: true };
        }
        return { changes, cursor: encode(`c1|${epoch}|${head}`), more: await after(head) };
      }

      const rows = await trx
        .selectFrom('connected_app_change')
        .select(['seq', 'document_id', 'change', 'at'])
        .where('app_id', '=', c.appId)
        .where('seq', '>', String(cursor.seq))
        .orderBy('seq')
        .limit(limit)
        .execute();
      const changes: AppChange[] = [];
      for (const r of rows) {
        if (r.change === 'unavailable') {
          changes.push({
            change: 'unavailable',
            at: r.at.toISOString(),
            document_id: r.document_id,
          });
          continue;
        }
        // Changed then, and not readable now: a later line says unavailable.
        const doc = now.get(r.document_id)?.doc;
        if (doc) changes.push({ change: 'changed', at: r.at.toISOString(), document: doc });
      }
      const lastSeq = rows.length > 0 ? Number(rows[rows.length - 1]?.seq) : cursor.seq;
      return {
        changes,
        cursor: encode(`c1|${epoch}|${lastSeq}`),
        more: await after(lastSeq),
      };
    });
  }

  /**
   * What changed since the app was last told, written to its feed: a line
   * for each document new to it or changed, and for each it could read and
   * may not now. Inside the feed's own lock.
   */
  private async refresh(trx: Db, c: AppCaller, now: Map<string, Readable1>): Promise<void> {
    const seen = await trx
      .selectFrom('connected_app_seen')
      .select(['document_id', 'fingerprint', 'available'])
      .where('app_id', '=', c.appId)
      .execute();
    const seenBy = new Map(seen.map((s) => [s.document_id, s]));
    const lines: Array<{ document_id: string; change: 'changed' | 'unavailable' }> = [];
    const upserts: Array<{ document_id: string; fingerprint: Buffer; available: boolean }> = [];
    for (const [id, r] of now) {
      const s = seenBy.get(id);
      if (!s || !s.available || !s.fingerprint.equals(r.fingerprint)) {
        lines.push({ document_id: id, change: 'changed' });
        upserts.push({ document_id: id, fingerprint: r.fingerprint, available: true });
      }
    }
    for (const s of seen) {
      if (s.available && !now.has(s.document_id)) {
        lines.push({ document_id: s.document_id, change: 'unavailable' });
        upserts.push({ document_id: s.document_id, fingerprint: s.fingerprint, available: false });
      }
    }
    if (lines.length === 0) return;
    lines.sort((a, b) => (a.document_id < b.document_id ? -1 : 1));
    for (let i = 0; i < upserts.length; i += 500) {
      await trx
        .insertInto('connected_app_seen')
        .values(
          upserts.slice(i, i + 500).map((u) => ({
            household_id: c.householdId,
            app_id: c.appId,
            document_id: u.document_id,
            fingerprint: u.fingerprint,
            available: u.available,
          })),
        )
        .onConflict((oc) =>
          oc.columns(['app_id', 'document_id']).doUpdateSet((eb) => ({
            fingerprint: eb.ref('excluded.fingerprint'),
            available: eb.ref('excluded.available'),
            changed_at: sql<Date>`now()`,
          })),
        )
        .execute();
    }
    for (let i = 0; i < lines.length; i += 500) {
      await trx
        .insertInto('connected_app_change')
        .values(
          lines.slice(i, i + 500).map((l) => ({
            household_id: c.householdId,
            app_id: c.appId,
            document_id: l.document_id,
            change: l.change,
          })),
        )
        .execute();
    }
  }

  // --------------------------------------------------------- the download

  /**
   * `GET /apps/documents/{id}/content`: the current file's bytes, server to
   * server — a download, never a page: `attachment`, nosniff, a sandbox. Its
   * ETag is the version's id (`304` for `If-None-Match`); a Range is `206`.
   * Counted against the app's bytes a day, and written down as a download in
   * the document's Activity, "via" the app.
   */
  async content(
    c: AppCaller,
    id: string,
    headers: { range?: string | undefined; ifNoneMatch?: string | undefined },
    meta: RequestMeta,
  ): Promise<
    | { status: 304; etag: string }
    | {
        status: 200 | 206;
        etag: string;
        headers: Record<string, string>;
        stream: Readable;
      }
  > {
    if (!UUID.test(id)) throw notFound();
    const docId = id.toLowerCase();
    const got = await withSystem(this.db, c.householdId, async (trx) => {
      const r = (await this.readable(trx, c, [docId])).get(docId);
      const v = r?.version;
      if (!r || !v || v.file_removed_at) throw notFound();
      return this.counted(trx, c, v, headers, meta, {});
    });
    return this.answered(got);
  }

  /**
   * `GET /apps/intake/{external_id}/content` (APP5): the exact file a send
   * of its became, by its own external id — while that file is still one of
   * the vault's versions, its document out of the Trash and not Only me —
   * whether or not the app may read the document now (a file filed into a
   * family paper as a new version, or one a newer family file came after).
   * Served, counted and written down as its downloads are; its ETag is the
   * version's id. Anything else is 404, as one never sent.
   */
  async sentContent(
    c: AppCaller,
    externalId: string,
    headers: { range?: string | undefined; ifNoneMatch?: string | undefined },
    meta: RequestMeta,
  ): Promise<
    | { status: 304; etag: string }
    | {
        status: 200 | 206;
        etag: string;
        headers: Record<string, string>;
        stream: Readable;
      }
  > {
    if (!EXTERNAL_ID_PATTERN.test(externalId)) throw notFound();
    const got = await withSystem(this.db, c.householdId, async (trx) => {
      const v = (await this.sentVersions(trx, c, [externalId])).get(externalId);
      if (!v) throw notFound();
      return this.counted(trx, c, v, headers, meta, { sent: true });
    });
    return this.answered(got);
  }

  /**
   * A version's bytes for the app, in the vault's own transaction once the
   * app's rule has given it: `304` for its ETag; else within the app's
   * download bytes for the day, counted with the app held, its document
   * held while its line is written, its key opened. The bytes are read
   * once the transaction is over.
   */
  private async counted(
    trx: Db,
    c: AppCaller,
    v: VersionRowLike,
    headers: { range?: string | undefined; ifNoneMatch?: string | undefined },
    meta: RequestMeta,
    more: Record<string, unknown>,
  ) {
    const docId = v.document_id;
    const etag = `"${v.id}"`;
    const asked = (headers.ifNoneMatch ?? '')
      .split(',')
      .map((t) => t.trim().replace(/^W\//, ''))
      .filter(Boolean);
    if (asked.includes(etag) || asked.includes('*')) return { kind: 'same' as const, etag };
    const total = Number(v.byte_size);
    const range = parseRange(headers.range, total);
    const bytes = range ? range.end - range.start + 1 : total;
    // More than it may download in a whole day: never, however long it
    // waits — so said, not to be retried; a Range takes it in parts.
    const cap = await trx
      .selectFrom('connected_app')
      .select('daily_read_bytes')
      .where('id', '=', c.appId)
      .executeTakeFirstOrThrow();
    if (bytes > Number(cap.daily_read_bytes)) {
      throw new ApiError(413, 'larger_than_daily_read', APP_REFUSALS.larger_than_daily_read, {
        detail: String(cap.daily_read_bytes),
      });
    }
    // Within the day's download bytes, counted with the app held.
    const hh = await trx.selectFrom('household').select('timezone').executeTakeFirstOrThrow();
    const zone = householdZone(hh.timezone);
    const day = localToday(zone, new Date(this.opts.now()));
    const counted = await trx
      .updateTable('connected_app')
      .set({
        read_day: day,
        read_bytes_today: sql<string>`case when read_day = ${day}::date then read_bytes_today + ${bytes} else ${bytes} end`,
      })
      .where('id', '=', c.appId)
      .where(
        sql<boolean>`(case when read_day = ${day}::date then read_bytes_today else 0 end) + ${bytes} <= daily_read_bytes`,
      )
      .returning('id')
      .executeTakeFirst();
    if (!counted) {
      const wait = Math.max(
        1,
        Math.ceil(
          (nextLocalMidnight(zone, new Date(this.opts.now())).getTime() - this.opts.now()) / 1000,
        ),
      );
      throw new ApiError(429, 'app_read_day_full', APP_REFUSALS.app_read_day_full, {
        retriable: true,
        retryAfter: wait,
      });
    }
    await holdForReading(trx, docId);
    const open = await this.opts.documents.appVersionBytes(trx, v);
    await appendAudit(trx, {
      householdId: c.householdId,
      actorAccountId: c.accountId,
      action: 'document.downloaded',
      objectType: 'document',
      objectId: docId,
      detail: {
        app_id: c.appId,
        app: c.name,
        version_no: v.version_no,
        range: range ? `${range.start}-${range.end}` : null,
        ...more,
      },
      ip: meta.ip,
    });
    return { kind: 'bytes' as const, etag, v, total, range, open };
  }

  /** What `counted` found, as the route answers it: the headers, and the bytes streamed. */
  private async answered(got: Awaited<ReturnType<AppReads['counted']>>): Promise<
    | { status: 304; etag: string }
    | {
        status: 200 | 206;
        etag: string;
        headers: Record<string, string>;
        stream: Readable;
      }
  > {
    if (got.kind === 'same') return { status: 304, etag: got.etag };
    const stream = await got.open(got.range);
    const out: Record<string, string> = {
      'content-type': deliveredType(got.v.mime),
      'content-disposition': attachmentDisposition(recordFileName(got.v.filename, got.v.mime)),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    };
    if (got.range) {
      out['content-range'] = `bytes ${got.range.start}-${got.range.end}/${got.total}`;
      out['content-length'] = String(got.range.end - got.range.start + 1);
      return { status: 206, etag: got.etag, headers: out, stream };
    }
    out['content-length'] = String(got.total);
    return { status: 200, etag: got.etag, headers: out, stream };
  }
}
