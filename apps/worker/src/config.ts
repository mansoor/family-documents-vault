import { canonicalZone, isTimeZone } from '@fdv/shared';
import { z } from 'zod';

/**
 * The levels a line is written at, least to most said: every one the API
 * takes (compose passes LOG_LEVEL to both), so `trace` or `fatal` never stops
 * the worker (the Phase 5 exit's review, D541-06).
 */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Whether a line at `level` is written when the worker is set to `setting`. */
export function logs(setting: LogLevel, level: string): boolean {
  const at = LOG_LEVELS.indexOf(level as LogLevel);
  return at >= 0 && at <= LOG_LEVELS.indexOf(setting);
}

const schema = z.object({
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: z.string().min(1).describe('Connection string for the application role.'),
  FDV_MASTER_KEY: z.string().min(32).optional(),
  FDV_MASTER_KEY_FILE: z.string().min(1).optional(),
  FDV_LOCAL_VAULT_DIR: z.string().min(1).default('/data/vault'),
  FDV_BACKUP_DIR: z.string().min(1).default('/data/backups'),
  FDV_BACKUP_RETAIN_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  FDV_BACKUP_CRON: z.string().min(1).default('30 2 * * *'),
  FDV_WEEKLY_HOUR: z.coerce
    .number()
    .int()
    .min(0)
    .max(23)
    .default(18)
    .describe('Local hour on Sunday for the weekly email summary.'),
  FDV_BASE_URL: z
    .string()
    .url()
    .default('http://localhost:8080')
    .describe('Where your vault is reachable; used for links in notifications.'),
  FDV_SMTP_URL: z
    .string()
    .regex(/^smtps?:[/][/]/, 'Use smtp://… or smtps://…')
    .optional()
    .describe(
      'The operator\u2019s mail server, for password-reset links and the codes a share link asks for.',
    ),
  FDV_SMTP_FROM: z
    .string()
    .min(3)
    .default('Family Document Vault <vault@localhost>')
    .describe('Who password-reset emails and share-link codes come from.'),
  FDV_VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  FDV_VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  FDV_VAPID_SUBJECT: z.string().min(1).default('mailto:vault@localhost'),
  FDV_PUSH_ALLOW_PRIVATE_ENDPOINTS: z
    .enum(['true', 'false'])
    .default('false')
    .describe(
      'Let pushes go to addresses inside your own network — a UnifiedPush distributor ' +
        '(ntfy) on the LAN. Off by default: a push address is chosen by whoever registers ' +
        'a device, and must not be able to point the vault at its own network.',
    ),
  FDV_TIMEZONE: z
    .string()
    .trim()
    .refine(isTimeZone, {
      message:
        'not a time zone this server knows: give an IANA name such as Europe/London, America/New_York or UTC',
    })
    // As the runtime spells it: "europe/london" is "Europe/London" (the TZ review).
    .transform((z) => canonicalZone(z) ?? z)
    .default('UTC')
    .describe(
      'The family’s time zone until an owner chooses one in Settings (0.9.0): the hour ' +
        'reminders and digests arrive at, and every time the worker writes, are on it.',
    ),
  FDV_DIGEST_HOUR: z.coerce
    .number()
    .int()
    .min(0)
    .max(23)
    .default(9)
    .describe("The household's local hour for the daily reminder message."),
  FDV_OCR_MAX_PAGES: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(20)
    .describe(
      "Pages of a PDF that are read, by the PDF's own text or by OCR where a page has none; the rest are stored but not searchable.",
    ),
  FDV_WATCH_DIR: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A folder a network scanner saves into (S3): mounted into the worker, it fills one ' +
        "person's Inbox once an owner turns it on. Unset: there is no scanner folder.",
    ),
  FDV_WATCH_ROOTS: z
    .string()
    .min(1)
    .max(4000)
    .default('/watch')
    .transform((s) =>
      s
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r.length > 0),
    )
    .refine((roots) => roots.length > 0 && roots.length <= 20, 'one to twenty folders')
    .describe(
      'The folders mounted into the worker that an owner may choose the scanner folder inside, ' +
        'in Settings (0.9.0), comma-separated. FDV_WATCH_DIR may always be chosen too.',
    ),
  FDV_WATCH_STABLE_SECONDS: z.coerce
    .number()
    .int()
    .min(2)
    .max(3600)
    .default(10)
    .describe(
      'How long a file in the scanner folder must stop changing before it is taken (it must look complete too).',
    ),
  FDV_WATCH_INCOMPLETE_GRACE_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86400)
    .default(120)
    .describe(
      'How long a scan that has stopped changing but looks unfinished waits before it is taken anyway.',
    ),
  FDV_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024)
    .describe(
      'Largest single file the vault accepts: from the scanner folder, or attached to an email, as from an upload.',
    ),
  FDV_MAIL_IN_HOST: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$/, 'a host name, such as imap.gmail.com')
    .optional()
    .describe(
      "The household mailbox's IMAP server (S4): with FDV_MAIL_IN_USER and a password, email in can be turned on.",
    ),
  FDV_MAIL_IN_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(993)
    .describe('Its IMAP port: TLS from the start, the certificate verified (993).'),
  FDV_MAIL_IN_USER: z
    .string()
    .min(1)
    .max(320)
    .optional()
    .describe('The sign-in of the household mailbox: usually its address.'),
  FDV_MAIL_IN_PASSWORD: z
    .string()
    .min(1)
    .optional()
    .describe('Its password (an app password): never logged, sent to the web, or stored.'),
  FDV_MAIL_IN_PASSWORD_FILE: z
    .string()
    .min(1)
    .optional()
    .describe('Or a file holding it (a Docker secret).'),
  FDV_MAIL_IN_ADDRESS: z
    .string()
    .min(3)
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+$/, 'an email address')
    .optional()
    .describe(
      'Where the family sends documents, shown to them; by default FDV_MAIL_IN_USER, when that is an address.',
    ),
  FDV_MAIL_IN_FOLDER: z
    .string()
    .min(1)
    .max(200)
    .default('INBOX')
    .describe('The folder checked for mail.'),
  FDV_MAIL_IN_POLL_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(86400)
    .default(300)
    .describe('How often the mailbox is checked.'),
  FDV_MAIL_IN_AFTER: z
    .enum(['move', 'delete'])
    .default('move')
    .describe(
      'What is done with an email once its attachments are in: moved to "Filed", or deleted.',
    ),
  FDV_MAIL_IN_AUTHSERV_ID: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$/, 'an authserv-id, such as mx.google.com')
    .optional()
    .describe(
      "The mailbox provider's Authentication-Results id (mx.google.com): set, a sender is accepted only on its word.",
    ),
  FDV_MAIL_IN_ALLOWED_PORTS: z
    .string()
    .min(1)
    .max(200)
    .default('993')
    .transform((s) =>
      s
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map(Number),
    )
    .refine(
      (ports) =>
        ports.length > 0 &&
        ports.length <= 20 &&
        ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535),
      'one to twenty port numbers',
    )
    .describe(
      'The ports a household mailbox set up in Settings may be on (0.9.0), comma-separated: 993 by default. FDV_MAIL_IN_PORT is the operator’s own, and not limited.',
    ),
  FDV_MAIL_IN_ALLOW_PRIVATE: z
    .enum(['true', 'false'])
    .default('false')
    .describe(
      'Let a household mailbox set up in Settings be on an address inside your own network (a mail server on the LAN). Off by default: an owner types the server, and must not be able to point the vault at its own network.',
    ),
  FDV_LOCAL_AI_URL: z
    .string()
    .max(2000)
    .transform((s, ctx) => {
      const url = localAiUrl(s);
      if (typeof url === 'string') {
        ctx.addIssue({ code: 'custom', message: url });
        return z.NEVER;
      }
      return url;
    })
    .optional()
    .describe(
      'The local AI reader (0.9.0, R4): an Ollama-compatible endpoint on your own server or ' +
        'network, such as http://ollama:11434. http or https, no user or password in it. ' +
        "Unset: there is no local AI. The worker sends it a paper's words and nothing leaves " +
        'for anywhere else; it must be your own.',
    ),
  FDV_LOCAL_AI_MODEL: z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/,
      'a model name such as qwen2.5:3b-instruct or llama3.2:3b',
    )
    .optional()
    .describe('The model the local AI reader asks for, pulled on that endpoint.'),
  FDV_LOCAL_AI_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(300)
    .default(120)
    .describe(
      'How long the local AI may take over one paper before it is read without it (5 to 300).',
    ),
  DATABASE_ADMIN_URL: z
    .string()
    .min(1)
    .optional()
    .describe('Connection string for the owning role; the job queue installs its schema with it.'),
});

export type WorkerConfig = z.infer<typeof schema>;

/**
 * FDV_LOCAL_AI_URL checked (R4): http or https, a host, no user or password,
 * no query or fragment; a path is kept as the endpoint's base. The URL, or
 * what is wrong with it.
 */
export function localAiUrl(s: string): URL | string {
  let url: URL;
  try {
    url = new URL(s.trim());
  } catch {
    return 'not a URL: give one such as http://ollama:11434';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'use http:// or https://';
  if (url.username || url.password) {
    return 'no user name or password in it: the local AI is on your own network';
  }
  if (!url.hostname) return 'give the host: http://ollama:11434';
  if (url.search || url.hash) return 'no query or # in it';
  return url;
}

const withMasterKey = schema
  .refine((c) => c.FDV_MASTER_KEY || c.FDV_MASTER_KEY_FILE, {
    message: 'set FDV_MASTER_KEY (or FDV_MASTER_KEY_FILE)',
    path: ['FDV_MASTER_KEY'],
  })
  .refine((c) => !c.FDV_LOCAL_AI_URL || c.FDV_LOCAL_AI_MODEL, {
    message: 'set FDV_LOCAL_AI_MODEL too: the model to ask for at FDV_LOCAL_AI_URL',
    path: ['FDV_LOCAL_AI_MODEL'],
  });

/**
 * An environment variable set to nothing is not set. Compose writes
 * `${FDV_VAPID_PUBLIC_KEY:-}` for anything optional, which hands the
 * container an empty string rather than leaving the variable out.
 */
function present(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = withMasterKey.safeParse(present(env));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration:\n${problems.join('\n')}`);
  }
  return parsed.data;
}
