import { operatorMailBinding, sealBytes } from '@fdv/crypto';

/**
 * What the API asks the worker to send to one address (`mail.to_address`,
 * 5.20): a share link's code, to the address its sharer typed.
 *
 * Alerts go to accounts, by id (alert-job.ts); this goes to an address that
 * belongs to nobody in the vault, and only ever through the operator's mail
 * server (FDV_SMTP_URL), never the household's, which an owner can point
 * anywhere (A21). The worker's `sendToAddress` (apps/worker/src/jobs/mail.ts)
 * is the other half of this shape.
 *
 * What goes on the queue is sealed (operatorMailBinding, under a key derived
 * from the master key): the queue's table, and every backup of it, holds no
 * address and no code — only the household it is for.
 */
export const MAIL_JOB = 'mail.to_address';

export interface MailRequest {
  householdId: string;
  to: string;
  subject: string;
  /** Plain text: no link, and nothing that names what was shared. */
  text: string;
}

/** What the job carries: the household, and the rest sealed. */
export function mailJob(key: Buffer, m: MailRequest): Record<string, unknown> {
  const sealed = sealBytes(
    key,
    Buffer.from(JSON.stringify({ to: m.to, subject: m.subject, text: m.text }), 'utf8'),
    operatorMailBinding(m.householdId),
  );
  return { household_id: m.householdId, sealed: sealed.toString('base64') };
}
