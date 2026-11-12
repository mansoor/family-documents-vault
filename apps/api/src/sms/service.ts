import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { openSmsPassword, sealSmsPassword } from '@fdv/crypto';
import {
  appendAudit,
  markSms,
  sendSms,
  smsGate,
  smsMonthCount,
  smsProblemWords,
  SmsProviderError,
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
  isLoopbackName,
  isPhoneCountry,
  isPrivateAddress,
  parsePhone,
  SMS_CAP_MAX,
  SMS_CAP_MIN,
  SMS_CLOUD_URL,
  SMS_DEFAULT_CAP,
  SMS_DEFAULT_COUNTRY,
  SMS_TEST_TEXT,
  SMS_TEST_WAIT_SECONDS,
  type SmsMode,
  type SmsSettingsInput,
  type SmsSettingsView,
  type SmsState,
  type SmsTestResult,
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

/** A control character: never in a sign-in. */
const CONTROL = /\p{Cc}/u;

/** What a text that failed on the phone is said as: the phone's own words beside ours. */
const failedWords = (error: string | undefined) =>
  `The phone couldn’t send the text. Check it has signal and credit.${error ? ` SMS Gate said: ${error}` : ''}`;

/** The message an owner, or whoever asked for a text, is given when it was not sent. */
const notSent = (words: string) =>
  new ApiError(503, 'sms_not_sent', `The text couldn’t be sent. ${words}`, {
    retriable: true,
    retryAfter: 60,
  });

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

  constructor(
    private readonly db: Db,
    opts: SmsOptions = {},
  ) {
    this.key = opts.key ?? null;
    this.provider = opts.provider ?? smsGate;
    this.resolve = opts.resolve ?? resolveHost;
    this.alert = opts.alert ?? (async () => undefined);
    this.testWaitMs = opts.testWaitMs ?? SMS_TEST_WAIT_SECONDS * 1000;
    this.pollMs = opts.pollMs ?? 2000;
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
    return withPrincipal(this.db, p, async (trx) => {
      const row = await trx
        .selectFrom('sms_settings')
        .select([
          'mode',
          'base_url',
          'username',
          'country',
          'monthly_cap',
          'status',
          'last_verified_at',
          'last_error',
          'updated_at',
          sql<boolean>`password_encrypted is not null`.as('has_password'),
        ])
        .executeTakeFirst();
      const sent = await smsMonthCount(trx);
      return {
        settings: row
          ? {
              mode: row.mode,
              base_url: row.base_url,
              username: row.username,
              password: row.has_password ? 'set' : 'not_set',
              country: row.country,
              monthly_cap: row.monthly_cap,
              status: row.status,
              last_verified_at: row.last_verified_at?.toISOString() ?? null,
              last_error: row.last_error,
              updated_at: row.updated_at.toISOString(),
            }
          : null,
        ready: row !== undefined && row.status === 'ok' && row.has_password,
        sent_this_month: sent,
        monthly_cap: row?.monthly_cap ?? SMS_DEFAULT_CAP,
        cloud_url: SMS_CLOUD_URL,
      };
    });
  }

  // ------------------------------------------------------------ setting

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

  /**
   * PUT /sms/settings: the household's SMS Gate, as an owner sets it up.
   * The password, when given, is sealed with the household, mode, address
   * and sign-in bound in; left out, the one set is kept — unless one of
   * those changed, when it is typed again. Saved, the settings wait for a
   * test if anything that reaches SMS Gate changed; a new limit or country
   * alone keeps a test that passed.
   */
  async put(p: Principal, input: SmsSettingsInput, meta: RequestMeta): Promise<SmsSettingsView> {
    if (p.role !== 'owner') throw ownersOnly();
    const mode = input.mode;
    const baseUrl = await this.address(mode, input.base_url);
    const username = input.username.trim();
    if (!username) throw bad('Type the username the SMS Gate app shows.');
    if (CONTROL.test(username)) throw bad('The username can’t have a line break or a tab in it.');
    const country = input.country.trim().toUpperCase();
    if (!isPhoneCountry(country)) throw bad('Choose the country your family’s numbers are in.');
    if (
      !Number.isInteger(input.monthly_cap) ||
      input.monthly_cap < SMS_CAP_MIN ||
      input.monthly_cap > SMS_CAP_MAX
    ) {
      throw bad(`The most texts in a month is a number from ${SMS_CAP_MIN} to ${SMS_CAP_MAX}.`);
    }
    const key = this.key;
    if (!key) throw new ApiError(503, 'unavailable', 'The vault can’t keep a password just now.');
    const password = input.password;
    let reached = false;
    await withPrincipal(this.db, p, async (trx) => {
      const before = await trx
        .selectFrom('sms_settings')
        .select([
          'mode',
          'base_url',
          'username',
          sql<boolean>`password_encrypted is not null`.as('has_password'),
        ])
        .forUpdate()
        .executeTakeFirst();
      // The password was kept for one mode, address and sign-in alone: any
      // of them changed, it is typed again, for the new one.
      const moved =
        before !== undefined &&
        (before.mode !== mode || before.base_url !== baseUrl || before.username !== username);
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
        mode,
        base_url: baseUrl,
        username,
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
   * Whoever controls SMS Gate reads every text the vault sends, the codes
   * that confirm the family's numbers among them: the other owners are told
   * when where it goes changes, as they are of the mail server.
   */
  private async tellOtherOwners(trx: Db, p: Principal, mode: SmsMode): Promise<void> {
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
          : 'a server of your own';
    await this.alert({
      householdId: p.householdId,
      accountIds: others.map((o) => o.account_id),
      subject: 'How the vault sends text messages was changed',
      body: `${me?.display_name ?? 'An owner'} changed how the vault sends text messages, to ${how}. The codes that confirm your family’s mobile numbers go through it. If that is a surprise, ask them about it.`,
    });
  }

  /** DELETE /sms/settings: SMS Gate forgotten, password and all. No text is sent after. */
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

  /**
   * Writes a text's row and asks SMS Gate to send it (`sendSms`, @fdv/db,
   * which the worker's texts go through too): refused, with nothing
   * written, when the household has no SMS Gate, or one no test has passed
   * (a test excepted), or this month's texts are all sent.
   */
  private async dispatch(
    householdId: string,
    r: SmsRequest,
  ): Promise<Exclude<SmsOutcome, { refused: unknown }>> {
    const key = this.key;
    if (!key) throw notSetUp();
    const way: SmsWay = {
      open: (sealed, household, to) => openSmsPassword(key, sealed, household, to),
      provider: this.provider,
    };
    const d = await sendSms(this.vault(householdId), way, householdId, r);
    if ('refused' in d) {
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
   * Sends one text through the household's SMS Gate: the one way the vault
   * sends any. Refused while text messages are not set up and tested
   * (`409 sms_not_set_up`), past the month's limit (`409 sms_cap_reached`),
   * or when SMS Gate does not take it (`503 sms_not_sent`, in plain words).
   */
  async send(householdId: string, r: SmsRequest): Promise<SmsDone> {
    const d = await this.dispatch(householdId, r);
    if ('problem' in d) {
      throw notSent(smsProblemWords(d.problem.problem, d.settings.mode, d.problem.status));
    }
    return d.sent;
  }

  /**
   * POST /sms/settings/test: a test text to the number an owner types,
   * through the settings saved. It passes once SMS Gate has sent it, within
   * SMS_TEST_WAIT_SECONDS: then the vault sends other texts. Failed, or
   * not sent in time, Settings says why in plain words, and nothing else
   * is sent until a test passes.
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
    const mode = d.settings.mode;
    let state: SmsState;
    let words: string;
    let ok = false;
    if ('problem' in d) {
      state = 'not_sent';
      words = smsProblemWords(d.problem.problem, mode, d.problem.status);
    } else {
      // Asked after until SMS Gate says it went, or failed, or the wait is over.
      state = d.sent.state;
      let error: string | undefined;
      let problem: SmsProviderError | null = null;
      const deadline = Date.now() + this.testWaitMs;
      while (state !== 'sent' && state !== 'delivered' && state !== 'failed') {
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, Math.min(this.pollMs, deadline - Date.now())));
        try {
          const now = await d.provider.state(d.sent.providerId);
          state = now.state;
          error = now.error;
        } catch (err) {
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
        words = smsProblemWords(problem.problem, mode, problem.status);
      } else if (state === 'failed') {
        words = failedWords(cleanWords(error, 200));
      } else {
        words = `SMS Gate took the text, but the phone hadn’t sent it after ${Math.round(this.testWaitMs / 1000)} seconds. Check the phone has signal and the app is running, then test again.`;
      }
      await markSms(this.vault(p.householdId), d.sent.messageId, {
        state,
        ...(state === 'failed' ? { error: failedWords(cleanWords(error, 200)) } : {}),
      });
    }
    await withSystem(this.db, p.householdId, async (trx) => {
      // The settings tested, and no others: changed since, they wait for a
      // test of their own.
      await trx
        .updateTable('sms_settings')
        .set(
          ok
            ? { status: 'ok', last_verified_at: new Date(), last_error: null }
            : { status: 'failed', last_error: words },
        )
        .where('mode', '=', d.settings.mode)
        .where('base_url', '=', d.settings.base_url)
        .where('username', '=', d.settings.username)
        .where('password_encrypted', '=', d.settings.password_encrypted as Buffer)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'sms.settings_tested',
        objectType: 'household',
        objectId: p.householdId,
        // Whether it went, and SMS Gate's word: never the number.
        detail: { ok, state },
        ip: meta.ip,
      });
    });
    return { ok, state, words, view: await this.get(p) };
  }
}
