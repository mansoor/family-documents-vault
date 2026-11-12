import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendAudit, withPrincipal, withSystem, type Db } from '@fdv/db';
import {
  maskPhone,
  parsePhone,
  PHONE_CODE_DIGITS,
  PHONE_CODE_MINUTES,
  PHONE_CODE_SENDS,
  PHONE_CODE_TRIES,
  phoneChangedText,
  phoneCodeText,
  type MemberPhoneView,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { notSetUp, type SmsService } from './service.js';

/**
 * Somebody's mobile number (0.9.0, SMS1), confirmed by a code texted to it.
 *
 * Whose: their own, and any owner's — an owner adds one for somebody with
 * no sign-in, a child, say, and the code goes to that phone. Nobody else is
 * told even that there is one (the database keeps member_phone to them).
 *
 * A number saved is unconfirmed, and a six-digit code is texted to it: typed
 * back within ten minutes, in five tries, it confirms the number. A number
 * changed is unconfirmed again until its own code is typed, and the number
 * it replaced, if it was confirmed, is told. A code is kept as an HMAC under
 * a key derived from the master key (phone-code-hmac), never as itself, and
 * only by the vault: nobody signed in reads phone_code (0084). At most 3
 * codes go to a number in 15 minutes, and 10 in a day.
 *
 * Only a household whose texts are set up and tested is offered any of it:
 * with none, `409 sms_not_set_up`.
 */

/** What the key a code is HMACed under is derived for. */
export const PHONE_CODE_KEY_PURPOSE = 'phone-code-hmac';

const notYours = () =>
  new ApiError(
    403,
    'forbidden',
    'Only the person themselves or an owner can see or change their mobile number.',
  );
const noPerson = () => new ApiError(404, 'not_found', 'That person isn’t in the family.');
const noNumber = () =>
  new ApiError(404, 'phone_none', 'There is no mobile number for this person yet.');
const invalid = () =>
  new ApiError(
    422,
    'phone_number_invalid',
    'That doesn’t look like a mobile number. Type it with its country code, such as +44 7700 900123.',
  );
const expired = () =>
  new ApiError(
    409,
    'phone_code_expired',
    'That code has ended. Ask for a new one, and type the newest.',
  );
const tooMany = () =>
  new ApiError(
    409,
    'phone_code_too_many',
    `That code was typed wrong ${PHONE_CODE_TRIES} times, so it no longer works. Ask for a new one.`,
  );
const wrong = (left: number) =>
  new ApiError(
    422,
    'phone_code_wrong',
    `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
  );

/** What a code typed looks like once spaces and dashes are taken out. */
const CODE = new RegExp(`^[0-9]{${PHONE_CODE_DIGITS}}$`);

/** What the confirm's transaction found, said after it commits: a wrong try is kept. */
type Tried = 'right' | 'expired' | 'too_many' | { wrong: number };

export interface PhoneOptions {
  /** The key a code is HMACed under (deriveKey(master, PHONE_CODE_KEY_PURPOSE)). */
  codeKey?: Buffer;
}

export class MemberPhoneService {
  private readonly codeKey: Buffer;

  constructor(
    private readonly db: Db,
    private readonly sms: SmsService,
    opts: PhoneOptions = {},
  ) {
    this.codeKey = opts.codeKey ?? Buffer.alloc(32);
  }

  /**
   * A code as the vault keeps it: an HMAC under its own key, over the person,
   * the number, the code's own row and the code — never a plain hash, which
   * a dump of six-digit codes gives back at once.
   */
  private codeHash(memberId: string, number: string, codeId: string, code: string): Buffer {
    return createHmac('sha256', this.codeKey)
      .update(`${memberId}:${number}:${codeId}:${code}`)
      .digest();
  }

  /** Whose number it is, and that the caller may see and change it: themselves, or an owner. */
  private async person(p: Principal, memberId: string): Promise<{ name: string }> {
    if (p.memberId !== memberId && p.role !== 'owner') throw notYours();
    const m = await withPrincipal(this.db, p, (trx) =>
      trx.selectFrom('member').select('display_name').where('id', '=', memberId).executeTakeFirst(),
    );
    if (!m) throw noPerson();
    return { name: m.display_name };
  }

  /** GET /members/{id}/phone. */
  async get(p: Principal, memberId: string): Promise<MemberPhoneView> {
    await this.person(p, memberId);
    return this.view(p, memberId);
  }

  private async view(p: Principal, memberId: string): Promise<MemberPhoneView> {
    const { row, expires } = await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('member_phone')
        .select(['number', 'confirmed_at', 'updated_at'])
        .where('member_id', '=', memberId)
        .executeTakeFirst();
      // Whether a code is out for it, and until when: the code itself is the
      // vault's alone (phone_code_expires, 0084).
      const live =
        row && !row.confirmed_at
          ? await sql<{
              at: Date | null;
            }>`select phone_code_expires(${memberId}::uuid) as at`.execute(trx)
          : null;
      return { row, expires: live?.rows[0]?.at ?? null };
    });
    const ready = await this.sms.ready(p);
    if (!row) return { phone: null, sms_ready: ready };
    return {
      phone: {
        masked: maskPhone(row.number),
        confirmed: row.confirmed_at !== null,
        confirmed_at: row.confirmed_at?.toISOString() ?? null,
        code_expires_at: expires?.toISOString() ?? null,
        updated_at: row.updated_at.toISOString(),
      },
      sms_ready: ready,
    };
  }

  /**
   * PUT /members/{id}/phone: the number, saved unconfirmed, and a code
   * texted to it. The same number again, unconfirmed, sends a new code; the
   * same number confirmed changes nothing. A confirmed number replaced is
   * told so, as best the vault can.
   */
  async put(
    p: Principal,
    memberId: string,
    typed: string,
    meta: RequestMeta,
  ): Promise<MemberPhoneView> {
    const { name } = await this.person(p, memberId);
    if (!(await this.sms.ready(p))) throw notSetUp();
    const number = parsePhone(typed, await this.sms.country(p));
    if (!number) throw invalid();
    const before = await withPrincipal(this.db, p, async (trx) => {
      const was = await trx
        .selectFrom('member_phone')
        .select(['number', 'confirmed_at'])
        .where('member_id', '=', memberId)
        .forUpdate()
        .executeTakeFirst();
      if (was && was.number === number) return was;
      const values = {
        number,
        confirmed_at: null,
        updated_by: p.accountId,
        updated_at: new Date(),
      };
      if (was) {
        await trx
          .updateTable('member_phone')
          .set(values)
          .where('member_id', '=', memberId)
          .execute();
      } else {
        await trx
          .insertInto('member_phone')
          .values({ member_id: memberId, household_id: p.householdId, ...values })
          .execute();
      }
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.phone_added',
        objectType: 'member',
        objectId: memberId,
        // Masked, never the number.
        detail: { number: maskPhone(number), replaced: was !== undefined },
        ip: meta.ip,
      });
      return was;
    });
    if (before?.number === number && before.confirmed_at) return this.view(p, memberId);
    if (before && before.number !== number && before.confirmed_at) {
      // The number it replaced is told, so a change nobody there made is
      // noticed. As best the vault can: it stops nothing.
      await this.sms
        .send(p.householdId, {
          to: before.number,
          memberId,
          kind: 'phone_changed',
          text: phoneChangedText(name),
        })
        .catch(() => undefined);
    }
    await this.issue(p, memberId, number, name);
    return this.view(p, memberId);
  }

  /** POST /members/{id}/phone/resend: a new code to the number saved, while it is unconfirmed. */
  async resend(p: Principal, memberId: string): Promise<MemberPhoneView> {
    const { name } = await this.person(p, memberId);
    if (!(await this.sms.ready(p))) throw notSetUp();
    const row = await withPrincipal(this.db, p, (trx) =>
      trx
        .selectFrom('member_phone')
        .select(['number', 'confirmed_at'])
        .where('member_id', '=', memberId)
        .executeTakeFirst(),
    );
    if (!row) throw noNumber();
    if (row.confirmed_at) {
      throw new ApiError(409, 'phone_confirmed', 'That number is confirmed already.');
    }
    await this.issue(p, memberId, row.number, name);
    return this.view(p, memberId);
  }

  /**
   * A new code for a number, texted: the ones before it end. At most 3 to a
   * number in 15 minutes and 10 in a day, however many ask at once. If the
   * text cannot be sent the code ends with it.
   */
  private async issue(p: Principal, memberId: string, number: string, name: string) {
    const hh = p.householdId;
    const made = await withSystem(this.db, hh, async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`phone_code:${hh}:${number}`}, 0))`.execute(
        trx,
      );
      const now = new Date();
      const dayStart = new Date(now.getTime() - 864e5);
      const windowStart = new Date(now.getTime() - PHONE_CODE_SENDS.windowMinutes * 60_000);
      // A code's row is kept a day, for the count; then it goes.
      await trx.deleteFrom('phone_code').where('sent_at', '<', dayStart).execute();
      const recent = await trx
        .selectFrom('phone_code')
        .select('sent_at')
        .where('number', '=', number)
        .where('sent_at', '>', dayStart)
        .orderBy('sent_at')
        .execute();
      const inWindow = recent.filter((r) => r.sent_at.getTime() > windowStart.getTime());
      const limit = (until: Date, message: string) =>
        new ApiError(429, 'phone_code_limit', message, {
          retriable: true,
          retryAfter: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)),
        });
      if (inWindow.length >= PHONE_CODE_SENDS.perWindow) {
        const oldest = inWindow[0]?.sent_at ?? now;
        throw limit(
          new Date(oldest.getTime() + PHONE_CODE_SENDS.windowMinutes * 60_000),
          `${PHONE_CODE_SENDS.perWindow} codes have been texted to that number in the last ${PHONE_CODE_SENDS.windowMinutes} minutes. Use the newest one, or wait a little and ask again.`,
        );
      }
      if (recent.length >= PHONE_CODE_SENDS.perDay) {
        const oldest = recent[0]?.sent_at ?? now;
        throw limit(
          new Date(oldest.getTime() + 864e5),
          `${PHONE_CODE_SENDS.perDay} codes have been texted to that number today. Use the newest one, or try again tomorrow.`,
        );
      }
      // Only the newest code works: the ones before it end now.
      await trx
        .updateTable('phone_code')
        .set({ expires_at: now })
        .where('member_id', '=', memberId)
        .where('used_at', 'is', null)
        .where('expires_at', '>', now)
        .execute();
      const id = randomUUID();
      const code = String(randomInt(0, 10 ** PHONE_CODE_DIGITS)).padStart(PHONE_CODE_DIGITS, '0');
      await trx
        .insertInto('phone_code')
        .values({
          id,
          household_id: hh,
          member_id: memberId,
          number,
          code_hash: this.codeHash(memberId, number, id, code),
          sent_at: now,
          expires_at: new Date(now.getTime() + PHONE_CODE_MINUTES * 60_000),
        })
        .execute();
      return { id, code };
    });
    try {
      await this.sms.send(hh, {
        to: number,
        memberId,
        kind: 'phone_code',
        text: phoneCodeText(made.code, name),
      });
    } catch (err) {
      // Not sent: the code ends, and is never typed; it still counts.
      await withSystem(this.db, hh, (trx) =>
        trx
          .updateTable('phone_code')
          .set({ expires_at: new Date() })
          .where('id', '=', made.id)
          .execute(),
      );
      throw err;
    }
  }

  /**
   * POST /members/{id}/phone/confirm: the code texted to the number. The
   * try is taken before the code is compared, so two at once cannot both
   * use the last; right, the code is used and the number confirmed — by the
   * vault, which alone may say so (0084).
   */
  async confirm(
    p: Principal,
    memberId: string,
    typed: string,
    meta: RequestMeta,
  ): Promise<MemberPhoneView> {
    await this.person(p, memberId);
    const number = await withPrincipal(this.db, p, (trx) =>
      trx
        .selectFrom('member_phone')
        .select(['number', 'confirmed_at'])
        .where('member_id', '=', memberId)
        .executeTakeFirst(),
    );
    if (!number) throw noNumber();
    if (number.confirmed_at) return this.view(p, memberId);
    const code = typed.replace(/[\s-]/g, '');
    const tried: Tried = await withSystem(this.db, p.householdId, async (trx) => {
      const live = await trx
        .selectFrom('phone_code')
        .select(['id', 'code_hash', 'attempts', 'expires_at', 'used_at'])
        .where('member_id', '=', memberId)
        .where('number', '=', number.number)
        .orderBy('sent_at', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      if (!live || live.used_at) return 'expired';
      if (live.attempts >= PHONE_CODE_TRIES) return 'too_many';
      if (live.expires_at.getTime() <= Date.now()) return 'expired';
      // The try, taken first.
      const reserved = await trx
        .updateTable('phone_code')
        .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
        .where('id', '=', live.id)
        .where('attempts', '<', PHONE_CODE_TRIES)
        .returning('attempts')
        .executeTakeFirst();
      if (!reserved) return 'too_many';
      const right =
        CODE.test(code) &&
        timingSafeEqual(this.codeHash(memberId, number.number, live.id, code), live.code_hash);
      if (!right) {
        return reserved.attempts >= PHONE_CODE_TRIES
          ? 'too_many'
          : { wrong: PHONE_CODE_TRIES - reserved.attempts };
      }
      await trx
        .updateTable('phone_code')
        .set({ used_at: new Date() })
        .where('id', '=', live.id)
        .execute();
      const confirmed = await trx
        .updateTable('member_phone')
        .set({ confirmed_at: new Date() })
        .where('member_id', '=', memberId)
        .where('number', '=', number.number)
        .where('confirmed_at', 'is', null)
        .returning('member_id')
        .executeTakeFirst();
      // The number changed while the code was typed: this code was for another.
      if (!confirmed) return 'expired';
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'member.phone_confirmed',
        objectType: 'member',
        objectId: memberId,
        detail: { number: maskPhone(number.number) },
        ip: meta.ip,
      });
      return 'right';
    });
    if (tried === 'expired') throw expired();
    if (tried === 'too_many') throw tooMany();
    if (tried !== 'right') throw wrong(tried.wrong);
    return this.view(p, memberId);
  }

  /** DELETE /members/{id}/phone: the number gone; a code still out for it confirms nothing. */
  async remove(p: Principal, memberId: string, meta: RequestMeta): Promise<MemberPhoneView> {
    await this.person(p, memberId);
    const gone = await withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .deleteFrom('member_phone')
        .where('member_id', '=', memberId)
        .returning('number')
        .executeTakeFirst();
      if (row) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'member.phone_removed',
          objectType: 'member',
          objectId: memberId,
          detail: { number: maskPhone(row.number) },
          ip: meta.ip,
        });
      }
      return row;
    });
    // A code still out for it confirms nothing now: there is no number for
    // it to confirm, and a number saved again sends a new code, which ends it.
    if (!gone) throw noNumber();
    return this.view(p, memberId);
  }
}
