import { openBytes } from '@fdv/crypto';
import { withSystem, type Db } from '@fdv/db';
import nodemailer from 'nodemailer';

/**
 * An emailed code for a request to send documents (5.21, A21): six digits,
 * to the address the requester typed, by the operator's mail server alone —
 * never the household's, which an owner can point anywhere. The email says
 * the code and how long it works, and nothing else: no link, no title, not
 * whose vault. The API hands the code over sealed under a key of the
 * server's, bound to the code's row; this opens it only to send it, and the
 * log says nothing of it, the address or the request.
 */

export interface UploadCodeJob {
  household_id: string;
  request_id: string;
  code_id: string;
  /** The code, sealed (base64): see the API's UploadRequestService.sendCode. */
  sealed: string;
}

export interface UploadCodeDeps {
  app: Db;
  /** deriveKey(master, 'upload-code-job'): the API's `codeJobKey`. */
  codeJobKey: Buffer;
  /** The operator's mail server (FDV_SMTP_URL), if there is one. */
  operatorMail: { url: string; from: string } | null;
  log: (level: string, msg: string, extra?: Record<string, unknown>) => void;
}

export function isUploadCodeJob(data: unknown): data is UploadCodeJob {
  const j = data as UploadCodeJob;
  return (
    typeof j?.household_id === 'string' &&
    typeof j?.request_id === 'string' &&
    typeof j?.code_id === 'string' &&
    typeof j?.sealed === 'string'
  );
}

/** Sends one code, if it can still be used. Returns whether an email went. */
export async function sendUploadCode(deps: UploadCodeDeps, job: UploadCodeJob): Promise<boolean> {
  if (!deps.operatorMail) {
    deps.log('warn', 'an emailed code was asked for, but FDV_SMTP_URL is not set');
    return false;
  }
  const to = await withSystem(deps.app, job.household_id, async (trx) => {
    const row = await trx
      .selectFrom('upload_code')
      .innerJoin('upload_request', 'upload_request.id', 'upload_code.request_id')
      .select(['upload_request.recipient_email as email'])
      .where('upload_code.id', '=', job.code_id)
      .where('upload_code.request_id', '=', job.request_id)
      .where('upload_code.used_at', 'is', null)
      .where('upload_code.expires_at', '>', new Date())
      .where('upload_request.email_code', '=', true)
      .where('upload_request.revoked_at', 'is', null)
      .where('upload_request.closed_at', 'is', null)
      .executeTakeFirst();
    return row?.email ?? null;
  });
  // Used, run out, or its request ended meanwhile: nothing to send.
  if (!to) return false;
  const code = openBytes(
    deps.codeJobKey,
    Buffer.from(job.sealed, 'base64'),
    `upload-code:${job.code_id}`,
  ).toString('utf8');
  const transport = nodemailer.createTransport(deps.operatorMail.url);
  try {
    await transport.sendMail({
      from: deps.operatorMail.from,
      to,
      subject: 'Your code',
      text:
        `Your code is ${code}. It works for 10 minutes, once.\n\n` +
        'You asked for it on a page for sending documents. If you did not, ignore this email.\n',
    });
    return true;
  } catch (err) {
    // What kind of failure, never to whom or what it said: a mail server's
    // own message can repeat the address.
    const e = err as { code?: unknown; responseCode?: unknown };
    deps.log('warn', 'an emailed code could not be sent', {
      code: typeof e.code === 'string' ? e.code : null,
      response_code: typeof e.responseCode === 'number' ? e.responseCode : null,
    });
    throw err;
  } finally {
    transport.close();
  }
}
