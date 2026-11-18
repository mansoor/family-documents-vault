import { createHash, randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { Readable } from 'node:stream';
import { appendAudit, householdZone, withSystem, type Db } from '@fdv/db';
import {
  APP_LINK_OPEN_SECONDS,
  APP_LINK_PAGES_MAX,
  APP_LINK_PATH,
  APP_LINK_SESSION_MINUTES,
  APP_ITSELF_READS_AS,
  APP_REFUSALS,
  attachmentDisposition,
  canShareToView,
  deliveredType,
  isRecordFormat,
  localToday,
  lockInEffect,
  recordFileName,
  suspensionInEffect,
  type AppDeleted,
  type AppLinkMinted,
  type AppLinkMode,
  type AppLinkSession,
  type AppScope,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { RequestMeta } from '../auth/service.js';
import type { DocumentService } from '../documents/service.js';
import { holdForReading } from '../documents/service.js';
import { ApiError } from '../errors.js';
import type { AppReads } from './reads.js';
import { appLine } from './lines.js';
import type { AppCaller } from './service.js';

/**
 * A connected app's links and deletes (0.9.0, APP3).
 *
 * **A link** is minted by the app, server to server, for a document it may
 * read now, and its user's browser is sent to it at once. Its token is 32
 * random bytes, kept only as their SHA-256, for one document, the version
 * current when it was minted, and one mode: `view` (the pages the vault
 * drew, on the `/a` page, never the file) or `download` (the file). It is
 * opened within two minutes, and once: the first open turns it into a
 * session of ten minutes — a cookie for `/api/v1/app-links/session` alone,
 * kept only as its hash — bound to the address it was opened from (IPv4
 * exactly, IPv6 by its /64). The token's second open, or one too late, is
 * the page's "used or ended", never why. The app's read rule is asked again
 * at every request in the session, with the app's state, its person's and
 * its scopes: a document it may no longer read, an app paused or removed,
 * ends it.
 *
 * **A delete** is of the app's own document alone (one a send of its made,
 * its current version still one the app sent): one it reads by a grant, or
 * may not read at all, is 404. As the owner chose for the app: it lets go
 * (its intake unlinked; the document stays, and leaves its own) or moves it
 * to the Trash as its person would. Either way it lets go of it, so the
 * family taking it out of the Trash keeps it as theirs.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

const notFound = () => new ApiError(404, 'not_found', 'Nothing by that id that this app may see.');
const ended = () => new ApiError(410, 'link_ended', APP_REFUSALS.link_ended);
const elsewhere = () => new ApiError(403, 'link_other_address', APP_REFUSALS.link_other_address);
const badRange = () =>
  new ApiError(416, 'range_not_satisfiable', 'That part of the file does not exist.');

const hashOf = (secret: string) => createHash('sha256').update(secret, 'utf8').digest();

/**
 * Whether two addresses are the same network for a link's session: an IPv4
 * address exactly, an IPv6 address by its first 64 bits (a phone's privacy
 * address changes within it). An IPv4 address written as IPv6 is IPv4.
 */
export function sameNetwork(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const v4 = (x: string) => /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(x)?.[1] ?? x;
  const x = v4(a);
  const y = v4(b);
  if (isIPv4(x) || isIPv4(y)) return x === y;
  if (!isIPv6(x) || !isIPv6(y)) return false;
  return prefix64(x) === prefix64(y);
}

/** An IPv6 address's first four groups, written out in full. */
function prefix64(ip: string): string {
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = ip.includes('::')
    ? [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t]
    : h;
  return groups
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':');
}

/** A Range header: one range of bytes, or null for the whole file. */
function parseRange(header: string | undefined, total: number) {
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

/** A link's row, as its session reads it. */
interface LinkRow {
  id: string;
  household_id: string;
  app_id: string;
  /** The API key it was minted with (APP6): revoked or expired, the link ends. */
  key_id: string;
  document_id: string;
  version_id: string;
  mode: AppLinkMode;
  open_by: Date;
  opened_at: Date | null;
  session_until: Date | null;
  first_address: string | null;
}

/** The version a link shows, as the vault keeps it. */
interface LinkVersion {
  id: string;
  document_id: string;
  version_no: number;
  filename: string;
  mime: string;
  byte_size: string | number;
  storage_key: string;
  vault_id: string;
  wrapped_by_scope: string;
  file_key_wrapped: Buffer;
  preview_state: string;
  preview_pages: number | null;
  preview_requested_at: Date | null;
  file_removed_at: Date | null;
}

export interface AppLinkOptions {
  reads: AppReads;
  documents: DocumentService;
  /** The address the app reaches the vault at: a link is on it too. */
  address: () => string;
}

/** What a token's open became: a session, or the page's "used" or "ended". */
export type LinkOpened =
  | { kind: 'session'; cookie: string; maxAge: number; mode: AppLinkMode }
  | { kind: 'used' }
  | { kind: 'ended' };

export class AppLinks {
  constructor(
    private readonly db: Db,
    private readonly opts: AppLinkOptions,
  ) {}

  // ------------------------------------------------------------ minting

  /**
   * `POST /apps/documents/{id}/links` (`documents.links`): a link for a
   * document the app may read now. Any link needs `documents.read` too —
   * its pages show what the document says — and a download link
   * `documents.download` as well: what the app may not read or download
   * itself, its user may not either. A view of a file the vault cannot draw is `409
   * view_unavailable`; more than the app's links an hour, `429
   * app_links_full`. A view's pages, not drawn yet, are asked for now.
   */
  async mint(c: AppCaller, id: string, mode: unknown, meta: RequestMeta): Promise<AppLinkMinted> {
    void meta;
    if (mode !== 'view' && mode !== 'download') {
      throw new ApiError(422, 'validation_failed', 'mode is "view" or "download".', {
        detail: 'mode',
      });
    }
    if (!UUID.test(id)) throw notFound();
    const docId = id.toLowerCase();
    for (const needed of mode === 'download'
      ? (['documents.read', 'documents.download'] as const)
      : (['documents.read'] as const)) {
      if (!c.scopes.includes(needed)) {
        throw new ApiError(403, 'scope_not_granted', APP_REFUSALS.scope_not_granted, {
          detail: needed,
        });
      }
    }
    const token = randomBytes(32).toString('base64url');
    const made = await withSystem(this.db, c.householdId, async (trx) => {
      const r = (await this.opts.reads.readable(trx, c, [docId])).get(docId);
      if (!r || !r.version || r.version.file_removed_at) throw notFound();
      const v = await this.version(trx, r.version.id);
      if (!v) throw notFound();
      if (
        mode === 'view' &&
        (!canShareToView(v.mime) ||
          isRecordFormat(v.mime) ||
          v.preview_state === 'unsupported' ||
          v.preview_state === 'failed')
      ) {
        throw new ApiError(409, 'view_unavailable', APP_REFUSALS.view_unavailable);
      }
      // So many an hour, counted with the app held.
      const app = await trx
        .selectFrom('connected_app')
        .select('links_per_hour')
        .where('id', '=', c.appId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const hour = await trx
        .selectFrom('connected_app_link')
        .select((eb) => [eb.fn.countAll<string>().as('n'), sql<Date>`now()`.as('now')])
        .where('app_id', '=', c.appId)
        .where('created_at', '>', sql<Date>`now() - interval '1 hour'`)
        .executeTakeFirstOrThrow();
      const n = Number(hour.n);
      if (n >= app.links_per_hour) {
        // Room again once this many of the hour's links are an hour old:
        // n − cap + 1 of them, so the (n − cap)th, counted from 0, oldest
        // first — the oldest itself only when the hour is exactly full (an
        // owner may have lowered the cap below what the hour holds).
        const freeing = await trx
          .selectFrom('connected_app_link')
          .select('created_at')
          .where('app_id', '=', c.appId)
          .where('created_at', '>', sql<Date>`now() - interval '1 hour'`)
          .orderBy('created_at')
          .offset(n - app.links_per_hour)
          .limit(1)
          .executeTakeFirst();
        const at = freeing ? new Date(freeing.created_at) : new Date(hour.now);
        const wait = Math.max(
          1,
          Math.ceil((at.getTime() + 3_600_000 - new Date(hour.now).getTime()) / 1000),
        );
        throw new ApiError(429, 'app_links_full', APP_REFUSALS.app_links_full, {
          retriable: true,
          retryAfter: wait,
        });
      }
      const row = await trx
        .insertInto('connected_app_link')
        .values({
          household_id: c.householdId,
          app_id: c.appId,
          key_id: c.keyId,
          document_id: docId,
          version_id: v.id,
          mode,
          token_hash: hashOf(token),
          open_by: sql<Date>`now() + make_interval(secs => ${APP_LINK_OPEN_SECONDS})`,
        })
        .returning('open_by')
        .executeTakeFirstOrThrow();
      // Its pages asked for now, so they are there when the browser comes.
      if (mode === 'view') await this.opts.documents.appPage(trx, c.householdId, v, 1);
      return row;
    });
    return {
      url: `${this.opts.address()}${APP_LINK_PATH}/${token}`,
      mode,
      open_by: new Date(made.open_by).toISOString(),
      session_minutes: APP_LINK_SESSION_MINUTES,
    };
  }

  private async version(trx: Db, id: string): Promise<LinkVersion | undefined> {
    return trx
      .selectFrom('document_version')
      .select([
        'id',
        'document_id',
        'version_no',
        'filename',
        'mime',
        'byte_size',
        'storage_key',
        'vault_id',
        'wrapped_by_scope',
        'file_key_wrapped',
        'preview_state',
        'preview_pages',
        'preview_requested_at',
        'file_removed_at',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  // ------------------------------------------------------- still good?

  /**
   * Whether a link may still give what it gives: its app live, on and
   * turned on, the API key it was minted with neither revoked nor expired
   * (APP6), its person able to act, its scopes — the app's and the key's —
   * still holding, and the document still one the app may read — asked as
   * the app, by its rule. The app, as it acts, and the document's title; or
   * null, never why.
   */
  private async stillGood(
    trx: Db,
    link: LinkRow,
  ): Promise<{ caller: AppCaller; title: string | null } | null> {
    const app = await trx
      .selectFrom('connected_app as a')
      .leftJoin('account_household as ah', (j) =>
        j
          .onRef('ah.account_id', '=', 'a.account_id')
          .onRef('ah.household_id', '=', 'a.household_id')
          .onRef('ah.member_id', '=', 'a.member_id'),
      )
      .innerJoin('household as hh', 'hh.id', 'a.household_id')
      .select([
        'a.id',
        'a.name',
        'a.scopes',
        'a.acts_as',
        'a.account_id',
        'a.member_id',
        'a.revoked_at',
        'a.paused_reason',
        'a.approval',
        'ah.role',
        'ah.suspended_at',
        'ah.suspended_until',
        'ah.suspend_reason',
        'hh.timezone',
      ])
      .where('a.id', '=', link.app_id)
      .executeTakeFirst();
    if (!app || app.revoked_at || app.paused_reason || app.approval !== 'approved') return null;
    // Its person able to act — an app acting as itself (APP8) has none, and
    // reads as an app acting as an adult would.
    const itself = app.acts_as === 'app';
    const role = itself ? APP_ITSELF_READS_AS : app.role;
    if (!role) return null;
    if (!itself) {
      const person = {
        suspend_reason: app.suspend_reason ?? null,
        suspended_at: app.suspended_at ?? null,
        suspended_until: app.suspended_until ?? null,
      };
      if (lockInEffect(person) || suspensionInEffect(person)) return null;
    }
    // The key it was minted with, live now: revoking a key ends its links.
    const key = await trx
      .selectFrom('connected_app_key')
      .select('permissions')
      .where('id', '=', link.key_id)
      .where('app_id', '=', link.app_id)
      .where('revoked_at', 'is', null)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
      .executeTakeFirst();
    if (!key) return null;
    const scopes = (app.scopes as AppScope[]).filter((s) => key.permissions.includes(s));
    if (!scopes.includes('documents.links') || !scopes.includes('documents.read')) return null;
    if (link.mode === 'download' && !scopes.includes('documents.download')) return null;
    const caller: AppCaller = {
      appId: app.id,
      keyId: link.key_id,
      householdId: link.household_id,
      actsAs: itself ? 'app' : 'person',
      accountId: itself ? null : app.account_id,
      memberId: itself ? null : app.member_id,
      role,
      name: app.name,
      memberName: null,
      timezone: householdZone(app.timezone),
      scopes,
      state: 'active',
      pausedReason: null,
    };
    const r = await this.opts.reads.readable(trx, caller, [link.document_id]).catch((e) => {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
      throw e;
    });
    const doc = r?.get(link.document_id);
    if (!doc) return null;
    return { caller, title: doc.title };
  }

  // ------------------------------------------------------------ opening

  /**
   * `GET /api/v1/app-links/{token}`: the browser's first open. Within two
   * minutes of minting, and once: a session of ten minutes, bound to this
   * address. Its second open is `used`; one too late, or for a document no
   * longer readable, `ended`. A view's open is the line in the Activity
   * ("Ahmed via Acme Money opened …"); a download's is each file it gives.
   */
  async open(token: string, address: string | null, meta: RequestMeta): Promise<LinkOpened> {
    if (!SECRET.test(token)) return { kind: 'ended' };
    const found = await sql<{
      household_id: string;
      link_id: string;
    }>`select household_id, link_id from connected_app_link_find(${hashOf(token)})`.execute(
      this.db,
    );
    const at = found.rows[0];
    if (!at) return { kind: 'ended' };
    const cookie = randomBytes(32).toString('base64url');
    return withSystem(this.db, at.household_id, async (trx): Promise<LinkOpened> => {
      const link = (await trx
        .selectFrom('connected_app_link')
        .select([
          'id',
          'household_id',
          'app_id',
          'key_id',
          'document_id',
          'version_id',
          'mode',
          'open_by',
          'opened_at',
          'session_until',
          'first_address',
        ])
        .select(sql<boolean>`open_by > now()`.as('in_time'))
        .where('id', '=', at.link_id)
        .forUpdate()
        .executeTakeFirst()) as (LinkRow & { in_time: boolean }) | undefined;
      if (!link) return { kind: 'ended' };
      if (link.opened_at) return { kind: 'used' };
      if (!link.in_time) return { kind: 'ended' };
      const good = await this.stillGood(trx, link);
      if (!good) return { kind: 'ended' };
      await trx
        .updateTable('connected_app_link')
        .set({
          opened_at: sql<Date>`now()`,
          session_hash: hashOf(cookie),
          session_until: sql<Date>`now() + make_interval(mins => ${APP_LINK_SESSION_MINUTES})`,
          first_address: address ? address.slice(0, 64) : null,
        })
        .where('id', '=', link.id)
        .execute();
      if (link.mode === 'view') {
        await holdForReading(trx, link.document_id);
        await appendAudit(trx, {
          householdId: link.household_id,
          actorAccountId: good.caller.accountId,
          action: 'document.viewed',
          objectType: 'document',
          objectId: link.document_id,
          detail: appLine(good.caller, { link: 'view' }),
          ip: meta.ip,
        });
      }
      return {
        kind: 'session',
        cookie,
        maxAge: APP_LINK_SESSION_MINUTES * 60,
        mode: link.mode,
      };
    });
  }

  /**
   * A request inside a session: its cookie, from the address it was opened
   * from, while it lasts and while the link may still give what it gives.
   * `410 link_ended` or `403 link_other_address` otherwise, never why.
   */
  private async inSession<T>(
    cookie: string | undefined,
    address: string | null,
    fn: (
      trx: Db,
      link: LinkRow,
      good: { caller: AppCaller; title: string | null },
      v: LinkVersion,
    ) => Promise<T>,
  ): Promise<T> {
    if (!cookie || !SECRET.test(cookie)) throw ended();
    const found = await sql<{
      household_id: string;
      link_id: string;
    }>`select household_id, link_id from connected_app_link_session_find(${hashOf(cookie)})`.execute(
      this.db,
    );
    const at = found.rows[0];
    if (!at) throw ended();
    return withSystem(this.db, at.household_id, async (trx) => {
      const link = (await trx
        .selectFrom('connected_app_link')
        .select([
          'id',
          'household_id',
          'app_id',
          'key_id',
          'document_id',
          'version_id',
          'mode',
          'open_by',
          'opened_at',
          'session_until',
          'first_address',
        ])
        .where('id', '=', at.link_id)
        .where('session_until', '>', sql<Date>`now()`)
        .executeTakeFirst()) as LinkRow | undefined;
      if (!link) throw ended();
      if (!sameNetwork(link.first_address, address)) throw elsewhere();
      const good = await this.stillGood(trx, link);
      if (!good) throw ended();
      const v = await this.version(trx, link.version_id);
      if (!v || v.document_id !== link.document_id) throw ended();
      return fn(trx, link, good, v);
    });
  }

  /** `GET /api/v1/app-links/session`: what the `/a` page shows. */
  async session(cookie: string | undefined, address: string | null): Promise<AppLinkSession> {
    return this.inSession(cookie, address, async (trx, link, good, v) => {
      let pages: AppLinkSession['pages'] = { state: 'none', count: 0 };
      if (link.mode === 'view') {
        const first = await this.opts.documents.appPage(trx, link.household_id, v, 1);
        pages =
          first.kind === 'ready'
            ? { state: 'ready', count: Math.min(v.preview_pages ?? 1, APP_LINK_PAGES_MAX) }
            : first.kind === 'pending'
              ? { state: 'drawing', count: 0 }
              : { state: 'none', count: 0 };
      }
      return {
        app: good.caller.name,
        mode: link.mode,
        title: good.title,
        pages,
        ends_at: (link.session_until as Date).toISOString(),
      };
    });
  }

  /** `GET /api/v1/app-links/session/pages/{n}`: one page a view link shows. */
  async page(cookie: string | undefined, address: string | null, n: number): Promise<Buffer> {
    const got = await this.inSession(cookie, address, async (trx, link, _good, v) => {
      if (link.mode !== 'view' || n < 1 || n > APP_LINK_PAGES_MAX) return { kind: 'none' as const };
      return this.opts.documents.appPage(trx, link.household_id, v, n);
    });
    if (got.kind === 'ready') return got.read();
    if (got.kind === 'pending') {
      throw new ApiError(404, 'preview_pending', 'The pages are being drawn. Try again shortly.', {
        retriable: true,
        retryAfter: 3,
      });
    }
    throw new ApiError(404, 'no_preview', 'There is no such page.');
  }

  /**
   * `GET /api/v1/app-links/session/file`: the file a download link gives —
   * the version current when it was minted, an attachment, never a page.
   * Each is a line in the Activity ("… via Acme Money downloaded …"). Every byte
   * it gives counts against the app's own download bytes for the day, as
   * its own downloads do: what the app may not download itself, its user
   * may not either (`413 larger_than_daily_read`, `429 app_read_day_full`).
   */
  async file(
    cookie: string | undefined,
    address: string | null,
    range: string | undefined,
    meta: RequestMeta,
  ): Promise<{ status: 200 | 206; headers: Record<string, string>; stream: Readable }> {
    const got = await this.inSession(cookie, address, async (trx, link, good, v) => {
      if (link.mode !== 'download' || v.file_removed_at) throw notFound();
      const total = Number(v.byte_size);
      const r = parseRange(range, total);
      const bytes = r ? r.end - r.start + 1 : total;
      // The app's day, counted with the app held, as its own downloads are.
      const cap = await trx
        .selectFrom('connected_app')
        .select('daily_read_bytes')
        .where('id', '=', good.caller.appId)
        .executeTakeFirstOrThrow();
      if (bytes > Number(cap.daily_read_bytes)) {
        throw new ApiError(413, 'larger_than_daily_read', APP_REFUSALS.larger_than_daily_read);
      }
      const day = localToday(good.caller.timezone, new Date());
      const counted = await trx
        .updateTable('connected_app')
        .set({
          read_day: day,
          read_bytes_today: sql<string>`case when read_day = ${day}::date then read_bytes_today + ${bytes} else ${bytes} end`,
        })
        .where('id', '=', good.caller.appId)
        .where(
          sql<boolean>`(case when read_day = ${day}::date then read_bytes_today else 0 end) + ${bytes} <= daily_read_bytes`,
        )
        .returning('id')
        .executeTakeFirst();
      if (!counted) {
        throw new ApiError(429, 'app_read_day_full', APP_REFUSALS.app_read_day_full);
      }
      await holdForReading(trx, link.document_id);
      const open = await this.opts.documents.appVersionBytes(trx, v);
      await appendAudit(trx, {
        householdId: link.household_id,
        actorAccountId: good.caller.accountId,
        action: 'document.downloaded',
        objectType: 'document',
        objectId: link.document_id,
        detail: appLine(good.caller, {
          link: 'download',
          version_no: v.version_no,
          range: r ? `${r.start}-${r.end}` : null,
        }),
        ip: meta.ip,
      });
      return { v, total, r, open };
    });
    const stream = await got.open(got.r);
    const headers: Record<string, string> = {
      'content-type': deliveredType(got.v.mime),
      'content-disposition': attachmentDisposition(recordFileName(got.v.filename, got.v.mime)),
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    };
    if (got.r) {
      headers['content-range'] = `bytes ${got.r.start}-${got.r.end}/${got.total}`;
      headers['content-length'] = String(got.r.end - got.r.start + 1);
      return { status: 206, headers, stream };
    }
    headers['content-length'] = String(got.total);
    return { status: 200, headers, stream };
  }

  // ------------------------------------------------------------ deleting

  /**
   * `DELETE /apps/documents/{id}` (`documents.delete`): its own document
   * alone — one it reads by a grant, or may not read, is 404. As the owner
   * chose: `unlink` lets go of it, and it stays in the vault; `trash`
   * moves it to the Trash as its person would. Either way the app lets go
   * of it: its intake reads `unavailable`, and its feed says what the
   * document now is to it.
   */
  async remove(c: AppCaller, id: string, meta: RequestMeta): Promise<AppDeleted> {
    if (!UUID.test(id)) throw notFound();
    const docId = id.toLowerCase();
    return withSystem(this.db, c.householdId, async (trx) => {
      const app = await trx
        .selectFrom('connected_app')
        .select('delete_mode')
        .where('id', '=', c.appId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      // Held while it is decided: an edit, a new version or a move to the
      // Trash meanwhile waits, and is then what it is.
      const held = await trx
        .selectFrom('document')
        .select('id')
        .where('id', '=', docId)
        .forUpdate()
        .executeTakeFirst();
      if (!held) throw notFound();
      // Its own, and its current file one it sent: a newer file from the
      // family (or another app) is never the app's to trash or let go of.
      const r = (await this.opts.reads.readable(trx, c, [docId])).get(docId);
      if (!r || !r.doc.own || !r.currentSent) throw notFound();
      await trx
        .updateTable('connected_app_intake')
        .set({ unlinked_at: sql<Date>`now()` })
        .where('app_id', '=', c.appId)
        .where('document_id', '=', docId)
        .where('state', '=', 'filed')
        .where('unlinked_at', 'is', null)
        .execute();
      if (app.delete_mode === 'trash') {
        await this.opts.documents.appTrash(trx, c.householdId, docId, c.accountId);
        await appendAudit(trx, {
          householdId: c.householdId,
          actorAccountId: c.accountId,
          action: 'document.deleted',
          objectType: 'document',
          objectId: docId,
          detail: appLine(c),
          ip: meta.ip,
        });
        return { document_id: docId, result: 'trashed' };
      }
      await appendAudit(trx, {
        householdId: c.householdId,
        actorAccountId: c.accountId,
        action: 'app.unlinked',
        objectType: 'document',
        objectId: docId,
        detail: appLine(c),
        ip: meta.ip,
      });
      return { document_id: docId, result: 'unlinked' };
    });
  }
}
