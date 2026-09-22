import { z } from 'zod';

/**
 * All API configuration comes from the environment. The public README's
 * configuration table is generated from the descriptions here, so every
 * setting a self-hoster can touch must be described in plain words.
 */
const schema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1).describe('Connection string for the application role.'),
  DATABASE_ADMIN_URL: z
    .string()
    .min(1)
    .optional()
    .describe('Connection string for the migration (table-owning) role. Defaults to DATABASE_URL.'),
  FDV_RUN_MIGRATIONS: z
    .enum(['true', 'false'])
    .default('true')
    .describe('Apply pending database migrations on start.'),

  FDV_DISPLAY_NAME: z.string().min(1).default('Our family vault'),
  FDV_EDITION: z.enum(['self_hosted', 'hosted']).default('self_hosted'),
  FDV_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024)
    .describe('Largest single file the vault accepts.'),
});

export type ApiConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid configuration:\n${problems}`);
  }
  return parsed.data;
}
