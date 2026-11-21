import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { openSmsSecret, sealSmsPassword, sealTwilioToken } from '@fdv/crypto';
import {
  appendAudit,
  markSms,
  sendSms,
  smsMonthCount,
  smsProblemWords,
  smsProvidersWith,
  smsSettingsUnusable,
  SmsProviderError,
  smsVia,
  withPrincipal,
  withSystem,
  type Db,
  type AsVault,
  type SmsDone,
  type SmsOutcome,
  type SmsProviderFactory,
  type SmsRequest,
  type SmsWay,
} from '@fdv/db';
import {
  E164,
  isLoopbackName,
  isPhoneCountry,
  isPrivateAddress,
  parsePhone,
  SMS_CAP_MAX,
  SMS_CAP_MIN,
  SMS_CLOUD_URL,
  SMS_DEFAULT_CAP,
  SMS_DEFAULT_COUNTRY,
  SMS_GATE_LOCAL_PORTS,
  SMS_TEST_TEXT,
  smsGateLocalRefused,
  smsGatePort,
  smsGatePortWords,
  SMS_TEST_WAIT_SECONDS,
  TWILIO_ACCOUNT_SID,
  TWILIO_MESSAGING_SERVICE_SID,
  type SmsGateSettingsInput,
  type SmsMode,
  type SmsSettingsInput,
  type SmsSettingsView,
  type SmsState,
  type SmsTestResult,
  type SmsVia,
  type TwilioSettingsInput,
} from '@fdv/shared';
import { sql } from 'kysely';
import type { AlertRequest } from '../alert-job.js';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { cleanWords } from '@fdv/db';

/**
 * Text messages (0.9.0, SMS1): the household's own SMS Gate, as an owner
 * sets it up in Settings, and the one way the vault sends a text.
 *
 * An owner chooses how the vault reaches SMS Gate — the local server on the
 * home network, SMS Gate's cloud relay, or a server of their own — and
 * types its sign-in. The password is sealed under a key derived from the
 * master key with the household, mode, address and sign-in bound in, and is
 * never returned, logged or put in an export. Saved, the settings are
 * untested, and nothing but a test is sent: a test passes once SMS Gate has
 * sent it (`Sent` or `Delivered`) within twenty seconds, and only then does
 * the vault send other texts. That a test passed is the vault's word: the
 * database takes it from nobody signed in (0084).
 *
 * Every text is one row of sms_message — whom, what kind, what became of it,
 * never its words — counted against the household's monthly cap on the
 * family's own calendar. Since notifications by text (SMS2) the worker
 * sends too, through the same `sendSms` (@fdv/db): one cap, one log.
 *
 * Since 0.9.0-dev.71 an owner may choose Twilio instead of SMS Gate: its
 * Account SID, its Auth Token (sealed as SMS Gate's password is, with the
 * household and Account SID bound in), and a From number or a Messaging
 * Service. One provider at a time: switching clears the other's settings,
 * secret and all, and waits for a test of its own.
 */

/** Where a cloud or private server's name is, as the vault would reach it. */
export type Resolve = (host: string) => Promise<string[]>;
const resolveHost: Resolve = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

const ownersOnly = () => new ApiError(403, 'forbidden', 'Only an owner can set up text messages.');
const bad = (words: string) => new ApiError(422, 'validation_failed', words);

export const notSetUp = () =>
  new ApiError(
    409,
    'sms_not_set_up',
    'Text messages aren’t set up for this household yet. An owner can set them up in Settings, under Text messages.',
  );

/** What an owner is told of a local server's address that is the vault's own (0.9.0-dev.77). */
const OWN_ADDRESS =
  'That address is the vault’s own, not a phone on your network. Type the address the SMS Gate app shows under Local server, such as http://192.168.1.20:8080.';

/** A control character: never in a sign-in. */
const CONTROL = /\p{Cc}/u;

/** What a text that failed is said as: the provider's own words beside ours. */
const failedWords = (via: SmsVia, error: string | undefined) =>
  via === 'twilio'
    ? `Twilio couldn’t deliver the text.${error ? ` ${error}.` : ' Check the number, and the logs in the Twilio Console.'}`
    : `The phone couldn’t send the text. Check it has signal and credit.${error ? ` SMS Gate said: ${error}` : ''}`;

/** A control character, or a space: never in a Twilio Auth Token. */
const NOT_A_TOKEN = /[\p{Cc}\s]/u;

/** A number as typed for Twilio's From, as E.164: "+44 7700 900123" is "+447700900123". */
const fromNumber = (typed: string) => typed.replace(/[\s().-]/g, '');

/** The message an owner, or whoever asked for a text, is given when it was not sent. */
const notSent = (words: string) =>
  new ApiError(503, 'sms_not_sent', `The text couldn’t be sent. ${words}`, {
    retriable: true,
    retryAfter: 60,
  });

/** Where the provider's own detail goes: the API's log (server.ts), never the owner. */
export type SmsLog = (fields: Record<string, unknown>, message: string) => void;

export interface SmsOptions {
  /**
   * The key SMS Gate's password is sealed under (deriveKey(master,
   * SMS_PASSWORD_PURPOSE)). Without it none can be set, and nothing sent.
   */
  key?: Buffer;
  /** Whatever sends a text: SMS Gate, unless a test stands in. */
  provider?: SmsProviderFactory;
  /** Tests: DNS of their own, for a private server's name. */
  resolve?: Resolve;
  /** FDV_SMS_GATE_ALLOWED_PORTS: the ports SMS Gate's local server may be on. */
  localPorts?: readonly number[];
  /** Other owners told when the settings change. */
  alert?: (a: AlertRequest) => Promise<void>;
  /** How long a test waits for SMS Gate to send it, and how often it asks. */
  testWaitMs?: number;
  pollMs?: number;
}

export class SmsService {
  private readonly key: Buffer | null;
  private readonly provider: SmsProviderFactory;
  private readonly resolve: Resolve;
  private readonly alert: (a: AlertRequest) => Promise<void>;
  private readonly testWaitMs: number;
  private readonly pollMs: number;
  private log: SmsLog = () => undefined;
  private readonly localPorts: readonly number[];

  constructor(
    private readonly db: Db,
    opts: SmsOptions = {},
  ) {
    this.key = opts.key ?? null;
    this.localPorts = opts.localPorts ?? SMS_GATE_LOCAL_PORTS;
    this.provider = opts.provider ?? smsProvidersWith({ localPorts: this.localPorts });
    this.resolve = opts.resolve ?? resolveHost;
    this.alert = opts.alert ?? (async () => undefined);
    this.testWaitMs = opts.testWaitMs ?? SMS_TEST_WAIT_SECONDS * 1000;
    this.pollMs = opts.pollMs ?? 2000;
  }

  /** Where the provider's own detail goes: the API's log, once it has one (server.ts). */
  useLog(log: SmsLog): void {
    this.log = log;
  }

  /**
   * What a provider said, for the operator: the household is told less of
   * the local server (one "couldn't reach the phone", smsProblemWords).
   * Never a number, a password or a text's words.
   */
  private logProblem(householdId: string, via: SmsVia, problem: SmsProviderError): void {
    this.log(
      {
        event: 'sms_problem',
        household: householdId,
        via,
        problem: problem.problem,
        detail: problem.message,
        ...(problem.status !== undefined ? { status: problem.status } : {}),
        ...(problem.code !== undefined ? { code: problem.code } : {}),
      },
      'text message provider problem',
    );
  }

  // ------------------------------------------------------------ reading

  /** Whether the household sends texts now: set up, with a password, and a test passed. */
  async ready(p: Principal): Promise<boolean> {
    return withPrincipal(this.db, p, async (trx) => {
      const r = await sql<{ ready: boolean }>`select sms_ready() as ready`.execute(trx);
      return r.rows[0]?.ready === true;
    });
  }

  /** Where a number typed without + is, for the household: its owners' choice, else the UK. */
  async country(p: Principal): Promise<string> {
    return withPrincipal(this.db, p, async (trx) => {
      const r = await sql<{ country: string | null }>`select sms_country() as country`.execute(trx);
      return r.rows[0]?.country ?? SMS_DEFAULT_COUNTRY;
    });
  }

  /** GET /sms/settings: an owner's. Never the password, only whether one is set. */
  async get(p: Principal): Promise<SmsSettingsView> {
    if (p.role !== 'owner') throw ownersOnly();
    await this.stillUsable(p);
    return withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('sms_settings')
        .select([
          'provider',
          'mode',
          'base_url',
          'username',
          'twilio_account_sid',
          'twilio_from',
          'twilio_messaging_service_sid',
          'country',
          'monthly_cap',
          'status',
          'last_verified_at',
          'last_error',
          'updated_at',
          sql<boolean>`password_encrypted is not null`.as('has_password'),
          sql<boolean>`twilio_token_encrypted is not null`.as('has_token'),
        ])
        .executeTakeFirst();
      const sent = await smsMonthCount(trx);
      const twilio = row?.provider === 'twilio';
      return {
        settings: row
          ? {
              provider: row.provider,
              mode: twilio ? null : row.mode,
              base_url: twilio ? null : row.base_url,
              username: twilio ? null : row.username,
              password: !twilio && row.has_password ? 'set' : 'not_set',
              twilio:
                twilio && row.twilio_account_sid
                  ? {
                      account_sid: row.twilio_account_sid,
                      auth_token: row.has_token ? 'set' : 'not_set',
                      from: row.twilio_from,
                      messaging_service_sid: row.twilio_messaging_service_sid,
                    }
                  : null,
              country: row.country,
              monthly_cap: row.monthly_cap,
              status: row.status,
              last_verified_at: row.last_verified_at?.toISOString() ?? null,
              last_error: row.last_error,
              updated_at: row.updated_at.toISOString(),
            }
          : null,
        ready:
          row !== undefined && row.status === 'ok' && (twilio ? row.has_token : row.has_password),
        sent_this_month: sent,
        monthly_cap: row?.monthly_cap ?? SMS_DEFAULT_CAP,
        cloud_url: SMS_CLOUD_URL,
      };
    });
  }

  // ------------------------------------------------------------ setting

  /**
   * A local server saved by an older release, or before the operator
   * narrowed FDV_SMS_GATE_ALLOWED_PORTS, that the vault no longer reaches
   * as it is saved (0.9.0-dev.77): its settings failed, with why — the
   * port and the setting, or that the address is the vault's own — so the
   * owners see it in Settings, and texts stop being offered, rather than
   * each failing unsaid. Asked as the settings are read; a send that meets
   * it does the same (sendSms).
   */
  private async stillUsable(p: Principal): Promise<void> {
    // Read as the owner asking; written, if it must be, as the vault.
    const row = await withPrincipal(this.db, p, (trx) =>
      trx.selectFrom('sms_settings').select(['provider', 'mode', 'base_url']).executeTakeFirst(),
    );
    if (row?.provider !== 'sms_gate' || row.mode !== 'local' || !row.base_url) return;
    const refused = smsGateLocalRefused(row.base_url, this.localPorts);
    if (!refused) return;
    const words = refused === 'port' ? smsGatePortWords(smsGatePort(row.base_url)) : OWN_ADDRESS;
    await smsSettingsUnusable(this.vault(p.householdId), row.base_url, words);
  }

  /** An address as the vault will keep it, or why not. */
  private async address(mode: SmsMode, typed: string | null | undefined): Promise<string> {
    if (mode === 'cloud') return SMS_CLOUD_URL;
    const text = (typed ?? '').trim().replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw bad(
        mode === 'local'
          ? 'Type the address the SMS Gate app shows under Local server, such as http://192.168.1.20:8080.'
          : 'Type your server’s address, starting with https://.',
      );
    }
    const https = url.protocol === 'https:';
    if (!https && !(mode === 'local' && url.protocol === 'http:')) {
      throw bad(
        mode === 'local'
          ? 'The address starts with http:// or https://.'
          : 'Your own server’s address must start with https://.',
      );
    }
    if (url.username || url.password || url.search || url.hash || !url.hostname) {
      throw bad('Type only the address: the username and password go in their own boxes.');
    }
    if (mode === 'local') {
      // The home network, but never this machine, a link-local or metadata
      // address, the vault's own services, or a port off the list (checked
      // again on every connection, on the address DNS gives then).
      const refused = smsGateLocalRefused(url.href, this.localPorts);
      if (refused === 'port') {
        const ports = this.localPorts;
        throw new ApiError(
          422,
          'sms_address_refused',
          `The vault reaches SMS Gate’s local server on port ${ports.length > 1 ? `${ports.slice(0, -1).join(', ')} or ${ports.at(-1)}` : ports.join('')} only. Use port 8080, SMS Gate’s own, in the app’s Local server settings; or whoever runs this server can allow another with FDV_SMS_GATE_ALLOWED_PORTS.`,
        );
      }
      if (refused) {
        throw new ApiError(422, 'sms_address_refused', OWN_ADDRESS);
      }
    }
    if (mode === 'private') {
      // A server of the family's own on the internet, never one inside the
      // vault's own network (that is the local server's choice): said now
      // where it can be, and checked again on every connection.
      const host = url.hostname.replace(/^\[|\]$/g, '');
      let addresses: string[] = [];
      try {
        addresses = isLoopbackName(host)
          ? ['127.0.0.1']
          : isIP(host)
            ? [host]
            : await this.resolve(host);
      } catch {
        // A name DNS cannot answer for now is left to the connection's check.
      }
      if (addresses.some((a) => isPrivateAddress(a))) {
        throw new ApiError(
          422,
          'sms_address_refused',
          'That address is inside the vault’s own network. Choose Local server on your network for it.',
        );
      }
    }
    const href = `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
    return href.replace(/\/+$/, '');
  }

  /** The country and the month's limit, as any provider's settings keep them, or why not. */
  private common(input: { country: string; monthly_cap: number }): string {
    const country = input.country.trim().toUpperCase();
    if (!isPhoneCountry(country)) throw bad('Choose the country your family’s numbers are in.');
    if (
      !Number.isInteger(input.monthly_cap) ||
      input.monthly_cap < SMS_CAP_MIN ||
      input.monthly_cap > SMS_CAP_MAX
    ) {
      throw bad(`The most texts in a month is a number from ${SMS_CAP_MIN} to ${SMS_CAP_MAX}.`);
    }
    return country;
  }

  /**
   * PUT /sms/settings: the household's texts, as an owner sets them up —
   * SMS Gate, or (0.9.0-dev.71) Twilio. Saved, the settings wait for a test
   * if anything that reaches the provider changed, the provider itself
   * among them; a new limit or country alone keeps a test that passed.
   */
  async put(p: Principal, input: SmsSettingsInput, meta: RequestMeta): Promise<SmsSettingsView> {
    if (p.role !== 'owner') throw ownersOnly();
    return input.provider === 'twilio'
      ? this.putTwilio(p, input, meta)
      : this.putSmsGate(p, input, meta);
  }

  /**
   * The household's SMS Gate. The password, when given, is sealed with the
   * household, mode, address and sign-in bound in; left out, the one set is
   * kept — unless one of those changed, or texts went through Twilio, when
   * it is typed again. Twilio's settings, its token among them, are cleared.
   */
  private async putSmsGate(
    p: Principal,
    input: SmsGateSettingsInput,
    meta: RequestMeta,
  ): Promise<SmsSettingsView> {
    const mode = input.mode;
    const baseUrl = await this.address(mode, input.base_url);
    const username = input.username.trim();
    if (!username) throw bad('Type the username the SMS Gate app shows.');
    if (CONTROL.test(username)) throw bad('The username can’t have a line break or a tab in it.');
    const country = this.common(input);
    const key = this.key;
    if (!key) throw new ApiError(503, 'unavailable', 'The vault can’t keep a password just now.');
    const password = input.password;
    let reached = false;
    await withPrincipal(this.db, p, async (trx) => {
      const before = await trx
        .selectFrom('sms_settings')
        .select([
          'provider',
          'mode',
          'base_url',
          'username',
          sql<boolean>`password_encrypted is not null`.as('has_password'),
        ])
        .forUpdate()
        .executeTakeFirst();
      // The password was kept for one mode, address and sign-in alone: any
      // of them changed, it is typed again, for the new one. Coming from
      // Twilio there is none: SMS Gate's went as Twilio was chosen.
      const moved =
        before !== undefined &&
        (before.provider !== 'sms_gate' ||
          before.mode !== mode ||
          before.base_url !== baseUrl ||
          before.username !== username);
      if (password === undefined && (!before?.has_password || moved)) {
        throw new ApiError(
          422,
          'sms_password_needed',
          before?.has_password
            ? 'Type the password again for the new address or username.'
            : 'Type the password the SMS Gate app shows.',
        );
      }
      // Anything that reaches SMS Gate changed: it waits for a test of its own.
      reached = before === undefined || moved || password !== undefined;
      const values = {
        provider: 'sms_gate' as const,
        mode,
        base_url: baseUrl,
        username,
        // One provider at a time: Twilio's settings go, its token with them.
        twilio_account_sid: null,
        twilio_from: null,
        twilio_messaging_service_sid: null,
        twilio_token_encrypted: null,
        country,
        monthly_cap: input.monthly_cap,
        updated_by: p.accountId,
        updated_at: new Date(),
        ...(password !== undefined
          ? {
              password_encrypted: sealSmsPassword(key, password, p.householdId, {
                mode,
                baseUrl,
                username,
              }),
            }
          : {}),
        ...(reached
          ? { status: 'untested' as const, last_verified_at: null, last_error: null }
          : {}),
      };
      if (before) {
        await trx.updateTable('sms_settings').set(values).execute();
      } else {
        await trx
          .insertInto('sms_settings')
          .values({ household_id: p.householdId, ...values })
          .execute();
      }
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'sms.settings_saved',
        objectType: 'household',
        objectId: p.householdId,
        // How, and whether the password or the address changed: never the
        // password, the address or the sign-in themselves.
        detail: {
          mode,
          password_changed: password !== undefined,
          address_changed: before === undefined || moved,
          monthly_cap: input.monthly_cap,
        },
        ip: meta.ip,
      });
      if (reached) await this.tellOtherOwners(trx, p, mode);
    });
    return this.get(p);
  }

  /**
   * The household's Twilio account (0.9.0-dev.71): its Account SID, its
   * Auth Token — sealed as SMS Gate's password is, with the household and
   * the Account SID bound in; left out, the one set is kept, unless the
   * Account SID changed or texts went through SMS Gate — and a From number
   * or a Messaging Service, exactly one. SMS Gate's settings, its password
   * among them, are cleared.
   */
  private async putTwilio(
    p: Principal,
    input: TwilioSettingsInput,
    meta: RequestMeta,
  ): Promise<SmsSettingsView> {
    const accountSid = input.account_sid.trim();
    if (!TWILIO_ACCOUNT_SID.test(accountSid)) {
      throw bad(
        'Type the Account SID the Twilio Console shows: AC followed by 32 letters and digits.',
      );
    }
    const typedFrom = (input.from ?? '').trim();
    const typedService = (input.messaging_service_sid ?? '').trim();
    if ((typedFrom === '') === (typedService === '')) {
      throw bad('Type either the number texts come from, or a Messaging Service SID: one of them.');
    }
    const from = typedFrom ? fromNumber(typedFrom) : null;
    if (from !== null && !E164.test(from)) {
      throw bad(
        'Type the number texts come from with its country code, such as +447700900123: one of your Twilio numbers.',
      );
    }
    const service = typedService || null;
    if (service !== null && !TWILIO_MESSAGING_SERVICE_SID.test(service)) {
      throw bad(
        'Type the Messaging Service SID the Twilio Console shows: MG followed by 32 letters and digits.',
      );
    }
    const token = input.auth_token;
    if (token !== undefined && (NOT_A_TOKEN.test(token) || token.length > 200)) {
      throw bad('The Auth Token can’t have a space, a line break or a tab in it.');
    }
    const country = this.common(input);
    const key = this.key;
    if (!key) throw new ApiError(503, 'unavailable', 'The vault can’t keep a password just now.');
    await withPrincipal(this.db, p, async (trx) => {
      const before = await trx
        .selectFrom('sms_settings')
        .select([
          'provider',
          'twilio_account_sid',
          'twilio_from',
          'twilio_messaging_service_sid',
          sql<boolean>`twilio_token_encrypted is not null`.as('has_token'),
        ])
        .forUpdate()
        .executeTakeFirst();
      // The token was kept for one account alone: another, or coming from
      // SMS Gate (whose settings had none), it is typed again.
      const moved =
        before !== undefined &&
        (before.provider !== 'twilio' || before.twilio_account_sid !== accountSid);
      if (token === undefined && (!before?.has_token || moved)) {
        throw new ApiError(
          422,
          'sms_password_needed',
          before?.has_token
            ? 'Type the Auth Token again for the new Account SID.'
            : 'Type the Auth Token the Twilio Console shows.',
        );
      }
      const senderChanged =
        before === undefined ||
        before.twilio_from !== from ||
        before.twilio_messaging_service_sid !== service;
      // Anything that reaches Twilio changed: it waits for a test of its own.
      const reached = before === undefined || moved || senderChanged || token !== undefined;
      const values = {
        provider: 'twilio' as const,
        // One provider at a time: SMS Gate's settings go, its password with them.
        mode: null,
        base_url: null,
        username: null,
        password_encrypted: null,
        twilio_account_sid: accountSid,
        twilio_from: from,
        twilio_messaging_service_sid: service,
        country,
        monthly_cap: input.monthly_cap,
        updated_by: p.accountId,
        updated_at: new Date(),
        ...(token !== undefined
          ? {
              twilio_token_encrypted: sealTwilioToken(key, token, p.householdId, { accountSid }),
            }
          : {}),
        ...(reached
          ? { status: 'untested' as const, last_verified_at: null, last_error: null }
          : {}),
      };
      if (before) {
        await trx.updateTable('sms_settings').set(values).execute();
      } else {
        await trx
          .insertInto('sms_settings')
          .values({ household_id: p.householdId, ...values })
          .execute();
      }
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'sms.settings_saved',
        objectType: 'household',
        objectId: p.householdId,
        // Which provider and how it sends, and whether the token, the account
        // or the sender changed: never the token, the SID or the number.
        detail: {
          provider: 'twilio',
          sender: service !== null ? 'messaging_service' : 'number',
          token_changed: token !== undefined,
          account_changed: before === undefined || moved,
          sender_changed: senderChanged,
          monthly_cap: input.monthly_cap,
        },
        ip: meta.ip,
      });
      if (reached) await this.tellOtherOwners(trx, p, 'twilio');
    });
    return this.get(p);
  }

  /**
   * Whoever controls the provider reads every text the vault sends, the
   * codes that confirm the family's numbers among them: the other owners
   * are told when where it goes changes, as they are of the mail server.
   */
  private async tellOtherOwners(trx: Db, p: Principal, mode: SmsVia): Promise<void> {
    const me = await trx
      .selectFrom('member')
      .select('display_name')
      .where('id', '=', p.memberId)
      .executeTakeFirst();
    const others = await trx
      .selectFrom('account_household')
      .select('account_id')
      .where('role', '=', 'owner')
      .where('account_id', '!=', p.accountId)
      .execute();
    if (others.length === 0) return;
    const how =
      mode === 'local'
        ? 'a phone on your home network'
        : mode === 'cloud'
          ? 'SMS Gate’s cloud relay'
          : mode === 'twilio'
            ? 'a Twilio account'
            : 'a server of your own';
    await this.alert({
      householdId: p.householdId,
      accountIds: others.map((o) => o.account_id),
      subject: 'How the vault sends text messages was changed',
      body: `${me?.display_name ?? 'An owner'} changed how the vault sends text messages, to ${how}. The codes that confirm your family’s mobile numbers go through it. If that is a surprise, ask them about it.`,
    });
  }

  /** DELETE /sms/settings: the provider forgotten, password or token and all. No text is sent after. */
  async remove(p: Principal, meta: RequestMeta): Promise<SmsSettingsView> {
    if (p.role !== 'owner') throw ownersOnly();
    await withPrincipal(this.db, p, async (trx) => {
      const gone = await trx.deleteFrom('sms_settings').returning('household_id').execute();
      if (gone.length > 0) {
        await appendAudit(trx, {
          householdId: p.householdId,
          actorAccountId: p.accountId,
          action: 'sms.settings_removed',
          objectType: 'household',
          objectId: p.householdId,
          detail: {},
          ip: meta.ip,
        });
      }
    });
    return this.get(p);
  }

  // ------------------------------------------------------------ sending

  /** The household's scope as the vault, for `sendSms` and `markSms`: who asked was checked first. */
  private vault(householdId: string): AsVault {
    return (fn) => withSystem(this.db, householdId, fn);
  }

  /** How a send opens the provider's secret, and whatever sends. */
  private way(key: Buffer): SmsWay {
    return {
      open: (sealed, household, to) => openSmsSecret(key, sealed, household, to),
      provider: this.provider,
    };
  }

  /**
   * Writes a text's row and asks the provider to send it (`sendSms`,
   * @fdv/db, which the worker's texts go through too): refused, with
   * nothing written, when the household has no provider set up, or one no
   * test has passed (a test excepted), or this month's texts are all sent.
   */
  private async dispatch(
    householdId: string,
    r: SmsRequest,
  ): Promise<Exclude<SmsOutcome, { refused: unknown }>> {
    const key = this.key;
    if (!key) throw notSetUp();
    const d = await sendSms(this.vault(householdId), this.way(key), householdId, r);
    if ('refused' in d) {
      if (d.refused === 'cap_reached' && d.links === true) {
        throw new ApiError(
          409,
          'sms_cap_reached',
          `This month’s ${d.cap} texts for sending links have all been sent: the rest are kept for the codes people sign in with. Email the link, or copy it and send it yourself. An owner can raise the limit in Settings, under Text messages.`,
        );
      }
      if (d.refused === 'cap_reached') {
        throw new ApiError(
          409,
          'sms_cap_reached',
          `This month’s ${d.cap} texts have all been sent. An owner can raise the limit in Settings, under Text messages.`,
        );
      }
      throw notSetUp();
    }
    return d;
  }

  /**
   * Sends one text through the household's provider: the one way the vault
   * sends any. Refused while text messages are not set up and tested
   * (`409 sms_not_set_up`), past the month's limit (`409 sms_cap_reached`),
   * or when the provider does not take it (`503 sms_not_sent`, in plain
   * words).
   */
  async send(householdId: string, r: SmsRequest): Promise<SmsDone> {
    const d = await this.dispatch(householdId, r);
    if ('problem' in d) {
      this.logProblem(householdId, smsVia(d.settings), d.problem);
      throw notSent(
        smsProblemWords(d.problem.problem, smsVia(d.settings), d.problem.status, d.problem.code),
      );
    }
    return d.sent;
  }

  /**
   * Sends one text and says what became of it, rather than throwing (SMS3):
   * for a code whose failure is told to somebody else, in their own words —
   * a link's recipient, or an invitation's maker. `not_set_up` and
   * `cap_reached` wrote nothing and sent nothing; `not_sent` was written,
   * and the provider never took it.
   */
  async attempt(
    householdId: string,
    r: SmsRequest,
  ): Promise<
    { sent: SmsDone } | { failed: 'not_set_up' | 'cap_reached' | 'not_sent'; words: string }
  > {
    const key = this.key;
    if (!key) return { failed: 'not_set_up', words: notSetUp().message };
    const d = await sendSms(this.vault(householdId), this.way(key), householdId, r);
    if ('refused' in d) {
      return d.refused === 'cap_reached'
        ? {
            failed: 'cap_reached',
            words: `This month’s ${d.cap} texts have all been sent. An owner can raise the limit in Settings, under Text messages.`,
          }
        : { failed: 'not_set_up', words: notSetUp().message };
    }
    if ('problem' in d) {
      this.logProblem(householdId, smsVia(d.settings), d.problem);
      return {
        failed: 'not_sent',
        words: smsProblemWords(
          d.problem.problem,
          smsVia(d.settings),
          d.problem.status,
          d.problem.code,
        ),
      };
    }
    return { sent: d.sent };
  }

  /**
   * POST /sms/settings/test: a test text to the number an owner types,
   * through the settings saved. It passes once the provider has sent it,
   * within SMS_TEST_WAIT_SECONDS — asked after its text the same way for
   * SMS Gate and Twilio — and then the vault sends other texts. Failed, or
   * not sent in time, Settings says why in plain words, and nothing else is
   * sent until a test passes.
   */
  async test(p: Principal, typed: string, meta: RequestMeta): Promise<SmsTestResult> {
    if (p.role !== 'owner') throw ownersOnly();
    const to = parsePhone(typed, await this.country(p));
    if (!to) {
      throw new ApiError(
        422,
        'phone_number_invalid',
        'That doesn’t look like a mobile number. Type it with its country code, such as +44 7700 900123.',
      );
    }
    const d = await this.dispatch(p.householdId, { to, kind: 'test', text: SMS_TEST_TEXT });
    const via = smsVia(d.settings);
    let state: SmsState;
    let words: string;
    let ok = false;
    if ('problem' in d) {
      state = 'not_sent';
      this.logProblem(p.householdId, via, d.problem);
      words = smsProblemWords(d.problem.problem, via, d.problem.status, d.problem.code);
    } else if (d.unconfirmed === true || d.sent.providerId === null) {
      // The provider did not say whether it took it: it may still arrive, and
      // there is nothing to ask after. Not a pass; its row keeps its words.
      state = d.sent.state;
      words = smsProblemWords('unconfirmed', via);
    } else {
      // Asked after until the provider says it went, or failed, or the wait
      // is over: each ask within what is left of the wait, never tried again
      // inside it, so the test answers in time.
      const providerId = d.sent.providerId;
      state = d.sent.state;
      let error: string | undefined;
      let problem: SmsProviderError | null = null;
      const deadline = Date.now() + this.testWaitMs;
      while (state !== 'sent' && state !== 'delivered' && state !== 'failed') {
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, Math.min(this.pollMs, deadline - Date.now())));
        const left = deadline - Date.now();
        if (left <= 0) break;
        try {
          const now = await d.provider.state(providerId, { timeoutMs: left, retry: false });
          state = now.state;
          error = now.error;
        } catch (err) {
          // An ask cut short by the wait's end: still waiting, as the words below say.
          if (err instanceof SmsProviderError && err.problem === 'timeout') break;
          problem =
            err instanceof SmsProviderError
              ? err
              : new SmsProviderError('unreachable', (err as Error).message);
          break;
        }
      }
      if (state === 'sent' || state === 'delivered') {
        ok = true;
        words = 'The test text went. The vault can send texts now.';
      } else if (problem) {
        this.logProblem(p.householdId, via, problem);
        words = smsProblemWords(problem.problem, via, problem.status, problem.code);
      } else if (state === 'failed') {
        words = failedWords(via, cleanWords(error, 200));
      } else if (via === 'twilio') {
        words = `Twilio took the text, but hadn’t sent it after ${Math.round(this.testWaitMs / 1000)} seconds. Check the message in the Twilio Console’s logs, then test again.`;
      } else {
        words = `SMS Gate took the text, but the phone hadn’t sent it after ${Math.round(this.testWaitMs / 1000)} seconds. Check the phone has signal and the app is running, then test again.`;
      }
      await markSms(this.vault(p.householdId), d.sent.messageId, {
        state,
        ...(state === 'failed' ? { error: failedWords(via, cleanWords(error, 200)) } : {}),
      });
    }
    const s = d.settings;
    await withSystem(this.db, p.householdId, async (trx) => {
      // The settings tested, and no others: changed since — another provider,
      // address, sign-in, sender, password or token — they wait for a test of
      // their own.
      await trx
        .updateTable('sms_settings')
        .set(
          ok
            ? { status: 'ok', last_verified_at: new Date(), last_error: null }
            : { status: 'failed', last_error: words },
        )
        .where('provider', '=', s.provider)
        .where('mode', 'is not distinct from', s.mode)
        .where('base_url', 'is not distinct from', s.base_url)
        .where('username', 'is not distinct from', s.username)
        .where('password_encrypted', 'is not distinct from', s.password_encrypted)
        .where('twilio_account_sid', 'is not distinct from', s.twilio_account_sid)
        .where('twilio_from', 'is not distinct from', s.twilio_from)
        .where(
          'twilio_messaging_service_sid',
          'is not distinct from',
          s.twilio_messaging_service_sid,
        )
        .where('twilio_token_encrypted', 'is not distinct from', s.twilio_token_encrypted)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'sms.settings_tested',
        objectType: 'household',
        objectId: p.householdId,
        // Whether it went, and the provider's word: never the number.
        detail: { ok, state },
        ip: meta.ip,
      });
    });
    return { ok, state, words, view: await this.get(p) };
  }
}
