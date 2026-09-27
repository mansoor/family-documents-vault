import { createHash, randomBytes, randomInt } from 'node:crypto';
import { isIPv6 } from 'node:net';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unwrapKey, type ScopeKeys } from '@fdv/crypto';
import {
  appendAudit,
  withPrincipal,
  withScope,
  withSystem,
  type Actor,
  type Db,
  type Scope,
} from '@fdv/db';
import { readAll } from '@fdv/storage';
import argon2 from 'argon2';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError, notFound } from '../errors.js';
import type { VaultService } from '../vaults/service.js';
import type { Enqueue } from './service.js';
import { DecryptStream } from '@fdv/crypto';
import {
  can,
  canSee,
  canShareToView,
  PREVIEW_MAX_PAGES,
  SHARE_LIMIT_MAX,
  SHARE_MAX_DAYS,
  shareEndProblem,
  shareEndWords,
  shareUses,
  type ShareLinkPreview,
  type SharePages,
  type SharePermission,
  type SharedItem,
  type SharedSession,
  type ShareProtection,
} from '@fdv/shared';

/**
 * Share links (SHR-05).
 *
 * The design is one sentence long: outside sharing is a link with an
 * expiry, and nothing else. No account at the far end, no permissions to
 * configure, no folder shared by accident. One document, seven days by
 * default, optionally a PIN, revocable, and every open recorded where the
 * family can see it.
 *
 * The link secret is 32 random bytes and is never stored — only its
 * SHA-256 — so it cannot be recovered from the vault, only replaced. A
 * PIN is four digits, because it is meant to be said over the phone, and
 * four digits are defensible only because the link secret is already the
 * hard part and ten wrong PINs kill the link.
 *
 * Since 5.16 a link is `/s#<token>`: the secret rides in the fragment, which
 * no server sees, and the page takes it out of the address bar and its
 * tab's history once it has read it (the browser's own history of visited
 * pages may keep it; a PIN is the lock for that). Its page shows who sent
 * what, and opens nothing until somebody presses Open (a link scanner
 * previews; it never opens). Opening is a POST with the PIN in its body,
 * and gives a session cookie — its hash is all the vault keeps — inside
 * which the document is fetched, every request checking the link again.
 * The links made before then (`flow = 'legacy'`) keep the old routes, and
 * only they do (A25).
 *
 * Since 5.18 a new link can end at a time as well as on a day, can be for
 * viewing only — its pages, drawn with whom it is for, and never the file
 * (A22) — and can be opened, or downloaded from, so many times. One use is
 * one Open that worked: whatever happens inside the session it gave is
 * free, and a download or a look at the pages is counted, and written to
 * the activity log, once a session for each document.
 */

const MAX_PIN_ATTEMPTS = 10;
const DEFAULT_DAYS = 7;
const ARGON2 = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

/** The session cookie (5.16), and the one path it is sent to. */
export const SHARE_COOKIE = 'fdv_share';
export const SHARE_COOKIE_PATH = '/api/v1/shared';
/** A session lasts 30 minutes from its last use, and 4 hours at most (A26). */
export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_MAX_MS = 4 * 3_600_000;

/**
 * The worker's jobs for a view-only link's pages (5.18): drawing them, and
 * removing them once the link has ended. The names match the worker's JOBS.
 */
export const SHARE_PAGES_JOB = 'share.pages';
export const SHARE_PAGES_PRUNE_JOB = 'share.pages.prune';
const sharePagesKey = (shareId: string) => `share-pages:${shareId}`;

const limit = z.number().int().min(1).max(SHARE_LIMIT_MAX).nullable().optional();

export const shareBody = z
  .object({
    /** What older clients send: whole days from now. */
    expires_in_days: z.number().int().min(1).max(SHARE_MAX_DAYS).optional(),
    /** The end, as a date and time (5.18): at least 5 minutes ahead. */
    expires_at: z.string().datetime({ offset: true }).optional(),
    /** A label for the family's own list: "the letting agent". */
    recipient_label: z.string().trim().max(80).optional(),
    /** True asks the server to invent one; nobody chooses 0000. */
    with_pin: z.boolean().optional(),
    /** To view (the pages) or to download (the file), 5.18. */
    permission: z.enum(['view', 'download']).optional(),
    max_opens: limit,
    max_downloads: limit,
  })
  .strict();

/** A legacy link's open and download: the PIN, if it has one. */
export const openBody = z.object({ pin: z.string().trim().max(12).optional() }).strict();

const linkToken = z.string().min(16).max(256);

/** What the page sends to show who sent what (5.16): the token, in a body. */
export const previewBody = z.object({ token: linkToken }).strict();

/** Pressing Open (5.16): the token and, when there is one, the secret. */
export const unlockBody = z
  .object({ token: linkToken, secret: z.string().trim().max(64).optional() })
  .strict();

export interface ShareView {
  id: string;
  document_id: string;
  document_title: string | null;
  recipient_label: string | null;
  created_by_name: string | null;
  created_at: string;
  expires_at: string;
  has_pin: boolean;
  open_count: number;
  last_opened_at: string | null;
  state: 'active' | 'expired' | 'revoked' | 'locked' | 'paused' | 'used_up';
  /** Which routes open it (5.16): the old ones for `legacy`, the new ones for `v2`. */
  flow: 'legacy' | 'v2';
  /** Paused, and why: a restore (5.16). An owner turns it back on. */
  paused_at: string | null;
  paused_reason: 'restored' | null;
  /** What it gives (5.18): the pages, drawn with whom it is for, or the file. */
  permission: SharePermission;
  max_opens: number | null;
  max_downloads: number | null;
  downloads_used: number;
  /** A view-only link's pages: how many, of how many, and whether drawn yet. */
  pages: SharePages | null;
  /** One sentence for the list on the home screen. */
  summary: string;
}

export interface CreatedShare {
  share: ShareView;
  /** Shown once. The vault keeps only its hash. */
  link_token: string;
  /**
   * The link to send, `{FDV_PUBLIC_URL}/s#{link_token}`, when the vault
   * has a public-only site; null when it has none, and the app puts its own
   * address before `/s#`.
   */
  link_url: string | null;
  /** Present only when one was asked for. */
  pin?: string;
}

/** What the person at the other end sees before they have the PIN. */
export interface SharePreview {
  household_name: string;
  needs_pin: boolean;
  expires_at: string;
  /** Withheld until the PIN is right: a title can say a great deal. */
  document_title: string | null;
  shared_by: string | null;
}

export interface SharedDocument {
  document_title: string | null;
  document_type: string | null;
  shared_by: string | null;
  expires_at: string;
  byte_size: number;
  content_type: string;
  filename: string;
}

/** A session made by Open: the cookie, once, and what it opened. */
export interface Unlocked {
  cookie: string;
  /** Seconds until the session ends at the latest: the cookie's Max-Age. */
  maxAge: number;
  session: SharedSession;
}

type Flow = 'legacy' | 'v2';

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest();

/** A transaction asked for by whoever holds one link, in its household: never anybody else. */
type LinkScope = Scope & { householdId: string; actor: Extract<Actor, { kind: 'link' }> };

/** A link as the family's lists show it, with who made it. */
type LinkView = ShareView & { created_by: string };

/** What the family's lists are sent of a link. */
const viewOnly = ({ created_by: _by, ...view }: LinkView): ShareView => view;

type LinkRow = {
  id: string;
  document_id: string;
  recipient_label: string | null;
  created_by: string;
  expires_at: Date;
  pin_hash: string | null;
  flow: Flow;
  permission: SharePermission;
  open_count: number;
  max_opens: number | null;
  downloads_used: number;
  max_downloads: number | null;
};

/** How one try of a link's PIN went. */
type Attempt = 'right' | 'no pin' | { wrong: number } | 'locked' | 'gone';

/** Why Open did not open: a PIN's try, or the link's opens used up (5.18). */
type Refusal = Exclude<Attempt, 'right' | 'no pin'> | 'used up';

/** A try that did not open the link, and the link it was made on. */
type Refused = { readonly refused: Refusal; readonly link: LinkRow };

const isRefused = (outcome: object): outcome is Refused =>
  'refused' in outcome && (outcome as Partial<Refused>).refused !== undefined;

/** Opened as many times as it allows (5.18). */
const usedUp = (link: { open_count: number; max_opens: number | null }) =>
  link.max_opens !== null && link.open_count >= link.max_opens;

const gone = () =>
  new ApiError(
    404,
    'link_not_valid',
    'That link is not valid any more. Ask whoever sent it for a new one.',
  );

/**
 * A link opened as many times as it allows (5.18). Said plainly, unlike the
 * other dead ends: whoever holds the link has the right to know somebody
 * has used it, and it may not have been them.
 */
const opensUsedUp = () =>
  new ApiError(
    410,
    'link_used_up',
    'This link has been opened as many times as it allows, so it cannot be opened again. Ask whoever sent it for a new one.',
  );

const sessionEnded = () =>
  new ApiError(
    401,
    'share_session_ended',
    'This page has been open too long, or was opened somewhere else. Open the link you were sent again.',
  );

const pinWrong = (left: number) =>
  new ApiError(
    401,
    'pin_wrong',
    left > 0
      ? 'That PIN is not right. Check with whoever sent you the link.'
      : 'That PIN was wrong too many times, so the link has stopped working.',
  );

const expiryRefused = (message: string) => new ApiError(422, 'expiry_out_of_range', message);

/**
 * An outsider's address, as the vault keeps it (A24): IPv4 to its /24 and
 * IPv6 to its /48 — the network they came from, not the machine.
 */
export function truncatedIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  const bare = ip.split('%')[0] ?? '';
  if (!isIPv6(bare)) return null;
  const [head = '', tail] = bare.split('::');
  const groups = (s: string) => (s ? s.split(':') : []);
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const full = [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0')];
  const [a = '0', b = '0', c = '0'] = full;
  const hex = (g: string) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16).toString(16) : '0');
  return `${hex(a)}:${hex(b)}:${hex(c)}::/48`;
}

export interface ShareOptions {
  /** How the worker is asked to draw, and to remove, a view-only link's pages (5.18). */
  enqueue?: Enqueue;
  /** FDV_SHARE_MAX_DAYS: the longest a link may last (A20). */
  maxDays?: number;
}

export class ShareService {
  private readonly enqueue: Enqueue;
  private readonly maxDays: number;

  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly vaults: VaultService,
    /** How a sharer is told their link was locked (alert.send). */
    private readonly alert: (input: AlertRequest) => Promise<void> = async () => undefined,
    /** The public-only site's address (FDV_PUBLIC_URL), which links start with when set. */
    private readonly publicUrl: string | null = null,
    opts: ShareOptions = {},
  ) {
    this.enqueue = opts.enqueue ?? (async () => undefined);
    this.maxDays = Math.min(opts.maxDays ?? SHARE_MAX_DAYS, SHARE_MAX_DAYS);
  }

  // -------------------------------------------------------------- making

  /** When a new link ends: `expires_at`, or `expires_in_days` from an older client, or a week. */
  private endOf(input: z.infer<typeof shareBody>): Date {
    if (input.expires_at !== undefined && input.expires_in_days !== undefined) {
      throw new ApiError(
        422,
        'validation_failed',
        'Say when the link ends once: expires_at or expires_in_days, not both.',
      );
    }
    if (input.expires_in_days !== undefined && input.expires_in_days > this.maxDays) {
      throw expiryRefused(`A link can last ${this.maxDays} days at most.`);
    }
    const end =
      input.expires_at !== undefined
        ? new Date(input.expires_at)
        : new Date(Date.now() + (input.expires_in_days ?? DEFAULT_DAYS) * 864e5);
    const problem = shareEndProblem(end, { maxDays: this.maxDays });
    if (problem) throw expiryRefused(problem);
    return end;
  }

  async create(
    p: Principal,
    documentId: string,
    input: z.infer<typeof shareBody>,
    meta: RequestMeta,
  ): Promise<CreatedShare> {
    requireCapability(p, 'document.share');
    const expiresAt = this.endOf(input);
    const permission: SharePermission = input.permission ?? 'download';
    if (permission === 'view' && input.max_downloads != null) {
      throw new ApiError(
        422,
        'validation_failed',
        'A link to view has nothing to download: leave out max_downloads.',
      );
    }
    const token = randomBytes(32).toString('base64url');
    const pin = input.with_pin ? String(randomInt(0, 10000)).padStart(4, '0') : null;
    const pinHash = pin ? await argon2.hash(pin, ARGON2) : null;

    const id = await withPrincipal(this.db, p, async (trx) => {
      const doc = await trx
        .selectFrom('document')
        .select(['id', 'title', 'visibility', 'owner_member_id'])
        .where('id', '=', documentId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      // Nobody sends out what they cannot see. For a private document that
      // means nobody but its owner, however senior they are: it is theirs.
      if (!doc || !canSee({ role: p.role, memberId: p.memberId }, doc)) {
        throw notFound('That document');
      }
      const newest = await trx
        .selectFrom('document_version')
        .select(['id', 'mime'])
        .where('document_id', '=', documentId)
        .orderBy('version_no', 'desc')
        .executeTakeFirst();
      if (!newest) {
        throw new ApiError(
          422,
          'nothing_to_share',
          'There is no file on this document yet, so there is nothing to send.',
        );
      }
      // To view is to see the pages the vault draws, and it draws PDFs and
      // photos; a Word or an Excel file can only go as itself (A22).
      if (permission === 'view' && !canShareToView(newest.mime)) {
        throw new ApiError(
          422,
          'view_not_possible',
          'Word and Excel files can only be shared to download: the vault cannot draw their pages.',
        );
      }

      // Always a new link (5.16): the column's default, never said here, so
      // no path through this code can make a legacy one.
      const row = await trx
        .insertInto('share_link')
        .values({
          household_id: p.householdId,
          document_id: documentId,
          token_hash: hashToken(token),
          pin_hash: pinHash,
          recipient_label: input.recipient_label ?? null,
          created_by: p.accountId,
          expires_at: expiresAt,
          permission,
          max_opens: input.max_opens ?? null,
          max_downloads: input.max_downloads ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'share.created',
        objectType: 'document',
        objectId: documentId,
        detail: {
          share_id: row.id,
          recipient_label: input.recipient_label ?? null,
          with_pin: Boolean(pin),
          expires_at: expiresAt.toISOString(),
          permission,
          max_opens: input.max_opens ?? null,
          max_downloads: input.max_downloads ?? null,
        },
        ip: meta.ip,
      });
      return row.id;
    });

    // A link to view shows the pages the worker draws for it, with whom it
    // is for across each: asked for now, so they are there when it opens.
    if (permission === 'view') await this.drawPages(p.householdId, id);

    const share = (await this.list(p)).find((s) => s.id === id) as ShareView;
    // The whole link to send, on the public-only site, when the vault has
    // one: the secret after the #, which no server is sent.
    const link_url = this.publicUrl ? `${this.publicUrl.replace(/\/+$/, '')}/s#${token}` : null;
    return pin
      ? { share, link_token: token, link_url, pin }
      : { share, link_token: token, link_url };
  }

  /** Asks the worker to draw a view-only link's pages: once, however often it is asked. */
  private drawPages(householdId: string, shareId: string, redraw = false) {
    return this.enqueue(
      SHARE_PAGES_JOB,
      { household_id: householdId, share_id: shareId, ...(redraw ? { redraw: true } : {}) },
      { singletonKey: sharePagesKey(shareId), priority: 10 },
    ).catch(() => undefined);
  }

  async list(p: Principal): Promise<ShareView[]> {
    return (await this.views(p)).map(viewOnly);
  }

  /** Every link the reader may know about, with who made it. */
  private async views(p: Principal): Promise<LinkView[]> {
    // Who a document went to outside the family ("the divorce lawyer"),
    // who sent it and how often it was opened is for those who may share
    // (0.5.0). A teen or a viewer — an accountant with a sign-in, say —
    // read every link to every document they could see.
    if (!can(p.role, 'document.share')) return [];
    return withPrincipal(this.db, p, async (trx) => {
      const rows = await trx
        .selectFrom('share_link')
        .innerJoin('document', 'document.id', 'share_link.document_id')
        .leftJoin('account_household', (j) =>
          j
            .onRef('account_household.account_id', '=', 'share_link.created_by')
            .onRef('account_household.household_id', '=', 'share_link.household_id'),
        )
        .leftJoin('member', 'member.id', 'account_household.member_id')
        .select([
          'share_link.id',
          'share_link.document_id',
          'share_link.recipient_label',
          'share_link.created_by',
          'share_link.created_at',
          'share_link.expires_at',
          'share_link.revoked_at',
          'share_link.open_count',
          'share_link.last_opened_at',
          'share_link.attempts',
          'share_link.pin_hash',
          'share_link.flow',
          'share_link.paused_at',
          'share_link.paused_reason',
          'share_link.permission',
          'share_link.max_opens',
          'share_link.max_downloads',
          'share_link.downloads_used',
          'document.title',
          'document.visibility',
          'document.owner_member_id',
          'member.display_name as created_by_name',
        ])
        .orderBy('share_link.created_at', 'desc')
        .execute();
      const household = await trx
        .selectFrom('household')
        .select('timezone')
        .executeTakeFirstOrThrow();
      // A link names its document, so the list shows only links to what the
      // reader may see — the same rule as every other list. Until 0.4.2
      // this checked only "private", and a teen could read the titles of
      // adults-only documents that had been shared out of the house.
      const seen = rows.filter((r) => canSee({ role: p.role, memberId: p.memberId }, r));
      const views: LinkView[] = [];
      for (const r of seen) {
        const state = stateOf(r);
        views.push({
          id: r.id,
          document_id: r.document_id,
          document_title: r.title,
          recipient_label: r.recipient_label,
          created_by_name: r.created_by_name,
          created_at: r.created_at.toISOString(),
          expires_at: r.expires_at.toISOString(),
          has_pin: r.pin_hash !== null,
          open_count: r.open_count,
          last_opened_at: r.last_opened_at?.toISOString() ?? null,
          state,
          flow: r.flow,
          paused_at: r.paused_at?.toISOString() ?? null,
          paused_reason: r.paused_reason,
          permission: r.permission,
          max_opens: r.max_opens,
          max_downloads: r.max_downloads,
          downloads_used: r.downloads_used,
          pages: r.permission === 'view' ? await this.pagesOf(trx, r.id, r.document_id) : null,
          summary: summarise(r, state, household.timezone),
          created_by: r.created_by,
        });
      }
      return views;
    });
  }

  /**
   * A view-only link's pages of a document: drawn (how many, of how many),
   * still being drawn, or impossible to draw. Drawn for the newest version,
   * as the link gives the newest; a newer version is drawn again.
   */
  private async pagesOf(trx: Db, shareId: string, documentId: string): Promise<SharePages> {
    const v = await trx
      .selectFrom('document_version')
      .select(['id', 'page_count', 'preview_state', 'preview_pages'])
      .where('document_id', '=', documentId)
      .orderBy('version_no', 'desc')
      .executeTakeFirst();
    if (!v) return { state: 'failed', shown: 0, total: null };
    const drawn = await trx
      .selectFrom('share_page')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('share_id', '=', shareId)
      .where('version_id', '=', v.id)
      .executeTakeFirstOrThrow();
    const n = Number(drawn.n);
    const total = v.page_count ?? (v.preview_state === 'ready' ? v.preview_pages : null);
    if (n > 0) return { state: 'ready', shown: n, total: total ?? n };
    if (v.preview_state === 'unsupported' || v.preview_state === 'failed') {
      return { state: 'failed', shown: 0, total };
    }
    return {
      state: 'drawing',
      shown: total !== null ? Math.min(total, PREVIEW_MAX_PAGES) : null,
      total,
    };
  }

  async revoke(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'document.share');
    const revoked = await withPrincipal(this.db, p, async (trx) => {
      // A link to a document the caller cannot see is not there for them.
      const target = await trx
        .selectFrom('share_link')
        .innerJoin('document', 'document.id', 'share_link.document_id')
        .select(['document.visibility', 'document.owner_member_id'])
        .where('share_link.id', '=', id)
        .executeTakeFirst();
      if (!target || !canSee({ role: p.role, memberId: p.memberId }, target)) {
        throw notFound('That link');
      }
      const row = await trx
        .updateTable('share_link')
        .set({ revoked_at: new Date(), revoked_by: p.accountId })
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .returning(['id', 'document_id', 'permission'])
        .executeTakeFirst();
      if (!row) throw notFound('That link');
      // Taken back is taken back everywhere: a page opened with it stops at
      // its next request anyway, and now there is no session left to ask.
      await trx.deleteFrom('share_session').where('share_id', '=', id).execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'share.revoked',
        objectType: 'document',
        objectId: row.document_id,
        detail: { share_id: row.id },
        ip: meta.ip,
      });
      return row;
    });
    // Its pages go with it (5.18): the worker removes them now.
    if (revoked.permission === 'view') {
      await this.enqueue(SHARE_PAGES_PRUNE_JOB, {
        household_id: p.householdId,
        share_id: id,
      }).catch(() => undefined);
    }
  }

  // ------------------------------------------------------ after a restore

  /**
   * The links a restore paused that the reader may decide about (A55): an
   * owner, every one to a document they can see, to turn back on or take
   * back; anybody else who may share, the ones they made, only to take
   * back (resumable says why).
   */
  async paused(p: Principal): Promise<ShareView[]> {
    const owner = can(p.role, 'restore.review');
    return (await this.views(p))
      .filter((s) => s.state === 'paused' && (owner || s.created_by === p.accountId))
      .map(viewOnly);
  }

  /**
   * Whether the caller may turn a paused link back on, and its document:
   * an owner may, for any link to a document they can see; nobody else,
   * whoever made it (A55: every link waits for an owner). A backup brings
   * back a link an owner took back after it was made, and the activity
   * log's line saying so is gone with the rest of what came after it — so
   * its maker is not the one to decide it still stands. Not even for a
   * link to their own Only me document, which no owner can see: what the
   * document is now says nothing about what it was when the link was
   * taken back, and it can be made Only me for the asking and put back
   * after. Such a link stays paused; its maker takes it back and makes a
   * new one. Taking a paused link back is not this: that only closes, and
   * stays with whoever may take back a link.
   */
  async resumable(p: Principal, id: string): Promise<string> {
    requireCapability(p, 'restore.review');
    const link = (await this.views(p)).find((s) => s.id === id);
    if (!link) throw notFound('That link');
    if (link.state !== 'paused') throw notFound('That paused link');
    return link.document_id;
  }

  /** Turns a paused link back on: it opens again, as it did before. */
  async resume(p: Principal, id: string, meta: RequestMeta): Promise<ShareView> {
    await this.resumable(p, id);
    const resumed = await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .updateTable('share_link')
        .set({ paused_at: null, paused_reason: null })
        .where('id', '=', id)
        .where('paused_at', 'is not', null)
        .returning(['id', 'document_id', 'permission'])
        .executeTakeFirst();
      if (!row) throw notFound('That paused link');
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'share.resumed',
        objectType: 'document',
        objectId: row.document_id,
        detail: { share_id: row.id },
        ip: meta.ip,
      });
      return row;
    });
    // The backup's record of its pages may name files removed since it was
    // made: a view-only link has them drawn again.
    if (resumed.permission === 'view') await this.drawPages(p.householdId, id, true);
    return (await this.list(p)).find((s) => s.id === id) as ShareView;
  }

  // ------------------------------------------------------------- finding

  private async householdOf(token: string): Promise<string> {
    const r = await sql<{ id: string | null }>`
      select share_link_household(${hashToken(token)}) as id
    `.execute(this.db);
    const id = r.rows[0]?.id;
    if (!id) throw gone();
    return id;
  }

  /**
   * Who asks for a token's link: whoever holds it. Finding which link that
   * is, by the token's hash, is the one step taken as the vault itself —
   * until it is found there is no link to ask as. Everything after asks as
   * the link.
   *
   * Each route finds only its own flow's links (5.16): a new link's token
   * is not valid on an old route, whatever it carries, and an old one's is
   * not valid on a new one.
   */
  private async linkScope(token: string, flow: Flow): Promise<LinkScope> {
    const householdId = await this.householdOf(token);
    const found = await withSystem(this.db, householdId, (trx) =>
      trx
        .selectFrom('share_link')
        .select('id')
        .where('token_hash', '=', hashToken(token))
        .where('flow', '=', flow)
        // Only a live link becomes somebody to ask as: a revoked, paused or
        // expired one is gone before it is anyone (live() still checks the
        // rest).
        .where('revoked_at', 'is', null)
        .where('paused_at', 'is', null)
        .where('expires_at', '>', new Date())
        .executeTakeFirst(),
    );
    if (!found) throw gone();
    return { householdId, actor: { kind: 'link', shareId: found.id } };
  }

  // ------------------------------------------------------ the new flow

  /**
   * What the page shows before anybody presses anything: whose vault, who
   * sent it, what it asks for, what it gives and until when. Nothing is
   * counted and nothing is written down — a link scanner fetching the page
   * is not somebody opening the document.
   */
  async previewLink(token: string): Promise<ShareLinkPreview> {
    const scope = await this.linkScope(token, 'v2');
    return withScope(this.db, scope, async (trx) => {
      const link = await this.live(trx, scope.actor.shareId, 'v2');
      if (usedUp(link)) throw opensUsedUp();
      const context = await this.context(trx, link.document_id, link.created_by);
      const protection: ShareProtection[] = link.pin_hash ? ['pin'] : [];
      return {
        household_name: context.household_name,
        shared_by: context.shared_by,
        protection,
        expires_at: link.expires_at.toISOString(),
        // With a protection on it, even the title waits: "Divorce
        // settlement" is information, and the PIN is there because somebody
        // wanted a second lock on exactly that.
        document_title: protection.length ? null : context.title,
        permission: link.permission,
        opens_left: link.max_opens === null ? null : link.max_opens - link.open_count,
      };
    });
  }

  /**
   * Open: the one step that is counted and written down. Its PIN is tried
   * (a wrong one uses up one of the link's ten, reserved before it is
   * checked, so tries made at once cannot get past ten), the open is
   * counted — within the link's opens, however many press Open at once —
   * and a session is made for this browser.
   */
  async unlock(input: z.infer<typeof unlockBody>, meta: RequestMeta): Promise<Unlocked> {
    const scope = await this.linkScope(input.token, 'v2');
    const { householdId } = scope;
    const outcome = await withScope(this.db, scope, async (trx) => {
      const link = await this.live(trx, scope.actor.shareId, 'v2');
      // Used up already: no PIN is tried on a link that cannot open.
      if (usedUp(link)) return { refused: 'used up', link } as const;
      const tried = await this.tryPin(trx, householdId, link, input.secret, meta);
      if (tried !== 'right' && tried !== 'no pin') return { refused: tried, link } as const;
      const counted = await this.countOpen(trx, link.id);
      if (counted !== 'counted') return { refused: counted, link } as const;

      const cookie = randomBytes(32).toString('base64url');
      const now = Date.now();
      // The earlier of four hours and the link's own end (A26): "until
      // Friday at five" is true of the page as well as the link.
      const expiresAt = new Date(Math.min(now + SESSION_MAX_MS, link.expires_at.getTime()));
      // Sessions of this link that have ended are cleared as a new one starts.
      await trx
        .deleteFrom('share_session')
        .where('share_id', '=', link.id)
        .where('expires_at', '<=', new Date(now))
        .execute();
      await trx
        .insertInto('share_session')
        .values({
          household_id: householdId,
          share_id: link.id,
          cookie_hash: hashToken(cookie),
          verified_by: tried === 'right' ? 'pin' : null,
          created_at: new Date(now),
          last_seen_at: new Date(now),
          expires_at: expiresAt,
          ip: truncatedIp(meta.ip),
          user_agent: meta.userAgent?.slice(0, 512) ?? null,
        })
        .execute();
      await this.record(trx, householdId, link, 'share.opened', meta);
      const session = await this.sessionView(trx, link, expiresAt);
      return { cookie, expiresAt, session } as const;
    });
    if (isRefused(outcome)) {
      if (outcome.refused === 'used up') throw opensUsedUp();
      await this.refuse(householdId, outcome.link, outcome.refused);
      throw gone();
    }
    return {
      cookie: outcome.cookie,
      maxAge: Math.max(1, Math.floor((outcome.expiresAt.getTime() - Date.now()) / 1000)),
      session: outcome.session,
    };
  }

  /** What is open in a session: the same answer Open gave. Free: nothing is counted. */
  async sessionItems(cookie: string | undefined): Promise<SharedSession> {
    return this.inSession(cookie, (trx, link, session) =>
      this.sessionView(trx, link, session.expires_at),
    );
  }

  /**
   * A document's file, inside a session. Only the link's own document: any
   * other id is not there for it — the database's rule for a link gives it
   * no other document's row, and the answer is the 404 of one that does
   * not exist. Only a link to download: a link to view never gives the
   * file (A22). The first download of each document in a session is
   * counted against the link's downloads and written down; the rest of that
   * session's are free.
   */
  async sessionContent(
    cookie: string | undefined,
    documentId: string,
    meta: RequestMeta,
  ): Promise<{ stream: Readable; total: number; contentType: string; filename: string }> {
    const found = await this.inSession(cookie, async (trx, link, session) => {
      const doc = await trx
        .selectFrom('document')
        .select('id')
        .where('id', '=', documentId)
        .executeTakeFirst();
      if (!doc || doc.id !== link.document_id) return null;
      if (link.permission !== 'download') {
        throw new ApiError(
          403,
          'view_only',
          'This link is for viewing only: the file itself was not shared.',
        );
      }
      const first = await this.used(trx, link, session.id, doc.id, 'downloaded');
      if (first) {
        // Within the link's downloads, however many ask at once: one
        // statement counts it, or finds there are none left. Refused, the
        // whole request is undone, the note that it was had included.
        const counted = await trx
          .updateTable('share_link')
          .set((eb) => ({ downloads_used: eb('downloads_used', '+', 1) }))
          .where('id', '=', link.id)
          .where((eb) =>
            eb.or([
              eb('max_downloads', 'is', null),
              eb('downloads_used', '<', eb.ref('max_downloads')),
            ]),
          )
          .returning('downloads_used')
          .executeTakeFirst();
        if (!counted) {
          throw new ApiError(
            403,
            'downloads_used_up',
            'This link has been downloaded from as many times as it allows. Ask whoever sent it for a new one.',
          );
        }
        await this.record(trx, link.household_id, link, 'share.downloaded', meta);
      }
      const v = await this.newestVersion(trx, link.document_id);
      const scopeKey = await this.keys.unwrapById(trx, v.wrapped_by_scope);
      const fileKey = unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`);
      const adapter = await this.vaults.adapterById(trx, v.vault_id);
      return { version: v, adapter, fileKey };
    });
    if (!found) throw notFound('That document');
    return this.decrypted(found);
  }

  /**
   * One page of a view-only link's document, inside a session: the page the
   * worker drew for this link, with whom it is for across it, and never the
   * vault's own preview or the file. The first page a session looks at is
   * written down (`share.viewed`), once for each document; the rest are
   * free. Pages not drawn yet answer `preview_pending`, as the family's own
   * do, and the worker is asked (again) to draw them.
   */
  async sessionPage(
    cookie: string | undefined,
    documentId: string,
    n: number,
    meta: RequestMeta,
  ): Promise<Buffer> {
    const outcome = await this.inSession(cookie, async (trx, link, session) => {
      const doc = await trx
        .selectFrom('document')
        .select('id')
        .where('id', '=', documentId)
        .executeTakeFirst();
      if (!doc || doc.id !== link.document_id) return { kind: 'missing' } as const;
      if (link.permission !== 'view') {
        throw new ApiError(
          404,
          'no_preview',
          'This link gives the file itself, not pages: download it.',
        );
      }
      const v = await this.newestVersion(trx, link.document_id);
      const page = await trx
        .selectFrom('share_page')
        .select('storage_key')
        .where('share_id', '=', link.id)
        .where('version_id', '=', v.id)
        .where('n', '=', n)
        .executeTakeFirst();
      if (!page) {
        const pages = await this.pagesOf(trx, link.id, link.document_id);
        if (pages.state === 'failed') {
          throw new ApiError(
            404,
            'no_preview',
            "The vault couldn't draw this document's pages. Ask whoever sent the link to send it another way.",
          );
        }
        if (pages.state === 'ready') {
          const shown = pages.shown ?? PREVIEW_MAX_PAGES;
          throw new ApiError(
            404,
            'no_preview',
            pages.total !== null && pages.total > shown
              ? `Pages after ${shown} were not shared.`
              : 'The document has no such page.',
          );
        }
        return { kind: 'pending', householdId: link.household_id, shareId: link.id } as const;
      }
      if (await this.used(trx, link, session.id, doc.id, 'viewed')) {
        await this.record(trx, link.household_id, link, 'share.viewed', meta);
      }
      const scopeKey = await this.keys.unwrapById(trx, v.wrapped_by_scope);
      const fileKey = unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`);
      const adapter = await this.vaults.adapterById(trx, v.vault_id);
      return {
        kind: 'page',
        key: page.storage_key,
        fileKey,
        adapter,
        householdId: link.household_id,
        shareId: link.id,
      } as const;
    });
    if (outcome.kind === 'missing') throw notFound('That document');
    const pending = (householdId: string, shareId: string, redraw: boolean) => {
      void this.drawPages(householdId, shareId, redraw);
      return new ApiError(
        404,
        'preview_pending',
        'The pages are still being drawn. Try again in a moment.',
        { retriable: true, retryAfter: 3 },
      );
    };
    if (outcome.kind === 'pending') throw pending(outcome.householdId, outcome.shareId, false);
    try {
      const dec = new DecryptStream(outcome.fileKey);
      const [, plain] = await Promise.all([
        pipeline(await outcome.adapter.get(outcome.key), dec),
        readAll(dec),
      ]);
      return plain;
    } catch {
      // Gone from the vault's storage — a restore brings back its record
      // after the file was removed, say: drawn again.
      throw pending(outcome.householdId, outcome.shareId, true);
    }
  }

  /**
   * Notes that a session has had a document — its download, or a look at
   * its pages — and says whether this was the first time. Two requests of
   * one session at once: the second waits for the first, and finds it done.
   */
  private async used(
    trx: Db,
    link: LinkRow & { household_id: string },
    sessionId: string,
    documentId: string,
    kind: 'viewed' | 'downloaded',
  ): Promise<boolean> {
    const row = await trx
      .insertInto('share_session_use')
      .values({
        household_id: link.household_id,
        session_id: sessionId,
        share_id: link.id,
        document_id: documentId,
        kind,
      })
      .onConflict((oc) => oc.doNothing())
      .returning('kind')
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Runs `fn` inside the session a cookie names, after the full check: the
   * session itself (not ended, not idle for 30 minutes) and then its link,
   * exactly as Open checked it — revoked, paused, expired, locked, its
   * maker no longer able to see the document, the document in the Trash.
   * A session that fails is removed, and its next request is refused too.
   * A link opened as many times as it allows is not ended by that: each
   * session is one of its opens, and lasts to its own end.
   */
  private async inSession<T>(
    cookie: string | undefined,
    fn: (
      trx: Db,
      link: LinkRow & { household_id: string },
      session: { id: string; expires_at: Date },
    ) => Promise<T>,
  ): Promise<T> {
    if (!cookie || cookie.length > 128) throw sessionEnded();
    const cookieHash = hashToken(cookie);
    const r = await sql<{ household_id: string; share_id: string }>`
      select household_id, share_id from share_session_find(${cookieHash})
    `.execute(this.db);
    const found = r.rows[0];
    if (!found) throw sessionEnded();
    const scope: LinkScope = {
      householdId: found.household_id,
      actor: { kind: 'link', shareId: found.share_id },
    };
    const outcome = await withScope(this.db, scope, async (trx) => {
      const session = await trx
        .selectFrom('share_session')
        .select(['id', 'share_id', 'expires_at', 'last_seen_at'])
        .where('cookie_hash', '=', cookieHash)
        .executeTakeFirst();
      if (!session) return { ended: 'session' } as const;
      const now = Date.now();
      const end = async (why: 'session' | 'link') => {
        await trx.deleteFrom('share_session').where('id', '=', session.id).execute();
        return { ended: why } as const;
      };
      if (
        session.expires_at.getTime() <= now ||
        session.last_seen_at.getTime() + SESSION_IDLE_MS <= now
      ) {
        return end('session');
      }
      let link: LinkRow;
      try {
        link = await this.live(trx, session.share_id, 'v2');
      } catch (err) {
        if (err instanceof ApiError && err.code === 'link_not_valid') return end('link');
        throw err;
      }
      await trx
        .updateTable('share_session')
        .set({ last_seen_at: new Date(now) })
        .where('id', '=', session.id)
        .execute();
      return {
        value: await fn(trx, { ...link, household_id: found.household_id }, session),
      } as const;
    });
    if ('ended' in outcome) throw outcome.ended === 'session' ? sessionEnded() : gone();
    return outcome.value;
  }

  private async sessionView(trx: Db, link: LinkRow, sessionEnds: Date): Promise<SharedSession> {
    const context = await this.context(trx, link.document_id, link.created_by);
    const v = await this.newestVersion(trx, link.document_id);
    const item: SharedItem = {
      id: link.document_id,
      title: context.title,
      type_label: context.type_label,
      filename: v.filename,
      content_type: v.mime,
      byte_size: Number(v.byte_size),
      pages: link.permission === 'view' ? await this.pagesOf(trx, link.id, link.document_id) : null,
    };
    return {
      household_name: context.household_name,
      shared_by: context.shared_by,
      expires_at: link.expires_at.toISOString(),
      session_expires_at: sessionEnds.toISOString(),
      items: [item],
      permission: link.permission,
      downloads_left:
        link.permission === 'download' && link.max_downloads !== null
          ? Math.max(0, link.max_downloads - link.downloads_used)
          : null,
    };
  }

  // ------------------------------------------------ the old routes (A25)

  /** What the recipient sees before they have typed anything. */
  async preview(token: string): Promise<SharePreview> {
    const scope = await this.linkScope(token, 'legacy');
    return withScope(this.db, scope, async (trx) => {
      const link = await this.live(trx, scope.actor.shareId, 'legacy');
      const context = await this.context(trx, link.document_id, link.created_by);
      return {
        household_name: context.household_name,
        needs_pin: link.pin_hash !== null,
        expires_at: link.expires_at.toISOString(),
        // With a PIN on it, even the title waits: "Divorce settlement" is
        // information, and the PIN is there because somebody wanted a
        // second lock on exactly that.
        document_title: link.pin_hash ? null : context.title,
        shared_by: context.shared_by,
      };
    });
  }

  /**
   * Opens the link. This is the step that is recorded — one row in the
   * family's activity log per open, with whatever the request told us.
   */
  async open(
    token: string,
    input: z.infer<typeof openBody>,
    meta: RequestMeta,
  ): Promise<SharedDocument> {
    const scope = await this.linkScope(token, 'legacy');
    const { householdId } = scope;
    const outcome = await withScope(this.db, scope, async (trx) => {
      const link = await this.live(trx, scope.actor.shareId, 'legacy');
      const tried = await this.tryPin(trx, householdId, link, input.pin, meta);
      if (tried !== 'right' && tried !== 'no pin') return { refused: tried, link } as const;
      if ((await this.countOpen(trx, link.id)) !== 'counted') {
        return { refused: 'gone', link } as const;
      }
      const context = await this.context(trx, link.document_id, link.created_by);
      const version = await this.newestVersion(trx, link.document_id);
      await this.record(trx, householdId, link, 'share.opened', meta);
      return {
        opened: {
          document_title: context.title,
          document_type: context.type_label,
          shared_by: context.shared_by,
          expires_at: link.expires_at.toISOString(),
          byte_size: Number(version.byte_size),
          content_type: version.mime,
          filename: version.filename,
        },
      } as const;
    });
    if (isRefused(outcome)) {
      await this.refuse(householdId, outcome.link, outcome.refused);
      throw gone();
    }
    return outcome.opened;
  }

  /**
   * The file itself. Takes the PIN again rather than handing out a second
   * token: it is one call from the same page, and a token that unlocks a
   * file is one more secret to lose. Fetching it does not count as a
   * second visit: the family's log should read like what happened. A legacy
   * link is always one to download (0041 holds it so).
   */
  async content(
    token: string,
    input: z.infer<typeof openBody>,
    meta: RequestMeta,
  ): Promise<{ stream: Readable; total: number; contentType: string; filename: string }> {
    const scope = await this.linkScope(token, 'legacy');
    const { householdId } = scope;
    const outcome = await withScope(this.db, scope, async (trx) => {
      const link = await this.live(trx, scope.actor.shareId, 'legacy');
      if (link.permission !== 'download') return { refused: 'gone', link } as const;
      const tried = await this.tryPin(trx, householdId, link, input.pin, meta);
      if (tried !== 'right' && tried !== 'no pin') return { refused: tried, link } as const;
      const v = await this.newestVersion(trx, link.document_id);
      const scopeKey = await this.keys.unwrapById(trx, v.wrapped_by_scope);
      const fileKey = unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`);
      const adapter = await this.vaults.adapterById(trx, v.vault_id);
      await this.record(trx, householdId, link, 'share.downloaded', meta);
      return { file: { version: v, adapter, fileKey } } as const;
    });
    if (isRefused(outcome)) {
      await this.refuse(householdId, outcome.link, outcome.refused);
      throw gone();
    }
    return this.decrypted(outcome.file);
  }

  // ------------------------------------------------------------- the PIN

  /**
   * One try of the link's PIN, in the link's own transaction.
   *
   * The try is reserved before the PIN is checked — `attempts + 1 where
   * attempts < 10`, which takes the row — so tries made at the same moment
   * queue behind it, and no more than ten are ever made however many
   * arrive at once. A right PIN gives its try back (the reservation is
   * rolled back to its savepoint, which also lets the next try in). A wrong
   * one keeps it; the tenth locks the link, once: its sessions end, the
   * family's log says so, and the sharer is told (refuse()).
   */
  private async tryPin(
    trx: Db,
    householdId: string,
    link: LinkRow,
    pin: string | undefined,
    meta: RequestMeta,
  ): Promise<Attempt> {
    if (!link.pin_hash) return 'no pin';
    await sql`savepoint fdv_pin_attempt`.execute(trx);
    const reserved = await trx
      .updateTable('share_link')
      .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
      .where('id', '=', link.id)
      .where('attempts', '<', MAX_PIN_ATTEMPTS)
      .returning('attempts')
      .executeTakeFirst();
    if (!reserved) {
      await sql`release savepoint fdv_pin_attempt`.execute(trx);
      return 'gone';
    }
    const right = pin ? await argon2.verify(link.pin_hash, pin).catch(() => false) : false;
    if (right) {
      await sql`rollback to savepoint fdv_pin_attempt`.execute(trx);
      return 'right';
    }
    await sql`release savepoint fdv_pin_attempt`.execute(trx);
    if (reserved.attempts < MAX_PIN_ATTEMPTS)
      return { wrong: MAX_PIN_ATTEMPTS - reserved.attempts };
    // The tenth: only one try ever takes the count to ten, so this happens
    // once in a link's life. Failed tries are counters, never audit rows;
    // the lock is one row.
    await trx.deleteFrom('share_session').where('share_id', '=', link.id).execute();
    await this.record(trx, householdId, link, 'share.locked', meta);
    return 'locked';
  }

  /**
   * After the link's transaction: throws what a refused try is answered
   * with, telling the sharer first if it locked the link.
   */
  private async refuse(householdId: string, link: LinkRow, why: Refusal) {
    if (why === 'gone' || why === 'used up') return;
    if (why === 'locked') {
      await this.alert({
        householdId,
        accountIds: [link.created_by],
        subject: 'A link you shared has stopped working',
        body:
          'Somebody typed the wrong PIN ten times on a link you shared, so it has stopped ' +
          'working and opens nothing now. The activity log shows which one; make a new link ' +
          'if they still need the document.',
      });
      throw pinWrong(0);
    }
    throw pinWrong(why.wrong);
  }

  /**
   * One more open, counted in one statement, and only while the link is
   * live and has opens left (5.18): of any number pressing Open at once on
   * a link with one open left, the statement counts one, and the rest find
   * none. Otherwise says which: used up, or gone since.
   */
  private async countOpen(trx: Db, id: string): Promise<'counted' | 'used up' | 'gone'> {
    const row = await trx
      .updateTable('share_link')
      .set((eb) => ({ open_count: eb('open_count', '+', 1), last_opened_at: new Date() }))
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .where('paused_at', 'is', null)
      .where('expires_at', '>', new Date())
      .where('attempts', '<', MAX_PIN_ATTEMPTS)
      .where((eb) =>
        eb.or([eb('max_opens', 'is', null), eb('open_count', '<', eb.ref('max_opens'))]),
      )
      .returning('open_count')
      .executeTakeFirst();
    if (row) return 'counted';
    const now = await trx
      .selectFrom('share_link')
      .select(['open_count', 'max_opens'])
      .where('id', '=', id)
      .executeTakeFirst();
    return now && usedUp(now) ? 'used up' : 'gone';
  }

  private record(
    trx: Db,
    householdId: string,
    link: { id: string; document_id: string; recipient_label: string | null },
    action: string,
    meta: RequestMeta,
  ) {
    return appendAudit(trx, {
      householdId,
      // Nobody signed in, so there is no actor account — this label is
      // what the family's activity log shows instead.
      actorLabel: link.recipient_label ? `shared link (${link.recipient_label})` : 'shared link',
      action,
      objectType: 'document',
      objectId: link.document_id,
      detail: { share_id: link.id, user_agent: meta.userAgent ?? null },
      // An outsider's address is kept only as far as their network (A24).
      ip: truncatedIp(meta.ip),
    });
  }

  // ------------------------------------------------------------- helpers

  /**
   * The link, if it may be used now: not revoked, paused, expired or locked;
   * of the flow the route serves; its document out of the Trash; and its
   * maker still in the household and still able to see the document. Asked
   * on every open and every request of a session, never remembered. (Its
   * opens are Open's to count: a session already opened is one of them.)
   */
  private async live(trx: Db, shareId: string, flow: Flow): Promise<LinkRow> {
    const row = await trx
      .selectFrom('share_link')
      .selectAll()
      .where('id', '=', shareId)
      .executeTakeFirst();
    if (!row) throw gone();
    if (row.flow !== flow) throw gone();
    if (row.revoked_at || row.paused_at) throw gone();
    if (row.expires_at.getTime() < Date.now()) throw gone();
    if (row.attempts >= MAX_PIN_ATTEMPTS) throw gone();
    // A document moved to the trash stops being shared, without anybody
    // having to remember the link exists.
    const doc = await trx
      .selectFrom('document')
      .select(['id', 'visibility', 'owner_member_id'])
      .where('id', '=', row.document_id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!doc) throw gone();
    // A link lends its maker's sight of the document, so it lasts only as
    // long as they still have it. Made "Only me" by its owner, the maker
    // demoted to teen or viewer, their sign-in taken away: each of these
    // ends the link, asked on every open rather than remembered.
    const maker = await trx
      .selectFrom('account_household')
      .select(['role', 'member_id'])
      .where('account_id', '=', row.created_by)
      .executeTakeFirst();
    if (!maker || !canSee({ role: maker.role, memberId: maker.member_id }, doc)) throw gone();
    // 5.28: a maker whose sign-in is suspended — locked by an owner, or
    // paused after a restore — lends nothing either. That state arrives
    // with 5.28; its check goes here, beside the membership above.
    return row;
  }

  private async decrypted(file: {
    version: { storage_key: string; byte_size: string | number; mime: string; filename: string };
    adapter: { get(key: string): Promise<Readable> };
    fileKey: Buffer;
  }) {
    const cipher = await file.adapter.get(file.version.storage_key);
    const dec = new DecryptStream(file.fileKey);
    cipher.on('error', (e) => dec.destroy(e));
    return {
      stream: cipher.pipe(dec),
      total: Number(file.version.byte_size),
      contentType: file.version.mime,
      filename: file.version.filename,
    };
  }

  private async context(trx: Db, documentId: string, createdBy: string) {
    const doc = await trx
      .selectFrom('document')
      .leftJoin('document_type', 'document_type.key', 'document.type_key')
      .select(['document.title', 'document_type.label as type_label'])
      .where('document.id', '=', documentId)
      .executeTakeFirstOrThrow();
    const household = await trx.selectFrom('household').select(['name']).executeTakeFirstOrThrow();
    const sharer = await trx
      .selectFrom('account_household')
      .innerJoin('member', 'member.id', 'account_household.member_id')
      .select(['member.display_name'])
      .where('account_household.account_id', '=', createdBy)
      .executeTakeFirst();
    return {
      title: doc.title,
      type_label: doc.type_label,
      household_name: household.name,
      shared_by: sharer?.display_name ?? null,
    };
  }

  private async newestVersion(trx: Db, documentId: string) {
    const v = await trx
      .selectFrom('document_version')
      .selectAll()
      .where('document_id', '=', documentId)
      .orderBy('version_no', 'desc')
      .executeTakeFirst();
    if (!v) throw gone();
    return v;
  }
}

function stateOf(r: {
  revoked_at: Date | null;
  expires_at: Date;
  attempts: number;
  paused_at: Date | null;
  open_count: number;
  max_opens: number | null;
}): ShareView['state'] {
  if (r.revoked_at) return 'revoked';
  if (r.attempts >= MAX_PIN_ATTEMPTS) return 'locked';
  if (r.expires_at.getTime() < Date.now()) return 'expired';
  if (r.paused_at) return 'paused';
  if (usedUp(r)) return 'used_up';
  return 'active';
}

function summarise(
  r: {
    recipient_label: string | null;
    open_count: number;
    max_opens: number | null;
    permission: SharePermission;
    downloads_used: number;
    max_downloads: number | null;
    flow: Flow;
    expires_at: Date;
  },
  state: ShareView['state'],
  timezone: string,
): string {
  const who = r.recipient_label ? `Shared with ${r.recipient_label}` : 'Shared by link';
  const uses = shareUses(r);
  const opened = `${uses.charAt(0).toLowerCase()}${uses.slice(1)}`;
  const end = shareEndWords(r.expires_at, timezone, { weekday: false });
  switch (state) {
    case 'active':
      return `${who}, ${opened}. Stops working on ${end}.`;
    case 'used_up':
      return `${who}, ${opened}. Used up: it cannot be opened again.`;
    case 'expired':
      return `${who}, ${opened}. Expired on ${end}.`;
    case 'revoked':
      return `${who}, ${opened}. You took this link back.`;
    case 'locked':
      return `${who}. The PIN was wrong too many times, so it stopped working.`;
    case 'paused':
      return `${who}, ${opened}. Paused after a restore until it is turned back on; it would stop working on ${end}.`;
  }
}
