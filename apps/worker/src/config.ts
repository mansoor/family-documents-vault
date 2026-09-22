import { z } from 'zod';

const schema = z.object({
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  DATABASE_URL: z.string().min(1).describe('Connection string for the application role.'),
  FDV_MASTER_KEY: z.string().min(32).optional(),
  FDV_MASTER_KEY_FILE: z.string().min(1).optional(),
  FDV_LOCAL_VAULT_DIR: z.string().min(1).default('/data/vault'),
  FDV_OCR_MAX_PAGES: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(20)
    .describe('Pages of a PDF that are OCRed; the rest are stored but not searchable.'),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = withMasterKey.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid configuration:\n${problems.join('\n')}`);
  }
  return parsed.data;
}
