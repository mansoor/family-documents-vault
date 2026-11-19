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
  HEALTH_CATEGORY,
  isRecordFormat,
  localToday,
  lockInEffect,
  myWordingOf,
  neutralUnder,
  canSee,
  neutralWordingOf,
  recordFileName,
  rulesFor,
  seesAdults,
  sensitiveOf,
  suspensionInEffect,
  type AppDeleted,
  type AppLinkMinted,
  type AppLinkMode,
  type AppLinkSession,
  type AppScope,
  type Role,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { AlertRequest } from '../alert-job.js';
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
 * opened within two minutes, and once. Opening takes a deliberate step
 * (0.9.0-dev.68): the link's address asked with GET is a small page that
 * consumes nothing — a chat's or a mail scanner's preview of the link
 * fetches it, and the link is still there — and its **Open** button, a
 * plain form with no script, sends a POST to the same address. That POST,
 * one click by the person, is the open: it turns the link into a
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
 * family taking it out of the Trash keeps it as theirs. A move to the Trash
 * is told (0.9.0-dev.68) to the document's person and the owners, by email,
 * naming the app — and the document only where the family's neutral
 * wording (H2) lets it be named to each of them, never when it is sensitive.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

const notFound = () => new ApiError(404, 'not_found', 'Nothing by that id that this app may see.');
const ended = () => new ApiError(410, 'link_ended', APP_REFUSALS.link_ended);
const elsewhere = () => new ApiError(403, 'link_other_address', APP_REFUSALS.link_other_address);
const badRange = () =>
  new ApiError(416, 'range_not_satisfiable', 'That part of the file does not exist.');

const hashOf = (secret: string) => createHash('sha256').update(secret, 'utf8').digest();

/** Whether a link's token is one the vault could have made: anything else is "ended" unasked. */
export const looksLikeToken = (token: string): boolean => SECRET.test(token);

/**
 * The page a link's address gives a GET (0.9.0-dev.68): it consumes
 * nothing, and opens nothing by itself — it has no script. Its **Open**
 * button sends a POST to the same address, and only that opens the link:
 * a scanner that fetches the link, or renders it in a browser of its own,
 * leaves it for the person. Its one style carries a nonce of its own.
 * `token` is a well-formed token (`looksLikeToken`), so it is safe in the
 * page as it is.
 */
export function openPage(token: string): { html: string; csp: string } {
  if (!SECRET.test(token)) throw new Error('not a link token');
  const nonce = randomBytes(16).toString('base64');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>Open the document</title>
<style nonce="${nonce}">
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f5f2;color:#1f1f1d}
main{max-width:28rem;padding:24px;text-align:center}
h1{font-size:22px;margin:0 0 8px}
p{margin:0 0 20px}
button{font:inherit;font-weight:600;padding:12px 32px;border-radius:8px;border:0;background:#1d4ed8;color:#fff;cursor:pointer}
button:focus-visible{outline:3px solid #93b4ff;outline-offset:2px}
@media (prefers-color-scheme:dark){body{background:#1b1b1a;color:#ecebe8}}
</style>
</head>
<body>
<main>
<h1>Open the document</h1>
<p>This link works once: open it here, in this browser.</p>
<form method="post" action="${APP_LINK_PATH}/${token}">
<button type="submit">Open</button>
</form>
</main>
</body>
</html>
`;
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { html, csp };
}

/** What a browser says of where a request came from: Fetch Metadata, Origin, Referer. */
export interface OpenFrom {
  secFetchSite?: string | undefined;
  origin?: string | undefined;
  referer?: string | undefined;
}

/**
 * Whether the POST that opens a link came from somewhere other than the
 * link's own page (0.9.0-dev.68), and is refused before the token is used:
 *
 * - `Sec-Fetch-Site` `cross-site` or `same-site` — another site's page, or
 *   another host of the same site. `same-origin`, `none` (typed or
 *   bookmarked) and its absence (an older browser) pass on to the next.
 * - Its Origin, else its Referer, naming a host that is not the vault's —
 *   the one it was asked at, or the one its links are made on. The page is
 *   sent with `Referrer-Policy: same-origin`, so its own POST carries a
 *   real Origin. Neither said, or `Origin: null`, proves nothing either
 *   way: the token itself is the secret. Hosts are compared without their
 *   port: the web container passes the host on without one.
 */
export function crossSite(from: OpenFrom, own: ReadonlyArray<string | null | undefined>): boolean {
  const site = from.secFetchSite?.trim().toLowerCase();
  if (site === 'cross-site' || site === 'same-site') return true;
  const hostOf = (v: string): string | null => {
    try {
      return new URL(v).hostname.toLowerCase();
    } catch {
      return null;
    }
  };
  const ours = new Set(
    own.flatMap((h) => {
      if (!h) return [];
      const host = hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(h) ? h : `http://${h}`);
      return host ? [host] : [];
    }),
  );
  const said = [from.origin, from.referer].find((v) => v && v !== 'null');
  if (!said) return false;
  const host = hostOf(said);
  return host === null || !ours.has(host);
}

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
  /** Told by email: a document an app moved to the Trash (0.9.0-dev.68). */
  alert?: (a: AlertRequest) => Promise<void>;
}

/** Whom an app's move to the Trash is told to, and how the document may be named to each. */
interface TrashTold {
  app: string;
  title: string | null;
  sensitive: boolean;
  health: boolean;
  household: string | null;
  /** Documents the app moved to the Trash in the last day, this one counted. */
  moved: number;
  people: Array<{
    account_id: string;
    role: Role;
    theirs: boolean;
    /** Whether they may see the document: anybody who may not is not told. */
    sees: boolean;
    my_wording: string | null;
  }>;
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

  /** The address links are made on: an open from its own page is from there. */
  linkAddress(): string {
    return this.opts.address();
  }

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
   * `POST /api/v1/app-links/{token}`: the browser's open, from the page the
   * same address gives a GET (0.9.0-dev.68; until then the GET itself
   * opened it, and a link preview could use it up). Within two minutes of
   * minting, and once: a session of ten minutes, bound to this
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
        // The day it was opened, on the family's calendar: the watermark's.
        opened_on: localToday(
          good.caller.timezone,
          new Date(link.opened_at ?? (link.session_until as Date)),
        ),
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
    const told: { what: TrashTold | null } = { what: null };
    const out = await withSystem(this.db, c.householdId, async (trx): Promise<AppDeleted> => {
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
        told.what = await this.trashTold(trx, c, docId);
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
    // Told once the move is kept: never for one that was not.
    if (told.what) await this.tellTrashed(c.householdId, told.what);
    return out;
  }

  /**
   * Whom a move to the Trash is told to (0.9.0-dev.68): the document's
   * person, when they sign in here, and every owner — each only if they may
   * see the document (its visibility as their role, or a viewer's
   * restriction, allows) — read in the move's own transaction, with what
   * decides how it may be named to each, and how many documents the app
   * has moved to the Trash in the last day, this one counted.
   */
  private async trashTold(trx: Db, c: AppCaller, docId: string): Promise<TrashTold | null> {
    const doc = await trx
      .selectFrom('document as d')
      .leftJoin('effective_document_type as t', 't.key', 'd.type_key')
      .select([
        'd.title',
        'd.visibility',
        'd.owner_member_id',
        'd.sensitive',
        't.sensitive_default',
        sql<string | null>`coalesce(d.category, t.category)`.as('category'),
      ])
      .where('d.id', '=', docId)
      .executeTakeFirst();
    if (!doc) return null;
    const moved = await trx
      .selectFrom('audit_event')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('action', '=', 'document.deleted')
      .where(sql<boolean>`detail->>'app_id' = ${c.appId}`)
      .where('at', '>', sql<Date>`now() - interval '1 day'`)
      .executeTakeFirstOrThrow();
    const hh = await trx
      .selectFrom('household')
      .select('neutral_wording')
      .where('id', '=', c.householdId)
      .executeTakeFirst();
    const people = await trx
      .selectFrom('account_household as ah')
      .leftJoin('access_restriction as r', 'r.member_id', 'ah.member_id')
      .select([
        'ah.account_id',
        'ah.role',
        'ah.member_id',
        'r.include_adults_only',
        'r.expires_at',
        sql<string | null>`(select np.neutral_wording from notification_preference np
                             where np.account_id = ah.account_id
                               and np.household_id = ah.household_id)`.as('my_wording'),
      ])
      .where('ah.household_id', '=', c.householdId)
      .where((eb) =>
        doc.owner_member_id
          ? eb.or([eb('ah.role', '=', 'owner'), eb('ah.member_id', '=', doc.owner_member_id)])
          : eb('ah.role', '=', 'owner'),
      )
      .execute();
    return {
      app: c.name,
      title: doc.title,
      sensitive: sensitiveOf(
        { sensitive: doc.sensitive },
        { sensitive_default: doc.sensitive_default },
      ),
      health: doc.category === HEALTH_CATEGORY,
      household: hh?.neutral_wording ?? null,
      moved: Number(moved.n),
      people: people.map((p) => {
        const role = p.role;
        const restriction =
          p.include_adults_only === null || p.include_adults_only === undefined
            ? null
            : { include_adults_only: p.include_adults_only, expires_at: p.expires_at ?? null };
        return {
          account_id: p.account_id,
          role,
          theirs: doc.owner_member_id !== null && p.member_id === doc.owner_member_id,
          sees: canSee(
            { role, memberId: p.member_id, seesAdults: seesAdults(role, restriction) },
            { visibility: doc.visibility, owner_member_id: doc.owner_member_id },
          ),
          my_wording: p.my_wording,
        };
      }),
    };
  }

  /**
   * The email itself (0.9.0-dev.68), to each who may see the document: the
   * app named; the document by its title only where the household's wording
   * and the person's own (H2) both let it be — never a sensitive one, and
   * never to a viewer. Its person is told it was theirs; the owners, that
   * it was the family's.
   *
   * At most TRASH_TOLD_PER_DAY a day an app: past them, one email more says
   * the app has moved more, to the owners alone, and then nothing until its
   * day has fewer — an app clearing out its documents never floods the
   * family's inboxes; the activity log still has every one.
   */
  private async tellTrashed(householdId: string, t: TrashTold): Promise<void> {
    const alert = this.opts.alert;
    if (!alert) return;
    const send = (a: Omit<AlertRequest, 'householdId' | 'emailOnly'>) =>
      alert({ householdId, emailOnly: true, ...a }).catch(() => undefined);
    if (t.moved > TRASH_TOLD_PER_DAY) {
      if (t.moved !== TRASH_TOLD_PER_DAY + 1) return;
      const owners = t.people.filter((p) => p.role === 'owner').map((p) => p.account_id);
      if (owners.length === 0) return;
      await send({
        accountIds: owners,
        subject: `${t.app} moved more documents to the Trash`,
        body: trashMoreBody(t.app),
      });
      return;
    }
    const household = neutralWordingOf(t.household);
    const groups = new Map<string, string[]>();
    for (const p of t.people) {
      if (!p.sees) continue;
      const neutral =
        t.sensitive ||
        p.role === 'viewer' ||
        neutralUnder(rulesFor(household, myWordingOf(p.my_wording)), {
          sensitive: t.sensitive,
          health: t.health,
        });
      const body = trashBody(t.app, { named: neutral ? null : t.title, theirs: p.theirs });
      groups.set(body, [...(groups.get(body) ?? []), p.account_id]);
    }
    for (const [body, accountIds] of groups) {
      await send({ accountIds, subject: `${t.app} moved a document to the Trash`, body });
    }
  }
}

/** Emails a day about one app's moves to the Trash, before the one that says there are more. */
export const TRASH_TOLD_PER_DAY = 5;

/**
 * What an app's move to the Trash says (0.9.0-dev.68): "Acme Money moved
 * your document “Water bill” to the Trash", or, where it may not be named,
 * "one of your documents" / "a document".
 */
export function trashBody(app: string, d: { named: string | null; theirs: boolean }): string {
  const what = d.named
    ? `${d.theirs ? 'your document ' : ''}“${d.named}”`
    : d.theirs
      ? 'one of your documents'
      : 'a document';
  return (
    `${app} moved ${what} to the Trash. It is set to move what it deletes to the Trash ` +
    '(Settings → Connected apps). To keep it, bring it back from the Trash. ' +
    'The activity log says when.'
  );
}

/** What the owners are told once an app has moved more than TRASH_TOLD_PER_DAY in a day. */
export function trashMoreBody(app: string): string {
  return (
    `${app} has moved more than ${TRASH_TOLD_PER_DAY} documents to the Trash in the last day. ` +
    'No more emails are sent about it until tomorrow: the activity log lists every one, and ' +
    'each can be brought back from the Trash.'
  );
}
