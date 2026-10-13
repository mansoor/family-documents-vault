import { isIP } from 'node:net';
import { ImapFlow, type ImapFlowOptions, type MailboxLockObject } from 'imapflow';
import { MAIL_IN_MAX_MESSAGE_BYTES } from '@fdv/shared';

/**
 * The household mailbox, over IMAP (0.8.0, S4): what email in asks of it,
 * behind an interface a test stands in for.
 *
 * imapflow (MIT) speaks IMAP on the worker's loop, as pg speaks to the
 * database: it frames the server's replies — numbers, flags, and a mail as
 * an opaque run of bytes — and nothing of a mail is read here. Only what
 * the vault asks for is fetched: UIDs and sizes, a mail's first bytes (its
 * header), and a whole mail, each with BODY.PEEK, so nothing is marked as
 * read; never an ENVELOPE or BODYSTRUCTURE, which the server would build
 * from what a sender wrote. Every reply is bounded: no literal larger than
 * a mail may be, no line or reply beyond a few megabytes over that. No
 * compression (a reply could inflate past every bound), no IDLE.
 *
 * TLS from the first byte (port 993: no STARTTLS to be stripped), with the
 * server's certificate verified against the system's roots and its name;
 * TLS 1.2 at least. The password is handed to imapflow alone, which logs
 * nothing (logger: false): what goes wrong comes back as a word
 * (MailboxError), never the server's message.
 */

/** What went wrong, as a word: the sign-in refused, the server not reached, its certificate, the folder. */
export type MailboxProblem = 'login_failed' | 'unreachable' | 'certificate' | 'no_folder';

export class MailboxError extends Error {
  constructor(readonly problem: MailboxProblem) {
    super(`the mailbox: ${problem}`);
    this.name = 'MailboxError';
  }
}

/** A mail in the folder: its UID and its size (RFC822.SIZE), as the server says. */
export interface MailboxEntry {
  uid: number;
  size: number;
}

/** The folder, open. */
export interface MailboxSession {
  /** The folder's UIDVALIDITY: a UID means the same mail only while this is the same. */
  readonly uidValidity: string;
  /** Every mail in the folder, by UID, oldest first. */
  list(): Promise<MailboxEntry[]>;
  /** A mail's first `maxBytes` bytes (its header, and maybe more): null when it has gone. */
  head(uid: number, maxBytes: number): Promise<Buffer | null>;
  /** A whole mail, at most `maxBytes` (more is cut there): null when it has gone. */
  source(uid: number, maxBytes: number): Promise<Buffer | null>;
  /** The folder to file mail in, made if it is not there. */
  ensureFolder(name: string): Promise<void>;
  /** Moved to that folder: false when it was not (gone already, or refused). */
  move(uid: number, folder: string): Promise<boolean>;
  /** Deleted (and expunged): false when it was not. */
  remove(uid: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface MailboxConnector {
  /** Signed in, and the folder open — or a MailboxError. */
  open(folder: string): Promise<MailboxSession>;
}

/** FDV_MAIL_IN_*: where, and as whom. The password never leaves here but to imapflow. */
export interface ImapSettings {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** Node's and OpenSSL's words for a certificate that could not be verified. */
const CERT =
  /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|HOSTNAME|EPROTO|ERR_SSL|ERR_TLS/i;

/** An imapflow error, as a word. */
export function problemOf(err: unknown): MailboxProblem {
  const e = err as { authenticationFailed?: boolean; code?: unknown } | null;
  if (e?.authenticationFailed) return 'login_failed';
  const c = typeof e?.code === 'string' ? e.code : '';
  if (CERT.test(c)) return 'certificate';
  return 'unreachable';
}

/** A server's reply this much larger than the largest mail is refused. */
const SLACK = 4 * 1024 * 1024;

export class ImapMailbox implements MailboxConnector {
  constructor(private readonly settings: ImapSettings) {}

  async open(folder: string): Promise<MailboxSession> {
    const { host, port, user, password } = this.settings;
    // The name the certificate must carry (an address carries none: SNI takes names alone).
    const name = isIP(host) ? undefined : host;
    const options: ImapFlowOptions = {
      host,
      port,
      secure: true,
      ...(name ? { servername: name } : {}),
      auth: { user, pass: password },
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      disableCompression: true,
      tls: {
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        ...(name ? { servername: name } : {}),
      },
      connectionTimeout: 30_000,
      greetingTimeout: 16_000,
      socketTimeout: 120_000,
      maxLiteralSize: MAIL_IN_MAX_MESSAGE_BYTES + SLACK,
      maxResponseSize: MAIL_IN_MAX_MESSAGE_BYTES + 2 * SLACK,
      maxLineLength: SLACK,
    };
    const client = new ImapFlow(options);
    // An error after the sign-in (the connection dropped) ends the session;
    // the next command says so.
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (err) {
      client.close();
      throw new MailboxError(problemOf(err));
    }
    let lock: MailboxLockObject;
    try {
      lock = await client.getMailboxLock(folder);
    } catch {
      await client.logout().catch(() => client.close());
      throw new MailboxError('no_folder');
    }
    const box = client.mailbox;
    const uidValidity = box ? String(box.uidValidity) : '0';
    return {
      uidValidity,
      async list() {
        if (!client.mailbox || client.mailbox.exists === 0) return [];
        const out: MailboxEntry[] = [];
        for await (const m of client.fetch('1:*', { uid: true, size: true })) {
          if (typeof m.uid === 'number' && typeof m.size === 'number') {
            out.push({ uid: m.uid, size: m.size });
          }
        }
        return out.sort((a, b) => a.uid - b.uid);
      },
      async head(uid, maxBytes) {
        const m = await client.fetchOne(
          String(uid),
          { uid: true, source: { maxLength: maxBytes } },
          { uid: true },
        );
        return m && m.source ? m.source.subarray(0, maxBytes) : null;
      },
      async source(uid, maxBytes) {
        const m = await client.fetchOne(
          String(uid),
          { uid: true, source: { maxLength: maxBytes } },
          { uid: true },
        );
        return m && m.source ? m.source.subarray(0, maxBytes) : null;
      },
      async ensureFolder(name) {
        const there = await client.list();
        if (there.some((b) => b.path === name)) return;
        await client.mailboxCreate(name).catch((err: unknown) => {
          // Made just now by somebody else is made.
          if ((err as { serverResponseCode?: string }).serverResponseCode !== 'ALREADYEXISTS') {
            throw err;
          }
        });
      },
      async move(uid, to) {
        const r = await client.messageMove(String(uid), to, { uid: true });
        return r !== false;
      },
      async remove(uid) {
        return client.messageDelete(String(uid), { uid: true });
      },
      async close() {
        lock.release();
        await client.logout().catch(() => client.close());
      },
    };
  }
}
