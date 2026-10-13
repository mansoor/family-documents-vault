/**
 * The mail thread (0.8.0, S4): a mail from the household mailbox read off
 * the worker's event loop, for `MailThread` (jobs/mail-thread.ts), as the
 * proposal thread reads an item's words. A mail is untrusted input from
 * anybody who knows the mailbox's address: its MIME is read here alone, by
 * mailparser (MIT), on a thread with a bounded heap and no copy of the
 * environment, stopped at its deadline.
 *
 * Two jobs, one at a time:
 *
 *  - `head`: the first bytes of a mail, its header — who it is From (one
 *    address, in one From header, or none), its Message-ID, the codes in its
 *    subject (never the subject itself), and whether the mailbox's provider
 *    vouched for the sender (mail-auth.ts).
 *  - `message`: a whole mail — the same, and its attachments: each one's
 *    name, kind as it says, size, and bytes, up to a size; one larger is
 *    said to be, and not kept. A forwarded mail (message/rfc822), attached
 *    or inline, is read for its own attachments, three deep at most. The
 *    body is read past, never kept: no text, no HTML made of it.
 *
 * It keeps nothing between mails, and logs nothing.
 */
import { parentPort } from 'node:worker_threads';
import { MailParser, type AddressObject, type HeaderLines, type Headers } from 'mailparser';
import { mailInCodesIn } from '@fdv/shared';
import { authVerdict, type AuthVerdict } from './jobs/mail-auth.js';

/** What a mail's header says, as far as the vault asks. */
export interface MailHead {
  /** Its From: one address, lower-cased; null for none, several, a group, or several From headers. */
  from: string | null;
  /** Its Message-ID, as written (at most 998 characters); null for none. */
  messageId: string | null;
  /** The codes to confirm an address in its subject (MAIL_IN_CODE_PATTERN). */
  codes: string[];
  /** The provider's word on the sender, when an authserv-id is set; `fail` otherwise. */
  auth: AuthVerdict;
}

/** An attachment of a mail. */
export interface MailPart {
  /** Its file name as the mail says; null for none. */
  name: string | null;
  /** Its kind as the mail says (the vault sniffs its bytes for its own). */
  contentType: string;
  size: number;
  /** In the body (Content-Disposition inline, or a picture the body refers to). */
  inline: boolean;
  /** Larger than it may be: its bytes are not here. */
  tooLarge: boolean;
  content: Uint8Array | null;
}

export type MailJob =
  | { id: number; kind: 'head'; bytes: Uint8Array; authservId: string | null }
  | {
      id: number;
      kind: 'message';
      bytes: Uint8Array;
      authservId: string | null;
      /** The most an attachment may be (FDV_MAX_UPLOAD_BYTES). */
      maxPartBytes: number;
    };

export type MailReply =
  | { ready: true }
  | { id: number; head: MailHead; parts?: MailPart[] }
  | { id: number; failed: true };

/** At most this many attachments are kept of a mail; the rest are not read. */
export const MAX_PARTS = 100;
/** Forwarded mails inside forwarded mails: this deep, and no deeper. */
const MAX_DEPTH = 3;

const PARSER_OPTIONS = {
  skipHtmlToText: true,
  skipTextToHtml: true,
  skipTextLinks: true,
  skipImageLinks: true,
  maxHtmlLengthToParse: 0,
} as const;

/** The header block of a mail's first bytes: up to the blank line, or all of them. */
function headerBlock(bytes: Buffer): Buffer | null {
  const crlf = bytes.indexOf('\r\n\r\n');
  const lf = bytes.indexOf('\n\n');
  const ends = [crlf >= 0 ? crlf + 4 : -1, lf >= 0 ? lf + 2 : -1].filter((n) => n >= 0);
  if (ends.length) return bytes.subarray(0, Math.min(...ends));
  return null;
}

/** The head of a parsed mail, from its headers and their lines. */
function headOf(headers: Headers, lines: HeaderLines, authservId: string | null): MailHead {
  const fromLines = lines.filter((l) => l.key === 'from').length;
  const fromHeader = headers.get('from') as AddressObject | undefined;
  const addresses = fromHeader?.value ?? [];
  const one = addresses.length === 1 ? addresses[0] : undefined;
  const address =
    fromLines === 1 && one && !one.group && typeof one.address === 'string'
      ? one.address.trim().toLowerCase()
      : null;
  // An address the vault could compare: one @, something either side, no space.
  const from = address && /^[^\s@]+@[^\s@]+$/.test(address) ? address : null;
  const rawId = headers.get('message-id');
  const messageId =
    typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim().slice(0, 998) : null;
  const subject = headers.get('subject');
  const codes = typeof subject === 'string' ? mailInCodesIn(subject.slice(0, 4096)) : [];
  const auth =
    from && authservId
      ? authVerdict(
          lines.map((l) => ({ key: l.key, line: l.line })),
          authservId,
          from.split('@')[1] as string,
        )
      : 'fail';
  return { from, messageId, codes, auth };
}

/**
 * A mail read: its head, and its attachments (`maxPartBytes` > 0) — those of
 * a forwarded mail inside it too, `depth` deep.
 */
function read(
  bytes: Buffer,
  authservId: string | null,
  maxPartBytes: number,
  depth: number,
  parts: MailPart[],
): Promise<MailHead> {
  return new Promise<MailHead>((resolve, reject) => {
    const parser = new MailParser(PARSER_OPTIONS);
    let headers: Headers | null = null;
    let lines: HeaderLines = [];
    const nested: Buffer[] = [];
    let failed = false;
    parser.on('headers', (h: Headers) => {
      headers = h;
    });
    parser.on('headerLines', (l: HeaderLines) => {
      lines = l;
    });
    parser.on('data', (d: { type: string; [k: string]: unknown }) => {
      if (d.type !== 'attachment') return;
      const a = d as unknown as {
        content: NodeJS.ReadableStream;
        contentType: string;
        filename?: string;
        contentDisposition?: string;
        related?: boolean;
        cid?: string;
        release: () => void;
      };
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      a.content.on('data', (c: Buffer) => {
        size += c.length;
        if (maxPartBytes <= 0 || tooLarge) return;
        if (size > maxPartBytes) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        chunks.push(c);
      });
      a.content.on('end', () => {
        const forwarded = a.contentType === 'message/rfc822';
        if (forwarded && !tooLarge && depth < MAX_DEPTH && maxPartBytes > 0) {
          nested.push(Buffer.concat(chunks));
        } else if (maxPartBytes > 0 && !forwarded && parts.length < MAX_PARTS) {
          parts.push({
            name: typeof a.filename === 'string' ? a.filename.slice(0, 1024) : null,
            contentType: String(a.contentType).slice(0, 200),
            size,
            inline: a.contentDisposition === 'inline' || a.related === true,
            tooLarge,
            // Its own memory (never a pool's shared with another part), to be handed back whole.
            content: tooLarge ? null : new Uint8Array(Buffer.concat(chunks)),
          });
        }
        a.release();
      });
    });
    parser.on('error', (err: unknown) => {
      failed = true;
      reject(err instanceof Error ? err : new Error('not readable'));
    });
    parser.on('end', () => {
      if (failed) return;
      if (!headers) {
        reject(new Error('no header'));
        return;
      }
      const head = headOf(headers, lines, authservId);
      // Forwarded mails, read for their attachments only: whose they say
      // they are, and what they say of themselves, count for nothing.
      void nested
        .reduce<Promise<unknown>>(
          (p, b) => p.then(() => read(b, null, maxPartBytes, depth + 1, parts)),
          Promise.resolve(),
        )
        .then(() => resolve(head), reject);
    });
    parser.end(bytes);
  });
}

async function run(job: MailJob): Promise<MailReply> {
  const bytes = Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength);
  if (job.kind === 'head') {
    // The header alone: a mail's first bytes may stop in its body, which is never read.
    const block = headerBlock(bytes) ?? bytes;
    const head = await read(
      Buffer.concat([block, Buffer.from('\r\n\r\n')]),
      job.authservId,
      0,
      0,
      [],
    );
    return { id: job.id, head };
  }
  const parts: MailPart[] = [];
  const head = await read(bytes, job.authservId, job.maxPartBytes, 0, parts);
  return { id: job.id, head, parts };
}

const port = parentPort;
if (port) {
  port.on('message', (job: MailJob) => {
    run(job).then(
      (reply) => {
        // The bytes go back, not copied.
        const moved = new Set<ArrayBuffer>();
        for (const p of (reply as { parts?: MailPart[] }).parts ?? []) {
          if (p.content?.buffer instanceof ArrayBuffer) moved.add(p.content.buffer);
        }
        try {
          port.postMessage(reply, [...moved]);
        } catch {
          port.postMessage({ id: job.id, failed: true } satisfies MailReply);
        }
      },
      () => port.postMessage({ id: job.id, failed: true } satisfies MailReply),
    );
  });
  port.postMessage({ ready: true } satisfies MailReply);
}
