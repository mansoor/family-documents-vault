import { createCipheriv, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { appendAudit, withScope, type Db } from '@fdv/db';
import { isLoopbackName, isPrivateAddress, pushAddressProblem } from '@fdv/shared';
import { sql } from 'kysely';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { Principal, RequestMeta } from '../auth/service.js';
import { ApiError } from '../errors.js';
import { allows, requireCapability } from '../authz.js';
import type { AlertRequest } from '../alert-job.js';
import type { PushRequest } from '../push-job.js';

/**
 * Devices that want push, who wants email, and the household's own SMTP
 * (decision 13: bring your own, with presets and a Test button that must
 * pass before anything is sent through it).
 */

export const deviceBody = z.object({
  /** A browser (Web Push), or the phone app through its distributor (UnifiedPush, 4.13). */
  kind: z.enum(['web_push', 'unified_push']).default('web_push'),
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
  label: z.string().trim().max(80).optional(),
});

/** Where a push address's host is, as the vault would reach it. */
export type Resolve = (host: string) => Promise<string[]>;
const resolveHost: Resolve = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

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

/**
 * Whether a device's session is still going — the worker's `liveDevice`,
 * seen from the person asking: a device from before 0.4.2 names no session
 * and goes with the account, which is signed in to be asking.
 */
const live = sql<boolean>`(device.session_id is null or exists (
  select 1 from session s
   where s.id = device.session_id and s.revoked_at is null and s.expires_at > now()))`;

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly smtpKey: Buffer,
    private readonly vapidPublicKey: string | null,
    private readonly alert: (input: AlertRequest) => Promise<void> = async () => undefined,
    private readonly opts: {
      /** Pushes the worker sends (4.13): a device's test. */
      push?: (input: PushRequest) => Promise<void>;
      /** FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS: a distributor on the operator's own network. */
      allowPrivateEndpoints?: boolean;
      /** Tests: DNS of their own. */
      resolve?: Resolve;
    } = {},
  ) {}

  /**
   * A push address the vault will send to: https, and not inside the
   * vault's own network (the worker checks again when it connects, on the
   * address DNS gives then). A name DNS cannot answer for now is left to
   * that check.
   */
  private async checkAddress(endpoint: string): Promise<void> {
    if (pushAddressProblem(endpoint)) {
      throw new ApiError(422, 'validation_failed', 'Push addresses must start with https://.');
    }
    if (this.opts.allowPrivateEndpoints) return;
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      addresses = isLoopbackName(host)
        ? ['127.0.0.1']
        : isIP(host)
          ? [host]
          : await (this.opts.resolve ?? resolveHost)(host);
    } catch {
      return;
    }
    if (addresses.some((a) => isPrivateAddress(a))) {
      throw new ApiError(
        422,
        'validation_failed',
        "That push address points inside the vault's own network, which isn't allowed.",
      );
    }
  }

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
    await this.checkAddress(input.endpoint);
    const installation = meta.installationId ?? null;
    return withScope(this.db, { householdId: p.householdId }, async (trx) => {
      // A phone signing in again brings a new address: its old one goes.
      if (installation && input.kind === 'unified_push') {
        await trx
          .deleteFrom('device')
          .where('account_id', '=', p.accountId)
          .where('installation_id', '=', installation)
          .where('kind', '=', 'unified_push')
          .where('endpoint', '!=', input.endpoint)
          .execute();
      }
      const row = await trx
        .insertInto('device')
        .values({
          household_id: p.householdId,
          account_id: p.accountId,
          kind: input.kind,
          installation_id: installation,
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
            // Signed in again: it follows the new session (and ends with it).
            session_id: p.sessionId,
            kind: input.kind,
            installation_id: installation,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
            failed_at: null,
            fail_reason: null,
            consecutive_failures: 0,
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
          'kind',
          'endpoint',
          'label',
          'user_agent',
          'created_at',
          'last_used_at',
          'failed_at',
          'session_id',
        ])
        .select(live.as('live'))
        .where('account_id', '=', p.accountId)
        .orderBy('created_at', 'desc')
        .execute(),
    ).then((rows) =>
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        endpoint: r.endpoint,
        label: r.label,
        user_agent: r.user_agent,
        created_at: r.created_at.toISOString(),
        last_used_at: r.last_used_at?.toISOString() ?? null,
        working: r.failed_at === null && r.live,
        failed_at: r.failed_at?.toISOString() ?? null,
        this_session: r.session_id === p.sessionId,
        signed_out: !r.live,
      })),
    );
  }

  /** A test push, to one of your own devices only (4.13). */
  async testDevice(p: Principal, id: string): Promise<void> {
    const device = await withScope(this.db, { householdId: p.householdId }, (trx) =>
      trx
        .selectFrom('device')
        .select(['id', 'kind', 'endpoint', 'p256dh', 'auth'])
        .select(live.as('live'))
        .where('id', '=', id)
        .where('account_id', '=', p.accountId)
        .executeTakeFirst(),
    );
    if (
      !device ||
      !device.p256dh ||
      !device.auth ||
      (device.kind !== 'web_push' && device.kind !== 'unified_push')
    ) {
      throw new ApiError(404, 'not_found', 'There is no such device of yours.');
    }
    // Digests and alerts skip it (the worker's liveDevice): a test must not say it works.
    if (!device.live) {
      throw new ApiError(
        409,
        'signed_out',
        'That device is signed out. Sign in on it again and it will hear from the vault.',
      );
    }
    await this.opts.push?.({
      householdId: p.householdId,
      message: { v: 1, type: 'test' },
      targets: [
        {
          id: device.id,
          kind: device.kind,
          endpoint: device.endpoint,
          p256dh: device.p256dh,
          auth: device.auth,
        },
      ],
    });
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
    // How email is set up — the host, the sign-in (often the owner's own
    // address), the last error — is for whoever may change it. Everyone
    // else is told only whether email works (5.3).
    const full = allows(p, 'notifications.manage');
    return {
      configured: true,
      provider: full ? row.provider : null,
      host: full ? row.host : null,
      port: full ? row.port : null,
      secure: row.secure,
      username: full ? row.username : null,
      from_name: full ? row.from_name : null,
      from_email: full ? row.from_email : null,
      status: row.status,
      last_verified_at: row.last_verified_at?.toISOString() ?? null,
      last_error: full ? row.last_error : null,
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
      // Every email the vault sends goes through this server, so whoever
      // controls it can read them. Everybody else who can see the adults'
      // documents is told when it changes, by push as well as by email.
      const me = await trx
        .selectFrom('member')
        .select('display_name')
        .where('id', '=', p.memberId)
        .executeTakeFirst();
      const others = await trx
        .selectFrom('account_household')
        .select('account_id')
        .where('role', 'in', ['owner', 'adult'])
        .where('account_id', '!=', p.accountId)
        .execute();
      if (others.length > 0) {
        await this.alert({
          householdId: p.householdId,
          accountIds: others.map((o) => o.account_id),
          subject: 'The vault\u2019s mail server was changed',
          body: `${me?.display_name ?? 'An owner'} changed where the vault\u2019s email comes from, to ${input.host}. Your reminders travel through it. If that is a surprise, ask them about it.`,
        });
      }
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
