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
  DATABASE_ADMIN_URL: z
    .string()
    .min(1)
    .optional()
    .describe('Connection string for the owning role; the job queue installs its schema with it.'),
});

export type WorkerConfig = z.infer<typeof schema>;

const withMasterKey = schema.refine((c) => c.FDV_MASTER_KEY || c.FDV_MASTER_KEY_FILE, {
  message: 'set FDV_MASTER_KEY (or FDV_MASTER_KEY_FILE)',
  path: ['FDV_MASTER_KEY'],
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
