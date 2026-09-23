import { createCipheriv, randomBytes } from 'node:crypto';
import { appendAudit, withScope, type Db } from '@fdv/db';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { requireCapability } from '../authz.js';

/**
 * Devices that want push, who wants email, and the household's own SMTP
 * (decision 13: bring your own, with presets and a Test button that must
 * pass before anything is sent through it).
 */

export const deviceBody = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
  label: z.string().trim().max(80).optional(),
});

export const preferenceBody = z
  .object({ daily_push: z.boolean(), daily_email: z.boolean(), weekly_email: z.boolean() })
  .partial();

export const smtpBody = z.object({
  provider: z.string().max(32).optional(),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  username: z.string().trim().max(255).nullable().optional(),
  password: z.string().max(512).nullable().optional(),
  from_name: z.string().trim().min(1).max(80).default('Family Document Vault'),
  from_email: z.string().trim().email().max(254),
});

/**
 * The common providers, so a household picks a name and pastes two
 * fields rather than hunting for a port number.
 */
export const SMTP_PRESETS: Record<
  string,
  { name: string; host: string; port: number; secure: boolean; hint: string }
> = {
  gmail: {
    name: 'Gmail',
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    hint: 'Use an app password, not your Google password.',
  },
  fastmail: {
    name: 'Fastmail',
    host: 'smtp.fastmail.com',
    port: 465,
    secure: true,
    hint: 'Create an app password under Settings → Privacy & Security.',
  },
  icloud: {
    name: 'iCloud Mail',
    host: 'smtp.mail.me.com',
    port: 587,
    secure: false,
    hint: 'Use an app-specific password from appleid.apple.com.',
  },
  outlook: {
    name: 'Outlook / Microsoft 365',
    host: 'smtp-mail.outlook.com',
    port: 587,
    secure: false,
    hint: 'Your email address is the username.',
  },
  ses: {
    name: 'Amazon SES',
    host: 'email-smtp.us-east-1.amazonaws.com',
    port: 587,
    secure: false,
    hint: 'Use SMTP credentials from the SES console, not your AWS keys.',
  },
  postmark: {
    name: 'Postmark',
    host: 'smtp.postmarkapp.com',
    port: 587,
    secure: false,
    hint: 'The server API token is both username and password.',
  },
  other: {
    name: 'Something else',
    host: '',
    port: 587,
    secure: false,
    hint: 'Your provider will call this SMTP or outgoing mail.',
  },
};

export interface SmtpView {
  configured: boolean;
  provider: string | null;
  host: string | null;
  port: number | null;
  secure: boolean;
  username: string | null;
  from_name: string | null;
  from_email: string | null;
  status: string;
  last_verified_at: string | null;
  last_error: string | null;
}

const ownerOnly = (p: Principal) => requireCapability(p, 'notifications.manage');

export function sealPassword(key: Buffer, password: string, householdId: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`smtp:${householdId}`));
  const ct = Buffer.concat([c.update(password, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export interface TestOutcome {
  ok: boolean;
  message: string;
  detail?: string;
}

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly smtpKey: Buffer,
    private readonly vapidPublicKey: string | null,
  ) {}

  /** What the browser needs before it can subscribe. */
  pushKey(): { public_key: string | null; enabled: boolean } {
    return { public_key: this.vapidPublicKey, enabled: Boolean(this.vapidPublicKey) };
  }

  async registerDevice(p: Principal, input: z.infer<typeof deviceBody>, meta: RequestMeta) {
    if (!this.vapidPublicKey) {
      throw new ApiError(
        503,
        'push_unavailable',
        'This vault is not set up for notifications yet.',
      );
    }
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await trx
        .insertInto('device')
        .values({
          household_id: p.householdId,
          account_id: p.accountId,
          kind: 'web_push',
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          label: input.label ?? null,
          user_agent: meta.userAgent ?? null,
          // Pushes to this browser end when this sign-in does.
          session_id: p.sessionId,
        })
        .onConflict((oc) =>
          oc.column('endpoint').doUpdateSet({
            account_id: p.accountId,
            household_id: p.householdId,
            session_id: p.sessionId,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
            failed_at: null,
            fail_reason: null,
            user_agent: meta.userAgent ?? null,
          }),
        )
        .returning(['id', 'created_at'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('notification_preference')
        .values({ account_id: p.accountId, household_id: p.householdId })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'notifications.device_registered',
        objectType: 'device',
        objectId: row.id,
        ip: meta.ip,
      });
      return { id: row.id };
    });
  }

  async removeDevice(p: Principal, endpoint: string): Promise<void> {
    await withScope(this.db, { householdId: p.householdId }, (trx) =>
      trx
        .deleteFrom('device')
        .where('endpoint', '=', endpoint)
        .where('account_id', '=', p.accountId)
        .execute(),
    );
  }

  async devices(p: Principal) {
    return withScope(this.db, { householdId: p.householdId }, (trx) =>
      trx
        .selectFrom('device')
        .select([
          'id',
          'endpoint',
          'label',
          'user_agent',
          'created_at',
          'last_used_at',
          'failed_at',
        ])
        .where('account_id', '=', p.accountId)
        .orderBy('created_at', 'desc')
        .execute(),
    ).then((rows) =>
      rows.map((r) => ({
        id: r.id,
        endpoint: r.endpoint,
        label: r.label,
        user_agent: r.user_agent,
        created_at: r.created_at.toISOString(),
        last_used_at: r.last_used_at?.toISOString() ?? null,
        working: r.failed_at === null,
      })),
    );
  }

  async preferences(p: Principal) {
    const row = await withScope(this.db, { householdId: p.householdId }, (trx) =>
      trx
        .selectFrom('notification_preference')
        .selectAll()
        .where('account_id', '=', p.accountId)
        .executeTakeFirst(),
    );
    return {
      daily_push: row?.daily_push ?? true,
      daily_email: row?.daily_email ?? false,
      weekly_email: row?.weekly_email ?? true,
    };
  }

  async updatePreferences(p: Principal, input: z.infer<typeof preferenceBody>) {
    await withScope(this.db, { householdId: p.householdId }, (trx) =>
      trx
        .insertInto('notification_preference')
        .values({ account_id: p.accountId, household_id: p.householdId, ...input })
        .onConflict((oc) => oc.columns(['account_id', 'household_id']).doUpdateSet(input))
        .execute(),
    );
    return this.preferences(p);
  }

  async smtp(p: Principal): Promise<SmtpView> {
    const row = await withScope(this.db, { householdId: p.householdId }, (trx) =>
      trx
        .selectFrom('smtp_settings')
        .selectAll()
        .where('household_id', '=', p.householdId)
        .executeTakeFirst(),
    );
    if (!row) {
      return {
        configured: false,
        provider: null,
        host: null,
        port: null,
        secure: false,
        username: null,
        from_name: null,
        from_email: null,
        status: 'untested',
        last_verified_at: null,
        last_error: null,
      };
    }
    return {
      configured: true,
      provider: row.provider,
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      from_name: row.from_name,
      from_email: row.from_email,
      status: row.status,
      last_verified_at: row.last_verified_at?.toISOString() ?? null,
      last_error: row.last_error,
    };
  }

  /** Saves the settings as untested. Nothing is sent until a Test passes. */
  async saveSmtp(
    p: Principal,
    input: z.infer<typeof smtpBody>,
    meta: RequestMeta,
  ): Promise<SmtpView> {
    ownerOnly(p);
    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const values = {
        household_id: p.householdId,
        provider: input.provider ?? null,
        host: input.host,
        port: input.port,
        secure: input.secure,
        username: input.username ?? null,
        from_name: input.from_name,
        from_email: input.from_email,
        status: 'untested' as const,
        last_error: null,
        last_verified_at: null,
        updated_at: new Date(),
        ...(input.password
          ? { password_encrypted: sealPassword(this.smtpKey, input.password, p.householdId) }
          : {}),
      };
      await trx
        .insertInto('smtp_settings')
        .values(values)
        .onConflict((oc) => oc.column('household_id').doUpdateSet(values))
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'notifications.smtp_saved',
        detail: { host: input.host, from: input.from_email },
        ip: meta.ip,
      });
    });
    return this.smtp(p);
  }

  /**
   * Sends a real message to the person asking, and reports in plain words.
   * Only a passing test switches the settings to `ok`.
   */
  async testSmtp(p: Principal, meta: RequestMeta): Promise<TestOutcome> {
    ownerOnly(p);
    const ctx = await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      const row = await trx
        .selectFrom('smtp_settings')
        .selectAll()
        .where('household_id', '=', p.householdId)
        .executeTakeFirst();
      if (!row) throw new ApiError(409, 'smtp_not_set', 'Fill in the email settings first.');
      const me = await trx
        .selectFrom('account')
        .select('email')
        .where('id', '=', p.accountId)
        .executeTakeFirstOrThrow();
      const hh = await trx
        .selectFrom('household')
        .select('name')
        .where('id', '=', p.householdId)
        .executeTakeFirstOrThrow();
      return { row, to: me.email, household: hh.name };
    });

    const { openPassword } = await import('./smtp-password.js');
    const transport = nodemailer.createTransport({
      host: ctx.row.host,
      port: ctx.row.port,
      secure: ctx.row.secure,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      ...(ctx.row.username && ctx.row.password_encrypted
        ? {
            auth: {
              user: ctx.row.username,
              pass: openPassword(this.smtpKey, ctx.row.password_encrypted, p.householdId),
            },
          }
        : {}),
    });
    let outcome: TestOutcome;
    try {
      await transport.sendMail({
        from: `"${ctx.row.from_name}" <${ctx.row.from_email}>`,
        to: ctx.to,
        subject: `Test from ${ctx.household}`,
        text: `This is the test message from your family vault.\n\nIf you are reading it, reminders will arrive the same way.\n`,
      });
      outcome = {
        ok: true,
        message: `Sent. Check ${ctx.to} — the test message should be there in a moment.`,
      };
    } catch (err) {
      outcome = { ok: false, message: explain(err), detail: (err as Error).message };
    } finally {
      transport.close();
    }

    await withScope(this.db, { householdId: p.householdId }, async (trx) => {
      await trx
        .updateTable('smtp_settings')
        .set({
          status: outcome.ok ? 'ok' : 'failed',
          last_verified_at: outcome.ok ? new Date() : null,
          last_error: outcome.ok ? null : (outcome.detail ?? outcome.message).slice(0, 300),
        })
        .where('household_id', '=', p.householdId)
        .execute();
      await appendAudit(trx, {
        householdId: p.householdId,
        actorAccountId: p.accountId,
        action: 'notifications.smtp_tested',
        detail: { ok: outcome.ok },
        ip: meta.ip,
      });
    });
    return outcome;
  }
}

/** SMTP failures, in words a person can act on. */
function explain(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const code = e.code ?? '';
  if (code === 'EAUTH' || e.responseCode === 535)
    return 'The username or password was not accepted. Many providers need an app password rather than your normal one.';
  if (code === 'ECONNREFUSED') return 'Nothing answered at that address and port.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return 'That server address could not be found.';
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION')
    return 'The mail server did not answer in time. Check the address, the port, and whether TLS should be on.';
  if (e.responseCode === 550 || e.responseCode === 553)
    return 'The server refused the from address. It usually has to be an address you own.';
  return 'The mail server refused the message.';
}
