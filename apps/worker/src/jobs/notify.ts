import { createDecipheriv } from 'node:crypto';
import type https from 'node:https';
import { withSystem, type Db } from '@fdv/db';
import { sql } from 'kysely';
import nodemailer from 'nodemailer';
import { deliver, pushDepsOf, unifiedPayload } from './push.js';
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
 *
 * Each call is one person's digest, already cut to what they may see (see
 * `sendToEach` in reminders.ts). So push goes only to that person's own
 * devices and email only to their own address, one message each: never a
 * household-wide list, and never everybody's address on one To: line.
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
  /** How pushes leave (4.13): the safe agent by default; tests bring their own. */
  agent?: https.Agent;
  /** FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS: a push distributor on the operator's own network. */
  allowPrivate?: boolean;
}

export function subject(d: Digest): string {
  const n = d.items.length;
  const overdue = d.items.filter((i) => i.overdue).length;
  if (d.kind === 'weekly') return `Your week in ${d.household_name}`;
  if (overdue === n) return n === 1 ? '1 thing has lapsed' : `${n} things have lapsed`;
  return n === 1 ? '1 thing needs attention' : `${n} things need attention`;
}

/**
 * What an email may say about an item. Email goes through the household's
 * mail server, which an owner can point anywhere, so a private document is
 * named only as that — its title and note stay for push and the app.
 */
export function forEmail(i: Digest['items'][number]): {
  title: string;
  label: string;
  note: string | null;
  overdue: boolean;
} {
  // Field by field, never the whole item: a field added to digest items
  // later stays out of email until somebody decides it may go.
  return i.private
    ? { title: 'One of your private documents', label: i.label, note: null, overdue: i.overdue }
    : { title: i.title, label: i.label, note: i.note, overdue: i.overdue };
}

export function textBody(d: Digest, baseUrl: string): string {
  const lines = d.items.map((item) => {
    const i = forEmail(item);
    return `• ${i.title} — ${i.label}${i.note ? ` (${i.note})` : ''}`;
  });
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
    .map((item) => forEmail(item))
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

/**
 * Whether the mail server turned down this recipient, as opposed to
 * failing. Since each person's digest is its own message, one mistyped
 * address in an invitation would otherwise mark the household's mail
 * server broken for everybody — and switch off the security alerts, which
 * only go out through a server marked working.
 */
export function recipientRefused(err: unknown): boolean {
  const e = err as { code?: unknown; command?: unknown; rejected?: unknown } | null;
  return e?.code === 'EENVELOPE' && (e.command === 'RCPT TO' || Array.isArray(e.rejected));
}

/**
 * A device is only pushed to while the sign-in that turned it on is live.
 * Signing out, a revoked session, a password change and a removed sign-in
 * all end it, and with it every notification to that browser (0020).
 * Devices from before 0.4.2 name no session, and are sent to only while
 * the account has some live session in the household.
 */
export const liveDevice = sql<boolean>`(
  (device.session_id is not null and exists (
     select 1 from session s
      where s.id = device.session_id and s.revoked_at is null and s.expires_at > now()))
  or (device.session_id is null and exists (
     select 1 from session s
      where s.account_id = device.account_id and s.household_id = device.household_id
        and s.revoked_at is null and s.expires_at > now())))`;

/** Shared with the alert job, which uses the same household mail server. */
export function openPassword(key: Buffer, sealed: Buffer, householdId: string): string {
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(`smtp:${householdId}`));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]).toString('utf8');
}

/**
 * The real notifier: push to the recipient's registered devices if they
 * want it, then email through the household's SMTP if they want that.
 * Returns the channels that actually reached them, which is what the
 * ledger records.
 */
export function createNotifier(deps: NotifyDeps): Notifier {
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
          account_id: d.recipient.account_id,
          count: d.items.length,
        });
      }
      return channels;
    },
  };
}

async function sendPush(deps: NotifyDeps, d: Digest): Promise<number> {
  if (!deps.vapid) return 0;
  const devices = await withSystem(deps.app, d.household_id, (trx) =>
    trx
      .selectFrom('device')
      .leftJoin('notification_preference', (j) =>
        j
          .onRef('notification_preference.account_id', '=', 'device.account_id')
          .onRef('notification_preference.household_id', '=', 'device.household_id'),
      )
      .select([
        'device.id',
        'device.kind',
        'device.endpoint',
        'device.p256dh',
        'device.auth',
        'notification_preference.daily_push',
      ])
      .where('device.account_id', '=', d.recipient.account_id)
      .where('device.failed_at', 'is', null)
      .where('device.kind', 'in', ['web_push', 'unified_push'])
      .where(liveDevice)
      .execute(),
  );
  // The Sunday summary is an email; a phone hears of the day's reminders (4.13).
  const wanted = devices.filter(
    (x) =>
      x.daily_push !== false &&
      x.p256dh &&
      x.auth &&
      !(d.kind === 'weekly' && x.kind === 'unified_push'),
  );
  if (wanted.length === 0) return 0;

  // A browser shows the first few; a phone is told how many, and asks the
  // vault for the rest once it is unlocked (4.13): no title leaves in it.
  const phone = unifiedPayload({ v: 1, type: 'digest', count: d.items.length, date: d.local_date });
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

  const pd = pushDepsOf(deps);
  let sent = 0;
  for (const device of wanted) {
    const outcome = await deliver(
      pd,
      {
        id: device.id,
        household_id: d.household_id,
        endpoint: device.endpoint,
        p256dh: device.p256dh as string,
        auth: device.auth as string,
      },
      device.kind === 'unified_push' ? phone : payload,
      'digest',
    );
    if (outcome === 'sent') sent++;
  }
  return sent;
}

async function sendEmail(deps: NotifyDeps, d: Digest): Promise<number> {
  const ctx = await withSystem(deps.app, d.household_id, async (trx) => {
    const smtp = await trx
      .selectFrom('smtp_settings')
      .selectAll()
      .where('household_id', '=', d.household_id)
      .executeTakeFirst();
    if (!smtp || smtp.status !== 'ok') return null;
    const wantField = d.kind === 'weekly' ? 'weekly_email' : 'daily_email';
    const pref = await trx
      .selectFrom('notification_preference')
      .select([`${wantField} as wants`])
      .where('account_id', '=', d.recipient.account_id)
      .where('household_id', '=', d.household_id)
      .executeTakeFirst();
    const wants = pref?.wants ?? null;
    // Defaults: weekly on, daily off (design: per-item email is off).
    const wanted = wants === null ? d.kind === 'weekly' : wants === true;
    return { smtp, wanted };
  });
  if (!ctx || !ctx.wanted) return 0;

  const { smtp } = ctx;
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
      to: d.recipient.email,
      subject: subject(d),
      text: textBody(d, deps.baseUrl),
      html: htmlBody(d, deps.baseUrl),
    });
    return 1;
  } catch (err) {
    if (recipientRefused(err)) {
      // This one address, not the mail server: the rest of the family still
      // gets their digests, and their security alerts, from it.
      deps.log('warn', 'email address refused', {
        household: d.household_name,
        account_id: d.recipient.account_id,
        error: (err as Error).message,
      });
      return 0;
    }
    deps.log('warn', 'email failed', {
      household: d.household_name,
      account_id: d.recipient.account_id,
      error: (err as Error).message,
    });
    await withSystem(deps.app, d.household_id, (trx) =>
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
