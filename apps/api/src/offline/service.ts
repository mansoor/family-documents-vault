import argon2 from 'argon2';
import { appendAudit, withPrincipal, type Db } from '@fdv/db';
import {
  canSee,
  type OfflineGrant,
  type OfflineOpen,
  type OfflineOpensResult,
  type OfflineSet,
} from '@fdv/shared';
import type { Principal, RequestMeta } from '../auth/service.js';
import type { DocumentService } from '../documents/service.js';
import { ApiError } from '../errors.js';

/**
 * Essentials a phone may keep (0.4.13).
 *
 * A phone keeps the household's Essentials for when there is no
 * connection. Four things make that safe:
 *
 *  - **A grant, with the password.** Filling the phone needs the person's
 *    password again — not a code, since the authenticator is usually on the
 *    same phone. It lasts at most 30 days and never past the session's own
 *    end, and goes with the session. It never relaxes the step-up the
 *    ordinary routes ask for.
 *  - **The complete set.** The phone is told everything it may keep, so
 *    what is missing from the set is what it must remove.
 *  - **Pages only for the set.** Visibility first (the same 404 as a
 *    version that does not exist), then the current version of an Essential
 *    in the set (404), then the grant (403).
 *  - **What was opened is told.** The phone reports each opening when it
 *    next connects; each is recorded once, dated when it arrived, with the
 *    phone's own time kept beside it.
 */

const DAY = 24 * 60 * 60 * 1000;
export const OFFLINE_GRANT_DAYS = 30;

const refused = () => new ApiError(401, 'invalid_credentials', "That password isn't right.");
const grantRequired = () =>
  new ApiError(
    403,
    'offline_grant_required',
    'Please confirm it is you to keep Essentials on this phone.',
  );

export class OfflineService {
  constructor(
    private readonly db: Db,
    private readonly docs: DocumentService,
    private readonly maxOfflineDays: number,
  ) {}

  /** POST /offline/grant: the password again, and this session may fill its phone. */
  async grant(
    p: Principal,
    input: { password: string; include_private?: boolean | undefined },
    meta: RequestMeta,
  ): Promise<OfflineGrant> {
    if (p.role === 'viewer') {
      throw new ApiError(
        403,
        'forbidden',
        "People outside the family can't keep documents on a phone.",
      );
    }
    const granted = await withPrincipal(this.db, p, async (trx) => {
      const session = await trx
        .selectFrom('session')
        .select(['installation_id', 'absolute_expires_at'])
        .where('id', '=', p.sessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!session)
        throw new ApiError(401, 'session_ended', 'Please sign in again.', { reason: 'revoked' });
      if (!session.installation_id) {
        throw new ApiError(422, 'validation_failed', 'Only the app keeps documents on a phone.', {
          detail: 'no installation id on this session',
        });
      }
      const account = await trx
        .selectFrom('account')
        .select('password_hash')
        .where('id', '=', p.accountId)
        .executeTakeFirst();
      if (
        !account?.password_hash ||
        !(await argon2.verify(account.password_hash, input.password))
      ) {
        return null;
      }
      const now = new Date();
      const expires = new Date(
        Math.min(
          now.getTime() + OFFLINE_GRANT_DAYS * DAY,
          new Date(session.absolute_expires_at).getTime(),
        ),
      );
      const includePrivate = input.include_private === true;
      await trx
        .updateTable('session')
        .set({
          offline_granted_at: now,
          offline_expires_at: expires,
          offline_include_private: includePrivate,
        })
        .where('id', '=', p.sessionId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.offline_granted',
        objectType: 'session',
        objectId: p.sessionId,
        detail: { expires_at: expires.toISOString(), include_private: includePrivate },
        ip: meta.ip,
      });
      return {
        granted_at: now.toISOString(),
        expires_at: expires.toISOString(),
        include_private: includePrivate,
      };
    });
    if (granted) return granted;
    // Recorded in a transaction of its own: the refusal must not take it back.
    await withPrincipal(this.db, p, (trx) =>
      appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.offline_grant_refused',
        objectType: 'session',
        objectId: p.sessionId,
        ip: meta.ip,
      }),
    );
    throw refused();
  }

  /** DELETE /offline/grant: this phone keeps nothing more. */
  async endGrant(p: Principal, meta: RequestMeta): Promise<void> {
    await withPrincipal(this.db, p, async (trx) => {
      await trx
        .updateTable('session')
        .set({ offline_granted_at: null, offline_expires_at: null, offline_include_private: false })
        .where('id', '=', p.sessionId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.offline_ended',
        objectType: 'session',
        objectId: p.sessionId,
        ip: meta.ip,
      });
    });
  }

  /** The grant in force on this session, if any. */
  private async current(p: Principal): Promise<OfflineGrant | null> {
    const row = await withPrincipal(this.db, p, (trx) =>
      trx
        .selectFrom('session')
        .select(['offline_granted_at', 'offline_expires_at', 'offline_include_private'])
        .where('id', '=', p.sessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst(),
    );
    if (!row?.offline_granted_at || !row.offline_expires_at) return null;
    if (new Date(row.offline_expires_at).getTime() <= Date.now()) return null;
    return {
      granted_at: new Date(row.offline_granted_at).toISOString(),
      expires_at: new Date(row.offline_expires_at).toISOString(),
      include_private: row.offline_include_private,
    };
  }

  /**
   * GET /offline/essentials: everything this phone may keep, and nothing
   * else. With no grant in force — never given, ended, or lapsed — that is
   * nothing: a phone that follows the set removes what it holds.
   */
  async set(p: Principal): Promise<OfflineSet> {
    const grant = await this.current(p);
    const { items, truncated } = grant
      ? await this.docs.offlineEssentials(p, grant.include_private)
      : { items: [], truncated: false };
    return {
      items,
      grant,
      max_offline_days: this.maxOfflineDays,
      server_time: new Date().toISOString(),
      truncated,
    };
  }

  /**
   * GET /offline/pages/{version}/{n}: a page for the phone's copy. Visible,
   * then in the set, then granted — in that order, so the answer never says
   * more than the person may know. Recorded once per session and version.
   */
  async page(p: Principal, versionId: string, n: number, meta: RequestMeta): Promise<Buffer> {
    // Whether Only me Essentials are in the set depends on the grant; with
    // none, the set is asked without them and the grant check refuses next.
    const grant = await this.current(p);
    const { documentId } = await this.docs.offlineVersion(
      p,
      versionId,
      grant?.include_private ?? false,
    );
    if (!grant) throw grantRequired();
    const bytes = await this.docs.page(p, versionId, n, meta, { audit: false });
    await withPrincipal(this.db, p, async (trx) => {
      const first = await trx
        .insertInto('offline_fill')
        .values({ household_id: p.householdId, session_id: p.sessionId, version_id: versionId })
        .onConflict((oc) => oc.doNothing())
        .returning('version_id')
        .executeTakeFirst();
      if (!first) return;
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'document.cached_offline',
        objectType: 'document',
        objectId: documentId,
        detail: { version_id: versionId },
        ip: meta.ip,
      });
    });
    return bytes;
  }

  /**
   * POST /offline/opens: what the phone did with its copies while it had no
   * connection. Each event once, however often it is sent; dated when it
   * arrived, with the phone's own time in `detail`, never later than now
   * nor earlier than the longest a phone keeps its copies.
   */
  async opens(p: Principal, events: OfflineOpen[], meta: RequestMeta): Promise<OfflineOpensResult> {
    const result: OfflineOpensResult = { accepted: 0, duplicates: 0, dropped: 0 };
    const now = Date.now();
    const earliest = now - this.maxOfflineDays * DAY;
    await withPrincipal(this.db, p, async (trx) => {
      for (const e of events) {
        const row = await trx
          .selectFrom('document_version')
          .innerJoin('document', 'document.id', 'document_version.document_id')
          .select(['document.id', 'document.visibility', 'document.owner_member_id'])
          .where('document_version.id', '=', e.version_id)
          .executeTakeFirst();
        // Nothing is written about a document the person cannot see: not
        // a line in anybody's log, not a receipt that says it exists.
        if (!row || p.role === 'viewer' || !canSee({ role: p.role, memberId: p.memberId }, row)) {
          result.dropped += 1;
          continue;
        }
        const fresh = await trx
          .insertInto('client_event_receipt')
          .values({ household_id: p.householdId, event_id: e.id, account_id: p.accountId })
          .onConflict((oc) => oc.doNothing())
          .returning('event_id')
          .executeTakeFirst();
        if (!fresh) {
          result.duplicates += 1;
          continue;
        }
        const at = Date.parse(e.opened_at);
        const clamped = new Date(Math.min(now, Math.max(earliest, Number.isFinite(at) ? at : now)));
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'document.opened_offline',
          objectType: 'document',
          objectId: row.id,
          detail: {
            event_id: e.id,
            version_id: e.version_id,
            opened_at: clamped.toISOString(),
            mode: e.mode,
            online: e.online,
          },
          ip: meta.ip,
        });
        result.accepted += 1;
      }
    });
    return result;
  }

  /** Whether a session's grant is in force: the device list says so. */
  static inForce(expiresAt: Date | string | null): boolean {
    return expiresAt !== null && new Date(expiresAt).getTime() > Date.now();
  }
}
