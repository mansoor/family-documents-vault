import { appendAudit, withSystem, type Db } from '@fdv/db';
import { LINK_TEXTS, type SmsKind } from '@fdv/shared';
import { sql } from 'kysely';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { z } from 'zod';
import type { Principal, RequestMeta } from './auth/service.js';
import { ApiError } from './errors.js';
import { notSetUp, type SmsService } from './sms/service.js';

/**
 * A link or a request texted to whoever it is for (0.9.0-dev.69; the
 * owner's feedback of 18 Nov 2026), as one is emailed: the parts a share
 * link's and a request's text have in common.
 *
 * The text goes through the household's own text messages (SmsService,
 * Settings → Text messages), counted against their monthly cap — and link
 * texts against their own share of it (LINK_TEXTS_CAP_SHARE, sms-send.ts),
 * so the codes people sign in with always have room. Each is one row of
 * share_link_email or upload_request_email with `way = 'sms'` (0117), the
 * number masked: what the day's sends are counted by, and what Sharing says
 * of where it went. Never the number itself, nor the link, in any log.
 *
 * As every other text the vault sends (a code, a number's confirmation),
 * the send is reserved — counted, its row and its line in the activity log
 * written — in a transaction that is over before SMS Gate is asked: a
 * transaction held open across the HTTP call to the phone held a pool
 * connection, and sendSms needs more of them, so a handful of texts at once
 * could stop the whole API (the dev.69 review).
 */

/** POST /shares/{id}/text and /upload-requests/{id}/text: the mobile number, as typed. */
export const linkTextBody = z.object({ to: z.string().trim().min(1).max(40) }).strict();

/** Whether the household's texts are set up and tested now, asked in the caller's own transaction. */
export async function textsReady(trx: Db, sms: SmsService | null): Promise<boolean> {
  if (!sms) return false;
  const r = await sql<{ ready: boolean }>`select sms_ready() as ready`.execute(trx);
  return r.rows[0]?.ready === true;
}

/** A country's name, as a person says it: "the United Kingdom". */
function countryName(code: string): string {
  try {
    const name = new Intl.DisplayNames(['en-GB'], { type: 'region' }).of(code) ?? code;
    return /^(United|Netherlands|Philippines|Czech|Dominican|Bahamas|Gambia)/.test(name)
      ? `the ${name}`
      : name;
  } catch {
    return code;
  }
}

const wrongNumber = (message: string) =>
  new ApiError(422, 'phone_number_invalid', message, { detail: 'to' });

/**
 * The number typed, as E.164, read in the household's country (its owners'
 * choice in Settings → Text messages, else the UK). Refused while texts are
 * not set up and tested (`409 sms_not_set_up`); and (`422
 * phone_number_invalid`) for anything but a mobile number — a premium-rate,
 * shared-cost, freephone, UAN, VoIP or landline number, or one the
 * numbering plan does not know, could cost the household or reach nobody —
 * and for a number outside the household's country (the dev.69 review).
 */
export async function textNumber(
  sms: SmsService | null,
  p: Principal,
  typed: string,
): Promise<string> {
  if (!sms || !(await sms.ready(p))) throw notSetUp();
  const country = await sms.country(p);
  const text = typed.trim();
  if (!text || text.length > 40 || !/^[+0-9 ()\-.]+$/.test(text)) {
    throw wrongNumber(
      'That doesn’t look like a mobile number. Type it as you would dial it, such as 07400 123456.',
    );
  }
  let parsed;
  try {
    parsed = parsePhoneNumberFromString(text, { defaultCountry: country as CountryCode });
  } catch {
    parsed = undefined;
  }
  if (!parsed || !parsed.isValid()) {
    throw wrongNumber(
      'That doesn’t look like a mobile number. Check it, and type it as you would dial it.',
    );
  }
  if (parsed.country !== country) {
    throw wrongNumber(
      `Only numbers in ${countryName(country)} can be texted. Email the link instead, or copy it and send it yourself.`,
    );
  }
  const type = parsed.getType();
  if (type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE') {
    throw wrongNumber(
      type === 'PREMIUM_RATE' || type === 'SHARED_COST' || type === 'TOLL_FREE' || type === 'UAN'
        ? 'That number isn’t a mobile one: texts go only to mobile numbers, never to premium-rate, shared-cost or freephone ones.'
        : 'That number isn’t a mobile one, so a text can’t reach it. Type their mobile number.',
    );
  }
  return parsed.number;
}

/** The tables a link's or a request's sends are kept in, with the column naming which. */
type SendsTable = 'share_link_email' | 'upload_request_email';
const ONE_OF: Record<SendsTable, 'share_id' | 'request_id'> = {
  share_link_email: 'share_id',
  upload_request_email: 'request_id',
};

/**
 * The day's texts of one link or request, and of its sender — links and
 * requests together, under one hold of the sender's sends (one at a time,
 * so the counts hold however many ask at once): at most LINK_TEXTS a link
 * or request, and a person, in any day (`429 text_link_limit`). A text SMS
 * Gate did not take still counts, as a code's does. Answers how many more
 * this one may be texted today, once this one has gone.
 */
export async function textsLeft(
  trx: Db,
  table: SendsTable,
  p: Principal,
  id: string,
  what: 'link' | 'request',
): Promise<number> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`link_texts:${p.accountId}`}, 0))`.execute(
    trx,
  );
  const now = Date.now();
  const since = new Date(now - 864e5);
  const sent = await sql<{ t: SendsTable; one: string | null; sent_at: Date }>`
    select 'share_link_email' as t, share_id::text as one, sent_at from share_link_email
     where sent_by = ${p.accountId} and way in ('sms', 'sms_not_sent') and sent_at > ${since}
    union all
    select 'upload_request_email' as t, request_id::text as one, sent_at from upload_request_email
     where sent_by = ${p.accountId} and way in ('sms', 'sms_not_sent') and sent_at > ${since}
     order by sent_at`.execute(trx);
  const all = sent.rows;
  const forOne = all.filter((s) => s.t === table && s.one === id);
  const tooMany = (oldest: Date | undefined, message: string) =>
    new ApiError(429, 'text_link_limit', message, {
      retriable: true,
      retryAfter: Math.max(1, Math.ceil(((oldest?.getTime() ?? now) + 864e5 - now) / 1000)),
    });
  if (forOne.length >= LINK_TEXTS.perLinkPerDay) {
    throw tooMany(
      forOne[0]?.sent_at,
      `This ${what} has been texted ${LINK_TEXTS.perLinkPerDay} times today, which is as many as the vault sends. Copy the link and send it yourself, or try again tomorrow.`,
    );
  }
  if (all.length >= LINK_TEXTS.perAccountPerDay) {
    throw tooMany(
      all[0]?.sent_at,
      `You have texted ${LINK_TEXTS.perAccountPerDay} links and requests today, which is as many as the vault sends for one person. Copy the link and send it yourself, or try again tomorrow.`,
    );
  }
  return LINK_TEXTS.perLinkPerDay - forOne.length - 1;
}

/** A text reserved, its transaction over: what sending it, or undoing it, needs. */
export interface TextReserved {
  table: SendsTable;
  /** The reservation's row. */
  rowId: string;
  /** The link's or the request's id. */
  oneId: string;
  sentAt: Date;
  to: string;
  masked: string;
  kind: Extract<SmsKind, 'share_link' | 'request_link'>;
  text: string;
  /** Where its lines in the activity log go, and what they say besides. */
  audit: {
    action: 'share_link.text_not_sent' | 'upload_request.text_not_sent';
    objectType: string;
    objectId: string | null;
    detail: Record<string, unknown>;
  };
}

/** The reservation row, written as its sender inside the transaction that counted it. */
export async function reserveText(
  trx: Db,
  p: Principal,
  table: SendsTable,
  oneId: string,
  masked: string,
  sentAt: Date,
): Promise<string> {
  const common = {
    household_id: p.householdId,
    sent_by: p.accountId,
    to_masked: masked,
    way: 'sms' as const,
    sent_at: sentAt,
  };
  const row =
    table === 'share_link_email'
      ? await trx
          .insertInto('share_link_email')
          .values({ ...common, share_id: oneId })
          .returning('id')
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('upload_request_email')
          .values({ ...common, request_id: oneId })
          .returning('id')
          .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Sends a reserved text, outside any transaction. Not sent, the
 * reservation is undone as the vault, and the activity log says so with
 * why in a word:
 *  - refused before SMS Gate was asked — texts not set up, or this month's
 *    (or link texts' share of them) all sent — its row goes, as a code's
 *    does: nothing was sent, and nothing is counted;
 *  - asked, and not taken by SMS Gate — its row becomes `sms_not_sent`: it
 *    still counts towards the day's texts, as a code's does, but Sharing
 *    never says the link went there.
 * Then the vault's own refusal is thrown, in its own words.
 */
export async function sendReserved(
  db: Db,
  sms: SmsService,
  p: Principal,
  r: TextReserved,
  meta: RequestMeta,
): Promise<void> {
  try {
    await sms.send(p.householdId, { to: r.to, kind: r.kind, text: r.text });
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'sms_not_sent';
    const reason =
      code === 'sms_not_set_up'
        ? 'not_set_up'
        : code === 'sms_cap_reached'
          ? 'cap_reached'
          : 'not_sent';
    await withSystem(db, p.householdId, async (trx) => {
      await sql`delete from ${sql.table(r.table)} where id = ${r.rowId}`.execute(trx);
      if (reason === 'not_sent') {
        await sql`insert into ${sql.table(r.table)}
            (household_id, ${sql.ref(ONE_OF[r.table])}, sent_by, to_masked, way, sent_at)
          values (${p.householdId}, ${r.oneId}, ${p.accountId}, ${r.masked}, 'sms_not_sent', ${r.sentAt})`.execute(
          trx,
        );
      }
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: r.audit.action,
        objectType: r.audit.objectType,
        objectId: r.audit.objectId,
        detail: { ...r.audit.detail, reason },
        ip: meta.ip,
      });
    }).catch(() => undefined);
    throw err;
  }
}
