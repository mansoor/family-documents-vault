import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ANONYMOUS,
  appendAudit,
  householdZone,
  withPrincipal,
  withScope,
  withSystem,
  type Db,
} from '@fdv/db';
import {
  maskPhone,
  mayStepUpByText,
  PHONE_CODE_DIGITS,
  PHONE_CODE_MINUTES,
  PHONE_CODE_SENDS,
  PHONE_CODE_TRIES,
  shareEndWords,
  SMS_OWNER_NEEDS_FACTOR,
  textCodeText,
  type Role,
  type SmsKind,
  type TextCodePurpose,
  type TextCodeSent,
  type TextCodeSettings,
  type TextCodeSettingsInput,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { AlertRequest } from '../alert-job.js';
import { stillSignedIn, type Principal, type RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import type { SmsService } from './service.js';

/**
 * Codes by text to somebody's own number (0.9.0, SMS3): a second proof of
 * who they are when their password is reset, at sign-in, and when they
 * confirm it's them.
 *
 * Each is the person's own choice, off until they turn it on, and goes only
 * to their own confirmed number (member_phone, 0084) while the household's
 * texts are set up and a test passed. A text is the weakest second factor —
 * a SIM swap moves the number — so it is only ever in addition: an owner
 * turns it on for sign-in only beside a passkey or two-step sign-in, an
 * owner never confirms it's them with one, and none of the owner's powers
 * (A54) is ever served by one. A reset whose code cannot be texted goes on
 * as it would have without it, and the person's owners are told: nobody is
 * locked out by a phone that is off.
 *
 * A code is six digits, 10 minutes and 5 tries, used once, and only the
 * newest for its purpose works. It is kept as an HMAC under a key derived
 * from the master key (sms-code-hmac), never as itself, and only by the
 * vault: nobody else reads sms_code (0088). At most 3 go to a number, or to
 * an account, in 15 minutes, and 10 in a day.
 */

/** What the key a code is HMACed under is derived for. */
export const SMS_CODE_KEY_PURPOSE = 'sms-code-hmac';

/** What each purpose's text is counted as, in sms_message. */
const KIND: Record<TextCodePurpose, SmsKind> = {
  reset: 'reset_code',
  sign_in: 'sign_in_code',
  step_up: 'step_up_code',
};

/** What a code typed looks like once spaces and dashes are taken out. */
const CODE = new RegExp(`^[0-9]{${PHONE_CODE_DIGITS}}$`);

export const smsCodeExpired = () =>
  new ApiError(
    409,
    'sms_code_expired',
    'That code has ended. Ask for a new one, and type the newest.',
  );
export const smsCodeTooMany = () =>
  new ApiError(
    409,
    'sms_code_too_many',
    `That code was typed wrong ${PHONE_CODE_TRIES} times, so it no longer works. Ask for a new one.`,
  );
const wrong = (left: number) =>
  new ApiError(
    422,
    'sms_code_wrong',
    `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
  );
export const smsCodeNotOffered = () =>
  new ApiError(409, 'sms_code_not_offered', 'A code by text isn’t offered here.');

/** What the try's transaction found, said after it commits: a wrong try is kept. */
type Tried = 'right' | 'expired' | 'too_many' | { wrong: number };

/**
 * Whose a code would be, as the vault finds it: the person's newest
 * household, their own number there, and whether texts go now.
 */
interface Target {
  householdId: string;
  memberId: string;
  role: Role;
  /** Their number, as E.164; null when they have none. */
  number: string | null;
  confirmed: boolean;
  ready: boolean;
  signInText: boolean;
  resetText: boolean;
}

/** Whether a reset asks for a code by text: no, yes (and where), or it should but cannot. */
/** Why a code by text could not be asked for, in a word (`auth.text_code_skipped`). */
export type TextSkipped = 'no_number' | 'not_ready' | 'cap_reached' | 'not_sent';

/** Each, in plain words, as the owners are told it. */
const SKIPPED_WORDS: Record<TextSkipped, string> = {
  no_number: 'their mobile number isn’t confirmed now',
  not_ready: 'the household’s text messages aren’t set up and working now',
  cap_reached: 'this month’s texts have all been sent',
  not_sent: 'the phone that sends the household’s texts didn’t take it',
};

export type ResetText =
  { asks: false } | { asks: true; to: string } | { asks: false; cannot: 'no_number' | 'not_ready' };

export interface TextCodeOptions {
  /** The key a code is HMACed under (deriveKey(master, SMS_CODE_KEY_PURPOSE)). */
  codeKey?: Buffer;
  /** How a person's owners are told a reset went on without its code. */
  alert?: (a: AlertRequest) => Promise<void>;
}

export class TextCodeService {
  private readonly codeKey: Buffer;
  private readonly alert: (a: AlertRequest) => Promise<void>;

  constructor(
    private readonly db: Db,
    private readonly sms: SmsService,
    opts: TextCodeOptions = {},
  ) {
    this.codeKey = opts.codeKey ?? Buffer.alloc(32);
    this.alert = opts.alert ?? (async () => undefined);
  }

  /**
   * A code as the vault keeps it: an HMAC under its own key, over what it
   * is for, whose it is, the number, the code's own row and the code.
   */
  private codeHash(
    purpose: TextCodePurpose,
    accountId: string,
    number: string,
    codeId: string,
    code: string,
  ): Buffer {
    return createHmac('sha256', this.codeKey)
      .update(`${purpose}:${accountId}:${number}:${codeId}:${code}`)
      .digest();
  }

  // ------------------------------------------------------------ reading

  /**
   * The person's newest household, their number there and whether the
   * household's texts go now. Their membership is read as the account, as a
   * sign-in reads it; their number and the household's readiness as the
   * vault, before anybody is signed in (a reset, a sign-in's second step).
   */
  private async target(accountId: string): Promise<Target | null> {
    const account = await this.db
      .selectFrom('account')
      .select(['sign_in_text', 'reset_text', 'disabled_at'])
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!account || account.disabled_at) return null;
    const membership = await withScope(this.db, { accountId, actor: ANONYMOUS }, (trx) =>
      trx
        .selectFrom('account_household')
        .select(['household_id', 'member_id', 'role'])
        .orderBy('joined_at', 'desc')
        .executeTakeFirst(),
    );
    if (!membership) return null;
    const found = await withSystem(this.db, membership.household_id, async (trx) => {
      const phone = await trx
        .selectFrom('member_phone')
        .select(['number', 'confirmed_at'])
        .where('member_id', '=', membership.member_id)
        .executeTakeFirst();
      const r = await sql<{ ready: boolean }>`select sms_ready() as ready`.execute(trx);
      return { phone, ready: r.rows[0]?.ready === true };
    });
    return {
      householdId: membership.household_id,
      memberId: membership.member_id,
      role: membership.role,
      number: found.phone?.number ?? null,
      confirmed: Boolean(found.phone?.confirmed_at),
      ready: found.ready,
      signInText: account.sign_in_text,
      resetText: account.reset_text,
    };
  }

  /** Whether somebody has a second factor besides a text: two-step sign-in or a passkey. */
  private async strongFactor(accountId: string): Promise<boolean> {
    const [account, passkey] = await Promise.all([
      this.db
        .selectFrom('account')
        .select('totp_confirmed_at')
        .where('id', '=', accountId)
        .executeTakeFirst(),
      this.db
        .selectFrom('credential')
        .select('id')
        .where('account_id', '=', accountId)
        .where('kind', '=', 'passkey')
        .executeTakeFirst(),
    ]);
    return Boolean(account?.totp_confirmed_at) || passkey !== undefined;
  }

  /** GET /auth/text-codes: the person's own, and whether they could turn either on. */
  async settings(p: Principal): Promise<TextCodeSettings> {
    const { account, phone } = await withPrincipal(this.db, p, async (trx) => ({
      account: await trx
        .selectFrom('account')
        .select(['sign_in_text', 'reset_text'])
        .where('id', '=', p.accountId)
        .executeTakeFirstOrThrow(),
      phone: await trx
        .selectFrom('member_phone')
        .select(['number', 'confirmed_at'])
        .where('member_id', '=', p.memberId)
        .executeTakeFirst(),
    }));
    const ready = await this.sms.ready(p);
    const confirmed = Boolean(phone?.confirmed_at);
    const whyNot = !ready
      ? 'Text messages aren’t set up for this household yet. An owner can set them up in Settings, under Text messages.'
      : !phone
        ? 'Add your mobile number first, and confirm it with the code we text to it.'
        : !confirmed
          ? 'Confirm your mobile number first, with the code we texted to it.'
          : null;
    return {
      sign_in: account.sign_in_text,
      reset: account.reset_text,
      phone: phone ? maskPhone(phone.number) : null,
      phone_confirmed: confirmed,
      sms_ready: ready,
      can_turn_on: whyNot === null,
      why_not: whyNot,
      step_up: mayStepUpByText(p.role),
    };
  }

  /**
   * PUT /auth/text-codes: either turned on or off. On only with a confirmed
   * number while texts go; a sign-in code, for an owner, only beside a
   * passkey or two-step sign-in (`409 sms_code_needs_factor`). Off always.
   */
  async set(
    p: Principal,
    input: TextCodeSettingsInput,
    meta: RequestMeta,
  ): Promise<TextCodeSettings> {
    const now = await this.settings(p);
    const turningOn =
      (input.sign_in === true && !now.sign_in) || (input.reset === true && !now.reset);
    if (turningOn && !now.can_turn_on) {
      throw new ApiError(409, 'sms_code_unavailable', now.why_not ?? 'Texts can’t be sent now.');
    }
    if (
      input.sign_in === true &&
      !now.sign_in &&
      p.role === 'owner' &&
      !(await this.strongFactor(p.accountId))
    ) {
      throw new ApiError(409, 'sms_code_needs_factor', SMS_OWNER_NEEDS_FACTOR);
    }
    const next = {
      sign_in_text: input.sign_in ?? now.sign_in,
      reset_text: input.reset ?? now.reset,
    };
    if (next.sign_in_text === now.sign_in && next.reset_text === now.reset) return now;
    await withPrincipal(this.db, p, async (trx) => {
      // From a session still live (5.29), as a passkey or two-step sign-in is.
      await stillSignedIn(trx, p);
      await trx.updateTable('account').set(next).where('id', '=', p.accountId).execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.text_codes_changed',
        detail: { sign_in: next.sign_in_text, reset: next.reset_text },
        ip: meta.ip,
      });
    });
    return this.settings(p);
  }

  // --------------------------------------------------- what each asks for

  /** At sign-in: where a code by text goes, when it is the person's to give now; else null. */
  async forSignIn(accountId: string): Promise<{ to: string } | null> {
    const t = await this.target(accountId);
    if (!t || !t.signInText || !t.confirmed || !t.ready || !t.number) return null;
    return { to: maskPhone(t.number) };
  }

  /** To confirm it's them: an adult or a teen who asked for codes by text, while they can go. */
  async forStepUp(p: Principal): Promise<{ to: string } | null> {
    if (!mayStepUpByText(p.role)) return null;
    const t = await this.target(p.accountId);
    if (!t || t.householdId !== p.householdId || t.memberId !== p.memberId) return null;
    if (!t.signInText || !t.confirmed || !t.ready || !t.number) return null;
    return { to: maskPhone(t.number) };
  }

  /**
   * At a reset: whether it asks for a code by text — the person asked, and
   * their number is confirmed and texts go — or should and cannot, when the
   * reset goes on without it (`skipped`).
   */
  async forReset(accountId: string): Promise<ResetText> {
    return this.asked(accountId, 'reset');
  }

  /**
   * At sign-in, the same: asked for and possible, not asked for, or asked
   * for and impossible — when somebody whose only second step it is signs
   * in with their password alone (the owner's decision of 12 Nov 2026).
   */
  async forSignInState(accountId: string): Promise<ResetText> {
    return this.asked(accountId, 'sign_in');
  }

  private async asked(accountId: string, at: 'reset' | 'sign_in'): Promise<ResetText> {
    const t = await this.target(accountId);
    if (!t || !(at === 'reset' ? t.resetText : t.signInText)) return { asks: false };
    if (!t.number || !t.confirmed) return { asks: false, cannot: 'no_number' };
    if (!t.ready) return { asks: false, cannot: 'not_ready' };
    return { asks: true, to: maskPhone(t.number) };
  }

  /**
   * A sign-in or a reset that should have asked for a code by text, and
   * could not, went on (don't lock anybody out; the owner's decision of 12
   * Nov 2026): written in the activity log as `auth.text_code_skipped` —
   * which, and why in a word — and the person's owners are told, by email
   * and push, never by text, since texts are what failed. Who, when and why
   * in plain words; never a code or a number. As best the vault can: it
   * stops nothing.
   */
  async skipped(accountId: string, at: 'reset' | 'sign_in', why: TextSkipped): Promise<void> {
    const t = await this.target(accountId);
    if (!t) return;
    const found = await withSystem(this.db, t.householdId, async (trx) => {
      await appendAudit(trx, {
        householdId: t.householdId,
        actorAccountId: accountId,
        action: 'auth.text_code_skipped',
        objectType: 'member',
        objectId: t.memberId,
        detail: { at, why },
      });
      return {
        owners: await trx
          .selectFrom('account_household')
          .select('account_id')
          .where('role', '=', 'owner')
          .execute(),
        name: await trx
          .selectFrom('member')
          .select('display_name')
          .where('id', '=', t.memberId)
          .executeTakeFirst(),
        timezone: (await trx.selectFrom('household').select('timezone').executeTakeFirst())
          ?.timezone,
      };
    });
    const accountIds = found.owners.map((o) => o.account_id);
    if (accountIds.length === 0) return;
    const who = found.name?.display_name ?? 'Somebody';
    const when = shareEndWords(new Date(), householdZone(found.timezone));
    await this.alert({
      householdId: t.householdId,
      accountIds,
      subject:
        at === 'reset'
          ? 'A password was reset without its code by text'
          : 'A sign-in went ahead without its code by text',
      body:
        (at === 'reset'
          ? `${who}’s password was reset on ${when} without the code by text they asked for, because ${SKIPPED_WORDS[why]}.`
          : `${who} signed in on ${when} with their password alone, without the code by text they asked for, because ${SKIPPED_WORDS[why]}.`) +
        ` If it wasn’t them, ask them about it${at === 'sign_in' ? ', and sign that device out' : ''}.`,
      // By email and push; never by text, which is what failed.
      noText: true,
    });
  }

  // ------------------------------------------------------------ sending

  /**
   * A new code for one of the person's purposes, texted to their own
   * confirmed number: the ones before it for that purpose end. At most 3 to
   * a number, or an account, in 15 minutes and 10 in a day, however many
   * ask at once. If the text cannot be sent the code ends with it, and the
   * reason is said in plain words (`409 sms_not_set_up`, `409
   * sms_cap_reached`, `503 sms_not_sent`). Whether the purpose is the
   * person's to ask for is the caller's to have checked.
   */
  async send(accountId: string, purpose: TextCodePurpose): Promise<TextCodeSent> {
    const t = await this.target(accountId);
    if (!t || !t.number || !t.confirmed) throw smsCodeNotOffered();
    const number = t.number;
    const hh = t.householdId;
    const made = await withSystem(this.db, hh, async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`sms_code:${hh}:${number}`}, 0))`.execute(
        trx,
      );
      const now = new Date();
      const dayStart = new Date(now.getTime() - 864e5);
      const windowStart = new Date(now.getTime() - PHONE_CODE_SENDS.windowMinutes * 60_000);
      // A code's row is kept a day, for the count; then it goes.
      await trx.deleteFrom('sms_code').where('sent_at', '<', dayStart).execute();
      const recent = await trx
        .selectFrom('sms_code')
        .select('sent_at')
        .where((eb) => eb.or([eb('number', '=', number), eb('account_id', '=', accountId)]))
        .where('sent_at', '>', dayStart)
        .orderBy('sent_at')
        .execute();
      const inWindow = recent.filter((r) => r.sent_at.getTime() > windowStart.getTime());
      const limit = (until: Date, message: string) =>
        new ApiError(429, 'sms_code_limit', message, {
          retriable: true,
          retryAfter: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)),
        });
      if (inWindow.length >= PHONE_CODE_SENDS.perWindow) {
        const oldest = inWindow[0]?.sent_at ?? now;
        throw limit(
          new Date(oldest.getTime() + PHONE_CODE_SENDS.windowMinutes * 60_000),
          `${PHONE_CODE_SENDS.perWindow} codes have been texted to your number in the last ${PHONE_CODE_SENDS.windowMinutes} minutes. Use the newest one, or wait a little and ask again.`,
        );
      }
      if (recent.length >= PHONE_CODE_SENDS.perDay) {
        const oldest = recent[0]?.sent_at ?? now;
        throw limit(
          new Date(oldest.getTime() + 864e5),
          `${PHONE_CODE_SENDS.perDay} codes have been texted to your number today. Use the newest one, or try again tomorrow.`,
        );
      }
      // Only the newest code for this purpose works: the ones before it end now.
      await trx
        .updateTable('sms_code')
        .set({ expires_at: now })
        .where('account_id', '=', accountId)
        .where('purpose', '=', purpose)
        .where('used_at', 'is', null)
        .where('expires_at', '>', now)
        .execute();
      const id = randomUUID();
      const code = String(randomInt(0, 10 ** PHONE_CODE_DIGITS)).padStart(PHONE_CODE_DIGITS, '0');
      const expiresAt = new Date(now.getTime() + PHONE_CODE_MINUTES * 60_000);
      await trx
        .insertInto('sms_code')
        .values({
          id,
          household_id: hh,
          account_id: accountId,
          member_id: t.memberId,
          purpose,
          number,
          code_hash: this.codeHash(purpose, accountId, number, id, code),
          sent_at: now,
          expires_at: expiresAt,
        })
        .execute();
      return { id, code, expiresAt };
    });
    try {
      await this.sms.send(hh, {
        to: number,
        memberId: t.memberId,
        kind: KIND[purpose],
        text: textCodeText(purpose, made.code),
      });
    } catch (err) {
      // Not sent: the code ends, and is never typed; it still counts.
      await withSystem(this.db, hh, (trx) =>
        trx
          .updateTable('sms_code')
          .set({ expires_at: new Date() })
          .where('id', '=', made.id)
          .execute(),
      );
      throw err;
    }
    return { sent_to: maskPhone(number), expires_at: made.expiresAt.toISOString() };
  }

  /**
   * A code typed back for one of the person's purposes: the newest for it,
   * still good, to the number that is still theirs and confirmed. The try
   * is taken before the code is compared, so two at once cannot both use
   * the last; right, the code is used. Wrong, expired or tried too often,
   * it throws, in plain words.
   */
  async verify(accountId: string, purpose: TextCodePurpose, typed: string): Promise<void> {
    const t = await this.target(accountId);
    if (!t || !t.number || !t.confirmed) throw smsCodeExpired();
    const number = t.number;
    const code = typed.replace(/[\s-]/g, '');
    const tried: Tried = await withSystem(this.db, t.householdId, async (trx) => {
      const live = await trx
        .selectFrom('sms_code')
        .select(['id', 'code_hash', 'attempts', 'expires_at', 'used_at', 'number'])
        .where('account_id', '=', accountId)
        .where('purpose', '=', purpose)
        .orderBy('sent_at', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      // A code for a number that is no longer theirs confirms nothing.
      if (!live || live.used_at || live.number !== number) return 'expired';
      if (live.attempts >= PHONE_CODE_TRIES) return 'too_many';
      if (live.expires_at.getTime() <= Date.now()) return 'expired';
      // The try, taken first.
      const reserved = await trx
        .updateTable('sms_code')
        .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
        .where('id', '=', live.id)
        .where('attempts', '<', PHONE_CODE_TRIES)
        .returning('attempts')
        .executeTakeFirst();
      if (!reserved) return 'too_many';
      const right =
        CODE.test(code) &&
        timingSafeEqual(this.codeHash(purpose, accountId, number, live.id, code), live.code_hash);
      if (!right) {
        return reserved.attempts >= PHONE_CODE_TRIES
          ? 'too_many'
          : { wrong: PHONE_CODE_TRIES - reserved.attempts };
      }
      await trx
        .updateTable('sms_code')
        .set({ used_at: new Date() })
        .where('id', '=', live.id)
        .execute();
      return 'right';
    });
    if (tried === 'expired') throw smsCodeExpired();
    if (tried === 'too_many') throw smsCodeTooMany();
    if (tried !== 'right') throw wrong(tried.wrong);
  }
}
