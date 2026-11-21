import {
  LINK_TEXT_KINDS,
  LINK_TEXTS_CAP_SHARE,
  phoneTail,
  smsGateLocalRefused,
  smsGatePortWords,
  type SmsKind,
  type SmsMode,
  type SmsProviderKind,
  type SmsState,
  type SmsVia,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { Db } from './client.js';
import {
  SmsProviderError,
  type SmsConnection,
  type SmsProblem,
  type SmsProvider,
  type SmsProviderFactory,
} from './sms-gate.js';
import { twilioErrorWords } from './sms-twilio.js';
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
 * sent, while the household has no provider set up (SMS Gate or Twilio),
 * or one no test has passed (a test excepted), or this month's texts are
 * all sent. One household's sends wait for each other, so the count holds
 * however many ask at once.
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

/** What a send did: the row it wrote, and the provider's id and word for it. */
export interface SmsDone {
  messageId: string;
  /**
   * Null when the provider did not say whether it took the text
   * (`unconfirmed`): it may have gone, so nothing can be asked after it.
   */
  providerId: string | null;
  state: SmsState;
}

/** A household's settings, as the vault itself reads them to send. */
export interface SmsSending {
  /** Who sends the texts (0.9.0-dev.71). */
  provider: SmsProviderKind;
  /** SMS Gate's; null for Twilio. */
  mode: SmsMode | null;
  base_url: string | null;
  username: string | null;
  password_encrypted: Buffer | null;
  /** Twilio's; null for SMS Gate. */
  twilio_account_sid: string | null;
  twilio_from: string | null;
  twilio_messaging_service_sid: string | null;
  twilio_token_encrypted: Buffer | null;
  country: string;
  monthly_cap: number;
  status: 'untested' | 'ok' | 'failed';
}

/** What a provider's sealed secret was sealed for: SMS Gate's sign-in, or Twilio's account. */
export type SmsSealedFor =
  | { provider?: 'sms_gate' | undefined; mode: SmsMode; baseUrl: string; username: string }
  | { provider: 'twilio'; accountSid: string };

/**
 * How a send reaches the provider: its sealed secret opened (openSmsSecret
 * under the key derived for it, from @fdv/crypto), and whatever sends —
 * SMS Gate or Twilio, unless a test stands in.
 */
export interface SmsWay {
  open: (sealed: Buffer, householdId: string, to: SmsSealedFor) => string;
  provider: SmsProviderFactory;
}

/** How a household's texts go, for the words said of a problem. */
export function smsVia(s: { provider: SmsProviderKind; mode: SmsMode | null }): SmsVia {
  return s.provider === 'twilio' ? 'twilio' : (s.mode ?? 'local');
}

/** The household's settings as the provider they chose, its secret opened; null without one. */
export function smsConnection(
  way: SmsWay,
  householdId: string,
  s: SmsSending,
): SmsConnection | null {
  if (s.provider === 'twilio') {
    if (!s.twilio_token_encrypted || !s.twilio_account_sid) return null;
    return {
      provider: 'twilio',
      accountSid: s.twilio_account_sid,
      authToken: way.open(s.twilio_token_encrypted, householdId, {
        provider: 'twilio',
        accountSid: s.twilio_account_sid,
      }),
      from: s.twilio_from,
      messagingServiceSid: s.twilio_messaging_service_sid,
    };
  }
  if (!s.password_encrypted || !s.mode || s.base_url === null || s.username === null) return null;
  return {
    mode: s.mode,
    baseUrl: s.base_url,
    username: s.username,
    password: way.open(s.password_encrypted, householdId, {
      mode: s.mode,
      baseUrl: s.base_url,
      username: s.username,
    }),
  };
}

/** Whether the provider chosen has its secret: nothing is sent without it. */
export function smsHasSecret(s: {
  provider: SmsProviderKind;
  password_encrypted: Buffer | null;
  twilio_token_encrypted: Buffer | null;
}): boolean {
  return s.provider === 'twilio'
    ? s.twilio_token_encrypted !== null
    : s.password_encrypted !== null;
}

/**
 * What a send came to:
 *  - `refused`: nothing written, nothing sent — `not_set_up` (no provider,
 *    no password, or no test passed) or `cap_reached` (this month's are all
 *    sent).
 *  - `problem`: written, but the provider never took it (its row says not_sent).
 *  - `sent`: the provider took it.
 */
export type SmsOutcome =
  | { refused: 'not_set_up' }
  /**
   * `links`: a link's or a request's text (0.9.0-dev.69), refused at link
   * texts' own share of the cap (`cap` is that share), so codes keep room.
   */
  | { refused: 'cap_reached'; cap: number; links?: true }
  | { problem: SmsProviderError; messageId: string; settings: SmsSending }
  /**
   * `unconfirmed`: the send may have reached the provider and it did not say
   * whether it took it (0.9.0-dev.71, Twilio's 5xx or a broken connection).
   * Counted as sent — its row `pending`, no provider id, the words saying so
   * — so nothing sends it again by itself: that could send it twice.
   */
  | { sent: SmsDone; provider: SmsProvider; settings: SmsSending; unconfirmed?: true };

/** What a text Twilio may or may not have taken is said as, in its row and to whoever asked. */
export const UNCONFIRMED_TWILIO =
  'Twilio didn’t say whether it took the text. It may still arrive: the vault won’t send it again by itself. Check the Twilio Console’s logs.';

/** In plain words, what went wrong with Twilio: for Settings, and for whoever asked for a text. */
function twilioProblemWords(problem: SmsProblem, status?: number, code?: number): string {
  switch (problem) {
    case 'unauthorised':
      return 'Twilio refused the Account SID or Auth Token. Check them in the Twilio Console, and type the Auth Token again.';
    case 'timeout':
      return 'Twilio didn’t answer within 10 seconds. Check the vault can reach the internet, then try again.';
    case 'unreachable':
    case 'address_refused':
    case 'port_refused':
      return 'The vault couldn’t reach Twilio. Check the vault can reach the internet (api.twilio.com).';
    case 'not_found':
      return 'Twilio no longer knows the text it was sent.';
    case 'unconfirmed':
      return UNCONFIRMED_TWILIO;
    case 'refused': {
      if (status === 429) {
        return 'Twilio asked the vault to slow down (it answered 429). Try again in a minute.';
      }
      const why = twilioErrorWords(code);
      return `Twilio didn’t take the text${status ? ` (it answered ${status})` : ''}.${
        why ? ` ${why}.` : ' Check the number or Messaging Service it sends from.'
      }`;
    }
  }
}

/** What any problem reaching SMS Gate's local server is said as (0.9.0-dev.77). */
export const SMS_GATE_LOCAL_UNREACHABLE =
  'The vault couldn’t reach SMS Gate on the phone. Check the address the app shows under Local server (its port is usually 8080), the username and password, and that the phone is on the same network as the vault with the app’s local server running.';

/**
 * In plain words, what went wrong with the household's provider: for
 * Settings, and for whoever asked for a text. `code` is the provider's own
 * (Twilio's error codes).
 */
export function smsProblemWords(
  problem: SmsProblem,
  via: SmsVia,
  status?: number,
  code?: number,
): string {
  if (via === 'twilio') return twilioProblemWords(problem, status, code);
  const mode = via;
  // A port the vault does not reach the local server on: said, with the
  // setting that allows others — the vault asked nothing of the network.
  if (problem === 'port_refused') return smsGatePortWords(code);
  // The local server (0.9.0-dev.77): one problem, whichever way it failed —
  // no answer, no connection, an address refused, a password refused, or
  // some other answer. Which it was would tell an owner what else listens
  // on the home network; it is in the server's log alone.
  if (mode === 'local' && problem !== 'unconfirmed' && problem !== 'not_found') {
    return SMS_GATE_LOCAL_UNREACHABLE;
  }
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
    case 'unconfirmed':
      return 'SMS Gate didn’t say whether it took the text. It may still arrive: the vault won’t send it again by itself.';
    case 'refused':
      return `SMS Gate didn’t take the text${status ? ` (it answered ${status})` : ''}. Check the address points at SMS Gate’s API.`;
  }
}

/**
 * The texts sent this calendar month on the family's clock, every kind
 * counted: what the cap is held to. Asked inside the household's scope.
 */
export async function smsMonthCount(
  trx: Db,
  /** Only these kinds (0.9.0-dev.69: link texts' own share); every kind when absent. */
  kinds?: readonly SmsKind[],
): Promise<number> {
  const hh = await trx.selectFrom('household').select('timezone').executeTakeFirst();
  const zone = householdZone(hh?.timezone);
  const r = await sql<{ n: number }>`
    select count(*)::int as n from sms_message
     where state <> 'not_sent'
       and (${kinds === undefined} or kind = any(${kinds ? [...kinds] : []}::text[]))
       and created_at >= (date_trunc('month', now() at time zone ${zone}) at time zone ${zone})`.execute(
    trx,
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * The household's SMS Gate settings failed, with why, while they are still
 * the local server at this address: an address the vault does not reach as
 * it is saved. The vault's to write, as a test's outcome is; no text but a
 * test goes until the address is changed and a test passes.
 */
export async function smsSettingsUnusable(
  asVault: AsVault,
  baseUrl: string,
  words: string,
): Promise<boolean> {
  const changed = await asVault((trx) =>
    trx
      .updateTable('sms_settings')
      .set({ status: 'failed', last_error: words })
      .where('provider', '=', 'sms_gate')
      .where('mode', '=', 'local')
      .where('base_url', '=', baseUrl)
      .where((eb) =>
        eb.or([eb('status', '<>', 'failed'), eb('last_error', 'is distinct from', words)]),
      )
      .returning('household_id')
      .execute(),
  );
  return changed.length > 0;
}

/** What became of a text, as its provider said: the vault's to write. */
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
 * Writes a text's row and asks the household's provider to send it, or says why not. The
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
        'provider',
        'mode',
        'base_url',
        'username',
        'password_encrypted',
        'twilio_account_sid',
        'twilio_from',
        'twilio_messaging_service_sid',
        'twilio_token_encrypted',
        'country',
        'monthly_cap',
        'status',
      ])
      .executeTakeFirst();
    if (!s || !smsHasSecret(s)) return { refused: 'not_set_up' };
    if (s.status !== 'ok' && r.kind !== 'test') return { refused: 'not_set_up' };
    if ((await smsMonthCount(trx)) >= s.monthly_cap) {
      return { refused: 'cap_reached', cap: s.monthly_cap };
    }
    // A link's or a request's text (0.9.0-dev.69) takes no more than its
    // share of the month's texts, so the codes people sign in, confirm it's
    // them and reset a password with always have room (the dev.69 review).
    if ((LINK_TEXT_KINDS as readonly string[]).includes(r.kind)) {
      const share = Math.floor(s.monthly_cap * LINK_TEXTS_CAP_SHARE);
      if ((await smsMonthCount(trx, LINK_TEXT_KINDS)) >= share) {
        return { refused: 'cap_reached', cap: share, links: true };
      }
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
  const connection = smsConnection(way, householdId, s);
  // Checked under the lock above: what the chosen provider needs is there.
  if (!connection) throw new Error('the household’s text messages lost their secret');
  const provider = way.provider(connection);
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
    if (problem.problem === 'unconfirmed') {
      // It may have gone: counted, kept as sent with its delivery unknown
      // (`pending`, no provider id), and told as sent, so neither the vault
      // nor whoever asked sends it again by itself.
      const words = smsProblemWords(problem.problem, smsVia(s), problem.status, problem.code);
      await markSms(asVault, held.messageId, { state: 'pending', error: words });
      return {
        sent: { messageId: held.messageId, providerId: null, state: 'pending' },
        provider,
        settings: s,
        unconfirmed: true,
      };
    }
    const words = smsProblemWords(problem.problem, smsVia(s), problem.status, problem.code);
    await markSms(asVault, held.messageId, { state: 'not_sent', error: words });
    // A local server the vault no longer reaches as it is saved — a port off
    // FDV_SMS_GATE_ALLOWED_PORTS, or an address of its own (0.9.0-dev.77; an
    // older release saved either): no text can go until the address is
    // changed. The settings say so in Settings, and texts stop being
    // offered, rather than each failing on its own.
    if (
      s.provider === 'sms_gate' &&
      s.mode === 'local' &&
      s.base_url !== null &&
      (problem.problem === 'port_refused' || smsGateLocalRefused(s.base_url) === 'own')
    ) {
      await smsSettingsUnusable(asVault, s.base_url, words);
    }
    return { problem, messageId: held.messageId, settings: s };
  }
}
