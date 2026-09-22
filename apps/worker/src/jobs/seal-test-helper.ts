import { createCipheriv, randomBytes } from 'node:crypto';

/** Mirrors the API's sealPassword, for tests that set SMTP rows directly. */
export function sealPassword(key: Buffer, password: string, householdId: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`smtp:${householdId}`));
  const ct = Buffer.concat([c.update(password, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
