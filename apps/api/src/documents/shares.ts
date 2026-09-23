import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Readable } from 'node:stream';
import { unwrapKey, type ScopeKeys } from '@fdv/crypto';
import { appendAudit, withScope, type Db } from '@fdv/db';
import argon2 from 'argon2';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Principal, RequestMeta } from '../auth/service.js';
import { requireCapability } from '../authz.js';
import { ApiError, notFound } from '../errors.js';
import type { VaultService } from '../vaults/service.js';
import { DecryptStream } from '@fdv/crypto';
import { canSee } from '@fdv/shared';

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
 */

const MAX_PIN_ATTEMPTS = 10;
const DEFAULT_DAYS = 7;
const ARGON2 = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

export const shareBody = z
  .object({
    expires_in_days: z.number().int().min(1).max(90).optional(),
    /** A label for the family's own list: "the letting agent". */
    recipient_label: z.string().trim().max(80).optional(),
    /** True asks the server to invent one; nobody chooses 0000. */
    with_pin: z.boolean().optional(),
  })
  .strict();

export const openBody = z.object({ pin: z.string().trim().max(12).optional() }).strict();

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
  state: 'active' | 'expired' | 'revoked' | 'locked';
  /** One sentence for the list on the home screen. */
  summary: string;
}

export interface CreatedShare {
  share: ShareView;
  /** Shown once. The vault keeps only its hash. */
  link_token: string;
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

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest();

const gone = () =>
  new ApiError(
    404,
    'link_not_valid',
    'That link is not valid any more. Ask whoever sent it for a new one.',
  );

export class ShareService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly vaults: VaultService,
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

    const id = await withScope(this.db, { householdId: p.householdId }, async (trx) => {
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
    return pin ? { share, link_token: token, pin } : { share, link_token: token };
  }

  async list(p: Principal): Promise<ShareView[]> {
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
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
          'share_link.created_at',
          'share_link.expires_at',
          'share_link.revoked_at',
          'share_link.open_count',
          'share_link.last_opened_at',
          'share_link.attempts',
          'share_link.pin_hash',
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
            summary: summarise(r, state),
          };
        });
    });
  }

  async revoke(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    requireCapability(p, 'document.share');
    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await trx
        .updateTable('share_link')
        .set({ revoked_at: new Date(), revoked_by: p.accountId })
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .returning(['id', 'document_id'])
        .executeTakeFirst();
      if (!row) throw notFound('That link');
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

  // ------------------------------------------------------------- opening

  private async householdOf(token: string): Promise<string> {
    const r = await sql<{ id: string | null }>`
      select share_link_household(${hashToken(token)}) as id
    `.execute(this.db);
    const id = r.rows[0]?.id;
    if (!id) throw gone();
    return id;
  }

  /** What the recipient sees before they have typed anything. */
  async preview(token: string): Promise<SharePreview> {
    const householdId = await this.householdOf(token);
    return withScope(this.db, { householdId }, async (trx) => {
      const link = await this.live(trx, token);
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
    const householdId = await this.householdOf(token);
    await this.checkPin(householdId, token, input.pin);
    return withScope(this.db, { householdId }, async (trx) => {
      const link = await this.live(trx, token);
      const context = await this.context(trx, link.document_id, link.created_by);
      const version = await this.newestVersion(trx, link.document_id);
      await trx
        .updateTable('share_link')
        .set((eb) => ({ open_count: eb('open_count', '+', 1), last_opened_at: new Date() }))
        .where('id', '=', link.id)
        .execute();
      await this.record(trx, householdId, link, 'share.opened', meta);
      return {
        document_title: context.title,
        document_type: context.type_label,
        shared_by: context.shared_by,
        expires_at: link.expires_at.toISOString(),
        byte_size: Number(version.byte_size),
        content_type: version.mime,
        filename: version.filename,
      };
    });
  }

  /**
   * The PIN, and the attempt counter behind it. Kept apart from opening
   * so that fetching the file after opening it does not count as a
   * second visit: the family's log should read like what happened.
   */
  private async checkPin(householdId: string, token: string, pin?: string): Promise<void> {
    const link = await withScope(this.db, { householdId }, (trx) => this.live(trx, token));
    if (!link.pin_hash) return;
    if (pin && (await argon2.verify(link.pin_hash, pin))) return;
    const left = await withScope(this.db, { householdId }, async (trx) => {
      const row = await trx
        .updateTable('share_link')
        .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
        .where('id', '=', link.id)
        .returning('attempts')
        .executeTakeFirstOrThrow();
      return MAX_PIN_ATTEMPTS - row.attempts;
    });
    throw new ApiError(
      401,
      'pin_wrong',
      left > 0
        ? 'That PIN is not right. Check with whoever sent you the link.'
        : 'That PIN was wrong too many times, so the link has stopped working.',
    );
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
      ip: meta.ip,
    });
  }

  /**
   * The file itself. Takes the PIN again rather than handing out a second
   * token: it is one call from the same page, and a token that unlocks a
   * file is one more secret to lose.
   */
  async content(
    token: string,
    input: z.infer<typeof openBody>,
    meta: RequestMeta,
  ): Promise<{ stream: Readable; total: number; contentType: string; filename: string }> {
    const householdId = await this.householdOf(token);
    await this.checkPin(householdId, token, input.pin);
    const { version, adapter, fileKey } = await withScope(this.db, { householdId }, async (trx) => {
      const link = await this.live(trx, token);
      const v = await this.newestVersion(trx, link.document_id);
      const scopeKey = await this.keys.unwrapById(trx, v.wrapped_by_scope);
      const fileKey = unwrapKey(v.file_key_wrapped, scopeKey, `version:${v.document_id}`);
      const adapter = await this.vaults.adapterById(trx, v.vault_id);
      await this.record(trx, householdId, link, 'share.downloaded', meta);
      return { version: v, adapter, fileKey };
    });
    const cipher = await adapter.get(version.storage_key);
    const dec = new DecryptStream(fileKey);
    cipher.on('error', (e) => dec.destroy(e));
    return {
      stream: cipher.pipe(dec),
      total: Number(version.byte_size),
      contentType: version.mime,
      filename: version.filename,
    };
  }

  // ------------------------------------------------------------- helpers

  private async live(trx: Db, token: string) {
    const row = await trx
      .selectFrom('share_link')
      .selectAll()
      .where('token_hash', '=', hashToken(token))
      .executeTakeFirst();
    if (!row) throw gone();
    if (row.revoked_at) throw gone();
    if (row.expires_at.getTime() < Date.now()) throw gone();
    if (row.attempts >= MAX_PIN_ATTEMPTS) throw gone();
    // A document moved to the trash stops being shared, without anybody
    // having to remember the link exists.
    const doc = await trx
      .selectFrom('document')
      .select(['id'])
      .where('id', '=', row.document_id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!doc) throw gone();
    return row;
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
}): ShareView['state'] {
  if (r.revoked_at) return 'revoked';
  if (r.attempts >= MAX_PIN_ATTEMPTS) return 'locked';
  if (r.expires_at.getTime() < Date.now()) return 'expired';
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
  }
}

function formatDay(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}
