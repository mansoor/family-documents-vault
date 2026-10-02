import { openBytes, operatorMailBinding } from '@fdv/crypto';
import { withSystem, type Db } from '@fdv/db';
import { sql } from 'kysely';
import nodemailer from 'nodemailer';
import type pg from 'pg';

/**
 * One email to one address (`mail.to_address`, 5.20): a share link's code,
 * to the address its sharer typed.
 *
 * Unlike an alert, it is to nobody with an account, so it carries its
 * address — sealed, with the rest, under a key derived from the master key
 * (apps/api/src/mail-job.ts is the other half), so the queue and every
 * backup of it hold no address and no code. It goes only through the
 * operator's mail server (FDV_SMTP_URL), never the household's, which an
 * owner can point anywhere (A21); without one it is not sent at all. It is
 * plain text, with no link and no button: whoever reads it types the code
 * where they asked for it. The log says that one was sent, or why not, and
 * never to whom or what it said.
 */

export interface MailJob {
  household_id: string;
  sealed: string;
}

export interface MailDeps {
  /** The key the API sealed the job under (OPERATOR_MAIL_KEY_PURPOSE). */
  mailKey: Buffer;
  /** The operator's mail server (FDV_SMTP_URL), if there is one. */
  operatorMail: { url: string; from: string } | null;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

export function isMailJob(data: unknown): data is MailJob {
  const m = data as MailJob;
  return typeof m?.household_id === 'string' && typeof m?.sealed === 'string';
}

/** Anything that looks like an email address, for a log line (apps/api's log-redaction.ts). */
const ADDRESS = /[^\s@<>"'(),;:[\]/\\]+@[^\s@<>"'(),;:[\]/\\]*\.[A-Za-z][A-Za-z0-9-]*/g;
const scrub = (s: string) => s.replace(ADDRESS, '[address]');

/** Sends it, or says in the log why not; true when the mail server took it. */
export async function sendToAddress(deps: MailDeps, job: MailJob): Promise<boolean> {
  if (!deps.operatorMail) {
    deps.log('warn', 'an email to one address, but FDV_SMTP_URL is not set: not sent', {
      household: job.household_id,
    });
    return false;
  }
  let mail: { to: string; subject: string; text: string };
  try {
    mail = JSON.parse(
      openBytes(
        deps.mailKey,
        Buffer.from(job.sealed, 'base64'),
        operatorMailBinding(job.household_id),
      ).toString('utf8'),
    ) as typeof mail;
  } catch {
    deps.log('warn', 'an email to one address that does not open: not sent', {
      household: job.household_id,
    });
    return false;
  }
  const transport = nodemailer.createTransport(deps.operatorMail.url);
  try {
    await transport.sendMail({
      from: deps.operatorMail.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
    return true;
  } catch (err) {
    // A mail server's words can name the recipient: never in the log.
    deps.log('warn', 'an email to one address failed', {
      household: job.household_id,
      error: scrub((err as Error).message ?? String(err)),
    });
    return false;
  } finally {
    transport.close();
  }
}

/**
 * What an ended link keeps of its code (5.20), cleared each night: the
 * address it went to — which the API clears as a link is taken back, locks
 * or is used up, and this clears once its end has passed — and every code
 * sent more than a day ago, or for a link that has ended. A code is only
 * ever needed for its 10 minutes, and its row for the day's count of sends.
 */
export async function pruneShareCodes(deps: {
  admin: pg.Pool;
  app: Db;
  log?: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}): Promise<{ addresses: number; codes: number }> {
  const ENDED = `(l.revoked_at is not null or l.expires_at <= now() or l.attempts >= 10
                  or (l.max_opens is not null and l.open_count >= l.max_opens))`;
  const { rows } = await deps.admin.query<{ household_id: string }>(
    `select household_id from share_link l where l.code_email is not null and ${ENDED}
     union
     select c.household_id from share_code c join share_link l on l.id = c.share_id
      where c.sent_at <= now() - interval '1 day' or ${ENDED}`,
  );
  let addresses = 0;
  let codes = 0;
  for (const { household_id: hh } of rows) {
    await withSystem(deps.app, hh, async (trx) => {
      const cleared = await sql`update share_link l set code_email = null
                                 where l.code_email is not null and ${sql.raw(ENDED)}`.execute(trx);
      addresses += Number(cleared.numAffectedRows ?? 0);
      const gone = await sql`delete from share_code c using share_link l
                              where l.id = c.share_id
                                and (c.sent_at <= now() - interval '1 day' or ${sql.raw(ENDED)})`.execute(
        trx,
      );
      codes += Number(gone.numAffectedRows ?? 0);
    });
  }
  if (addresses || codes) {
    deps.log?.('info', "cleared ended links' code addresses and old codes", { addresses, codes });
  }
  return { addresses, codes };
}
