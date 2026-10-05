import { createHash, randomBytes } from 'node:crypto';
import type { ScopeKeys } from '@fdv/crypto';
import { ANONYMOUS, appendAudit, withPrincipal, withScope, withSystem, type Db } from '@fdv/db';
import {
  can,
  capabilityToInvite,
  DECEASED_NO_SIGN_IN,
  GUEST_DESCRIPTION_MAX,
  guestAccessEnded,
  guestEndProblem,
  mayBeRestricted,
  refusalFor,
  roleLabel,
  ROLES,
  type MemberKind,
  type Role,
} from '@fdv/shared';
import argon2 from 'argon2';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AuthService, Principal, RequestMeta, Tokens } from '../auth/service.js';
import { ApiError, notFound } from '../errors.js';
import {
  accessGrantBody,
  ADULTS_ONLY_OWNERS,
  checkGrant,
  grantOf,
  isRestricted,
  limitsAfter,
  restrictedRefusal,
  writeGrant,
} from './restrictions.js';

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
    /**
     * What a viewer will see once they accept (5.33): applied in the same
     * transaction that makes their sign-in. An adult inviting a viewer must
     * give one, without Adults only documents (A27); an owner may give one,
     * or none. A viewer's alone.
     */
    restriction: accessGrantBody.nullable().optional(),
    /**
     * Someone outside the family (5.34): a guest is always a viewer, always
     * given a `restriction`, and their sign-in ends at `access_expires_at`,
     * within a year (A28). The family's when left out.
     */
    kind: z.enum(['family', 'guest']).optional(),
    access_expires_at: z.string().datetime({ offset: true }).optional(),
    /**
     * Somebody new's relationship to the family — for a guest, what they
     * are to it: "attorney", "the family's accountant", which the activity
     * log names them with ("Guest — Jane Smith, attorney").
     */
    relationship: z.string().trim().max(GUEST_DESCRIPTION_MAX).nullable().optional(),
  })
  .strict();

export const inviteBody = inviteFields.refine(
  (b) => Boolean(b.member_id) !== Boolean(b.display_name),
  { message: 'Say who this is for: either an existing person or a name.' },
);

/** `POST /members/{id}/invite`, where the person is already named by the path. */
export const inviteExistingBody = inviteFields.omit({
  member_id: true,
  display_name: true,
  relationship: true,
});

export const acceptBody = z.object({
  code: z.string().trim().min(1).max(32),
  password: z.string().min(10, 'Use at least 10 characters.').max(1024),
  /**
   * The address the person will sign in with, chosen by them. Password
   * resets go to it, so it must be theirs and not whoever typed the
   * invitation's — who could otherwise reset their password later and read
   * their private documents. Defaults to the address it was sent to.
   */
  email: z.string().trim().toLowerCase().email().max(254).optional(),
});

/** An invitation link's secret: base64url of 32 bytes. */
const linkToken = z.string().min(16).max(256);

/**
 * What the page sends to show whose vault this is (5.17): the token it read
 * from the link's fragment, in a body — never in a path, where a proxy on
 * the way would see it.
 */
export const lookupBody = z.object({ token: linkToken }).strict();

/** Accepting (5.17): the token in the body, beside the code and the password. */
export const acceptByBody = acceptBody.extend({ token: linkToken });

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
  /** A viewer's invitation that limits what they will see (5.33). */
  limited: boolean;
  /** A guest's (5.34): always a viewer's, limited, with an end. */
  kind: MemberKind;
  /** When the guest's sign-in will end once accepted; null for the family's. */
  access_expires_at: string | null;
}

/**
 * An invitation's limits as kept (0055): the grant as it was checked when
 * the invitation was made, and whether an owner made it — an owner's
 * replaces limits an owner set before; an adult's never does.
 */
interface StoredLimits {
  people: string[];
  types: string[];
  collections: string[];
  include_adults_only: boolean;
  include_no_person_docs: boolean;
  expires_at: string | null;
  by_owner: boolean;
  /** Whether it names people, or kinds, at all (the 5.33 review); absent before, as the lists say. */
  limits_people?: boolean;
  limits_types?: boolean;
}

/** What accepting does with an invitation's limits, decided before the sign-in is made. */
type LimitsPlan = { limits: StoredLimits; exists: boolean } | null;

/** Said to an adult inviting a viewer with no limits (A27). */
export const LIMITS_REQUIRED =
  'Only an owner can invite a viewer who sees every family document. Choose what they can see.';

/** What the invitee sees before they have signed in to anything. */
export interface InvitationPreview {
  household_name: string;
  display_name: string;
  email: string;
  role: Role;
  role_label: string;
  invited_by: string | null;
  expires_at: string;
  /** A guest's (5.34): from outside the family, until `access_expires_at`. */
  kind: MemberKind;
  access_expires_at: string | null;
}

/**
 * What an invitation asks of an owner beyond the ordinary step-up (5.34,
 * A27, A54): a passkey or a code, never the password — the route's
 * `requireOwnerPower(p, 'limit_access')`. Asked when the invitation decides
 * what a viewer sees as only an owner may: a viewer who sees every family
 * document, Adults only documents for a viewer or a guest, or limits that
 * would replace those already set on that person (the 5.33 review, S533-02).
 */
export interface InviteOptions {
  ownerDecides?: () => Promise<void>;
}

/** Said to an adult inviting somebody an owner gave Adults only documents (the 5.34 review). */
export const OWNER_GAVE_ADULTS_ONLY =
  'An owner gave them Adults only documents, so only an owner can invite them.';

/** Said to whoever accepts an adult's invitation that would keep an owner's Adults only grant. */
export const OWNER_NEEDED =
  'This invitation cannot be accepted as it is. Ask an owner of the family to invite you.';

/** Said of a guest who has had a sign-in (the 5.34 review, S534-01). */
export const GUEST_HAD_SIGN_IN = (name: string) =>
  `${name} has had a sign-in here. An owner can give it back, with a new end, from People outside the family; or invite them by their name as somebody new.`;

/** Whether an owner gave somebody Adults only documents (0056): asked as the vault, which reads it. */
async function givenAdultsOnly(trx: Db, memberId: string): Promise<boolean> {
  const r = await sql<{
    given: boolean;
  }>`select member_given_adults_only(${memberId}) as given`.execute(trx);
  return r.rows[0]?.given === true;
}

/** Said of a guest's invitation that names nothing they may see (A27). */
export const GUEST_LIMITS_REQUIRED =
  'A guest is always limited to what they are given. Choose what they can see.';

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

  /**
   * Whether this invitation is an owner's decision about what a viewer sees
   * (5.34; its review, W534-02), asked before anything else so that the
   * route asks once — for a passkey or a code, which serves the ordinary
   * step-up too — and not the password first and the factor after. The
   * same refusals as `create`, in its order, come first. `create` asks
   * again, under its locks, and is what decides.
   */
  async asksOwnerDecision(p: Principal, input: z.infer<typeof inviteBody>): Promise<boolean> {
    const { decides, limits } = this.validate(p, input);
    if (decides) return true;
    if (p.role !== 'owner' || !limits || !input.member_id) return false;
    // Limits replacing those already set on the person (S533-02).
    const had = await withPrincipal(this.db, p, (trx) =>
      trx
        .selectFrom('access_restriction')
        .select('member_id')
        .where('member_id', '=', input.member_id as string)
        .executeTakeFirst(),
    );
    return had !== undefined;
  }

  /**
   * What an invitation asks before the database is asked anything: who may
   * invite for the role; a guest's own rules (a viewer, limited, an end
   * within a year); an adult's viewer limited and without Adults only
   * documents (A27). And whether it is an owner's decision about what a
   * viewer sees (A27, D6, A54): a viewer who sees every family document,
   * Adults only documents for a viewer or a guest, or — the lead's decision
   * on the 5.34 review — any guest an owner invites.
   */
  private validate(
    p: Principal,
    input: z.infer<typeof inviteBody>,
  ): {
    kind: MemberKind;
    accessEnd: Date | null;
    limits: z.infer<typeof accessGrantBody> | null;
    decides: boolean;
  } {
    const capability = capabilityToInvite(input.role);
    if (!can(p.role, capability)) {
      throw new ApiError(403, 'forbidden', refusalFor(capability));
    }
    // Someone outside the family (5.34): a viewer, always limited, with an
    // end within a year (A28). Nobody of the family has an end.
    const kind: MemberKind = input.kind ?? 'family';
    let accessEnd: Date | null = null;
    if (kind === 'guest') {
      if (input.role !== 'viewer') {
        throw new ApiError(422, 'validation_failed', 'A guest is always a viewer.', {
          detail: 'role',
        });
      }
      if (!input.restriction) {
        throw new ApiError(422, 'validation_failed', GUEST_LIMITS_REQUIRED, {
          detail: 'restriction',
        });
      }
      if (!input.access_expires_at) {
        throw new ApiError(422, 'validation_failed', 'Choose the day their access ends.', {
          detail: 'access_expires_at',
        });
      }
      accessEnd = new Date(input.access_expires_at);
      const problem = guestEndProblem(accessEnd);
      if (problem) {
        throw new ApiError(422, 'validation_failed', problem, { detail: 'access_expires_at' });
      }
    } else if (input.access_expires_at) {
      throw new ApiError(
        422,
        'validation_failed',
        'Only a guest’s access ends on a day. Somebody of the family keeps theirs.',
        { detail: 'access_expires_at' },
      );
    }
    // Who somebody is to the family is said as they are made; after that,
    // on their page.
    if (input.relationship && input.member_id) {
      throw new ApiError(422, 'validation_failed', 'Change who they are on their page.', {
        detail: 'relationship',
      });
    }
    // What a viewer will see (5.33): a viewer's alone; an adult's must say
    // (A27), and only an owner may give Adults only documents (D6).
    const limits = input.restriction ?? null;
    if (limits && input.role !== 'viewer') {
      throw new ApiError(
        422,
        'validation_failed',
        'Only a viewer can be limited to some documents.',
        {
          detail: 'restriction',
        },
      );
    }
    if (input.role === 'viewer' && p.role !== 'owner') {
      if (!limits) throw new ApiError(403, 'forbidden', LIMITS_REQUIRED);
      if (limits.include_adults_only) throw new ApiError(403, 'forbidden', ADULTS_ONLY_OWNERS);
    }
    const decides =
      input.role === 'viewer' &&
      (!limits || limits.include_adults_only || (kind === 'guest' && p.role === 'owner'));
    return { kind, accessEnd, limits, decides };
  }

  async create(
    p: Principal,
    input: z.infer<typeof inviteBody>,
    meta: RequestMeta,
    opts: InviteOptions = {},
  ): Promise<CreatedInvitation> {
    const { kind, accessEnd, limits, decides } = this.validate(p, input);
    // An owner's decision (A27, D6, A54): a viewer who sees every family
    // document, Adults only documents for a viewer or a guest, and any guest
    // an owner invites, ask for a passkey or a code — never the password —
    // and an owner with neither is refused it (5.34).
    if (decides) await opts.ownerDecides?.();

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

    const id = await withPrincipal(this.db, p, async (trx) => {
      const memberId = input.member_id
        ? await this.existingMember(trx, input.member_id, kind)
        : await this.newMember(trx, p, input.display_name as string, meta, {
            kind,
            relationship: input.relationship ?? null,
          });
      // Somebody restricted is invited as a viewer or not at all (the 5.32
      // review): accepting it would give them a role their restriction never
      // stands beside, and the database refuses that as it is accepted. An
      // owner, who reads every restriction, is told now.
      if (input.member_id && !mayBeRestricted(input.role) && (await isRestricted(trx, memberId))) {
        throw restrictedRefusal(null);
      }
      // An adult's invitation keeps the limits an owner set on the person
      // (limitsPlan), so it never brings back Adults only documents an owner
      // gave them: only an owner invites them (A27, D6; the 5.34 review,
      // S534-01). Asked again as it is accepted.
      if (input.member_id && p.role !== 'owner' && (await givenAdultsOnly(trx, memberId))) {
        throw new ApiError(403, 'forbidden', OWNER_GAVE_ADULTS_ONLY);
      }
      // The limits, checked as the inviter sees the family: people, kinds
      // and collections they may see, and only a collection for Everyone (A17).
      // Whether people, and kinds, are named follows the rule a PUT and the
      // preview follow: an empty list keeps what the person's limits say now
      // (which an owner reads; anybody else, none), unless the body says
      // otherwise (the 5.33 second round, N533A-01).
      const had =
        limits && input.member_id
          ? await trx
              .selectFrom('access_restriction')
              .select(['limits_people', 'limits_types'])
              .where('member_id', '=', memberId)
              .executeTakeFirst()
          : undefined;
      // An owner's limits replace those already set on the person as they
      // accept (limitsPlan): a change of what they see, asked as a PUT of
      // their limits is — a passkey or a code (the 5.33 review, S533-02).
      // An adult's never replace them, and an owner reads every restriction.
      if (had && p.role === 'owner') await opts.ownerDecides?.();
      const stored: StoredLimits | null = limits
        ? await checkGrant(trx, grantOf(limits)).then((g) => ({
            people: g.people,
            types: g.types,
            collections: g.collections,
            include_adults_only: g.include_adults_only,
            include_no_person_docs: g.include_no_person_docs,
            expires_at: g.expires_at?.toISOString() ?? null,
            by_owner: p.role === 'owner',
            limits_people: limitsAfter(g.people, g.limits_people, had?.limits_people),
            limits_types: limitsAfter(g.types, g.limits_types, had?.limits_types),
          }))
        : null;

      // Replacing a live invitation is what "send another one" means; the
      // partial unique index would otherwise refuse the insert. But only its
      // maker or an owner may: otherwise any adult could quietly swap an
      // owner's invitation for one of their own and accept it themselves.
      const pending = await trx
        .selectFrom('invitation')
        .select(['invited_by'])
        .where('member_id', '=', memberId)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (pending && pending.invited_by !== p.accountId && p.role !== 'owner') {
        throw new ApiError(
          409,
          'already_invited',
          'Somebody else has already invited this person. Ask them, or an owner, to send it again.',
        );
      }
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
          restriction: stored ? JSON.stringify(stored) : null,
          kind,
          access_expires_at: accessEnd,
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
        detail: {
          email: input.email,
          role: input.role,
          member_id: memberId,
          ...(stored ? { limited: true } : {}),
          ...(accessEnd ? { kind: 'guest', access_expires_at: accessEnd.toISOString() } : {}),
        },
        ip: meta.ip,
      });
      return row.id;
    });

    const invitation = (await this.list(p)).find((i) => i.id === id) as InvitationView;
    return { invitation, link_token: token, code };
  }

  private async existingMember(trx: Db, memberId: string, kind: MemberKind): Promise<string> {
    const member = await trx
      .selectFrom('member')
      .select(['id', 'display_name', 'is_deceased', 'kind'])
      .where('id', '=', memberId)
      .executeTakeFirst();
    if (!member) throw notFound('That person');
    // Nobody signs in as somebody who has passed away (5.25).
    if (member.is_deceased) throw passedAway(member.display_name);
    // Of the family or a guest, as they were made (5.34): never the other.
    if (member.kind === 'guest' && kind !== 'guest') {
      throw new ApiError(
        409,
        'guest',
        `${member.display_name} is from outside the family. Invite them as a guest.`,
      );
    }
    if (member.kind !== 'guest' && kind === 'guest') {
      throw new ApiError(
        409,
        'not_a_guest',
        `${member.display_name} is of the family. A guest is somebody from outside it: invite them by their name.`,
      );
    }
    const held = await trx
      .selectFrom('account_household')
      .select(['account_id'])
      .where('member_id', '=', memberId)
      .executeTakeFirst();
    if (held) throw alreadySignedIn();
    await this.mustNeverHaveSignedIn(trx, memberId, member.display_name);
    // Held before any invitation is, as accepting one and recording a
    // passing hold the person first (the 5.25 review): one order everywhere,
    // the person, then their invitations, then the log. Read again once
    // held, so a passing or a sign-in made meanwhile is seen. The database's
    // rule for changing a person gives no row to a hold it would refuse —
    // an adult's, once the person has a sign-in.
    const now = await trx
      .selectFrom('member')
      .select(['is_deceased'])
      .where('id', '=', member.id)
      .forKeyShare()
      .executeTakeFirst();
    if (!now) throw alreadySignedIn();
    if (now.is_deceased) throw passedAway(member.display_name);
    const signedIn = await trx
      .selectFrom('account_household')
      .select(['account_id'])
      .where('member_id', '=', member.id)
      .executeTakeFirst();
    if (signedIn) throw alreadySignedIn();
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
    // A guest has no member key and owns nothing (0056), so what else says
    // they had a sign-in: one taken away (former_account_id), or any
    // invitation of theirs accepted (the 5.34 review, S534-01). Giving it
    // back is an owner's, with a new end (POST /members/{id}/sign-in,
    // renew_guest); inviting them again as somebody new is by their name.
    const person = await trx
      .selectFrom('member')
      .select(['kind', 'former_account_id'])
      .where('id', '=', memberId)
      .executeTakeFirst();
    const accepted = await trx
      .selectFrom('invitation')
      .select('id')
      .where('member_id', '=', memberId)
      .where('accepted_at', 'is not', null)
      .executeTakeFirst();
    if (person?.kind === 'guest' && (person.former_account_id !== null || accepted)) {
      throw new ApiError(409, 'had_sign_in', GUEST_HAD_SIGN_IN(name));
    }
    const key = await trx
      .selectFrom('scope_key')
      .select(['key_wrapped_cred'])
      .where('kind', '=', 'member')
      .where('member_id', '=', memberId)
      .executeTakeFirst();
    const owned = await trx
      .selectFrom('document')
      .select('id')
      .where('owner_member_id', '=', memberId)
      .where('visibility', '=', 'private')
      .executeTakeFirst();
    if (key?.key_wrapped_cred || owned) {
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
    how: { kind: MemberKind; relationship: string | null },
  ): Promise<string> {
    // A colour of the family's: a guest is not counted among them (5.34).
    const n = await trx
      .selectFrom('member')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('kind', '=', 'family')
      .executeTakeFirstOrThrow();
    const row = await trx
      .insertInto('member')
      .values({
        household_id: p.householdId,
        display_name: displayName,
        colour: Number(n.n) % 8,
        kind: how.kind,
        relationship: how.relationship || null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Their private scope key exists from the moment they do, with no
    // credential wrap until they choose a password (data model §8). A
    // guest has none (5.34): they own no document, so nothing of theirs is
    // private, and the database refuses one for them (0056).
    if (how.kind === 'family') {
      await this.keys.mintMemberKey(trx, p.householdId, row.id, null);
    }
    await appendAudit(trx, {
      householdId: p.householdId,
      actorAccountId: p.accountId,
      action: 'member.added',
      objectType: 'member',
      objectId: row.id,
      detail: {
        display_name: displayName,
        via: 'invitation',
        ...(how.kind === 'guest' ? { kind: 'guest' } : {}),
      },
      ip: meta.ip,
    });
    return row.id;
  }

  async list(p: Principal): Promise<InvitationView[]> {
    if (!can(p.role, 'member.invite')) {
      throw new ApiError(403, 'forbidden', refusalFor('member.invite'));
    }
    return withPrincipal(this.db, p, async (trx) => {
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
          sql<boolean>`invitation.restriction is not null`.as('limited'),
          'invitation.kind',
          'invitation.access_expires_at',
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
        limited: r.limited,
        kind: r.kind,
        access_expires_at: r.access_expires_at?.toISOString() ?? null,
      }));
    });
  }

  async revoke(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    if (!can(p.role, 'member.invite')) {
      throw new ApiError(403, 'forbidden', refusalFor('member.invite'));
    }
    await withPrincipal(this.db, p, async (trx) => {
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

  /**
   * What an invitee is shown before they commit to anything. The link alone
   * is not the invitation — the code is the other half — so the address it
   * was sent to is shown masked (5.3): a forwarded link tells its reader
   * the family's name, not somebody's email.
   */
  async preview(token: string): Promise<InvitationPreview> {
    const householdId = await this.householdOf(token);
    return withScope(this.db, { householdId, actor: ANONYMOUS }, async (trx) => {
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
        email: maskedEmail(row.email),
        role: row.role,
        role_label: roleLabel(row.role),
        invited_by: inviter?.display_name ?? null,
        expires_at: row.expires_at.toISOString(),
        kind: row.kind,
        access_expires_at: row.access_expires_at?.toISOString() ?? null,
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
    // The invitee is nobody the vault knows yet: the account this makes is
    // not the one asking.
    const scope = { householdId, actor: ANONYMOUS };

    // One try of the code (5.17 review, as a share link's PIN since 5.16).
    // The try is reserved before the code is checked — `attempts + 1 where
    // attempts < 5`, which takes the row — so tries made at the same moment,
    // by either way in, queue behind it, and no more than five are ever made
    // however many arrive at once. Until then each one read the count, and
    // twenty at once were twenty tries. A right code gives its try back (the
    // reservation is rolled back to its savepoint, which also lets the next
    // try in), so a refusal after it — an address taken, say — costs none. A
    // wrong one keeps it: the count has to survive the failure it is
    // counting, so the transaction commits and the refusal is thrown after.
    const left = await withScope(this.db, scope, async (trx) => {
      const { id, code_hash } = await this.live(trx, token);
      await sql`savepoint fdv_code_attempt`.execute(trx);
      const reserved = await trx
        .updateTable('invitation')
        .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
        .where('id', '=', id)
        .where('attempts', '<', MAX_ATTEMPTS)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .returning('attempts')
        .executeTakeFirst();
      // Used up, taken or taken back while this one waited: the one refusal.
      if (!reserved) throw gone();
      if (await argon2.verify(code_hash, normaliseCode(input.code))) {
        await sql`rollback to savepoint fdv_code_attempt`.execute(trx);
        return null;
      }
      await sql`release savepoint fdv_code_attempt`.execute(trx);
      return MAX_ATTEMPTS - reserved.attempts;
    });
    if (left !== null) {
      throw new ApiError(
        401,
        'invitation_code_wrong',
        left > 0
          ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
          : 'That code was wrong too many times. Ask whoever invited you for a new invitation.',
      );
    }

    // As the vault itself: whether this person owns private documents is
    // asked of documents no anonymous caller may see, and a check that saw
    // none would always pass.
    const accountId = await withSystem(this.db, householdId, async (trx) => {
      // Read it again inside the writing transaction: between the check and
      // here, somebody may have revoked it.
      const invited = await this.live(trx, token);
      // The person, held: a passing recorded at the same moment (5.25) is
      // waited for, and seen — and so is the invitation it takes back.
      const member = await trx
        .selectFrom('member')
        .select(['display_name', 'is_deceased', 'kind'])
        .where('id', '=', invited.member_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const row = await this.live(trx, token);
      if (member.is_deceased) throw passedAway(member.display_name);
      // A guest's invitation is a guest's (5.34), and gives a sign-in only
      // while what it gives has not ended.
      if (row.kind !== member.kind) throw gone();
      const guest = row.kind === 'guest';
      if (guest && (!row.access_expires_at || guestAccessEnded(row.access_expires_at))) {
        throw new ApiError(
          409,
          'access_ended',
          'The access this invitation gives has already ended. Ask whoever invited you for a new one.',
        );
      }
      await this.mustNeverHaveSignedIn(trx, row.member_id, member.display_name);
      const passwordHash = await argon2.hash(input.password, ARGON2);
      const email = input.email ?? row.email;
      const taken = await trx
        .selectFrom('account')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();
      if (taken) {
        throw new ApiError(
          409,
          'email_taken',
          'That address already has a sign-in here. Choose another one.',
        );
      }
      const account = await trx
        .insertInto('account')
        .values({ email, password_hash: passwordHash })
        .returning('id')
        .executeTakeFirstOrThrow();
      // Whether the invitation's limits are to be applied, decided on the
      // restriction as it is before the sign-in exists (which asks the
      // owners to confirm any it finds, 0054), and held: the person, then
      // their restriction, then the sign-in, then the log.
      const plan = await this.limitsPlan(trx, row);
      await trx
        .insertInto('account_household')
        .values({
          account_id: account.id,
          household_id: householdId,
          member_id: row.member_id,
          role: row.role,
          // A guest's sign-in ends then (5.34, A28).
          access_expires_at: guest ? row.access_expires_at : null,
        })
        .execute();
      // Their limits (5.33), in this transaction: never a moment unrestricted.
      // A guest's sign-in without them would not commit (0056).
      await this.applyLimits(trx, householdId, row, plan, meta);
      // Their private documents can now be reached with what they know,
      // not only with what the server holds. A guest has no member key, and
      // nothing private to reach (5.34).
      if (!guest) {
        await this.keys.attachCredential(
          trx,
          { householdId, kind: 'member', memberId: row.member_id },
          input.password,
        );
      }
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
        detail: {
          email,
          ...(email !== row.email ? { invited_as: row.email } : {}),
          role: row.role,
          member_id: row.member_id,
          ...(guest ? { kind: 'guest' } : {}),
        },
        ip: meta.ip,
      });
      return account.id;
    });

    return this.auth.openSessionForAccount(accountId, meta, 'invitation');
  }

  /**
   * An invitation's limits, applied as it is accepted (5.33), as the vault
   * itself, in the transaction that makes the sign-in: a viewer is never
   * unrestricted for a moment. What it names is what is still there — a
   * person, kind or collection deleted since, or a collection no longer for
   * Everyone, is left out, and gives nothing (named, the rest still narrow).
   * An owner's replaces limits set before the invitation was made; limits
   * set after it, or any already there for an adult's, stay, and ask the
   * owners to confirm them (0054's reconfirm). Logged as made by whoever
   * invited them.
   */
  private async limitsPlan(
    trx: Db,
    row: { member_id: string; restriction: unknown; created_at: Date },
  ): Promise<LimitsPlan> {
    const limits = row.restriction as StoredLimits | null;
    if (!limits) return null;
    const existing = await trx
      .selectFrom('access_restriction')
      .select(['member_id', 'updated_at', 'include_adults_only'])
      .where('member_id', '=', row.member_id)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) return { limits, exists: false };
    // An adult's keeps what an owner set, so never Adults only documents an
    // owner gave: asked when it was made, and again now (the 5.34 review).
    if (!limits.by_owner && existing.include_adults_only) {
      throw new ApiError(409, 'owner_needed', OWNER_NEEDED);
    }
    // An adult's never replaces an owner's; an owner's only limits set
    // before the invitation was made — newer ones stay (the lead's
    // decision on the 5.33 review), and the owners are asked to confirm
    // them as for any sign-in given to somebody limited (0054).
    if (!limits.by_owner || existing.updated_at.getTime() >= row.created_at.getTime()) return null;
    return { limits, exists: true };
  }

  private async applyLimits(
    trx: Db,
    householdId: string,
    row: { member_id: string; invited_by: string },
    plan: LimitsPlan,
    meta: RequestMeta,
  ): Promise<void> {
    if (!plan) return;
    const { limits } = plan;
    const existing = plan.exists ? { member_id: row.member_id } : undefined;
    const people =
      limits.people.length > 0
        ? await trx.selectFrom('member').select('id').where('id', 'in', limits.people).execute()
        : [];
    const types =
      limits.types.length > 0
        ? await trx
            .selectFrom('document_type')
            .select('key')
            .where('key', 'in', limits.types)
            .execute()
        : [];
    const collections =
      limits.collections.length > 0
        ? await trx
            .selectFrom('doc_collection')
            .select('id')
            .where('id', 'in', limits.collections)
            .where('deleted_at', 'is', null)
            .where('audience', '=', 'everyone')
            .orderBy('id')
            .execute()
        : [];
    const grant = {
      people: people.map((m) => m.id),
      types: types.map((t) => t.key),
      collections: collections.map((c) => c.id),
      include_adults_only: limits.by_owner && limits.include_adults_only === true,
      include_no_person_docs: limits.include_no_person_docs === true,
      expires_at: limits.expires_at ? new Date(limits.expires_at) : null,
    };
    await writeGrant(trx, householdId, row.member_id, grant, {
      exists: existing !== undefined,
      // As the invitation named them: some deleted since still narrow.
      limits: {
        people: limits.limits_people ?? limits.people.length > 0,
        types: limits.limits_types ?? limits.types.length > 0,
      },
    });
    await appendAudit(trx, {
      householdId,
      actorAccountId: row.invited_by,
      action: existing ? 'access.changed' : 'access.restricted',
      objectType: 'member',
      objectId: row.member_id,
      detail: {
        people: limits.people.length,
        types: limits.types.length,
        collections: limits.collections.length,
        include_adults_only: grant.include_adults_only,
        include_no_person_docs: grant.include_no_person_docs,
        ...(grant.expires_at ? { expires_at: grant.expires_at.toISOString() } : {}),
        via: 'invitation',
        ...(existing ? { changed: true } : {}),
      },
      ip: meta.ip,
    });
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

const alreadySignedIn = () =>
  new ApiError(409, 'already_signed_in', 'That person already has a sign-in.');

/** Somebody recorded as passed away is not given a sign-in (5.25). */
const passedAway = (name: string) => new ApiError(409, 'passed_away', DECEASED_NO_SIGN_IN(name));

/** "j•••@example.com": enough for its owner to recognise, not enough to use (5.3). */
export function maskedEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at <= 0 ? '•••' : `${email[0]}•••${email.slice(at)}`;
}
