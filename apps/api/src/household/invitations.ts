import { createHash, randomBytes } from 'node:crypto';
import type { ScopeKeys } from '@fdv/crypto';
import { appendAudit, withScope, type Db } from '@fdv/db';
import { can, capabilityToInvite, refusalFor, roleLabel, ROLES, type Role } from '@fdv/shared';
import argon2 from 'argon2';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AuthService, Principal, RequestMeta, Tokens } from '../auth/service.js';
import { ApiError, notFound } from '../errors.js';

/**
 * Invitations (SHR-02) — a link and a code.
 *
 * The shape of this is dictated by what actually happens in a family. One
 * person sets it up; the other is handed something. The link goes by
 * whatever they already use to talk to each other, and the code is said
 * out loud or sent separately, so that a forwarded message on its own is
 * not a way in.
 *
 * Neither secret is stored. The link's hash is looked up; the code is
 * verified with Argon2 and guarded by an attempt counter, because eight
 * characters a person can read aloud would otherwise be guessable. After
 * five wrong codes the invitation is dead and has to be made again — which
 * is deliberately annoying, and deliberately not silent.
 */

/** No 0/O/1/I/L/U: this gets read aloud and written on paper. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_ATTEMPTS = 5;
const DEFAULT_TTL_DAYS = 7;

const ARGON2 = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

const inviteFields = z
  .object({
    /** An existing person in the household who has no sign-in yet. */
    member_id: z.string().uuid().optional(),
    /** Or a person who is not in the household yet, named here. */
    display_name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().toLowerCase().email().max(254),
    role: z.enum(ROLES),
    expires_in_days: z.number().int().min(1).max(30).optional(),
  })
  .strict();

export const inviteBody = inviteFields.refine(
  (b) => Boolean(b.member_id) !== Boolean(b.display_name),
  { message: 'Say who this is for: either an existing person or a name.' },
);

/** `POST /members/{id}/invite`, where the person is already named by the path. */
export const inviteExistingBody = inviteFields.omit({ member_id: true, display_name: true });

export const acceptBody = z.object({
  code: z.string().trim().min(1).max(32),
  password: z.string().min(10, 'Use at least 10 characters.').max(1024),
});

export interface InvitationView {
  id: string;
  member_id: string;
  display_name: string;
  email: string;
  role: Role;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  state: 'pending' | 'accepted' | 'revoked' | 'expired' | 'locked';
  attempts_left: number;
}

/** What the invitee sees before they have signed in to anything. */
export interface InvitationPreview {
  household_name: string;
  display_name: string;
  email: string;
  role: Role;
  role_label: string;
  invited_by: string | null;
  expires_at: string;
}

export interface CreatedInvitation {
  invitation: InvitationView;
  /** Shown once, to be passed along. Never stored, so never shown again. */
  link_token: string;
  code: string;
}

export function newCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[(bytes[i] as number) % CODE_ALPHABET.length];
    if (i === 3) out += '-';
  }
  return out;
}

/** Forgives the things a person does when typing a code off a note. */
export function normaliseCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest();

const gone = () =>
  new ApiError(
    404,
    'invitation_not_valid',
    'That invitation link is not valid any more. Ask whoever invited you to send a new one.',
  );

export class InvitationService {
  constructor(
    private readonly db: Db,
    private readonly keys: ScopeKeys,
    private readonly auth: AuthService,
  ) {}

  // ------------------------------------------------------------- inviting

  async create(
    p: Principal,
    input: z.infer<typeof inviteBody>,
    meta: RequestMeta,
  ): Promise<CreatedInvitation> {
    const capability = capabilityToInvite(input.role);
    if (!can(p.role, capability)) {
      throw new ApiError(403, 'forbidden', refusalFor(capability));
    }

    // An account is global, so this is asked outside the household scope.
    const existing = await this.db
      .selectFrom('account')
      .select(['id'])
      .where('email', '=', input.email)
      .executeTakeFirst();
    if (existing) {
      throw new ApiError(
        409,
        'email_in_use',
        'That email address already has a sign-in here. They can sign in with it instead.',
      );
    }

    const token = randomBytes(32).toString('base64url');
    const code = newCode();
    const codeHash = await argon2.hash(normaliseCode(code), ARGON2);
    const expiresAt = new Date(
      Date.now() + (input.expires_in_days ?? DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000,
    );

    const id = await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const memberId = input.member_id
        ? await this.existingMember(trx, input.member_id)
        : await this.newMember(trx, p, input.display_name as string, meta);

      // Replacing a live invitation is what "send another one" means; the
      // partial unique index would otherwise refuse the insert.
      await trx
        .updateTable('invitation')
        .set({ revoked_at: new Date(), revoked_by: p.accountId })
        .where('member_id', '=', memberId)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .execute();

      const row = await trx
        .insertInto('invitation')
        .values({
          household_id: p.householdId,
          member_id: memberId,
          email: input.email,
          role: input.role,
          token_hash: hashToken(token),
          code_hash: codeHash,
          invited_by: p.accountId,
          expires_at: expiresAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'invitation.created',
        objectType: 'invitation',
        objectId: row.id,
        // No token, no code, no hash of either: the audit log is readable
        // by every adult, and an invitation is a way in.
        detail: { email: input.email, role: input.role, member_id: memberId },
        ip: meta.ip,
      });
      return row.id;
    });

    const invitation = (await this.list(p)).find((i) => i.id === id) as InvitationView;
    return { invitation, link_token: token, code };
  }

  private async existingMember(trx: Db, memberId: string): Promise<string> {
    const member = await trx
      .selectFrom('member')
      .select(['id', 'display_name'])
      .where('id', '=', memberId)
      .executeTakeFirst();
    if (!member) throw notFound('That person');
    const held = await trx
      .selectFrom('account_household')
      .select(['account_id'])
      .where('member_id', '=', memberId)
      .executeTakeFirst();
    if (held) {
      throw new ApiError(409, 'already_signed_in', 'That person already has a sign-in.');
    }
    await this.mustNeverHaveSignedIn(trx, memberId, member.display_name);
    return member.id;
  }

  /**
   * Somebody who has had a sign-in has private documents locked to their
   * own password. An invitation for them would be a way into those for
   * whoever holds its link and code — and whoever makes an invitation
   * holds both. So they are never invited again; an owner gives the old
   * sign-in back instead (`POST /members/{id}/sign-in`).
   *
   * Checked when an invitation is made and again when one is accepted,
   * because an invitation made before 0.4.2 may still be waiting.
   */
  private async mustNeverHaveSignedIn(trx: Db, memberId: string, name: string): Promise<void> {
    const key = await trx
      .selectFrom('scope_key')
      .select(['key_wrapped_cred'])
      .where('kind', '=', 'member')
      .where('member_id', '=', memberId)
      .executeTakeFirst();
    if (key?.key_wrapped_cred) {
      throw new ApiError(
        409,
        'had_sign_in',
        `${name} has had their own sign-in, and their private documents are locked to it, so they cannot be invited as somebody new. An owner can give them their sign-in back from their page.`,
      );
    }
  }

  private async newMember(
    trx: Db,
    p: Principal,
    displayName: string,
    meta: RequestMeta,
  ): Promise<string> {
    const n = await trx
      .selectFrom('member')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    const row = await trx
      .insertInto('member')
      .values({
        household_id: p.householdId,
        display_name: displayName,
        colour: Number(n.n) % 8,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Their private scope key exists from the moment they do, with no
    // credential wrap until they choose a password (data model §8).
    await this.keys.mintMemberKey(trx, p.householdId, row.id, null);
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'member.added',
      objectType: 'member',
      objectId: row.id,
      detail: { display_name: displayName, via: 'invitation' },
      ip: meta.ip,
    });
    return row.id;
  }

  async list(p: Principal): Promise<InvitationView[]> {
    if (!can(p.role, 'member.invite')) {
      throw new ApiError(403, 'forbidden', refusalFor('member.invite'));
    }
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const rows = await trx
        .selectFrom('invitation')
        .innerJoin('member', 'member.id', 'invitation.member_id')
        .leftJoin('account_household as inviter', (j) =>
          j
            .onRef('inviter.account_id', '=', 'invitation.invited_by')
            .onRef('inviter.household_id', '=', 'invitation.household_id'),
        )
        .leftJoin('member as inviter_member', 'inviter_member.id', 'inviter.member_id')
        .select([
          'invitation.id',
          'invitation.member_id',
          'invitation.email',
          'invitation.role',
          'invitation.attempts',
          'invitation.created_at',
          'invitation.expires_at',
          'invitation.accepted_at',
          'invitation.revoked_at',
          'member.display_name',
          'inviter_member.display_name as invited_by',
        ])
        .orderBy('invitation.created_at', 'desc')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        member_id: r.member_id,
        display_name: r.display_name,
        email: r.email,
        role: r.role,
        invited_by: r.invited_by,
        created_at: r.created_at.toISOString(),
        expires_at: r.expires_at.toISOString(),
        state: stateOf(r),
        attempts_left: Math.max(0, MAX_ATTEMPTS - r.attempts),
      }));
    });
  }

  async revoke(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    if (!can(p.role, 'member.invite')) {
      throw new ApiError(403, 'forbidden', refusalFor('member.invite'));
    }
    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await trx
        .updateTable('invitation')
        .set({ revoked_at: new Date(), revoked_by: p.accountId })
        .where('id', '=', id)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .returning(['id', 'email'])
        .executeTakeFirst();
      if (!row) throw notFound('That invitation');
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'invitation.revoked',
        objectType: 'invitation',
        objectId: row.id,
        detail: { email: row.email },
        ip: meta.ip,
      });
    });
  }

  // ------------------------------------------------------------ accepting

  /**
   * Finds the household a link belongs to, before any scope is set. This
   * is the one query that cannot run under row-level security, so it is a
   * security-definer function that answers nothing but the household id.
   */
  private async householdOf(token: string): Promise<string> {
    const r = await sql<{ id: string | null }>`
      select invitation_household(${hashToken(token)}) as id
    `.execute(this.db);
    const id = r.rows[0]?.id;
    if (!id) throw gone();
    return id;
  }

  /** What an invitee is shown before they commit to anything. */
  async preview(token: string): Promise<InvitationPreview> {
    const householdId = await this.householdOf(token);
    return withScope(this.db, { householdId }, async (trx) => {
      const row = await this.live(trx, token);
      const household = await trx
        .selectFrom('household')
        .select(['name'])
        .where('id', '=', householdId)
        .executeTakeFirstOrThrow();
      const member = await trx
        .selectFrom('member')
        .select(['display_name'])
        .where('id', '=', row.member_id)
        .executeTakeFirstOrThrow();
      const inviter = await trx
        .selectFrom('account_household')
        .innerJoin('member', 'member.id', 'account_household.member_id')
        .select(['member.display_name'])
        .where('account_household.account_id', '=', row.invited_by)
        .executeTakeFirst();
      return {
        household_name: household.name,
        display_name: member.display_name,
        email: row.email,
        role: row.role,
        role_label: roleLabel(row.role),
        invited_by: inviter?.display_name ?? null,
        expires_at: row.expires_at.toISOString(),
      };
    });
  }

  /**
   * Turns a link, a code and a chosen password into a signed-in account.
   * Everything that makes the person real happens in one transaction: the
   * account, the membership, the credential wrap on their own scope key.
   */
  async accept(
    token: string,
    input: z.infer<typeof acceptBody>,
    meta: RequestMeta,
  ): Promise<Tokens> {
    const householdId = await this.householdOf(token);

    // The attempt counter has to survive the failure it is counting, so a
    // wrong code is recorded in its own transaction and thrown afterwards.
    const invitationId = await withScope(
      this.db,
      { householdId },
      async (trx) => (await this.live(trx, token)).id,
    );
    const stored = await withScope(this.db, { householdId }, (trx) =>
      trx
        .selectFrom('invitation')
        .select(['code_hash'])
        .where('id', '=', invitationId)
        .executeTakeFirstOrThrow(),
    );
    if (!(await argon2.verify(stored.code_hash, normaliseCode(input.code)))) {
      const left = await withScope(this.db, { householdId }, async (trx) => {
        const row = await trx
          .updateTable('invitation')
          .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
          .where('id', '=', invitationId)
          .returning('attempts')
          .executeTakeFirstOrThrow();
        return MAX_ATTEMPTS - row.attempts;
      });
      throw new ApiError(
        401,
        'invitation_code_wrong',
        left > 0
          ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
          : 'That code was wrong too many times. Ask whoever invited you for a new invitation.',
      );
    }

    const accountId = await withScope(this.db, { householdId }, async (trx) => {
      // Read it again inside the writing transaction: between the check and
      // here, somebody may have revoked it.
      const row = await this.live(trx, token);
      const member = await trx
        .selectFrom('member')
        .select(['display_name'])
        .where('id', '=', row.member_id)
        .executeTakeFirstOrThrow();
      await this.mustNeverHaveSignedIn(trx, row.member_id, member.display_name);
      const passwordHash = await argon2.hash(input.password, ARGON2);
      const account = await trx
        .insertInto('account')
        .values({ email: row.email, password_hash: passwordHash })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('account_household')
        .values({
          account_id: account.id,
          household_id: householdId,
          member_id: row.member_id,
          role: row.role,
        })
        .execute();
      // Their private documents can now be reached with what they know,
      // not only with what the server holds.
      await this.keys.attachCredential(
        trx,
        { householdId, kind: 'member', memberId: row.member_id },
        input.password,
      );
      await trx
        .updateTable('invitation')
        .set({ accepted_at: new Date(), accepted_by: account.id })
        .where('id', '=', row.id)
        .execute();
      await appendAudit(trx, {
        householdId,
        actorAccountId: account.id,
        action: 'invitation.accepted',
        objectType: 'invitation',
        objectId: row.id,
        detail: { email: row.email, role: row.role, member_id: row.member_id },
        ip: meta.ip,
      });
      return account.id;
    });

    return this.auth.openSessionForAccount(accountId, meta, 'invitation');
  }

  /** The invitation behind a token, or the one refusal all failures share. */
  private async live(trx: Db, token: string) {
    const row = await trx
      .selectFrom('invitation')
      .selectAll()
      .where('token_hash', '=', hashToken(token))
      .executeTakeFirst();
    if (!row) throw gone();
    if (row.accepted_at || row.revoked_at) throw gone();
    if (row.expires_at.getTime() < Date.now()) throw gone();
    if (row.attempts >= MAX_ATTEMPTS) throw gone();
    return row;
  }
}

function stateOf(r: {
  accepted_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
  attempts: number;
}): InvitationView['state'] {
  if (r.accepted_at) return 'accepted';
  if (r.revoked_at) return 'revoked';
  if (r.attempts >= MAX_ATTEMPTS) return 'locked';
  if (r.expires_at.getTime() < Date.now()) return 'expired';
  return 'pending';
}
