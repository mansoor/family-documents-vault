import { withHousehold, type Db } from '@fdv/db';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { openPassword, type VapidKeys } from './notify.js';

/**
 * Alerts: one thing, to named people, now.
 *
 * A digest is the right shape for "here is what is coming up" and the
 * wrong shape for "somebody just signed in on a device you have never
 * used" or "somebody asked for your owner role to be taken away". These
 * are the messages where waiting until nine in the morning, or being the
 * fourth bullet in a list, would be a failure.
 *
 * So: no aggregation, no preference to opt out of, no schedule. They go
 * to both channels at once and a failure on one never stops the other.
 * There are only two kinds of them and both are about somebody's access
 * to the vault, which is why they are not something to turn off.
 */

export interface Alert {
  household_id: string;
  /** Who to tell. Accounts, because this is about sign-ins, not people. */
  account_ids: string[];
  subject: string;
  body: string;
  /** Where the button goes, when somewhere better than the vault's front page. */
  url?: string;
  url_label?: string;
  /**
   * Skip push. A lock screen is a poor place for a link that opens an
   * account, and for the news that somebody changed your password.
   */
  email_only?: boolean;
}

export interface AlertDeps {
  app: Db;
  vapid: VapidKeys | null;
  smtpKey: Buffer;
  baseUrl: string;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

export function isAlert(data: unknown): data is Alert {
  const a = data as Alert;
  return (
    typeof a?.household_id === 'string' &&
    Array.isArray(a?.account_ids) &&
    typeof a?.subject === 'string' &&
    typeof a?.body === 'string'
  );
}

export async function sendAlert(deps: AlertDeps, alert: Alert): Promise<string[]> {
  if (alert.account_ids.length === 0) return [];
  const channels: string[] = [];
  if (!alert.email_only && (await pushAlert(deps, alert)) > 0) channels.push('push');
  if ((await emailAlert(deps, alert)) > 0) channels.push('email');
  if (channels.length === 0) {
    // Worth a line in the log: the point of an alert is that somebody
    // hears it, and nobody did.
    deps.log('warn', 'alert had nowhere to go', {
      household: alert.household_id,
      subject: alert.subject,
    });
  }
  return channels;
}

async function pushAlert(deps: AlertDeps, alert: Alert): Promise<number> {
  if (!deps.vapid) return 0;
  webpush.setVapidDetails(deps.vapid.subject, deps.vapid.publicKey, deps.vapid.privateKey);
  const devices = await withHousehold(deps.app, alert.household_id, (trx) =>
    trx
      .selectFrom('device')
      .select(['id', 'endpoint', 'p256dh', 'auth'])
      .where('failed_at', 'is', null)
      .where('kind', '=', 'web_push')
      .where('account_id', 'in', alert.account_ids)
      .execute(),
  );
  const payload = JSON.stringify({
    title: alert.subject,
    body: alert.body,
    url: `${deps.baseUrl}/settings`,
    // No tag: one alert must never replace another in the tray.
    count: 1,
  });
  let sent = 0;
  for (const d of devices) {
    if (!d.p256dh || !d.auth) continue;
    try {
      await webpush.sendNotification(
        { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
        payload,
        { TTL: 24 * 3600, urgency: 'high' },
      );
      sent++;
    } catch (err) {
      deps.log('warn', 'alert push failed', {
        device_id: d.id,
        status: (err as { statusCode?: number }).statusCode,
      });
    }
  }
  return sent;
}

async function emailAlert(deps: AlertDeps, alert: Alert): Promise<number> {
  const ctx = await withHousehold(deps.app, alert.household_id, async (trx) => {
    const smtp = await trx
      .selectFrom('smtp_settings')
      .selectAll()
      .where('household_id', '=', alert.household_id)
      .executeTakeFirst();
    if (!smtp || smtp.status !== 'ok') return null;
    const people = await trx
      .selectFrom('account')
      .select(['email'])
      .where('id', 'in', alert.account_ids)
      .where('disabled_at', 'is', null)
      .execute();
    return { smtp, recipients: people.map((x) => x.email) };
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
            pass: openPassword(deps.smtpKey, smtp.password_encrypted, alert.household_id),
          },
        }
      : {}),
  });
  try {
    await transport.sendMail({
      from: `"${smtp.from_name}" <${smtp.from_email}>`,
      // One at a time: these say things about a particular person, and
      // the other recipients are not always entitled to know.
      bcc: recipients.join(', '),
      subject: alert.subject,
      text: `${alert.body}\n\nOpen your vault: ${deps.baseUrl}\n`,
      html: htmlAlert(alert, deps.baseUrl),
    });
    return recipients.length;
  } catch (err) {
    deps.log('warn', 'alert email failed', {
      household: alert.household_id,
      error: (err as Error).message,
    });
    return 0;
  }
}

export function htmlAlert(alert: Alert, baseUrl: string): string {
  const href = alert.url ?? baseUrl;
  const label = alert.url_label ?? 'Open your vault';
  const esc = (s: string) =>
    s.replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
    );
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#faf8f4;color:#1c1917;padding:24px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(alert.subject)}</h1>
<p style="margin:0 0 20px;line-height:1.5">${esc(alert.body)}</p>
<p><a href="${esc(href)}" style="background:#1f5d4c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;display:inline-block">${esc(label)}</a></p>
<p style="color:#5e574e;font-size:13px;margin-top:20px">This is about who can get into your vault, so it is not something the app can be told to stop sending.</p>
</body></html>`;
}
