import { createDecipheriv } from 'node:crypto';
import { withHousehold, type Db } from '@fdv/db';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import type { Digest, Notifier } from './reminders.js';

/**
 * Delivering a digest (REM-05, REM-06, STO-09).
 *
 * Push first: it needs no configuration at all beyond the VAPID keys the
 * install generates, and it reaches Android, desktop and iOS 16.4+ through
 * the installed PWA. Email second: the household brings its own SMTP
 * (decision 13), so there is no deliverability liability and the reminder
 * arrives from a domain the family trusts.
 *
 * Nothing is sent per item. One message carries the day's list, and a
 * failure on one channel never stops the other.
 */

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string; // mailto: or https: contact, per the spec
}

export interface NotifyDeps {
  app: Db;
  vapid: VapidKeys | null;
  /** deriveKey(master, 'smtp-credentials') */
  smtpKey: Buffer;
  /** Where the app lives, for links in the message. */
  baseUrl: string;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

export function subject(d: Digest): string {
  const n = d.items.length;
  const overdue = d.items.filter((i) => i.overdue).length;
  if (d.kind === 'weekly') return `Your week in ${d.household_name}`;
  if (overdue === n) return n === 1 ? '1 thing has lapsed' : `${n} things have lapsed`;
  return n === 1 ? '1 thing needs attention' : `${n} things need attention`;
}

export function textBody(d: Digest, baseUrl: string): string {
  const lines = d.items.map((i) => `• ${i.title} — ${i.label}${i.note ? ` (${i.note})` : ''}`);
  const intro =
    d.kind === 'catch_up'
      ? 'While nobody was looking, these came up:'
      : d.kind === 'weekly'
        ? 'Here is what is coming up in the next few weeks:'
        : 'These need attention today:';
  return `${intro}\n\n${lines.join('\n')}\n\nOpen your vault: ${baseUrl}\n`;
}

export function htmlBody(d: Digest, baseUrl: string): string {
  const esc = (s: string) =>
    s.replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
    );
  const rows = d.items
    .map(
      (i) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #e6e0d6"><strong>${esc(i.title)}</strong><br><span style="color:${i.overdue ? '#b3261e' : '#5e574e'}">${esc(i.label)}</span>${i.note ? `<br><span style="color:#5e574e">${esc(i.note)}</span>` : ''}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#faf8f4;color:#1c1a17;padding:24px">
<h1 style="font-size:20px;margin:0 0 4px">${esc(subject(d))}</h1>
<p style="color:#5e574e;margin:0 0 16px">${esc(d.household_name)}</p>
<table style="width:100%;border-collapse:collapse">${rows}</table>
<p style="margin-top:20px"><a href="${esc(baseUrl)}" style="background:#1f5d4c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;display:inline-block">Open your vault</a></p>
<p style="color:#5e574e;font-size:13px;margin-top:20px">You are getting this because you keep documents in this vault. Turn these off in Settings.</p>
</body></html>`;
}

/** Shared with the alert job, which uses the same household mail server. */
export function openPassword(key: Buffer, sealed: Buffer, householdId: string): string {
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(`smtp:${householdId}`));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]).toString('utf8');
}

/**
 * The real notifier: push to every registered device whose owner wants it,
 * then email through the household's SMTP to everyone who wants that.
 * Returns the channels that actually delivered, which is what the ledger
 * records.
 */
export function createNotifier(deps: NotifyDeps): Notifier {
  if (deps.vapid) {
    webpush.setVapidDetails(deps.vapid.subject, deps.vapid.publicKey, deps.vapid.privateKey);
  }
  return {
    async digest(d: Digest): Promise<string[]> {
      const channels: string[] = [];
      const pushed = await sendPush(deps, d);
      if (pushed > 0) channels.push('push');
      const mailed = await sendEmail(deps, d);
      if (mailed > 0) channels.push('email');
      if (channels.length === 0) {
        deps.log('info', 'digest had nowhere to go', {
          household: d.household_name,
          count: d.items.length,
        });
      }
      return channels;
    },
  };
}

async function sendPush(deps: NotifyDeps, d: Digest): Promise<number> {
  if (!deps.vapid) return 0;
  const devices = await withHousehold(deps.app, d.household_id, (trx) =>
    trx
      .selectFrom('device')
      .leftJoin('notification_preference', (j) =>
        j
          .onRef('notification_preference.account_id', '=', 'device.account_id')
          .onRef('notification_preference.household_id', '=', 'device.household_id'),
      )
      .select([
        'device.id',
        'device.endpoint',
        'device.p256dh',
        'device.auth',
        'notification_preference.daily_push',
      ])
      .where('device.failed_at', 'is', null)
      .where('device.kind', '=', 'web_push')
      .execute(),
  );
  const wanted = devices.filter((x) => x.daily_push !== false && x.p256dh && x.auth);
  if (wanted.length === 0) return 0;

  const payload = JSON.stringify({
    title: subject(d),
    body: d.items
      .slice(0, 3)
      .map((i) => `${i.title} — ${i.label}`)
      .join('\n'),
    url: `${deps.baseUrl}/reminders`,
    tag: `fdv-digest-${d.local_date}`,
    count: d.items.length,
  });

  let sent = 0;
  for (const device of wanted) {
    try {
      await webpush.sendNotification(
        {
          endpoint: device.endpoint,
          keys: { p256dh: device.p256dh as string, auth: device.auth as string },
        },
        payload,
        { TTL: 24 * 3600, urgency: 'normal' },
      );
      sent++;
      await withHousehold(deps.app, d.household_id, (trx) =>
        trx
          .updateTable('device')
          .set({ last_used_at: new Date() })
          .where('id', '=', device.id)
          .execute(),
      );
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410 mean the browser threw the subscription away: stop trying.
      const gone = status === 404 || status === 410;
      await withHousehold(deps.app, d.household_id, (trx) =>
        trx
          .updateTable('device')
          .set({
            failed_at: new Date(),
            fail_reason: `${status ?? 'error'}: ${(err as Error).message}`.slice(0, 200),
          })
          .where('id', '=', device.id)
          .execute(),
      );
      deps.log(gone ? 'info' : 'warn', gone ? 'push subscription gone' : 'push failed', {
        device_id: device.id,
        status,
      });
    }
  }
  return sent;
}

async function sendEmail(deps: NotifyDeps, d: Digest): Promise<number> {
  const ctx = await withHousehold(deps.app, d.household_id, async (trx) => {
    const smtp = await trx
      .selectFrom('smtp_settings')
      .selectAll()
      .where('household_id', '=', d.household_id)
      .executeTakeFirst();
    if (!smtp || smtp.status !== 'ok') return null;
    const wantField = d.kind === 'weekly' ? 'weekly_email' : 'daily_email';
    const people = await trx
      .selectFrom('account_household')
      .innerJoin('account', 'account.id', 'account_household.account_id')
      .leftJoin('notification_preference', (j) =>
        j
          .onRef('notification_preference.account_id', '=', 'account_household.account_id')
          .onRef('notification_preference.household_id', '=', 'account_household.household_id'),
      )
      .select(['account.email', `notification_preference.${wantField} as wants`])
      .where('account.disabled_at', 'is', null)
      .execute();
    // Defaults: weekly on, daily off (design: per-item email is off).
    const recipients = people
      .filter((p) => (p.wants === null ? d.kind === 'weekly' : p.wants === true))
      .map((p) => p.email);
    return { smtp, recipients };
  });
  if (!ctx || ctx.recipients.length === 0) return 0;

  const { smtp, recipients } = ctx;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.username && smtp.password_encrypted
      ? {
          auth: {
            user: smtp.username,
            pass: openPassword(deps.smtpKey, smtp.password_encrypted, d.household_id),
          },
        }
      : {}),
  });
  try {
    await transport.sendMail({
      from: `"${smtp.from_name}" <${smtp.from_email}>`,
      to: recipients.join(', '),
      subject: subject(d),
      text: textBody(d, deps.baseUrl),
      html: htmlBody(d, deps.baseUrl),
    });
    return recipients.length;
  } catch (err) {
    deps.log('warn', 'email failed', {
      household: d.household_name,
      error: (err as Error).message,
    });
    await withHousehold(deps.app, d.household_id, (trx) =>
      trx
        .updateTable('smtp_settings')
        .set({ status: 'failed', last_error: (err as Error).message.slice(0, 300) })
        .where('household_id', '=', d.household_id)
        .execute(),
    );
    return 0;
  } finally {
    transport.close();
  }
}
