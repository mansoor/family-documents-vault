import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  ANONYMOUS,
  appendAudit,
  householdZone,
  withPrincipal,
  withScope,
  withSystem,
  type Db,
  type Role,
} from '@fdv/db';
import {
  normaliseRecoveryCode,
  normaliseSecurityAnswer,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  RECOVERY_CODES_LOW,
  recoveryCodeWords,
  SECURITY_QUESTION_CHOICES,
  SECURITY_QUESTION_COUNT,
  SECURITY_QUESTION_MAX,
  SECURITY_QUESTION_OWN,
  SECURITY_QUESTION_TRIES,
  SECURITY_QUESTIONS_REFUSED_HOURS,
  securityAnswerProblem,
  shareEndWords,
  type RecoveryCodesMade,
  type RecoveryCodesState,
  type RecoveryWay,
  type SecurityQuestion,
  type SecurityQuestionsInput,
  type SecurityQuestionsRule,
  type SecurityQuestionsState,
} from '@fdv/shared';
import argon2 from 'argon2';
import { sql } from 'kysely';
import type { AlertRequest } from '../alert-job.js';
import { ApiError } from '../errors.js';
import { COMPUTERS_STOPPED, stopDevicesOf } from '../devices/service.js';
import { endDevices, SESSION_ENDED, type PushRequest, type PushTarget } from '../push-job.js';
import { ARGON2, stillSignedIn, type Principal, type RequestMeta } from './service.js';
import type { Attempt, SignInGuard } from './sign-in-guard.js';

/**
 * Getting back in when the second step is lost (0.9.0-dev.104).
 *
 * Two ways, both the person's own to set up, and neither ever enough on its
 * own: ten one-time recovery codes, and — if they choose — three security
 * questions. Either stands in for the second step (an authenticator app, a
 * passkey, codes by text) with the password, or with a reset link sent to
 * the person's own address. Nothing here lets anybody in without one of
 * those.
 *
 * Used, the person is let in, and everything that stood in the way goes:
 * every second step of theirs (the authenticator app, every passkey, codes
 * by text), the rest of their recovery codes, and every session of theirs.
 * Until they set up a second step again and make new recovery codes beside
 * it, their session may only do that (`account.recovered_at`, the
 * `recovered` reason of `two_step_setup_required`). The person is emailed,
 * and when they are an owner, the other owners are too; their Activity has
 * a line.
 *
 * Codes and answers are hashed as passwords are (Argon2id), and never kept
 * or logged as themselves. Each try is reserved before it is checked, on the
 * account's own count of failed sign-ins (sign-in-guard.ts): five wrong, and
 * signing in waits. Security questions answered wrong five times are refused
 * for a day besides. Both tables are the vault's alone (0134): nobody signed
 * in reads a row of either, an owner included.
 */

/** Said of a recovery code that didn't match, or was used already. */
export const RECOVERY_CODE_WRONG = 'That recovery code isn’t right, or it was used already.';

const codeWrong = () => new ApiError(401, 'recovery_code_wrong', RECOVERY_CODE_WRONG);

const answersWrong = (left: number) =>
  new ApiError(
    401,
    'security_answers_wrong',
    left > 0
      ? `Those answers aren’t all right. ${left} ${left === 1 ? 'try' : 'tries'} left before your security questions are refused for a day.`
      : 'Those answers aren’t all right, and your security questions are now refused for a day. Use a recovery code, or ask an owner to send you a password reset.',
  );

/** The questions can't be used here: none set, or the household doesn't offer them. */
export const questionsNotOffered = () =>
  new ApiError(
    409,
    'security_questions_not_offered',
    'Security questions aren’t set up for this sign-in.',
  );

const needsSecondStep = () =>
  new ApiError(
    409,
    'recovery_codes_need_second_step',
    'Set up two-step sign-in first — an authenticator app, a passkey or codes by text — and then make recovery codes for it.',
  );

const questionsOff = () =>
  new ApiError(
    409,
    'security_questions_off',
    'An owner has turned security questions off for this household.',
  );

const bad = (message: string) => new ApiError(422, 'validation_failed', message);

/**
 * Somebody who got back in at sign-in, still to finish setting up: any other
 * sign-in by password alone is refused, and only the session the recovery
 * opened may make the codes that finish it.
 */
export const RECOVERY_UNFINISHED_MESSAGE =
  'Finish setting up on the device where you recovered, or use Forgot password.';
export const recoveryUnfinished = () =>
  new ApiError(409, 'recovery_unfinished', RECOVERY_UNFINISHED_MESSAGE);

/** What stands in for the second step, as it was given. */
export type RecoveryProof = { code: string } | { answers: string[] };

/** Where it was used: at sign-in (with the password), or finishing a reset. */
export type RecoveredAt = 'sign_in' | 'reset';

/** Whose a sign-in is: their newest household, as a sign-in opens it. */
interface Whose {
  householdId: string;
  memberId: string;
  role: Role;
}

/** One recovery code, ten letters and digits from RECOVERY_CODE_ALPHABET. */
function newCode(): string {
  let code = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    code += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
  }
  return code;
}

/** What the key a recovery code is HMACed under is derived for. */
export const RECOVERY_CODE_KEY_PURPOSE = 'recovery-code-hmac';

/**
 * Runs `fn` as the vault inside the caller's own transaction, and gives the
 * transaction back as it was: the few statements a reset or a sign-in's
 * recovery makes to the vault's own tables (recovery codes, security
 * answers, a sign-in marked recovered), committed with the rest or not at
 * all.
 */
export async function asVault<T>(trx: Db, fn: () => Promise<T>): Promise<T> {
  const was = await sql<{ actor: string | null }>`
    select current_setting('app.actor', true) as actor`.execute(trx);
  await sql`select set_config('app.actor', 'system', true)`.execute(trx);
  try {
    return await fn();
  } finally {
    await sql`select set_config('app.actor', ${was.rows[0]?.actor ?? ''}, true)`.execute(trx);
  }
}

/** What a sign-in's or a reset's recovery checked, and holds until it is used. */
export interface Standing {
  accountId: string;
  who: Whose;
  used: { codeId: string } | { questions: true };
  attempt: Attempt | null;
}

export class RecoveryService {
  private readonly alert: (a: AlertRequest) => Promise<void>;
  private readonly push: (r: PushRequest) => Promise<void>;
  private readonly guard: SignInGuard | null;
  private readonly codeKey: Buffer;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    opts: {
      /**
       * The key a code is HMACed under (deriveKey(master,
       * RECOVERY_CODE_KEY_PURPOSE)). A code has about 50 random bits: a slow
       * hash would only cost memory at every try.
       */
      codeKey?: Buffer;
      /** Emails the person, and the other owners when they are one. */
      alert?: (a: AlertRequest) => Promise<void>;
      /** "You were signed out", to the phones of the sessions a recovery ends. */
      push?: (r: PushRequest) => Promise<void>;
      /** Failed sign-ins counted per account (sign-in-guard.ts). */
      guard?: SignInGuard | null;
      now?: () => number;
    } = {},
  ) {
    this.codeKey = opts.codeKey ?? Buffer.alloc(32);
    this.alert = opts.alert ?? (async () => undefined);
    this.push = opts.push ?? (async () => undefined);
    this.guard = opts.guard ?? null;
    this.now = opts.now ?? (() => Date.now());
  }

  /** A code as the vault keeps it: an HMAC over whose it is and the code, never the code. */
  private codeHash(accountId: string, code: string): Buffer {
    return createHmac('sha256', this.codeKey).update(`recovery:${accountId}:${code}`).digest();
  }

  // ------------------------------------------------------------ reading

  /** The person's newest household, as a sign-in reads it; null without one. */
  private async whose(accountId: string): Promise<Whose | null> {
    const m = await withScope(this.db, { accountId, actor: ANONYMOUS }, (trx) =>
      trx
        .selectFrom('account_household')
        .select(['household_id', 'member_id', 'role'])
        .orderBy('joined_at', 'desc')
        .executeTakeFirst(),
    );
    return m ? { householdId: m.household_id, memberId: m.member_id, role: m.role } : null;
  }

  /**
   * Whether somebody has a second step for recovery to stand in for: an
   * authenticator app, a passkey, or codes by text — at sign-in, or when
   * their password is reset.
   */
  async hasSecondStep(accountId: string): Promise<boolean> {
    const r = await sql<{ has: boolean }>`
      select exists (select 1 from account
                      where id = ${accountId}
                        and (totp_confirmed_at is not null or sign_in_text or reset_text))
          or exists (select 1 from credential
                      where account_id = ${accountId} and kind = 'passkey') as has
    `.execute(this.db);
    return r.rows[0]?.has === true;
  }

  /** Whether the household lets security questions stand in, as the vault reads it. */
  private async offeredIn(trx: Db, householdId: string): Promise<boolean> {
    const hh = await trx
      .selectFrom('household')
      .select(['security_questions'])
      .where('id', '=', householdId)
      .executeTakeFirst();
    return hh?.security_questions === true;
  }

  /**
   * What may stand in for this person's second step now, as a sign-in or a
   * reset offers it: recovery codes while any are left; security questions
   * when three are set and the household offers them (refused for a day
   * after five wrong answers, which answering says).
   */
  async waysFor(accountId: string): Promise<RecoveryWay[]> {
    const who = await this.whose(accountId);
    if (!who) return [];
    return withSystem(this.db, who.householdId, async (trx) => {
      const codes = await trx
        .selectFrom('recovery_code')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('account_id', '=', accountId)
        .where('used_at', 'is', null)
        .executeTakeFirst();
      const questions = await trx
        .selectFrom('security_answer')
        .select(['account_id'])
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      const ways: RecoveryWay[] = [];
      if (Number(codes?.n ?? 0) > 0) ways.push('recovery_code');
      if (questions && (await this.offeredIn(trx, who.householdId))) {
        ways.push('security_questions');
      }
      return ways;
    });
  }

  /**
   * The person's three questions, in order, to answer at sign-in or at a
   * reset: only once the password or the link has been proven, and only
   * while the household offers them (`409 security_questions_not_offered`).
   */
  async questionsFor(accountId: string): Promise<string[]> {
    const who = await this.whose(accountId);
    if (!who) throw questionsNotOffered();
    return withSystem(this.db, who.householdId, async (trx) => {
      const row = await trx
        .selectFrom('security_answer')
        .select(['questions'])
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      if (!row || !(await this.offeredIn(trx, who.householdId))) throw questionsNotOffered();
      return questionsOf(row.questions).map((q) => q.text);
    });
  }

  // ------------------------------------------------------ recovery codes

  /** GET /auth/recovery-codes: how many are left, never the codes. */
  async codesState(p: Principal): Promise<RecoveryCodesState> {
    const rows = await withSystem(this.db, p.householdId, (trx) =>
      trx
        .selectFrom('recovery_code')
        .select(['made_at', 'used_at'])
        .where('account_id', '=', p.accountId)
        .execute(),
    );
    const remaining = rows.filter((r) => r.used_at === null).length;
    const made = rows.reduce<Date | null>(
      (at, r) => (at === null || r.made_at > at ? r.made_at : at),
      null,
    );
    return {
      remaining,
      made_at: made?.toISOString() ?? null,
      low: made !== null && remaining <= RECOVERY_CODES_LOW,
      second_step: await this.hasSecondStep(p.accountId),
    };
  }

  /**
   * POST /auth/recovery-codes: ten new codes, which replace every code the
   * person had, shown this once. Only beside a second step (`409
   * recovery_codes_need_second_step`): with none, there is nothing for them
   * to stand in for. After a recovery, this is what lets the person's
   * sessions go on (`recovered_at` cleared) — from the session the
   * recovery opened alone, when it was a sign-in's (`409
   * recovery_unfinished` from any other).
   */
  async makeCodes(p: Principal, meta: RequestMeta): Promise<RecoveryCodesMade> {
    if (!(await this.hasSecondStep(p.accountId))) throw needsSecondStep();
    const state = await this.db
      .selectFrom('account')
      .select(['recovered_at', 'recovered_session'])
      .where('id', '=', p.accountId)
      .executeTakeFirst();
    if (state?.recovered_at && state.recovered_session && state.recovered_session !== p.sessionId) {
      throw recoveryUnfinished();
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newCode);
    const hashes = codes.map((c) => this.codeHash(p.accountId, c));
    // From a session still live (5.29), as every change to how somebody
    // signs in is: a reset that ended it meanwhile is not followed by codes
    // it never saw.
    await withPrincipal(this.db, p, (trx) => stillSignedIn(trx, p));
    await withSystem(this.db, p.householdId, async (trx) => {
      const before = await trx
        .deleteFrom('recovery_code')
        .where('account_id', '=', p.accountId)
        .executeTakeFirst();
      await trx
        .insertInto('recovery_code')
        .values(
          hashes.map((code_hash) => ({
            household_id: p.householdId,
            account_id: p.accountId,
            member_id: p.memberId,
            code_hash,
          })),
        )
        .execute();
      // A second step set up again, and new codes beside it: the session a
      // recovery left goes on.
      await trx
        .updateTable('account')
        .set({ recovered_at: null, recovered_session: null })
        .where('id', '=', p.accountId)
        .where('recovered_at', 'is not', null)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.recovery_codes_made',
        objectType: 'member',
        objectId: p.memberId,
        detail: { count: RECOVERY_CODE_COUNT, replaced: Number(before.numDeletedRows) > 0 },
        ip: meta.ip,
      });
    });
    return {
      ...(await this.codesState(p)),
      codes: codes.map(recoveryCodeWords),
    };
  }

  // -------------------------------------------------- security questions

  /** GET /auth/security-questions: the person's own questions, never their answers. */
  async questionsState(p: Principal): Promise<SecurityQuestionsState> {
    return withSystem(this.db, p.householdId, async (trx) => {
      const row = await trx
        .selectFrom('security_answer')
        .select(['questions', 'set_at', 'refused_until'])
        .where('account_id', '=', p.accountId)
        .executeTakeFirst();
      const refused =
        row?.refused_until && row.refused_until.getTime() > this.now() ? row.refused_until : null;
      return {
        set: row !== undefined,
        questions: row ? questionsOf(row.questions) : [],
        set_at: row?.set_at.toISOString() ?? null,
        offered: await this.offeredIn(trx, p.householdId),
        refused_until: refused?.toISOString() ?? null,
      };
    });
  }

  /**
   * PUT /auth/security-questions: three questions and their answers, which
   * replace any the person had. Each a different question — one of them in
   * their own words, if they like — and each answer at least four letters
   * or numbers once case, spaces and punctuation are taken out, and none
   * the same as another. Refused while the household doesn't offer them.
   */
  async setQuestions(
    p: Principal,
    input: SecurityQuestionsInput,
    meta: RequestMeta,
  ): Promise<SecurityQuestionsState> {
    const offered = await withSystem(this.db, p.householdId, (trx) =>
      this.offeredIn(trx, p.householdId),
    );
    if (!offered) throw questionsOff();
    const questions = chosenQuestions(input);
    const answers = input.questions.map((q) => normaliseSecurityAnswer(q.answer));
    // One at a time: each Argon2 hash takes its own memory.
    const hashes: string[] = [];
    for (const a of answers) hashes.push(await argon2.hash(a, ARGON2));
    await withPrincipal(this.db, p, (trx) => stillSignedIn(trx, p));
    await withSystem(this.db, p.householdId, async (trx) => {
      const before = await trx
        .selectFrom('security_answer')
        .select(['account_id'])
        .where('account_id', '=', p.accountId)
        .forUpdate()
        .executeTakeFirst();
      await trx
        .insertInto('security_answer')
        .values({
          account_id: p.accountId,
          household_id: p.householdId,
          member_id: p.memberId,
          questions: JSON.stringify(questions),
          answer_hashes: hashes,
        })
        .onConflict((oc) =>
          oc.column('account_id').doUpdateSet({
            household_id: p.householdId,
            member_id: p.memberId,
            questions: JSON.stringify(questions),
            answer_hashes: hashes,
            set_at: sql<Date>`now()`,
            tries: 0,
            tries_since: null,
            refused_until: null,
          }),
        )
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.security_questions_set',
        objectType: 'member',
        objectId: p.memberId,
        // Whether they were set before: never which questions, nor any answer.
        detail: { changed: before !== undefined },
        ip: meta.ip,
      });
    });
    return this.questionsState(p);
  }

  /** DELETE /auth/security-questions: gone. None to remove answers the same. */
  async removeQuestions(p: Principal, meta: RequestMeta): Promise<SecurityQuestionsState> {
    await withPrincipal(this.db, p, (trx) => stillSignedIn(trx, p));
    await withSystem(this.db, p.householdId, async (trx) => {
      const gone = await trx
        .deleteFrom('security_answer')
        .where('account_id', '=', p.accountId)
        .executeTakeFirst();
      if (Number(gone.numDeletedRows) === 0) return;
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'auth.security_questions_removed',
        objectType: 'member',
        objectId: p.memberId,
        ip: meta.ip,
      });
    });
    return this.questionsState(p);
  }

  /** GET /household/security-questions: whether the household offers them. */
  async rule(p: Principal): Promise<SecurityQuestionsRule> {
    return withPrincipal(this.db, p, async (trx) => {
      const hh = await trx
        .selectFrom('household')
        .select(['security_questions'])
        .where('id', '=', p.householdId)
        .executeTakeFirstOrThrow();
      return { on: hh.security_questions, can_change: p.role === 'owner' };
    });
  }

  /**
   * PUT /household/security-questions: an owner's (the database holds it to
   * owners too, 0134). Off, the questions people set are kept and never
   * asked; on again, they are asked again. Each change is in the activity
   * log; the same again changes nothing.
   */
  async setRule(p: Principal, on: boolean, meta: RequestMeta): Promise<SecurityQuestionsRule> {
    if (p.role !== 'owner') {
      throw new ApiError(
        403,
        'forbidden',
        'Only an owner can choose whether security questions are offered.',
      );
    }
    await withPrincipal(this.db, p, async (trx) => {
      const before = await trx
        .selectFrom('household')
        .select(['security_questions'])
        .where('id', '=', p.householdId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (before.security_questions === on) return;
      await trx
        .updateTable('household')
        .set({ security_questions: on })
        .where('id', '=', p.householdId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'household.security_questions_changed',
        objectType: 'household',
        objectId: p.householdId,
        detail: { on },
        ip: meta.ip,
      });
    });
    return this.rule(p);
  }

  // ------------------------------------------------------------ using one

  /**
   * A recovery code or the answers, standing in for the second step of
   * somebody whose password (or reset link) the caller has proven: checked,
   * nothing more. The try is reserved first, on the account's own count of
   * failed sign-ins; wrong, it is counted and refused. Right, the caller
   * applies it in its own transaction (`apply`) — a new password set, or a
   * reset link claimed — then `finish`es it, and `release`s it whatever
   * happened.
   */
  async begin(accountId: string, proof: RecoveryProof, meta: RequestMeta): Promise<Standing> {
    const who = await this.whose(accountId);
    if (!who) throw 'code' in proof ? codeWrong() : questionsNotOffered();
    // Reserved before it is checked, on the account's own count: from
    // whichever device, a recovery is a try at the account.
    const guard = this.guard;
    const attempt = guard ? await guard.begin(guard.subjectOfAccount(accountId)) : null;
    try {
      const used =
        'code' in proof
          ? await this.checkCode(accountId, who, proof.code)
          : await this.checkAnswers(accountId, who, proof.answers);
      if (used === null) {
        if (guard && attempt) {
          await guard.failed(
            attempt,
            accountId,
            'code' in proof ? 'recovery_code' : 'questions',
            meta,
          );
        }
        throw 'code' in proof ? codeWrong() : answersWrong(await this.triesLeft(accountId, who));
      }
      return { accountId, who, used, attempt };
    } catch (err) {
      if (guard && attempt) await guard.release(attempt);
      throw err;
    }
  }

  /** A standing let go of, whatever became of it: its reserved try settled. */
  async release(s: Standing): Promise<void> {
    if (this.guard && s.attempt) await this.guard.release(s.attempt);
  }

  /**
   * After the caller's transaction committed: the try counted as a success,
   * the phones of the ended sessions told, and the person — and the other
   * owners, when they are one — emailed.
   */
  async finish(
    s: Standing,
    phones: PushTarget[],
    at: RecoveredAt,
    extra: { computers?: number } = {},
  ): Promise<void> {
    if (this.guard && s.attempt) await this.guard.succeeded(s.attempt);
    if (phones.length > 0) {
      await this.push({ householdId: s.who.householdId, message: SESSION_ENDED, targets: phones });
    }
    await this.tell(s.accountId, s.who, 'codeId' in s.used ? 'code' : 'questions', at, extra);
  }

  /** The id of the unused code the typed one is; null when it is none of them. */
  private async checkCode(
    accountId: string,
    who: Whose,
    typed: string,
  ): Promise<{ codeId: string } | null> {
    const word = normaliseRecoveryCode(typed);
    const rows = await withSystem(this.db, who.householdId, (trx) =>
      trx
        .selectFrom('recovery_code')
        .select(['id', 'code_hash'])
        .where('account_id', '=', accountId)
        .where('used_at', 'is', null)
        .execute(),
    );
    if (word.length !== RECOVERY_CODE_LENGTH) return null;
    // Every row compared, each in constant time: how long it takes says
    // nothing of which, if any, it is.
    const want = this.codeHash(accountId, word);
    let found: string | null = null;
    for (const r of rows) {
      if (r.code_hash.length === want.length && timingSafeEqual(r.code_hash, want)) found = r.id;
    }
    return found ? { codeId: found } : null;
  }

  /**
   * Whether every answer is right; null when any is not. The try is
   * reserved first, on the questions' own count: five wrong within a day,
   * and they are refused until a day after the fifth (`429
   * security_questions_refused`), whatever is typed.
   */
  private async checkAnswers(
    accountId: string,
    who: Whose,
    typed: string[],
  ): Promise<{ questions: true } | null> {
    const now = new Date(this.now());
    const day = new Date(now.getTime() - SECURITY_QUESTIONS_REFUSED_HOURS * 3600_000);
    const reserved = await withSystem(this.db, who.householdId, async (trx) => {
      if (!(await this.offeredIn(trx, who.householdId))) throw questionsNotOffered();
      const row = await trx
        .selectFrom('security_answer')
        .select(['answer_hashes', 'refused_until'])
        .where('account_id', '=', accountId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw questionsNotOffered();
      const taken = await sql<{ tries: number }>`
        update security_answer set
          tries = case when tries_since is null or tries_since < ${day} then 1 else tries + 1 end,
          tries_since = case when tries_since is null or tries_since < ${day} then ${now}
                             else tries_since end
        where account_id = ${accountId}
          and (refused_until is null or refused_until <= ${now})
          and (tries_since is null or tries_since < ${day} or tries < ${SECURITY_QUESTION_TRIES})
        returning tries`.execute(trx);
      if (taken.rows.length === 0) return { refusedUntil: row.refused_until };
      return { hashes: row.answer_hashes };
    });
    if (!('hashes' in reserved)) {
      throw await this.questionsRefused(who, reserved.refusedUntil);
    }
    const answers = typed.map(normaliseSecurityAnswer);
    // One at a time, every one checked whatever the first said: each Argon2
    // check takes its own memory, and how long it takes says nothing.
    let right = answers.length === SECURITY_QUESTION_COUNT;
    for (const [i, h] of reserved.hashes.entries()) {
      const ok = await argon2.verify(h, answers[i] ?? '').catch(() => false);
      right = right && ok;
    }
    if (right) return { questions: true };
    // Wrong: the fifth within a day refuses them for a day from now.
    await withSystem(this.db, who.householdId, (trx) =>
      trx
        .updateTable('security_answer')
        .set({
          refused_until: new Date(now.getTime() + SECURITY_QUESTIONS_REFUSED_HOURS * 3600_000),
        })
        .where('account_id', '=', accountId)
        .where('tries', '>=', SECURITY_QUESTION_TRIES)
        .execute(),
    );
    return null;
  }

  /** How many wrong answers are left before the questions are refused. */
  private async triesLeft(accountId: string, who: Whose): Promise<number> {
    const row = await withSystem(this.db, who.householdId, (trx) =>
      trx
        .selectFrom('security_answer')
        .select(['tries', 'refused_until'])
        .where('account_id', '=', accountId)
        .executeTakeFirst(),
    );
    if (!row || (row.refused_until && row.refused_until.getTime() > this.now())) return 0;
    return Math.max(0, SECURITY_QUESTION_TRIES - row.tries);
  }

  /** Refused for a day after five wrong answers, until when on the household's clock. */
  private async questionsRefused(who: Whose, until: Date | null): Promise<ApiError> {
    const zone = await withSystem(this.db, who.householdId, async (trx) =>
      householdZone(
        (await trx.selectFrom('household').select(['timezone']).executeTakeFirst())?.timezone,
      ),
    );
    const seconds = until ? Math.max(1, Math.ceil((until.getTime() - this.now()) / 1000)) : 60;
    return new ApiError(
      429,
      'security_questions_refused',
      `Your security questions were answered wrong ${SECURITY_QUESTION_TRIES} times, so they can’t be used${
        until ? ` until ${shareEndWords(until, zone)}` : ' for now'
      }. Use a recovery code, or ask an owner to send you a password reset.`,
      { retryAfter: seconds },
    );
  }

  /**
   * A standing used, inside the caller's transaction (a sign-in's new
   * password, or a reset link claimed), as the vault where its own tables
   * are written: the code used (once: two at the same moment cannot both
   * have it), the person's second steps taken away — the authenticator app,
   * every passkey, codes by text — and the rest of their codes; their
   * sign-in marked as recovered, bound to `session` when a sign-in opens
   * one; and the line. With `endEverything` (a sign-in's: a reset ends these
   * itself) every session of theirs ends, every computer that sends their
   * scans stops, and their exports end too. Answers the phones of the ended
   * sessions and the computers stopped, to tell once it commits.
   */
  async apply(
    trx: Db,
    s: Standing,
    at: RecoveredAt,
    meta: RequestMeta,
    opts: { session: string | null; endEverything: boolean },
  ): Promise<{ phones: PushTarget[]; computers: number }> {
    const { accountId, who, used } = s;
    const done = await asVault(trx, async () => {
      if ('codeId' in used) {
        const taken = await trx
          .updateTable('recovery_code')
          .set({ used_at: sql<Date>`now()` })
          .where('id', '=', used.codeId)
          .where('used_at', 'is', null)
          .executeTakeFirst();
        if (Number(taken.numUpdatedRows) !== 1) throw codeWrong();
      } else {
        await trx
          .updateTable('security_answer')
          .set({ tries: 0, tries_since: null, refused_until: null })
          .where('account_id', '=', accountId)
          .execute();
      }
      // The rest of the set goes too: new codes are made beside the new
      // second step, and replace them.
      await trx.deleteFrom('recovery_code').where('account_id', '=', accountId).execute();
      await trx
        .updateTable('account')
        .set({
          totp_secret: null,
          totp_confirmed_at: null,
          totp_last_step: null,
          sign_in_text: false,
          reset_text: false,
          recovered_at: sql<Date>`now()`,
          recovered_session: opts.session,
        })
        .where('id', '=', accountId)
        .execute();
      const passkeys = await trx
        .deleteFrom('credential')
        .where('account_id', '=', accountId)
        .where('kind', '=', 'passkey')
        .executeTakeFirst();
      if (!opts.endEverything) {
        return { passkeys: Number(passkeys.numDeletedRows), sessions: 0, exports: 0, phones: [] };
      }
      const ended = await trx
        .updateTable('session')
        .set({ revoked_at: new Date(), revoked_reason: RECOVERED_REASON })
        .where('account_id', '=', accountId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      const phones = await endDevices(trx, { accountId });
      // What a reset ends, a recovery ends: every copy of everything they
      // asked for.
      const expired = await trx
        .updateTable('export')
        .set({ expires_at: sql<Date>`now()` })
        .where('requested_by', '=', accountId)
        .where((eb) =>
          eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]),
        )
        .executeTakeFirst();
      return {
        passkeys: Number(passkeys.numDeletedRows),
        sessions: Number(ended.numUpdatedRows),
        exports: Number(expired.numUpdatedRows),
        phones,
      };
    });
    // And every computer that sends their scans: as the sign-in page, for
    // the account it names, as a reset stops them.
    const computers = opts.endEverything
      ? await stopDevicesOf(
          trx,
          { householdId: who.householdId, actorAccountId: accountId },
          accountId,
          'password_changed',
          meta,
        )
      : 0;
    await appendAudit(trx, {
      householdId: who.householdId,
      actorAccountId: accountId,
      action: 'codeId' in used ? 'auth.recovery_code_used' : 'auth.security_questions_used',
      objectType: 'member',
      objectId: who.memberId,
      // Where, and what went: never the code, nor an answer.
      detail: {
        at,
        passkeys_removed: done.passkeys,
        ...(opts.endEverything
          ? {
              sessions_ended: done.sessions,
              computers_stopped: computers,
              exports_ended: done.exports,
              new_password: true,
            }
          : {}),
      },
      ip: meta.ip,
    });
    return { phones: done.phones, computers };
  }

  /**
   * The person is emailed, and when they are an owner, the other owners
   * too: by email, as every alert about a sign-in is; never with the code.
   * As best the vault can: it stops nothing.
   */
  private async tell(
    accountId: string,
    who: Whose,
    way: 'code' | 'questions',
    at: RecoveredAt,
    extra: { computers?: number } = {},
  ): Promise<void> {
    const found = await withSystem(this.db, who.householdId, async (trx) => ({
      name: (
        await trx
          .selectFrom('member')
          .select('display_name')
          .where('id', '=', who.memberId)
          .executeTakeFirst()
      )?.display_name,
      owners: (
        await trx
          .selectFrom('account_household')
          .select('account_id')
          .where('role', '=', 'owner')
          .where('account_id', '<>', accountId)
          .execute()
      ).map((o) => o.account_id),
    }));
    const what = way === 'code' ? 'a recovery code' : 'your security questions';
    const how = at === 'reset' ? 'to finish a password reset' : 'to sign in';
    await this.alert({
      householdId: who.householdId,
      accountIds: [accountId],
      subject:
        way === 'code'
          ? 'A recovery code was used for your vault'
          : 'Your security questions were used for your vault',
      body:
        `Somebody used ${what} ${how}, in place of your second step, and set a new password. Your authenticator app, passkeys and codes by text have been taken away, and every other device has been signed out. If that was you, set up two-step sign-in again and make new recovery codes. If it wasn't, ask an owner to lock your sign-in now, and look at the activity log.` +
        ((extra.computers ?? 0) > 0 ? ` ${COMPUTERS_STOPPED}` : ''),
      emailOnly: true,
      text: 'signed_out',
    }).catch(() => undefined);
    if (who.role !== 'owner' || found.owners.length === 0) return;
    const name = found.name ?? 'An owner';
    await this.alert({
      householdId: who.householdId,
      accountIds: found.owners,
      subject: `${name} got back into their sign-in`,
      body: `${name}, an owner of your vault, used ${way === 'code' ? 'a recovery code' : 'their security questions'} ${how}, in place of their second step. Their two-step sign-in has been taken away until they set it up again. If you don't think it was them, check with them, and see Activity.`,
      emailOnly: true,
      noText: true,
    }).catch(() => undefined);
  }
}

/** Why a person's sessions ended when a recovery code or the questions were used. */
export const RECOVERED_REASON = 'recovered';

/** The questions as they are kept: three, each a key and its words. */
function questionsOf(raw: unknown): SecurityQuestion[] {
  const list = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(list)) return [];
  return list.flatMap((q: unknown) => {
    if (!q || typeof q !== 'object') return [];
    const { key, text } = q as { key?: unknown; text?: unknown };
    return typeof key === 'string' && typeof text === 'string' ? [{ key, text }] : [];
  });
}

/** The three questions chosen, as kept; or a refusal in plain words. */
function chosenQuestions(input: SecurityQuestionsInput): SecurityQuestion[] {
  if (input.questions.length !== SECURITY_QUESTION_COUNT) {
    throw bad(`Choose ${SECURITY_QUESTION_COUNT} questions, and answer each.`);
  }
  const keys = new Set<string>();
  const chosen = input.questions.map((q): SecurityQuestion => {
    if (q.key === SECURITY_QUESTION_OWN) {
      const text = (q.text ?? '').replace(/\s+/g, ' ').trim();
      if (text.length < 8) throw bad('Write your own question in a few words.');
      if (text.length > SECURITY_QUESTION_MAX) {
        throw bad(`Your own question can be ${SECURITY_QUESTION_MAX} characters at most.`);
      }
      if (keys.has(q.key)) throw bad('Only one of the questions can be in your own words.');
      keys.add(q.key);
      return { key: q.key, text };
    }
    const choice = SECURITY_QUESTION_CHOICES.find((c) => c.key === q.key);
    if (!choice) throw bad('Choose each question from the list, or write your own.');
    if (keys.has(q.key)) throw bad('Choose a different question each time.');
    keys.add(q.key);
    return { key: choice.key, text: choice.text };
  });
  const answers = input.questions.map((q) => normaliseSecurityAnswer(q.answer));
  for (const q of input.questions) {
    const problem = securityAnswerProblem(q.answer);
    if (problem) throw bad(problem);
  }
  if (new Set(answers).size !== answers.length) {
    throw bad('Give a different answer to each question.');
  }
  return chosen;
}
