import { createDecipheriv } from 'node:crypto';

/** Opens an SMTP password sealed by `sealPassword`. */
export function openPassword(key: Buffer, sealed: Buffer, householdId: string): string {
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(`smtp:${householdId}`));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]).toString('utf8');
}
