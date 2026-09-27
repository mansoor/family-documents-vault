import { createHash, randomBytes, randomInt } from 'node:crypto';
import { isIPv6 } from 'node:net';
import type { Readable } from 'node:stream';
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
import argon2 from 'argon2';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError, notFound } from '../errors.js';
import type { VaultService } from '../vaults/service.js';
import { DecryptStream } from '@fdv/crypto';
import {
  can,
  canSee,
  type ShareLinkPreview,
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

export const shareBody = z
  .object({
    expires_in_days: z.number().int().min(1).max(90).optional(),
    /** A label for the family's own list: "the letting agent". */
    recipient_label: z.string().trim().max(80).optional(),
    /** True asks the server to invent one; nobody chooses 0000. */
    with_pin: z.boolean().optional(),
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
  state: 'active' | 'expired' | 'revoked' | 'locked' | 'paused';
  /** Which routes open it (5.16): the old ones for `legacy`, the new ones for `v2`. */
  flow: 'legacy' | 'v2';
  /** Paused, and why: a restore (5.16). An owner turns it back on. */
  paused_at: string | null;
  paused_reason: 'restored' | null;
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
};

/** How one try of a link's PIN went. */
type Attempt = 'right' | 'no pin' | { wrong: number } | 'locked' | 'gone';

/** A try that did not open the link, and the link it was made on. */
type Refused = { readonly refused: Exclude<Attempt, 'right' | 'no pin'>; readonly link: LinkRow };

const isRefused = (outcome: object): outcome is Refused =>
  'refused' in outcome && (outcome as Partial<Refused>).refused !== undefined;

const gone = () =>
  new ApiError(
    404,
    'link_not_valid',
    'That link is not valid any more. Ask whoever sent it for a new one.',
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

export class ShareService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly vaults: VaultService,
    /** How a sharer is told their link was locked (alert.send). */
    private readonly alert: (input: AlertRequest) => Promise<void> = async () => undefined,
    /** The public-only site's address (FDV_PUBLIC_URL), which links start with when set. */
    private readonly publicUrl: string | null = null,
  ) {}

  // -------------------------------------------------------------- making

  async create(
    p: Principal,
    documentId: string,
    input: z.infer<typeof shareBody>,
    meta: RequestMeta,
  ): Promise<CreatedShare> {
    requireCapability(p, 'document.share');
    const token = randomBytes(32).toString('base64url');
    const pin = input.with_pin ? String(randomInt(0, 10000)).padStart(4, '0') : null;
    const pinHash = pin ? await argon2.hash(pin, ARGON2) : null;
    const expiresAt = new Date(Date.now() + (input.expires_in_days ?? DEFAULT_DAYS) * 864e5);

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
      const versions = await trx
        .selectFrom('document_version')
        .select(['id'])
        .where('document_id', '=', documentId)
        .executeTakeFirst();
      if (!versions) {
        throw new ApiError(
          422,
          'nothing_to_share',
          'There is no file on this document yet, so there is nothing to send.',
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
        },
        ip: meta.ip,
      });
      return row.id;
    });

    const share = (await this.list(p)).find((s) => s.id === id) as ShareView;
    // The whole link to send, on the public-only site, when the vault has
    // one: the secret after the #, which no server is sent.
    const link_url = this.publicUrl ? `${this.publicUrl.replace(/\/+$/, '')}/s#${token}` : null;
    return pin
      ? { share, link_token: token, link_url, pin }
      : { share, link_token: token, link_url };
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
          'document.title',
          'document.visibility',
          'document.owner_member_id',
          'member.display_name as created_by_name',
        ])
        .orderBy('share_link.created_at', 'desc')
        .execute();
      // A link names its document, so the list shows only links to what the
      // reader may see — the same rule as every other list. Until 0.4.2
      // this checked only "private", and a teen could read the titles of
      // adults-only documents that had been shared out of the house.
      return rows
        .filter((r) => canSee({ role: p.role, memberId: p.memberId }, r))
        .map((r) => {
          const state = stateOf(r);
          return {
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
            summary: summarise(r, state),
            created_by: r.created_by,
          };
        });
    });
  }

  async revoke(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'document.share');
    await withPrincipal(this.db, p, async (trx) => {
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
        .returning(['id', 'document_id'])
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
    });
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
    await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .updateTable('share_link')
        .set({ paused_at: null, paused_reason: null })
        .where('id', '=', id)
        .where('paused_at', 'is not', null)
        .returning(['id', 'document_id'])
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
    });
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
   * sent it, what it asks for and until when. Nothing is counted and
   * nothing is written down — a link scanner fetching the page is not
   * somebody opening the document.
   */
  async previewLink(token: string): Promise<ShareLinkPreview> {
    const scope = await this.linkScope(token, 'v2');
    return withScope(this.db, scope, async (trx) => {
      const link = await this.live(trx, scope.actor.shareId, 'v2');
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
      };
    });
  }

  /**
   * Open: the one step that is counted and written down. Its PIN is tried
   * (a wrong one uses up one of the link's ten, reserved before it is
   * checked, so tries made at once cannot get past ten), the open is
   * counted, and a session is made for this browser.
   */
  async unlock(input: z.infer<typeof unlockBody>, meta: RequestMeta): Promise<Unlocked> {
    const scope = await this.linkScope(input.token, 'v2');
    const { householdId } = scope;
    const outcome = await withScope(this.db, scope, async (trx) => {
      const link = await this.live(trx, scope.actor.shareId, 'v2');
      const tried = await this.tryPin(trx, householdId, link, input.secret, meta);
      if (tried !== 'right' && tried !== 'no pin') return { refused: tried, link } as const;
      if (!(await this.countOpen(trx, link.id))) return { refused: 'gone', link } as const;

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
      await this.refuse(householdId, outcome.link, outcome.refused);
      throw gone();
    }
    return {
      cookie: outcome.cookie,
      maxAge: Math.max(1, Math.floor((outcome.expiresAt.getTime() - Date.now()) / 1000)),
      session: outcome.session,
    };
  }

  /** What is open in a session: the same answer Open gave. */
  async sessionItems(cookie: string | undefined): Promise<SharedSession> {
    return this.inSession(cookie, (trx, link, session) =>
      this.sessionView(trx, link, session.expires_at),
    );
  }

  /**
   * A document's file, inside a session. Only the link's own document: any
   * other id is not there for it — the database's rule for a link gives it
   * no other document's row, and the answer is the 404 of one that does
   * not exist.
   */
  async sessionContent(
    cookie: string | undefined,
    documentId: string,
    meta: RequestMeta,
  ): Promise<{ stream: Readable; total: number; contentType: string; filename: string }> {
    const found = await this.inSession(cookie, async (trx, link) => {
      const doc = await trx
        .selectFrom('document')
        .select('id')
        .where('id', '=', documentId)
        .executeTakeFirst();
      if (!doc || doc.id !== link.document_id) return null;
      const v = await this.newestVersion(trx, link.document_id);
      const scopeKey = await this.keys.unwrapById(trx, v.wrapped_by_scope);
      const fileKey = unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`);
      const adapter = await this.vaults.adapterById(trx, v.vault_id);
      await this.record(trx, link.household_id, link, 'share.downloaded', meta);
      return { version: v, adapter, fileKey };
    });
    if (!found) throw notFound('That document');
    return this.decrypted(found);
  }

  /**
   * Runs `fn` inside the session a cookie names, after the full check: the
   * session itself (not ended, not idle for 30 minutes) and then its link,
   * exactly as Open checked it — revoked, paused, expired, locked, its
   * maker no longer able to see the document, the document in the Trash.
   * A session that fails is removed, and its next request is refused too.
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
    };
    return {
      household_name: context.household_name,
      shared_by: context.shared_by,
      expires_at: link.expires_at.toISOString(),
      session_expires_at: sessionEnds.toISOString(),
      items: [item],
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
      if (!(await this.countOpen(trx, link.id))) return { refused: 'gone', link } as const;
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
   * second visit: the family's log should read like what happened.
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
  private async refuse(
    householdId: string,
    link: LinkRow,
    why: Exclude<Attempt, 'right' | 'no pin'>,
  ) {
    if (why === 'gone') return;
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

  /** One more open, counted in one statement, and only while the link is live. */
  private async countOpen(trx: Db, id: string): Promise<boolean> {
    const row = await trx
      .updateTable('share_link')
      .set((eb) => ({ open_count: eb('open_count', '+', 1), last_opened_at: new Date() }))
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .where('paused_at', 'is', null)
      .where('expires_at', '>', new Date())
      .where('attempts', '<', MAX_PIN_ATTEMPTS)
      .returning('open_count')
      .executeTakeFirst();
    return row !== undefined;
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
   * on every open and every request of a session, never remembered.
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
}): ShareView['state'] {
  if (r.revoked_at) return 'revoked';
  if (r.attempts >= MAX_PIN_ATTEMPTS) return 'locked';
  if (r.expires_at.getTime() < Date.now()) return 'expired';
  if (r.paused_at) return 'paused';
  return 'active';
}

function summarise(
  r: { recipient_label: string | null; open_count: number; expires_at: Date },
  state: ShareView['state'],
): string {
  const who = r.recipient_label ? `Shared with ${r.recipient_label}` : 'Shared by link';
  const opened =
    r.open_count === 0
      ? 'not opened yet'
      : r.open_count === 1
        ? 'opened once'
        : `opened ${r.open_count} times`;
  switch (state) {
    case 'active':
      return `${who}, ${opened}. Stops working on ${formatDay(r.expires_at)}.`;
    case 'expired':
      return `${who}, ${opened}. Expired on ${formatDay(r.expires_at)}.`;
    case 'revoked':
      return `${who}, ${opened}. You took this link back.`;
    case 'locked':
      return `${who}. The PIN was wrong too many times, so it stopped working.`;
    case 'paused':
      return `${who}, ${opened}. Paused after a restore until it is turned back on; it would stop working on ${formatDay(r.expires_at)}.`;
  }
}

function formatDay(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}
