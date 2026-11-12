import { openSmsPassword } from '@fdv/crypto';
import {
  householdZone,
  sendSms,
  smsGate,
  withSystem,
  type Db,
  type SmsProviderFactory,
  type SmsWay,
} from '@fdv/db';
import {
  ALERT_TEXTS,
  isAlertTextKind,
  QUIET_FROM_DEFAULT,
  QUIET_TO_DEFAULT,
  quietHoursEnd,
  remindersText,
  shareOpenedText,
  type AlertTextKind,
  type SmsKind,
} from '@fdv/shared';
import { sql } from 'kysely';
import nodemailer from 'nodemailer';
import type { Alert } from './alerts.js';
import { openPassword } from './notify.js';
import type { Digest } from './reminders.js';

/**
 * Notifications by text (0.9.0, SMS2): the day's reminders, the alerts and
 * a link opened, each to whoever asked for it by text.
 *
 * Each is off until the person turns it on, in Settings → Notifications. A
 * text goes only to their own confirmed number (member_phone, 0084), only
 * while the household's SMS Gate is set up and a test passed, and through
 * `sendSms` (@fdv/db) as the API's do: one monthly cap for every kind, and
 * one log (sms_message), never the words.
 *
 * A text never names a document. The day's reminders are one text with a
 * count; an alert says its headline, chosen as a word by the API
 * (ALERT_TEXTS), never its subject, which may name people; a link opened
 * says whom it was shared for, as the family labelled it.
 *
 * Quiet hours are each person's, on the family's clock (21:00 to 08:00
 * until they choose). A text that falls in them is put back on the queue
 * until they end (pg-boss's startAfter, never a wait here), unless it is an
 * alert about their own sign-in — a new device, their password, a lock, who
 * owns the vault — which goes at once.
 *
 * When a text they asked for cannot go — no confirmed number, texts not set
 * up, the month's all sent, SMS Gate refused it — and it was the only way
 * they would have heard, they are emailed instead, through the household's
 * mail server: the day's digest, as if they had asked for it by email; or
 * the text's own words. Never both, and never when anything else reached
 * them. An alert went by email already.
 */

/** A text that waits on the queue (`sms.text`), or that the API asks for. */
export type TextJob =
  /** A link was opened (the API's shareOpenedJob): its maker hears, at most once an hour. */
  | { kind: 'share_opened'; household_id: string; share_id: string }
  /** The day's reminders, as a count, after somebody's quiet hours. */
  | {
      kind: 'reminders';
      household_id: string;
      account_id: string;
      count: number;
      all_documents: boolean;
      /** Nothing else reached them: emailed instead if the text cannot go. */
      alone: boolean;
    }
  /** An alert's headline, after somebody's quiet hours. */
  | { kind: 'alert'; household_id: string; account_id: string; text_kind: AlertTextKind };

export function isTextJob(data: unknown): data is TextJob {
  const j = data as Record<string, unknown> | null;
  if (typeof j?.household_id !== 'string') return false;
  switch (j.kind) {
    case 'share_opened':
      return typeof j.share_id === 'string';
    case 'reminders':
      return (
        typeof j.account_id === 'string' &&
        typeof j.count === 'number' &&
        typeof j.all_documents === 'boolean' &&
        typeof j.alone === 'boolean'
      );
    case 'alert':
      return typeof j.account_id === 'string' && isAlertTextKind(j.text_kind);
    default:
      return false;
  }
}

export interface TextDeps {
  app: Db;
  /** deriveKey(master, SMS_PASSWORD_PURPOSE): SMS Gate's password opens under it. */
  smsKey: Buffer;
  /** deriveKey(master, 'smtp-credentials'): for the email sent instead. */
  smtpKey: Buffer;
  /** Where the app lives, for the email sent instead. */
  baseUrl: string;
  /** Whatever sends a text: SMS Gate, unless a test stands in. */
  provider?: SmsProviderFactory;
  /** Puts a text back on the queue until `at`: pg-boss's startAfter. */
  later: (job: TextJob, at: Date) => Promise<void>;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
  /** Tests: the current instant. */
  now?: () => Date;
}

/**
 * What became of a text somebody might have had:
 *  - `off`: they did not ask for it (or may not hear just now);
 *  - `sent`: SMS Gate took it;
 *  - `later`: it waits for their quiet hours to end;
 *  - `failed`: they asked, and it could not go.
 */
export type Texted = 'off' | 'sent' | 'later' | 'failed';

/** The worker's texts, as notify.ts, alerts.ts and the `sms.text` job ask for them. */
export interface Texter {
  /** One person's day's reminders, beside their push and email (`reached`). */
  digest(d: Digest, reached: readonly string[]): Promise<Texted>;
  /** An alert, to each of its people who asked for alerts by text: how many it reached or waits for. */
  alert(a: Alert): Promise<number>;
  /** A text the queue holds, or the API asked for. */
  run(job: TextJob): Promise<Texted>;
}

/** Somebody, as a text to them is decided: what they want, their number, the family's clock. */
interface Reader {
  account_id: string;
  member_id: string;
  email: string;
  /** Not switched off, locked, paused after a restore, nor a guest past their end. */
  active: boolean;
  daily_text: boolean;
  alerts_text: boolean;
  share_opened_text: boolean;
  quiet_from: string;
  quiet_to: string;
  /** Their own confirmed number; null when there is none, or it waits for its code. */
  number: string | null;
  /** Whether the household sends texts now (sms_ready()). */
  ready: boolean;
  timezone: string;
}

async function readerOf(db: Db, householdId: string, accountId: string): Promise<Reader | null> {
  return withSystem(db, householdId, async (trx) => {
    const row = await trx
      .selectFrom('account_household as ah')
      .innerJoin('account', 'account.id', 'ah.account_id')
      .leftJoin('notification_preference as np', (j) =>
        j
          .onRef('np.account_id', '=', 'ah.account_id')
          .onRef('np.household_id', '=', 'ah.household_id'),
      )
      .leftJoin('member_phone as mp', 'mp.member_id', 'ah.member_id')
      .select([
        'ah.account_id',
        'ah.member_id',
        'account.email',
        sql<boolean>`(account.disabled_at is null
           and not suspension_in_effect(ah.suspended_at, ah.suspended_until)
           and not coalesce(ah.access_expires_at <= now(), false))`.as('active'),
        'np.daily_text',
        'np.alerts_text',
        'np.share_opened_text',
        'np.quiet_from',
        'np.quiet_to',
        sql<string | null>`case when mp.confirmed_at is not null then mp.number end`.as('number'),
        sql<boolean>`sms_ready()`.as('ready'),
      ])
      .where('ah.account_id', '=', accountId)
      .where('ah.household_id', '=', householdId)
      .executeTakeFirst();
    if (!row) return null;
    const hh = await trx.selectFrom('household').select('timezone').executeTakeFirst();
    return {
      account_id: row.account_id,
      member_id: row.member_id,
      email: row.email,
      active: row.active === true,
      daily_text: row.daily_text === true,
      alerts_text: row.alerts_text === true,
      share_opened_text: row.share_opened_text === true,
      quiet_from: row.quiet_from ?? QUIET_FROM_DEFAULT,
      quiet_to: row.quiet_to ?? QUIET_TO_DEFAULT,
      number: row.number,
      ready: row.ready === true,
      timezone: householdZone(hh?.timezone),
    };
  });
}

export function createTexter(deps: TextDeps): Texter {
  const now = () => deps.now?.() ?? new Date();
  const way: SmsWay = {
    open: (sealed, householdId, to) => openSmsPassword(deps.smsKey, sealed, householdId, to),
    provider: deps.provider ?? smsGate,
  };

  /**
   * Sends one text to somebody who asked for it, or puts it back on the
   * queue until their quiet hours end. Counts and kinds in the log, never
   * the words or the number.
   */
  const textTo = async (
    householdId: string,
    r: Reader,
    kind: SmsKind,
    text: string,
    urgent: boolean,
    job: TextJob,
  ): Promise<Texted> => {
    if (!r.ready || !r.number) return 'failed';
    if (!urgent) {
      const end = quietHoursEnd(r.timezone, r.quiet_from, r.quiet_to, now());
      if (end) {
        await deps.later(job, end);
        deps.log('info', 'text waits for quiet hours to end', {
          household: householdId,
          kind,
          at: end.toISOString(),
        });
        return 'later';
      }
    }
    const outcome = await sendSms((fn) => withSystem(deps.app, householdId, fn), way, householdId, {
      to: r.number,
      memberId: r.member_id,
      kind,
      text,
    });
    if ('sent' in outcome) return 'sent';
    deps.log('warn', 'text not sent', {
      household: householdId,
      kind,
      why: 'refused' in outcome ? outcome.refused : outcome.problem.problem,
    });
    return 'failed';
  };

  /** The email sent instead of a text that could not go: its own words, to them alone. */
  const instead = async (
    householdId: string,
    r: Reader,
    subject: string,
    words: string,
  ): Promise<boolean> => {
    const smtp = await withSystem(deps.app, householdId, (trx) =>
      trx
        .selectFrom('smtp_settings')
        .selectAll()
        .where('household_id', '=', householdId)
        .executeTakeFirst(),
    );
    if (!smtp || smtp.status !== 'ok') return false;
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      ...(smtp.username && smtp.password_encrypted
        ? {
            auth: {
              user: smtp.username,
              pass: openPassword(deps.smtpKey, smtp.password_encrypted, householdId),
            },
          }
        : {}),
    });
    try {
      await transport.sendMail({
        from: `"${smtp.from_name}" <${smtp.from_email}>`,
        to: r.email,
        subject,
        text:
          `${words.replace(/^Family Vault: /, '')}\n\n` +
          `You asked for this by text, and the text couldn’t be sent, so it came by email.\n\n` +
          `Open your vault: ${deps.baseUrl}\n`,
      });
      return true;
    } catch (err) {
      deps.log('warn', 'email instead of a text failed', {
        household: householdId,
        error: (err as Error).message,
      });
      return false;
    } finally {
      transport.close();
    }
  };

  const reminders = async (
    householdId: string,
    r: Reader,
    job: Extract<TextJob, { kind: 'reminders' }>,
  ): Promise<Texted> => {
    if (!r.daily_text || !r.active) return 'off';
    return textTo(
      householdId,
      r,
      'reminders',
      remindersText(job.count, job.all_documents),
      false,
      job,
    );
  };

  const alertTo = async (
    householdId: string,
    r: Reader,
    textKind: AlertTextKind,
    ownSignIn: boolean,
  ): Promise<Texted> => {
    // About their own sign-in, it reaches them while it is locked or
    // paused, as the alert's email does; anything else, while it works.
    if (!r.alerts_text || (!r.active && !ownSignIn)) return 'off';
    const { text, urgent } = ALERT_TEXTS[textKind];
    return textTo(householdId, r, 'alert', text, urgent, {
      kind: 'alert',
      household_id: householdId,
      account_id: r.account_id,
      text_kind: textKind,
    });
  };

  const shareOpened = async (job: Extract<TextJob, { kind: 'share_opened' }>) => {
    const link = await withSystem(deps.app, job.household_id, (trx) =>
      trx
        .selectFrom('share_link')
        .select(['created_by', 'recipient_label'])
        .where('id', '=', job.share_id)
        .executeTakeFirst(),
    );
    if (!link) return 'off';
    const r = await readerOf(deps.app, job.household_id, link.created_by);
    if (!r || !r.share_opened_text || !r.active) return 'off';
    const text = shareOpenedText(link.recipient_label);
    // Quiet hours first: the hour is counted from when they are told.
    if (r.ready && r.number) {
      const end = quietHoursEnd(r.timezone, r.quiet_from, r.quiet_to, now());
      if (end) {
        await deps.later(job, end);
        return 'later';
      }
    }
    // Told at most once an hour a link, whichever way: the first to claim it.
    const claimed = await withSystem(deps.app, job.household_id, (trx) =>
      trx
        .updateTable('share_link')
        .set({ opened_texted_at: now() })
        .where('id', '=', job.share_id)
        .where((eb) =>
          eb.or([
            eb('opened_texted_at', 'is', null),
            eb('opened_texted_at', '<=', new Date(now().getTime() - 3_600_000)),
          ]),
        )
        .returning('id')
        .executeTakeFirst(),
    );
    if (!claimed) return 'off';
    const texted = await textTo(job.household_id, r, 'share_opened', text, true, job);
    if (texted === 'failed') {
      await instead(job.household_id, r, 'A link you shared was opened', text);
    }
    return texted;
  };

  return {
    async digest(d, reached) {
      // The Sunday summary is an email; a text is the day's.
      if (d.kind === 'weekly' || d.items.length === 0) return 'off';
      const r = await readerOf(deps.app, d.household_id, d.recipient.account_id);
      if (!r) return 'off';
      return reminders(d.household_id, r, {
        kind: 'reminders',
        household_id: d.household_id,
        account_id: r.account_id,
        count: d.items.length,
        all_documents: d.items.every((i) => i.document_id !== null),
        alone: reached.length === 0,
      });
    },

    async alert(a) {
      // The operator's mail alone (a reset's link): never texted; nor news
      // that a code by text could not be sent (SMS3).
      if (a.via === 'operator' || a.no_text === true) return 0;
      const kind: AlertTextKind = isAlertTextKind(a.text_kind) ? a.text_kind : 'news';
      let told = 0;
      for (const accountId of [...new Set(a.account_ids)]) {
        const r = await readerOf(deps.app, a.household_id, accountId);
        if (!r) continue;
        const texted = await alertTo(a.household_id, r, kind, a.own_sign_in === true);
        if (texted === 'sent' || texted === 'later') told++;
      }
      return told;
    },

    async run(job) {
      if (job.kind === 'share_opened') return shareOpened(job);
      const r = await readerOf(deps.app, job.household_id, job.account_id);
      if (!r) return 'off';
      if (job.kind === 'alert') {
        return alertTo(job.household_id, r, job.text_kind, false);
      }
      const texted = await reminders(job.household_id, r, job);
      if (texted === 'failed' && job.alone) {
        await instead(
          job.household_id,
          r,
          'Reminders from your vault',
          remindersText(job.count, job.all_documents),
        );
      }
      return texted;
    },
  };
}
