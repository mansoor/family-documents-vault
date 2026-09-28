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
  type Role,
  type Scope,
} from '@fdv/db';
import { readAll } from '@fdv/storage';
import argon2 from 'argon2';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { seenCollection } from '../collections/service.js';
import { ApiError, notFound } from '../errors.js';
import type { VaultService } from '../vaults/service.js';
import { seenDocument, type Enqueue } from './service.js';
import { DecryptStream } from '@fdv/crypto';
import {
  can,
  canSee,
  canSeeCollection,
  canShareToView,
  collectionShareItem,
  COLLECTION_SHARE_REASONS,
  FOLLOW_MAX_DAYS,
  PREVIEW_MAX_PAGES,
  SHARE_END_GRACE_MINUTES,
  SHARE_LIMIT_MAX,
  SHARE_MAX_DAYS,
  shareEndProblem,
  shareEndWords,
  shareUses,
  withinCollectionAudience,
  type CollectionAudience,
  type CollectionSharePreview,
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
 *
 * Since 5.19 a link can be to a collection: exactly the documents its
 * sharer ticked (a snapshot), each checked again on every request — still
 * in the collection, out of the Trash, and one the sharer can still see —
 * with the collection itself still theirs to see, neither deleted nor Only
 * me, and the sharer still somebody who may share. What fails is simply not
 * given, and nothing says it was there. A link that follows its collection
 * (A19) also gives what is put in it later, for the whole of its audience;
 * it lasts 30 days at most. Every collection's link asks to confirm it's
 * you, and the collection's maker is told when somebody else shares it.
 * The database holds all of it a second time (0042).
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
const sharePagesKey = (shareId: string, versionId: string) => `share-pages:${shareId}:${versionId}`;
/** How long pages the worker could not draw are said to have failed before they are asked for again. */
export const PAGES_RETRY_MS = 60 * 60_000;

const limit = z.number().int().min(1).max(SHARE_LIMIT_MAX).nullable().optional();

const shareOptions = {
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
};

export const shareBody = z.object(shareOptions).strict();

/**
 * A collection shared (5.19): the documents ticked, and 5.18's options. At
 * least one document, unless the link follows the collection.
 */
export const collectionShareBody = z
  .object({
    ...shareOptions,
    document_ids: z.array(z.string().uuid()).max(200),
    follow_collection: z.boolean().optional(),
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
  /** Null for a link to a collection (5.19). */
  document_id: string | null;
  document_title: string | null;
  /** A link to a collection (5.19): which, and its name now. Never how many documents went. */
  collection_id: string | null;
  collection_name: string | null;
  follow_collection: boolean;
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
  /** A view-only link's pages: how many, of how many, and whether drawn yet. A document's link only. */
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

/** Whether a link turned back on after a restore is a document's or a collection's. */
export interface Resumable {
  document_id: string | null;
  collection_id: string | null;
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
  document_id: string | null;
  collection_id: string | null;
  follow_collection: boolean;
  /** The audience a following link was made for (the 5.19 review): what follows must fit it. */
  follow_audience: 'everyone' | 'teens' | 'adults' | null;
  recipient_label: string | null;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  pin_hash: string | null;
  flow: Flow;
  permission: SharePermission;
  open_count: number;
  max_opens: number | null;
  downloads_used: number;
  max_downloads: number | null;
};

/** A collection, as its link reads it (5.19). */
type LinkCollection = {
  id: string;
  name: string;
  audience: CollectionAudience;
  owner_member_id: string | null;
};

/**
 * A link that may be used now, with what its check found: whoever made it,
 * as they are now, and a collection's link's collection.
 */
type Live = LinkRow & {
  maker: { role: Role; member_id: string };
  collection: LinkCollection | null;
};

/** A live link inside a session, with its household. */
type InSession = Live & { household_id: string };

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

/** What a link's lines in the activity log are about: its document, or its collection. */
const objectOf = (link: { document_id: string | null; collection_id: string | null }) =>
  link.collection_id !== null
    ? { objectType: 'collection', objectId: link.collection_id }
    : { objectType: 'document', objectId: link.document_id };

const gone = () =>
  new ApiError(
    404,
    'link_not_valid',
    'That link is not valid any more. Ask whoever sent it for a new one.',
  );

/** A legacy link's one document: every legacy link has one (0042 holds it so). */
const documentOf = (link: { document_id: string | null }): string => {
  if (!link.document_id) throw gone();
  return link.document_id;
};

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

const noCollection = () => new ApiError(404, 'not_found', 'That collection does not exist.');
const notInCollection = () =>
  new ApiError(404, 'not_found', 'That document is not in this collection.');

/**
 * An Only me collection is its maker's alone (A17): it goes nowhere, and
 * made Only me, a shared one's links end (5.19).
 */
const onlyMeStaysHome = () =>
  new ApiError(
    422,
    'collection_only_me',
    'An Only me collection is yours alone, so it cannot be shared outside the family. Change who it is for first.',
  );

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

  /**
   * When a new link ends: `expires_at`, or `expires_in_days` from an older
   * client, or a week. A client that says a date and time can know the
   * vault's longest (`limits.share_max_days`), and past it is refused. An
   * older one cannot, so its days, and the week nobody said, are cut to
   * the longest (the answer's `expires_at` says when it ends).
   */
  private endOf(
    input: { expires_at?: string | undefined; expires_in_days?: number | undefined },
    maxDays = this.maxDays,
  ): Date {
    if (input.expires_at !== undefined && input.expires_in_days !== undefined) {
      throw new ApiError(
        422,
        'validation_failed',
        'Say when the link ends once: expires_at or expires_in_days, not both.',
      );
    }
    const days = Math.min(input.expires_in_days ?? DEFAULT_DAYS, maxDays);
    const end =
      input.expires_at !== undefined
        ? new Date(input.expires_at)
        : new Date(Date.now() + days * 864e5);
    // A few minutes past the longest are let through: a client's clock may
    // be that far ahead of this one, and it offered only what it could.
    const problem = shareEndProblem(end, { maxDays, graceMinutes: SHARE_END_GRACE_MINUTES });
    if (problem) throw expiryRefused(problem);
    return end;
  }

  /** A link to view has nothing to download. */
  private permissionOf(input: {
    permission?: SharePermission | undefined;
    max_downloads?: number | null | undefined;
  }): SharePermission {
    const permission: SharePermission = input.permission ?? 'download';
    if (permission === 'view' && input.max_downloads != null) {
      throw new ApiError(
        422,
        'validation_failed',
        'A link to view has nothing to download: leave out max_downloads.',
      );
    }
    return permission;
  }

  /** The link's secret, and its PIN when one is asked for. */
  private async secrets(withPin: boolean | undefined) {
    const token = randomBytes(32).toString('base64url');
    const pin = withPin ? String(randomInt(0, 10000)).padStart(4, '0') : null;
    return { token, pin, pinHash: pin ? await argon2.hash(pin, ARGON2) : null };
  }

  /** What the maker of a link is handed, once. */
  private async handOver(
    p: Principal,
    id: string,
    token: string,
    pin: string | null,
  ): Promise<CreatedShare> {
    const share = (await this.list(p)).find((s) => s.id === id) as ShareView;
    // The whole link to send, on the public-only site, when the vault has
    // one: the secret after the #, which no server is sent.
    const link_url = this.publicUrl ? `${this.publicUrl.replace(/\/+$/, '')}/s#${token}` : null;
    return pin
      ? { share, link_token: token, link_url, pin }
      : { share, link_token: token, link_url };
  }

  async create(
    p: Principal,
    documentId: string,
    input: z.infer<typeof shareBody>,
    meta: RequestMeta,
  ): Promise<CreatedShare> {
    requireCapability(p, 'document.share');
    const expiresAt = this.endOf(input);
    const permission = this.permissionOf(input);
    const { token, pin, pinHash } = await this.secrets(input.with_pin);

    const { id, versionId } = await withPrincipal(this.db, p, async (trx) => {
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
      return { id: row.id, versionId: newest.id };
    });

    // A link to view shows the pages the worker draws for it, with whom it
    // is for across each: asked for now, so they are there when it opens.
    if (permission === 'view') await this.drawPages(p.householdId, id, versionId);
    return this.handOver(p, id, token, pin);
  }

  // ------------------------------------------------- a collection (5.19)

  /**
   * A collection the caller may see, for sharing it: one they may share at
   * all (a teen never shares one outside, A18), that is there for them, and
   * not Only me. Asked before the credential is (step-up), so nobody is
   * asked to confirm it's them about a collection that is not there for them.
   */
  async shareableCollection(p: Principal, collectionId: string): Promise<void> {
    requireCapability(p, 'document.share');
    await withPrincipal(this.db, p, (trx) => this.collectionFor(trx, p, collectionId));
  }

  private async collectionFor(trx: Db, p: Principal, collectionId: string) {
    const c = await trx
      .selectFrom('doc_collection as l')
      .select(['l.id', 'l.name', 'l.audience', 'l.owner_member_id'])
      .where('l.id', '=', collectionId)
      .where(seenCollection(p))
      .executeTakeFirst();
    if (!c) throw noCollection();
    if (c.audience === 'only_me') throw onlyMeStaysHome();
    return c;
  }

  /**
   * What the share sheet offers (5.19): the documents in the collection the
   * sharer can see, out of the Trash, in the collection's order — none they
   * cannot, and nothing that counts those. Each is ticked when everybody the
   * collection is for may see it; an adults-only one in a collection for
   * everybody asks "include anyway?"; the sharer's own private one says so
   * and is never ticked for them; one with no file cannot go.
   */
  async collectionPreview(p: Principal, collectionId: string): Promise<CollectionSharePreview> {
    requireCapability(p, 'document.share');
    return withPrincipal(this.db, p, async (trx) => {
      const c = await this.collectionFor(trx, p, collectionId);
      const rows = await this.collectionDocuments(trx, p, c.id);
      return {
        collection_id: c.id,
        collection_name: c.name,
        audience: c.audience,
        items: rows.map((r) => {
          const offer = collectionShareItem(c.audience, {
            visibility: r.visibility,
            has_file: r.mime !== null,
          });
          return {
            document_id: r.id,
            title: r.title,
            type_label: r.type_label,
            ticked: offer.ticked,
            lock: offer.lock,
            reason: offer.lock ? COLLECTION_SHARE_REASONS[offer.lock] : null,
            viewable: canShareToView(r.mime),
          };
        }),
      };
    });
  }

  /**
   * The documents in a collection the caller can see, out of the Trash, in
   * its order, each with its newest file's kind (null: no file yet); only
   * `ids`, when given.
   */
  private async collectionDocuments(trx: Db, p: Principal, collectionId: string, ids?: string[]) {
    let q = trx
      .selectFrom('doc_collection_item as i')
      .innerJoin('document as d', 'd.id', 'i.document_id')
      .leftJoin('document_type as t', 't.key', 'd.type_key')
      .select([
        'd.id',
        'd.title',
        'd.visibility',
        'd.owner_member_id',
        'i.position',
        't.label as type_label',
      ])
      .select((eb) =>
        eb
          .selectFrom('document_version as v')
          .select('v.mime')
          .whereRef('v.document_id', '=', 'd.id')
          .orderBy('v.version_no', 'desc')
          .limit(1)
          .as('mime'),
      )
      .where('i.collection_id', '=', collectionId)
      .where('d.deleted_at', 'is', null)
      .where(seenDocument(p));
    if (ids) q = q.where('d.id', 'in', ids);
    return q.orderBy('i.position').orderBy('i.document_id').execute();
  }

  /**
   * A link to a collection (5.19): the documents ticked, each one in the
   * collection now that the sharer can see and that has a file — anything
   * else is answered as a document that is not in it — and 5.18's options.
   * A link that follows the collection lasts 30 days at most. The route
   * has asked the sharer to confirm it's them (`share_collection`), always.
   * The collection's maker is told when somebody else shares it.
   */
  async createForCollection(
    p: Principal,
    collectionId: string,
    input: z.infer<typeof collectionShareBody>,
    meta: RequestMeta,
  ): Promise<CreatedShare> {
    requireCapability(p, 'document.share');
    const follow = input.follow_collection === true;
    const asked = [...new Set(input.document_ids.map((d) => d.toLowerCase()))];
    if (asked.length === 0 && !follow) {
      throw new ApiError(422, 'validation_failed', 'Choose at least one document to share.', {
        detail: 'document_ids',
      });
    }
    const followRefused = () =>
      expiryRefused(
        `A link that keeps up with its collection lasts ${FOLLOW_MAX_DAYS} days at most. Choose an earlier end, or share it as it is now.`,
      );
    const grace = SHARE_END_GRACE_MINUTES * 60_000;
    if (
      follow &&
      input.expires_at !== undefined &&
      new Date(input.expires_at).getTime() > Date.now() + FOLLOW_MAX_DAYS * 864e5 + grace
    ) {
      throw followRefused();
    }
    // Days from an older client, or the week nobody said, are cut to it.
    let expiresAt = this.endOf(
      input,
      follow ? Math.min(this.maxDays, FOLLOW_MAX_DAYS) : this.maxDays,
    );
    const permission = this.permissionOf(input);
    const { token, pin, pinHash } = await this.secrets(input.with_pin);

    const made = await withPrincipal(this.db, p, async (trx) => {
      const c = await this.collectionFor(trx, p, collectionId);
      // Held to the database's own clock, which the link's row is checked
      // against (share_link_follow_30_days): now() is the transaction's,
      // and the API's own clock, or the client's, may be a little ahead of
      // it. An end within SHARE_END_GRACE_MINUTES past 30 days — the grace
      // every link's end has (5.18) — and days from an older client are cut
      // to 30 days exactly; past that, refused.
      if (follow) {
        const r = await sql<{ now: Date }>`select now() as now`.execute(trx);
        const latest = (r.rows[0]?.now ?? new Date()).getTime() + FOLLOW_MAX_DAYS * 864e5;
        if (expiresAt.getTime() > latest) {
          if (input.expires_at !== undefined && expiresAt.getTime() - latest > grace) {
            throw followRefused();
          }
          expiresAt = new Date(latest);
        }
      }
      const found = asked.length ? await this.collectionDocuments(trx, p, c.id, asked) : [];
      // One the sharer cannot see is answered as one that is not in it.
      if (found.length !== asked.length) throw notInCollection();
      const empty = found.find((d) => d.mime === null);
      if (empty) {
        throw new ApiError(
          422,
          'nothing_to_share',
          `There is no file on “${empty.title ?? 'a document'}” yet, so there is nothing to send. Untick it.`,
        );
      }
      const unviewable = found.find((d) => !canShareToView(d.mime));
      if (permission === 'view' && unviewable) {
        throw new ApiError(
          422,
          'view_not_possible',
          `Word and Excel files can only be shared to download, and “${unviewable.title ?? 'a document'}” is one. Untick it, or let them download.`,
        );
      }

      const row = await trx
        .insertInto('share_link')
        .values({
          household_id: p.householdId,
          document_id: null,
          collection_id: c.id,
          follow_collection: follow,
          // What follows must fit the audience it was made for, as well as
          // the collection's then: narrowing only takes away (5.19 review).
          // (An Only me collection was refused above: it goes nowhere.)
          follow_audience: follow && c.audience !== 'only_me' ? c.audience : null,
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
      // A link that keeps up with its collection keeps, too, what was in it
      // and was not ticked — whoever may see it — so that it never follows,
      // however it is taken out and put back (5.19 review): only what is
      // put in afterwards, and was never in it as the link was made, can.
      const leftOut = follow
        ? (
            await trx
              .selectFrom('doc_collection_item')
              .select(['document_id', 'position'])
              .where('collection_id', '=', c.id)
              .execute()
          ).filter((i) => !found.some((d) => d.id === i.document_id))
        : [];
      if (found.length || leftOut.length) {
        await trx
          .insertInto('share_link_item')
          .values([
            ...found.map((d) => ({
              share_id: row.id,
              household_id: p.householdId,
              collection_id: c.id,
              document_id: d.id,
              position: d.position,
              kind: 'ticked' as const,
            })),
            ...leftOut.map((i) => ({
              share_id: row.id,
              household_id: p.householdId,
              collection_id: c.id,
              document_id: i.document_id,
              position: i.position,
              kind: 'left_out' as const,
            })),
          ])
          .execute();
      }
      // About the collection, for whoever may see it; the documents that
      // went by id only, so that the chain says exactly what was sent and
      // no line names one its reader may not see.
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'share.created',
        objectType: 'collection',
        objectId: c.id,
        detail: {
          share_id: row.id,
          recipient_label: input.recipient_label ?? null,
          with_pin: Boolean(pin),
          expires_at: expiresAt.toISOString(),
          permission,
          max_opens: input.max_opens ?? null,
          max_downloads: input.max_downloads ?? null,
          follow_collection: follow,
          document_ids: found.map((d) => d.id),
        },
        ip: meta.ip,
      });
      // The collection read again, now that the household's log is held: a
      // maker making it Only me, or deleting it, holds the log too as it
      // takes its links back, so one made meanwhile is seen here, or is
      // there for that to take back (C519-07). Made Only me, or gone, the
      // link is not made.
      const still = await trx
        .selectFrom('doc_collection')
        .select(['audience', 'deleted_at'])
        .where('id', '=', c.id)
        .executeTakeFirst();
      if (!still || still.deleted_at !== null) throw noCollection();
      if (still.audience === 'only_me') throw onlyMeStaysHome();
      // Its maker is told when somebody else shares their collection (A19).
      const maker =
        c.owner_member_id && c.owner_member_id !== p.memberId
          ? await trx
              .selectFrom('account_household')
              .select('account_id')
              .where('member_id', '=', c.owner_member_id)
              .executeTakeFirst()
          : undefined;
      const sharer = await trx
        .selectFrom('member')
        .select('display_name')
        .where('id', '=', p.memberId)
        .executeTakeFirst();
      return { id: row.id, maker: maker?.account_id ?? null, sharer: sharer?.display_name ?? null };
    });

    if (made.maker) {
      // Nothing in it names the collection, whom it went to or what: an
      // email leaves the vault. The activity log says, to whoever may see.
      await this.alert({
        householdId: p.householdId,
        accountIds: [made.maker],
        subject: 'Somebody shared one of your collections',
        body:
          `${made.sharer ?? 'Somebody in your family'} shared one of the collections you made ` +
          'with somebody outside the family, by a link. The activity log shows which, and whom it ' +
          'went to. Ask them if you did not expect it.',
      }).catch(() => undefined);
    }
    if (permission === 'view') {
      for (const v of await this.linkVersions(p.householdId, made.id)) {
        await this.drawPages(p.householdId, made.id, v.id);
      }
    }
    return this.handOver(p, made.id, token, pin);
  }

  /**
   * The newest file of each document a link gives now, as the database
   * gives them to the link itself (0042): its own rules decide, and nothing
   * here says them again.
   */
  private linkVersions(householdId: string, shareId: string) {
    return withScope(this.db, { householdId, actor: { kind: 'link', shareId } }, (trx) =>
      trx.selectFrom('document_version').select(['id', 'document_id']).execute(),
    );
  }

  /**
   * Asks the worker to draw a view-only link's pages of a version: once
   * for each link and version queued or being drawn, however often it is
   * asked. A request that fails (the worker has not made its queue yet) is
   * asked again by whoever looks at the link next.
   */
  private drawPages(householdId: string, shareId: string, versionId: string, redraw = false) {
    return this.enqueue(
      SHARE_PAGES_JOB,
      {
        household_id: householdId,
        share_id: shareId,
        version_id: versionId,
        ...(redraw ? { redraw: true } : {}),
      },
      { singletonKey: sharePagesKey(shareId, versionId), priority: 10 },
    ).catch(() => undefined);
  }

  async list(p: Principal): Promise<ShareView[]> {
    return (await this.views(p)).map(viewOnly);
  }

  /**
   * Every link the reader may know about, with who made it.
   *
   * A document's: to a document the reader can see. A collection's (5.19):
   * to a collection the reader can see, and only when they can see every
   * document it was made with — or made it. It never says how many.
   */
  private async views(p: Principal): Promise<LinkView[]> {
    // Who a document went to outside the family ("the divorce lawyer"),
    // who sent it and how often it was opened is for those who may share
    // (0.5.0). A teen or a viewer — an accountant with a sign-in, say —
    // read every link to every document they could see.
    if (!can(p.role, 'document.share')) return [];
    return withPrincipal(this.db, p, async (trx) => {
      const rows = await trx
        .selectFrom('share_link')
        .leftJoin('document', 'document.id', 'share_link.document_id')
        // The database gives no other member's Only me collection (0036).
        .leftJoin('doc_collection', 'doc_collection.id', 'share_link.collection_id')
        .leftJoin('account_household', (j) =>
          j
            .onRef('account_household.account_id', '=', 'share_link.created_by')
            .onRef('account_household.household_id', '=', 'share_link.household_id'),
        )
        .leftJoin('member', 'member.id', 'account_household.member_id')
        // Who took it back, by name (W519-1): the list says it to others.
        .leftJoin('account_household as revoker', (j) =>
          j
            .onRef('revoker.account_id', '=', 'share_link.revoked_by')
            .onRef('revoker.household_id', '=', 'share_link.household_id'),
        )
        .leftJoin('member as revoker_member', 'revoker_member.id', 'revoker.member_id')
        .select([
          'share_link.id',
          'share_link.document_id',
          'share_link.collection_id',
          'share_link.follow_collection',
          'share_link.recipient_label',
          'share_link.created_by',
          'share_link.created_at',
          'share_link.expires_at',
          'share_link.revoked_at',
          'share_link.revoked_by',
          'share_link.revoked_why',
          'revoker_member.display_name as revoked_by_name',
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
          'doc_collection.name as collection_name',
          'doc_collection.audience as collection_audience',
          'doc_collection.owner_member_id as collection_owner',
          'doc_collection.deleted_at as collection_deleted_at',
          'member.display_name as created_by_name',
        ])
        .orderBy('share_link.created_at', 'desc')
        .execute();
      const household = await trx
        .selectFrom('household')
        .select('timezone')
        .executeTakeFirstOrThrow();
      const reader = { role: p.role, memberId: p.memberId };
      // What each collection's link was made with, and has followed: the
      // reader must be able to see every one of them, or it is not theirs
      // to know about. (What it was made without, left out, is not.)
      const collectionLinks = rows.filter((r) => r.collection_id !== null).map((r) => r.id);
      const unseen = new Set<string>();
      if (collectionLinks.length) {
        const items = await trx
          .selectFrom('share_link_item')
          .innerJoin('document', 'document.id', 'share_link_item.document_id')
          .select(['share_link_item.share_id', 'document.visibility', 'document.owner_member_id'])
          .where('share_link_item.share_id', 'in', collectionLinks)
          .where('share_link_item.kind', 'in', ['ticked', 'followed'])
          .execute();
        for (const i of items) if (!canSee(reader, i)) unseen.add(i.share_id);
      }
      // A link names its document, so the list shows only links to what the
      // reader may see — the same rule as every other list. Until 0.4.2
      // this checked only "private", and a teen could read the titles of
      // adults-only documents that had been shared out of the house.
      const seen = rows.filter((r) => {
        if (r.collection_id === null) {
          return r.visibility !== null && canSee(reader, { ...r, visibility: r.visibility });
        }
        return (
          r.collection_audience !== null &&
          r.collection_deleted_at === null &&
          canSeeCollection(reader, {
            audience: r.collection_audience,
            owner_member_id: r.collection_owner,
          }) &&
          (r.created_by === p.accountId || !unseen.has(r.id))
        );
      });
      const views: LinkView[] = [];
      for (const r of seen) {
        const state = stateOf(r);
        views.push({
          id: r.id,
          document_id: r.document_id,
          document_title: r.collection_id === null ? r.title : null,
          collection_id: r.collection_id,
          collection_name: r.collection_id !== null ? r.collection_name : null,
          follow_collection: r.follow_collection,
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
          // A live link's pages still to be drawn are asked for here too.
          // A collection's are asked for as its recipient's page is looked at.
          pages:
            r.permission === 'view' && r.document_id !== null
              ? await this.pagesOf(
                  trx,
                  { id: r.id, document_id: r.document_id },
                  state === 'active' ? p.householdId : undefined,
                )
              : null,
          summary: summarise(r, state, household.timezone, p.accountId),
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
   *
   * Asked with `ask` (the link's household), for a live link, pages still
   * to be drawn are asked of the worker as well — whoever looks at the link
   * is what keeps it from waiting for ever (5.18 review): a newer version
   * uploaded, a job lost on its way, a worker that started after the API.
   * Once for each link and version, however often it is asked.
   *
   * Pages the worker's last try could not draw are said to have failed, and
   * not asked for, for PAGES_RETRY_MS; after that, they are asked for again
   * (the second review: a storage outage of a minute must not end a link's
   * pages for good). The version's own previews failing, or a kind of file
   * the vault cannot draw, is for good. The same for each document of a
   * collection's link (5.19): its failures are kept a version at a time
   * (share_page_failure, 0042), a document's link's as well.
   */
  private async pagesOf(
    trx: Db,
    link: { id: string; document_id: string },
    ask?: string,
  ): Promise<SharePages> {
    const v = await trx
      .selectFrom('document_version')
      .select(['id', 'page_count', 'preview_state', 'preview_pages'])
      .where('document_id', '=', link.document_id)
      .orderBy('version_no', 'desc')
      .executeTakeFirst();
    if (!v) return { state: 'failed', shown: 0, total: null };
    const drawn = await trx
      .selectFrom('share_page')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('share_id', '=', link.id)
      .where('version_id', '=', v.id)
      .executeTakeFirstOrThrow();
    const n = Number(drawn.n);
    const total = v.page_count ?? (v.preview_state === 'ready' ? v.preview_pages : null);
    if (n > 0) return { state: 'ready', shown: n, total: total ?? n };
    const failure = await trx
      .selectFrom('share_page_failure')
      .select('failed_at')
      .where('share_id', '=', link.id)
      .where('version_id', '=', v.id)
      .executeTakeFirst();
    // The hour is lifted only for a caller about to ask again: a link that
    // is not live says what it has, "failed", not "being drawn" by nobody
    // (the third review).
    const failedLately =
      failure !== undefined && (!ask || Date.now() - failure.failed_at.getTime() < PAGES_RETRY_MS);
    if (v.preview_state === 'unsupported' || v.preview_state === 'failed' || failedLately) {
      return { state: 'failed', shown: 0, total };
    }
    if (ask) void this.drawPages(ask, link.id, v.id);
    return {
      state: 'drawing',
      shown: total !== null ? Math.min(total, PREVIEW_MAX_PAGES) : null,
      total,
    };
  }

  /** A link's pages of one of its documents. */
  private pagesFor(trx: Db, link: LinkRow, documentId: string, ask?: string) {
    return this.pagesOf(trx, { id: link.id, document_id: documentId }, ask);
  }

  /**
   * Takes a link back. A document's: whoever may share and can see the
   * document. A collection's (5.19): whoever may share and can see the
   * collection, when they made the link, are an owner, or can see every
   * document it was made with. Anybody else is told there is no such link.
   */
  async revoke(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'document.share');
    const revoked = await withPrincipal(this.db, p, async (trx) => {
      const reader = { role: p.role, memberId: p.memberId };
      // A link to a document the caller cannot see is not there for them.
      const target = await trx
        .selectFrom('share_link')
        .leftJoin('document', 'document.id', 'share_link.document_id')
        .leftJoin('doc_collection', 'doc_collection.id', 'share_link.collection_id')
        .select([
          'share_link.created_by',
          'share_link.collection_id',
          'document.visibility',
          'document.owner_member_id',
          'doc_collection.audience as collection_audience',
          'doc_collection.owner_member_id as collection_owner',
        ])
        .where('share_link.id', '=', id)
        .executeTakeFirst();
      if (!target) throw notFound('That link');
      if (target.collection_id === null) {
        if (!target.visibility || !canSee(reader, { ...target, visibility: target.visibility })) {
          throw notFound('That link');
        }
      } else {
        if (
          !target.collection_audience ||
          !canSeeCollection(reader, {
            audience: target.collection_audience,
            owner_member_id: target.collection_owner,
          })
        ) {
          throw notFound('That link');
        }
        if (target.created_by !== p.accountId && p.role !== 'owner') {
          const items = await trx
            .selectFrom('share_link_item')
            .innerJoin('document', 'document.id', 'share_link_item.document_id')
            .select(['document.visibility', 'document.owner_member_id'])
            .where('share_link_item.share_id', '=', id)
            .where('share_link_item.kind', 'in', ['ticked', 'followed'])
            .execute();
          if (items.some((i) => !canSee(reader, i))) throw notFound('That link');
        }
      }
      const row = await trx
        .updateTable('share_link')
        .set({ revoked_at: new Date(), revoked_by: p.accountId })
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .returning(['id', 'document_id', 'collection_id', 'permission'])
        .executeTakeFirst();
      if (!row) throw notFound('That link');
      // Taken back is taken back everywhere: a page opened with it stops at
      // its next request anyway, and now there is no session left to ask.
      await trx.deleteFrom('share_session').where('share_id', '=', id).execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'share.revoked',
        ...objectOf(row),
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
   * owner, every one they may know about, to turn back on or take back;
   * anybody else who may share, the ones they made, only to take back
   * (resumable says why).
   */
  async paused(p: Principal): Promise<ShareView[]> {
    const owner = can(p.role, 'restore.review');
    return (await this.views(p))
      .filter((s) => s.state === 'paused' && (owner || s.created_by === p.accountId))
      .map(viewOnly);
  }

  /**
   * Whether the caller may turn a paused link back on, and what it is to:
   * an owner may, for any link they may know about; nobody else, whoever
   * made it (A55: every link waits for an owner). A backup brings back a
   * link an owner took back after it was made, and the activity log's line
   * saying so is gone with the rest of what came after it — so its maker is
   * not the one to decide it still stands. Not even for a link to their own
   * Only me document, which no owner can see: what the document is now says
   * nothing about what it was when the link was taken back, and it can be
   * made Only me for the asking and put back after. Such a link stays
   * paused; its maker takes it back and makes a new one. Taking a paused
   * link back is not this: that only closes, and stays with whoever may
   * take back a link. A collection's link is known to an owner who can see
   * the collection and every document it was made with (5.19).
   */
  async resumable(p: Principal, id: string): Promise<Resumable> {
    requireCapability(p, 'restore.review');
    const link = (await this.views(p)).find((s) => s.id === id);
    if (!link) throw notFound('That link');
    if (link.state !== 'paused') throw notFound('That paused link');
    return { document_id: link.document_id, collection_id: link.collection_id };
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
        .returning(['id', 'document_id', 'collection_id', 'permission'])
        .executeTakeFirst();
      if (!row) throw notFound('That paused link');
      // Turned back on, a link whose pages could not be drawn is tried
      // afresh, every version of every document it gives.
      await trx.deleteFrom('share_page_failure').where('share_id', '=', row.id).execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'share.resumed',
        ...objectOf(row),
        detail: { share_id: row.id },
        ip: meta.ip,
      });
      return row;
    });
    // The backup's record of its pages may name files removed since it was
    // made: a view-only link has them drawn again.
    if (resumed.permission === 'view') {
      for (const v of await this.linkVersions(p.householdId, id)) {
        await this.drawPages(p.householdId, id, v.id, true);
      }
    }
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
      // A view-only link's pages still to be drawn are asked for while the
      // recipient reads this: nothing is counted or written down for it.
      if (link.permission === 'view') {
        for (const doc of await this.liveItems(trx, link)) {
          await this.pagesFor(trx, link, doc, scope.householdId);
        }
      }
      const from = await this.from(trx, link.created_by);
      const protection: ShareProtection[] = link.pin_hash ? ['pin'] : [];
      // With a protection on it, even the title waits: "Divorce
      // settlement" is information, and the PIN is there because somebody
      // wanted a second lock on exactly that. A collection's name too.
      const title =
        link.document_id !== null ? (await this.documentWords(trx, link.document_id)).title : null;
      return {
        household_name: from.household_name,
        shared_by: from.shared_by,
        protection,
        expires_at: link.expires_at.toISOString(),
        document_title: protection.length ? null : title,
        permission: link.permission,
        opens_left: link.max_opens === null ? null : link.max_opens - link.open_count,
        kind: link.collection ? 'collection' : 'document',
        ...(link.collection
          ? { collection_name: protection.length ? null : link.collection.name }
          : {}),
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
      const made = await trx
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
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.record(trx, householdId, link, 'share.opened', meta);
      const session = await this.sessionView(
        trx,
        { ...link, household_id: householdId },
        expiresAt,
        made.id,
      );
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
      this.sessionView(trx, link, session.expires_at, session.id),
    );
  }

  /**
   * Whether a link gives a document now: its own document, or one of what
   * its collection's link gives (5.19). Any other id is not there for it —
   * the database's rule for a link gives it no other document's row, and
   * the answer is the 404 of one that does not exist.
   */
  private async gives(trx: Db, link: Live, documentId: string): Promise<boolean> {
    const doc = await trx
      .selectFrom('document')
      .select('id')
      .where('id', '=', documentId)
      .executeTakeFirst();
    if (!doc) return false;
    return (await this.liveItems(trx, link)).includes(doc.id);
  }

  /**
   * A document's file, inside a session. Only a document the link gives:
   * any other id is not there for it. Only a link to download: a link to
   * view never gives the file (A22). The first download of each document in
   * a session is counted against the link's downloads and written down; the
   * rest of that session's are free.
   */
  async sessionContent(
    cookie: string | undefined,
    documentId: string,
    meta: RequestMeta,
  ): Promise<{ stream: Readable; total: number; contentType: string; filename: string }> {
    const found = await this.inSession(cookie, async (trx, link, session) => {
      if (!(await this.gives(trx, link, documentId))) return null;
      if (link.permission !== 'download') {
        throw new ApiError(
          403,
          'view_only',
          'This link is for viewing only: the file itself was not shared.',
        );
      }
      const first = await this.used(trx, link, session.id, documentId, 'downloaded');
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
        await this.record(trx, link.household_id, link, 'share.downloaded', meta, documentId);
      }
      const v = await this.newestVersion(trx, documentId);
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
      if (!(await this.gives(trx, link, documentId))) return { kind: 'missing' } as const;
      if (link.permission !== 'view') {
        throw new ApiError(
          404,
          'no_preview',
          'This link gives the file itself, not pages: download it.',
        );
      }
      const v = await this.newestVersion(trx, documentId);
      const page = await trx
        .selectFrom('share_page')
        .select('storage_key')
        .where('share_id', '=', link.id)
        .where('version_id', '=', v.id)
        .where('n', '=', n)
        .executeTakeFirst();
      if (!page) {
        // Asked of the worker again, when they are still to be drawn.
        const pages = await this.pagesFor(trx, link, documentId, link.household_id);
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
        return { kind: 'pending' } as const;
      }
      if (await this.used(trx, link, session.id, documentId, 'viewed')) {
        await this.record(trx, link.household_id, link, 'share.viewed', meta, documentId);
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
        versionId: v.id,
      } as const;
    });
    if (outcome.kind === 'missing') throw notFound('That document');
    const pending = () =>
      new ApiError(
        404,
        'preview_pending',
        'The pages are still being drawn. Try again in a moment.',
        { retriable: true, retryAfter: 3 },
      );
    if (outcome.kind === 'pending') throw pending();
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
      void this.drawPages(outcome.householdId, outcome.shareId, outcome.versionId, true);
      throw pending();
    }
  }

  /**
   * Notes that a session has had a document — its download, or a look at
   * its pages — and says whether this was the first time. Two requests of
   * one session at once: the second waits for the first, and finds it done.
   */
  private async used(
    trx: Db,
    link: InSession,
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
   * maker no longer able to see the document, the document in the Trash;
   * for a collection's, the collection and its sharer as they are now.
   * A session that fails is removed, and its next request is refused too.
   * A link opened as many times as it allows is not ended by that: each
   * session is one of its opens, and lasts to its own end.
   */
  private async inSession<T>(
    cookie: string | undefined,
    fn: (trx: Db, link: InSession, session: { id: string; expires_at: Date }) => Promise<T>,
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
      let link: Live;
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

  /**
   * What is open in a session: the documents the link gives now, and for a
   * link to view, their pages — asked of the worker again while they are
   * still to be drawn, so that the page polling this is what keeps them
   * coming (5.18 review). For a link to download, whether this session has
   * had each file already: it may again, free, once the link's downloads
   * are used up. A collection's link (5.19) gives what it gives now, in the
   * collection's order, and nothing about what it does not.
   */
  private async sessionView(
    trx: Db,
    link: InSession,
    sessionEnds: Date,
    sessionId: string,
  ): Promise<SharedSession> {
    const from = await this.from(trx, link.created_by);
    const ids = await this.liveItems(trx, link);
    const downloaded =
      link.permission === 'download' && ids.length
        ? new Set(
            (
              await trx
                .selectFrom('share_session_use')
                .select('document_id')
                .where('session_id', '=', sessionId)
                .where('kind', '=', 'downloaded')
                .execute()
            ).map((u) => u.document_id),
          )
        : new Set<string>();
    const items: SharedItem[] = [];
    for (const id of ids) {
      const words = await this.documentWords(trx, id);
      const v = await this.newestVersion(trx, id);
      items.push({
        id,
        title: words.title,
        type_label: words.type_label,
        filename: v.filename,
        content_type: v.mime,
        byte_size: Number(v.byte_size),
        pages:
          link.permission === 'view' ? await this.pagesFor(trx, link, id, link.household_id) : null,
        downloaded: downloaded.has(id),
      });
    }
    return {
      household_name: from.household_name,
      shared_by: from.shared_by,
      expires_at: link.expires_at.toISOString(),
      session_expires_at: sessionEnds.toISOString(),
      items,
      permission: link.permission,
      downloads_left:
        link.permission === 'download' && link.max_downloads !== null
          ? Math.max(0, link.max_downloads - link.downloads_used)
          : null,
      kind: link.collection ? 'collection' : 'document',
      ...(link.collection ? { collection_name: link.collection.name } : {}),
    };
  }

  // ------------------------------------------------ the old routes (A25)

  /** What the recipient sees before they have typed anything. */
  async preview(token: string): Promise<SharePreview> {
    const scope = await this.linkScope(token, 'legacy');
    return withScope(this.db, scope, async (trx) => {
      const link = await this.live(trx, scope.actor.shareId, 'legacy');
      const from = await this.from(trx, link.created_by);
      const words = await this.documentWords(trx, documentOf(link));
      return {
        household_name: from.household_name,
        needs_pin: link.pin_hash !== null,
        expires_at: link.expires_at.toISOString(),
        // With a PIN on it, even the title waits: "Divorce settlement" is
        // information, and the PIN is there because somebody wanted a
        // second lock on exactly that.
        document_title: link.pin_hash ? null : words.title,
        shared_by: from.shared_by,
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
      const from = await this.from(trx, link.created_by);
      const words = await this.documentWords(trx, documentOf(link));
      const version = await this.newestVersion(trx, documentOf(link));
      await this.record(trx, householdId, link, 'share.opened', meta);
      return {
        opened: {
          document_title: words.title,
          document_type: words.type_label,
          shared_by: from.shared_by,
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
      const v = await this.newestVersion(trx, documentOf(link));
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

  /**
   * A line the link writes in the family's activity log, about what it is
   * to — or, for a download or a look at pages, about that document.
   */
  private record(
    trx: Db,
    householdId: string,
    link: {
      id: string;
      document_id: string | null;
      collection_id: string | null;
      recipient_label: string | null;
    },
    action: string,
    meta: RequestMeta,
    documentId?: string,
  ) {
    return appendAudit(trx, {
      householdId,
      // Nobody signed in, so there is no actor account — this label is
      // what the family's activity log shows instead.
      actorLabel: link.recipient_label ? `shared link (${link.recipient_label})` : 'shared link',
      action,
      ...(documentId ? { objectType: 'document', objectId: documentId } : objectOf(link)),
      detail: { share_id: link.id, user_agent: meta.userAgent ?? null },
      // An outsider's address is kept only as far as their network (A24).
      ip: truncatedIp(meta.ip),
    });
  }

  // ------------------------------------------------------------- helpers

  /**
   * The link, if it may be used now: not revoked, paused, expired or locked;
   * of the flow the route serves; and its maker still in the household.
   * A document's: the document out of the Trash, and its maker still able
   * to see it. A collection's (5.19): the collection neither deleted nor
   * Only me, and its maker still somebody who may share (an owner or an
   * adult: a teen never shares outside, A18) who can see it. Asked on every
   * open and every request of a session, never remembered. (Its opens are
   * Open's to count: a session already opened is one of them.) The database
   * asks the same of its own (app_live_share(), 0042).
   */
  private async live(trx: Db, shareId: string, flow: Flow): Promise<Live> {
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
    const maker = await trx
      .selectFrom('account_household')
      .select(['role', 'member_id'])
      .where('account_id', '=', row.created_by)
      .executeTakeFirst();
    if (!maker) throw gone();
    const sharer = { role: maker.role, memberId: maker.member_id };
    if (row.document_id !== null) {
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
      if (!canSee(sharer, doc)) throw gone();
      return { ...row, maker, collection: null };
    }
    if (row.collection_id === null) throw gone();
    // A collection lent: its maker's sight of the collection, and their
    // right to send anything outside the family at all.
    const collection = await trx
      .selectFrom('doc_collection')
      .select(['id', 'name', 'audience', 'owner_member_id', 'deleted_at'])
      .where('id', '=', row.collection_id)
      .executeTakeFirst();
    if (!collection || collection.deleted_at !== null) throw gone();
    if (collection.audience === 'only_me') throw gone();
    if (!can(maker.role, 'document.share')) throw gone();
    if (!canSeeCollection(sharer, collection)) throw gone();
    // 5.28: a maker whose sign-in is suspended — locked by an owner, or
    // paused after a restore — lends nothing either. That state arrives
    // with 5.28; its check goes here, beside the membership above.
    return {
      ...row,
      maker,
      collection: {
        id: collection.id,
        name: collection.name,
        audience: collection.audience,
        owner_member_id: collection.owner_member_id,
      },
    };
  }

  /**
   * The documents a live link gives now, in order. A document's: its own. A
   * collection's (5.19): each document of its snapshot — ticked as it was
   * made, or followed, decided as it was put in the collection (the 5.19
   * review) — that is in the collection now, out of the Trash, with a file,
   * and one its sharer can see; one that followed only while it is still
   * for the whole of the audience the link was made for and of the
   * collection's now. Nothing is decided here: every check only takes
   * away. Never a count of the rest. The database asks the same
   * (app_link_documents(), 0042), and gives the link no row of anything else.
   */
  private async liveItems(trx: Db, link: Live): Promise<string[]> {
    if (link.document_id !== null) return [link.document_id];
    const collection = link.collection;
    if (!collection) return [];
    const snapshot = new Map(
      (
        await trx
          .selectFrom('share_link_item')
          .select(['document_id', 'kind'])
          .where('share_id', '=', link.id)
          .where('kind', 'in', ['ticked', 'followed'])
          .execute()
      ).map((t) => [t.document_id, t.kind]),
    );
    const rows = await trx
      .selectFrom('doc_collection_item as i')
      .innerJoin('document as d', 'd.id', 'i.document_id')
      .select(['d.id', 'd.visibility', 'd.owner_member_id', 'd.deleted_at'])
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('document_version as v')
              .select('v.id')
              .whereRef('v.document_id', '=', 'd.id'),
          )
          .as('has_file'),
      )
      .where('i.collection_id', '=', collection.id)
      .orderBy('i.position')
      .orderBy('i.document_id')
      .execute();
    const sharer = { role: link.maker.role, memberId: link.maker.member_id };
    return rows
      .filter((d) => {
        const kind = snapshot.get(d.id);
        if (!kind || d.deleted_at !== null || !d.has_file || !canSee(sharer, d)) return false;
        return (
          kind === 'ticked' ||
          (link.follow_audience !== null &&
            withinCollectionAudience(collection.audience, d.visibility) &&
            withinCollectionAudience(link.follow_audience, d.visibility))
        );
      })
      .map((d) => d.id);
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

  /** Whose vault, and who sent it: what every page of a link names. */
  private async from(trx: Db, createdBy: string) {
    const household = await trx.selectFrom('household').select(['name']).executeTakeFirstOrThrow();
    const sharer = await trx
      .selectFrom('account_household')
      .innerJoin('member', 'member.id', 'account_household.member_id')
      .select(['member.display_name'])
      .where('account_household.account_id', '=', createdBy)
      .executeTakeFirst();
    return { household_name: household.name, shared_by: sharer?.display_name ?? null };
  }

  /** A document's title and kind, as the page shows them. */
  private async documentWords(trx: Db, documentId: string) {
    const doc = await trx
      .selectFrom('document')
      .leftJoin('document_type', 'document_type.key', 'document.type_key')
      .select(['document.title', 'document_type.label as type_label'])
      .where('document.id', '=', documentId)
      .executeTakeFirst();
    if (!doc) throw gone();
    return { title: doc.title, type_label: doc.type_label };
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
    follow_collection?: boolean;
    revoked_by?: string | null;
    revoked_by_name?: string | null;
    revoked_why?: 'collection_only_me' | 'collection_deleted' | null;
  },
  state: ShareView['state'],
  timezone: string,
  reader: string,
): string {
  const who = r.recipient_label ? `Shared with ${r.recipient_label}` : 'Shared by link';
  const uses = shareUses(r);
  const opened = `${uses.charAt(0).toLowerCase()}${uses.slice(1)}`;
  const end = shareEndWords(r.expires_at, timezone, { weekday: false });
  const follows = r.follow_collection ? ' Keeps up with the collection.' : '';
  switch (state) {
    case 'active':
      return `${who}, ${opened}. Stops working on ${end}.${follows}`;
    case 'used_up':
      return `${who}, ${opened}. Used up: it cannot be opened again.`;
    case 'expired':
      return `${who}, ${opened}. Expired on ${end}.`;
    case 'revoked':
      return `${who}, ${opened}. ${takenBack(r, reader)}`;
    case 'locked':
      return `${who}. The PIN was wrong too many times, so it stopped working.`;
    case 'paused':
      return `${who}, ${opened}. Paused after a restore until it is turned back on; it would stop working on ${end}.`;
  }
}

/**
 * Why a link stopped, said to whoever reads the list (5.19 review, W519-1):
 * a collection's link that ended with its collection says so; otherwise the
 * one who took it back is "You" only to themselves, and named to the rest.
 */
function takenBack(
  r: {
    revoked_by?: string | null;
    revoked_by_name?: string | null;
    revoked_why?: 'collection_only_me' | 'collection_deleted' | null;
  },
  reader: string,
): string {
  if (r.revoked_why === 'collection_only_me') {
    return 'It stopped when the collection was made Only me.';
  }
  if (r.revoked_why === 'collection_deleted') return 'It stopped when the collection was deleted.';
  if (r.revoked_by && r.revoked_by === reader) return 'You took this link back.';
  if (r.revoked_by_name) return `${r.revoked_by_name} took this link back.`;
  return 'It was taken back.';
}
