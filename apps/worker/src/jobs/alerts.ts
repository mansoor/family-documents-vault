import type https from 'node:https';
import { withHousehold, type Db } from '@fdv/db';
import nodemailer from 'nodemailer';
import { liveDevice, openPassword, type VapidKeys } from './notify.js';
import { deliver, pushDepsOf, unifiedPayload } from './push.js';

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
  /**
   * 'operator': by the operator's own mail server and nothing else — never
   * push, never the household's. For password-reset links: a household
   * mail server is one an owner can point at themselves.
   */
  via?: 'operator';
  /**
   * What a phone is told (4.13), as a word and nothing more: a new device,
   * a change of owner. An alert without one is not pushed to phones.
   */
  push_type?: 'new_device' | 'owner_change';
}

export interface AlertDeps {
  app: Db;
  vapid: VapidKeys | null;
  smtpKey: Buffer;
  baseUrl: string;
  /** The operator's mail server (FDV_SMTP_URL), if there is one. */
  operatorMail?: { url: string; from: string } | null;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
  agent?: https.Agent;
  allowPrivate?: boolean;
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
  if (alert.via === 'operator') {
    return (await operatorEmail(deps, alert)) > 0 ? ['email'] : [];
  }
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
  const devices = await withHousehold(deps.app, alert.household_id, (trx) =>
    trx
      .selectFrom('device')
      .select(['id', 'kind', 'endpoint', 'p256dh', 'auth'])
      .where('failed_at', 'is', null)
      .where('kind', 'in', ['web_push', 'unified_push'])
      .where('account_id', 'in', alert.account_ids)
      .where(liveDevice)
      .execute(),
  );
  const payload = JSON.stringify({
    title: alert.subject,
    body: alert.body,
    url: `${deps.baseUrl}/settings`,
    // No tag: one alert must never replace another in the tray.
    count: 1,
  });
  const pd = pushDepsOf(deps);
  let sent = 0;
  for (const d of devices) {
    if (!d.p256dh || !d.auth) continue;
    // A phone is told only the word, and only for the alerts that have one.
    if (d.kind === 'unified_push' && !alert.push_type) continue;
    const body =
      d.kind === 'unified_push' && alert.push_type
        ? unifiedPayload({ v: 1, type: alert.push_type })
        : payload;
    const outcome = await deliver(
      pd,
      {
        id: d.id,
        household_id: alert.household_id,
        endpoint: d.endpoint,
        p256dh: d.p256dh,
        auth: d.auth,
      },
      body,
      alert.push_type ?? 'test',
      { urgency: 'high', topic: false },
    );
    if (outcome === 'sent') sent++;
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
      // The link in the text part too: a plain-text mail client shows no button.
      text: `${alert.body}\n\n${alert.url_label ?? 'Open your vault'}: ${alert.url ?? deps.baseUrl}\n`,
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

async function operatorEmail(deps: AlertDeps, alert: Alert): Promise<number> {
  if (!deps.operatorMail) {
    deps.log('warn', 'an operator-mail alert, but FDV_SMTP_URL is not set', {
      household: alert.household_id,
      subject: alert.subject,
    });
    return 0;
  }
  const recipients = await withHousehold(deps.app, alert.household_id, (trx) =>
    trx
      .selectFrom('account')
      .select(['email'])
      .where('id', 'in', alert.account_ids)
      .where('disabled_at', 'is', null)
      .execute(),
  );
  const transport = nodemailer.createTransport(deps.operatorMail.url);
  let sent = 0;
  try {
    for (const r of recipients) {
      try {
        await transport.sendMail({
          from: deps.operatorMail.from,
          to: r.email,
          subject: alert.subject,
          text: `${alert.body}\n\n${alert.url_label ?? 'Open your vault'}: ${alert.url ?? deps.baseUrl}\n`,
          html: htmlAlert(alert, deps.baseUrl),
        });
        sent++;
      } catch (err) {
        deps.log('warn', 'operator email failed', {
          household: alert.household_id,
          error: (err as Error).message,
        });
      }
    }
  } finally {
    transport.close();
  }
  return sent;
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
