import { phoneTail, type SmsKind, type SmsMode, type SmsState } from '@fdv/shared';
import { sql } from 'kysely';
import type { Db } from './client.js';
import {
  SmsProviderError,
  type SmsConnection,
  type SmsProblem,
  type SmsProvider,
  type SmsProviderFactory,
} from './sms-gate.js';
import { householdZone } from './zone.js';

/**
 * Sending one text (0.9.0, SMS1; shared with the worker since SMS2): the
 * one way the vault sends any, whoever asks — the API for a test and the
 * codes that confirm a number, the worker for reminders, alerts and the
 * news of a link opened.
 *
 * Every text is one row of sms_message — whom, what kind, what became of
 * it, never its words — counted against the household's monthly cap on the
 * family's own calendar, whatever its kind. Nothing is written, and nothing
 * sent, while the household has no SMS Gate, or one no test has passed (a
 * test excepted), or this month's texts are all sent. One household's sends
 * wait for each other, so the count holds however many ask at once.
 *
 * Written as the vault (sms_message is the vault's to write, 0084), in the
 * household's scope: the API and the worker each say so themselves, as
 * `asVault`, for nothing in the packages but client.ts asks as the vault.
 */

/** The household's scope, as the vault itself: withSystem(db, householdId, fn), from the caller. */
export type AsVault = <T>(fn: (trx: Db) => Promise<T>) => Promise<T>;

/** One text, as asked for. */
export interface SmsRequest {
  /** E.164. */
  to: string;
  /** Whom it is for, when it is for somebody of the family. */
  memberId?: string | null;
  kind: SmsKind;
  text: string;
}

/** What a send did: the row it wrote, and SMS Gate's id and word for it. */
export interface SmsDone {
  messageId: string;
  providerId: string;
  state: SmsState;
}

/** A household's settings, as the vault itself reads them to send. */
export interface SmsSending {
  mode: SmsMode;
  base_url: string;
  username: string;
  password_encrypted: Buffer | null;
  country: string;
  monthly_cap: number;
  status: 'untested' | 'ok' | 'failed';
}

/**
 * How a send reaches SMS Gate: the sealed password opened (openSmsPassword
 * under the key derived for it, from @fdv/crypto), and whatever sends —
 * SMS Gate, unless a test stands in.
 */
export interface SmsWay {
  open: (sealed: Buffer, householdId: string, to: Omit<SmsConnection, 'password'>) => string;
  provider: SmsProviderFactory;
}

/**
 * What a send came to:
 *  - `refused`: nothing written, nothing sent — `not_set_up` (no SMS Gate,
 *    no password, or no test passed) or `cap_reached` (this month's are all
 *    sent).
 *  - `problem`: written, but SMS Gate never took it (its row says not_sent).
 *  - `sent`: SMS Gate took it.
 */
export type SmsOutcome =
  | { refused: 'not_set_up' }
  | { refused: 'cap_reached'; cap: number }
  | { problem: SmsProviderError; messageId: string; settings: SmsSending }
  | { sent: SmsDone; provider: SmsProvider; settings: SmsSending };

/** In plain words, what went wrong with SMS Gate: for Settings, and for whoever asked for a text. */
export function smsProblemWords(problem: SmsProblem, mode: SmsMode, status?: number): string {
  switch (problem) {
    case 'unauthorised':
      return 'SMS Gate refused the username or password. Check them in the SMS Gate app, and type them again.';
    case 'timeout':
      return mode === 'local'
        ? 'SMS Gate didn’t answer within 10 seconds. Check the phone is on, on the same network as the vault, and the app’s local server is running.'
        : 'SMS Gate didn’t answer within 10 seconds. Check the address, and that the phone is on and the app is running.';
    case 'unreachable':
      return mode === 'local'
        ? 'The vault couldn’t reach SMS Gate at that address. Check the address the app shows under Local server, and that the phone is on the same network.'
        : 'The vault couldn’t reach SMS Gate at that address. Check the address.';
    case 'address_refused':
      return 'That address is inside the vault’s own network. Only the local server may be: choose Local server on your network for it.';
    case 'not_found':
      return 'SMS Gate no longer knows the text it was sent.';
    case 'refused':
      return `SMS Gate didn’t take the text${status ? ` (it answered ${status})` : ''}. Check the address points at SMS Gate’s API.`;
  }
}

/**
 * The texts sent this calendar month on the family's clock, every kind
 * counted: what the cap is held to. Asked inside the household's scope.
 */
export async function smsMonthCount(trx: Db): Promise<number> {
  const hh = await trx.selectFrom('household').select('timezone').executeTakeFirst();
  const zone = householdZone(hh?.timezone);
  const r = await sql<{ n: number }>`
    select count(*)::int as n from sms_message
     where state <> 'not_sent'
       and created_at >= (date_trunc('month', now() at time zone ${zone}) at time zone ${zone})`.execute(
    trx,
  );
  return r.rows[0]?.n ?? 0;
}

/** What became of a text, as SMS Gate said: the vault's to write. */
export async function markSms(
  asVault: AsVault,
  messageId: string,
  v: { provider_id?: string; state: SmsState; error?: string | null },
): Promise<void> {
  await asVault((trx) =>
    trx
      .updateTable('sms_message')
      .set({ ...v, updated_at: new Date() })
      .where('id', '=', messageId)
      .execute(),
  );
}

/**
 * Writes a text's row and asks SMS Gate to send it, or says why not. The
 * vault's to do (sms_message is the vault's to write, 0084): whoever asks
 * has been checked first, as themselves.
 */
export async function sendSms(
  asVault: AsVault,
  way: SmsWay,
  householdId: string,
  r: SmsRequest,
): Promise<SmsOutcome> {
  type Held =
    Extract<SmsOutcome, { refused: unknown }> | { settings: SmsSending; messageId: string };
  const held = await asVault(async (trx): Promise<Held> => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`sms:${householdId}`}, 0))`.execute(
      trx,
    );
    const s = await trx
      .selectFrom('sms_settings')
      .select([
        'mode',
        'base_url',
        'username',
        'password_encrypted',
        'country',
        'monthly_cap',
        'status',
      ])
      .executeTakeFirst();
    if (!s || !s.password_encrypted) return { refused: 'not_set_up' };
    if (s.status !== 'ok' && r.kind !== 'test') return { refused: 'not_set_up' };
    if ((await smsMonthCount(trx)) >= s.monthly_cap) {
      return { refused: 'cap_reached', cap: s.monthly_cap };
    }
    const row = await trx
      .insertInto('sms_message')
      .values({
        household_id: householdId,
        member_id: r.memberId ?? null,
        number_tail: phoneTail(r.to),
        kind: r.kind,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { settings: s, messageId: row.id };
  });
  if ('refused' in held) return held;
  const s = held.settings;
  const provider = way.provider({
    mode: s.mode,
    baseUrl: s.base_url,
    username: s.username,
    password: way.open(s.password_encrypted as Buffer, householdId, {
      mode: s.mode,
      baseUrl: s.base_url,
      username: s.username,
    }),
  });
  try {
    const sent = await provider.send(r.to, r.text);
    await markSms(asVault, held.messageId, { provider_id: sent.id, state: sent.state });
    return {
      sent: { messageId: held.messageId, providerId: sent.id, state: sent.state },
      provider,
      settings: s,
    };
  } catch (err) {
    const problem =
      err instanceof SmsProviderError
        ? err
        : new SmsProviderError('unreachable', (err as Error).message);
    await markSms(asVault, held.messageId, {
      state: 'not_sent',
      error: smsProblemWords(problem.problem, s.mode, problem.status),
    });
    return { problem, messageId: held.messageId, settings: s };
  }
}
