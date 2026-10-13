import { randomBytes } from 'node:crypto';
import type { MailboxConnector, MailboxEntry, MailboxProblem, MailboxSession } from './mailbox.js';
import { MailboxError } from './mailbox.js';

/**
 * For the tests of email in (S4): mail written as a mail client writes it,
 * and a household mailbox that keeps it in memory, behind the same
 * interface the worker signs in to over IMAP.
 */

/** A PDF small enough to read, complete as far as its ends go. */
export const pdf = (marker: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

/** A PNG's signature, a header and its IEND, padded to `size` bytes. */
export const png = (size = 64) => {
  const head = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0,
  ]);
  const end = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length - end.length), 1), end]);
};

export interface Part {
  /** A file attached. */
  name?: string;
  type?: string;
  content?: Buffer;
  /** In the body, referred to by a Content-ID. */
  inline?: boolean;
  /** A whole mail inside this one (message/rfc822), attached or inline. */
  forwarded?: string;
  /** As written, part and all: for the broken ones. */
  raw?: string;
  /** Parts inside parts. */
  parts?: Part[];
  subtype?: 'mixed' | 'alternative' | 'related';
}

export interface MailSpec {
  from?: string | string[];
  /** Headers above everything, as a provider adds them: Authentication-Results among them. */
  above?: string[];
  /** Headers below the From, as the sender writes them. */
  below?: string[];
  subject?: string;
  messageId?: string | null;
  body?: string;
  parts?: Part[];
}

const CRLF = '\r\n';
const wrap = (b64: string) => b64.replace(/.{1,76}/g, (l) => `${l}${CRLF}`).trimEnd();

function partText(p: Part): string {
  if (p.raw !== undefined) return p.raw;
  if (p.parts) return multipart(p.parts, p.subtype ?? 'mixed');
  if (p.forwarded !== undefined) {
    return [
      'Content-Type: message/rfc822',
      `Content-Disposition: ${p.inline ? 'inline' : `attachment; filename="${p.name ?? 'forwarded.eml'}"`}`,
      '',
      p.forwarded,
    ].join(CRLF);
  }
  const name = p.name ?? 'file.bin';
  const lines = [
    `Content-Type: ${p.type ?? 'application/octet-stream'}; name="${name}"`,
    p.inline
      ? `Content-Disposition: inline; filename="${name}"`
      : `Content-Disposition: attachment; filename="${name}"`,
    'Content-Transfer-Encoding: base64',
  ];
  if (p.inline) lines.push(`Content-ID: <${randomBytes(4).toString('hex')}@mail.test>`);
  return [...lines, '', wrap((p.content ?? Buffer.alloc(0)).toString('base64'))].join(CRLF);
}

function multipart(parts: Part[], subtype: string): string {
  const b = `b-${randomBytes(6).toString('hex')}`;
  return [
    `Content-Type: multipart/${subtype}; boundary="${b}"`,
    '',
    ...parts.flatMap((p) => [`--${b}`, partText(p)]),
    `--${b}--`,
    '',
  ].join(CRLF);
}

/** A mail, as a mail client writes it. */
export function mail(s: MailSpec): string {
  const froms = Array.isArray(s.from) ? s.from : [s.from ?? 'nobody@mail.test'];
  const head = [
    ...(s.above ?? []),
    ...froms.map((f) => `From: ${f}`),
    ...(s.below ?? []),
    'To: home@vault.test',
    `Subject: ${s.subject ?? 'Documents'}`,
    'Date: Tue, 13 Oct 2026 09:00:00 +0000',
    ...(s.messageId === null
      ? []
      : [`Message-ID: ${s.messageId ?? `<${randomBytes(8).toString('hex')}@mail.test>`}`]),
    'MIME-Version: 1.0',
  ];
  const body: Part = {
    raw: ['Content-Type: text/plain; charset=utf-8', '', s.body ?? 'See attached.'].join(CRLF),
  };
  return [...head, multipart([body, ...(s.parts ?? [])], 'mixed')].join(CRLF);
}

interface Stored {
  uid: number;
  raw: Buffer;
  /** What the server says its size is: its own, unless a test says otherwise. */
  size: number;
}

/** A household mailbox in memory: its folders, and what the vault did with it. */
export class FakeMailbox implements MailboxConnector {
  uidValidity = '1';
  private nextUid = 1;
  readonly folders = new Map<string, Stored[]>([['INBOX', []]]);
  /** The sign-in refused, the server not reached, … : every open fails so. */
  failing: MailboxProblem | null = null;
  opens = 0;
  /** UIDs whose whole mail was fetched, whose header was. */
  readonly sources: number[] = [];
  readonly heads: number[] = [];
  /** Moves and deletes refused, this many more times. */
  refuseFiling = 0;
  /** Folders made. */
  readonly made: string[] = [];
  /** What the server can do: MOVE, UIDPLUS (F10). */
  caps = { move: true, uidplus: true };
  /** UIDs marked read. */
  readonly seen: number[] = [];
  /** Moves and deletes asked for, whatever came of them. */
  readonly filings: Array<{ uid: number; how: 'move' | 'remove' }> = [];

  /** Whole mails the server hands over in place of what was delivered: a header and a body that disagree. */
  private readonly whole = new Map<number, Buffer>();

  /** The whole mail of `uid`, as the server will hand it over: not what its header said. */
  wholeAs(uid: number, raw: string): void {
    this.whole.set(uid, Buffer.from(raw));
  }

  /** A mail delivered to the folder; its UID. */
  deliver(raw: string | Buffer, opts: { folder?: string; size?: number } = {}): number {
    const buf = typeof raw === 'string' ? Buffer.from(raw) : raw;
    const uid = this.nextUid++;
    const f = opts.folder ?? 'INBOX';
    if (!this.folders.has(f)) this.folders.set(f, []);
    this.folders.get(f)?.push({ uid, raw: buf, size: opts.size ?? buf.length });
    return uid;
  }

  /** The mailbox rebuilt: a new UIDVALIDITY, every mail a new UID. */
  renumber(): void {
    this.uidValidity = String(Number(this.uidValidity) + 1);
    for (const list of this.folders.values()) for (const m of list) m.uid = this.nextUid++;
  }

  inbox(folder = 'INBOX'): Stored[] {
    return this.folders.get(folder) ?? [];
  }

  async open(folder: string): Promise<MailboxSession> {
    this.opens += 1;
    if (this.failing) throw new MailboxError(this.failing);
    if (!this.folders.has(folder)) throw new MailboxError('no_folder');
    const box = () => this.folders.get(folder) ?? [];
    const find = (uid: number) => box().find((m) => m.uid === uid);
    const take = (uid: number) => {
      const list = box();
      const at = list.findIndex((m) => m.uid === uid);
      return at < 0 ? null : (list.splice(at, 1)[0] as Stored);
    };
    return {
      uidValidity: this.uidValidity,
      canMove: this.caps.move && this.caps.uidplus,
      canDelete: this.caps.uidplus,
      markSeen: async (uid) => {
        this.seen.push(uid);
        return find(uid) !== undefined;
      },
      list: async (): Promise<MailboxEntry[]> =>
        box()
          .map((m) => ({ uid: m.uid, size: m.size }))
          .sort((a, b) => a.uid - b.uid),
      head: async (uid, maxBytes) => {
        this.heads.push(uid);
        return find(uid)?.raw.subarray(0, maxBytes) ?? null;
      },
      source: async (uid, maxBytes) => {
        this.sources.push(uid);
        const m = find(uid);
        return m ? (this.whole.get(uid) ?? m.raw).subarray(0, maxBytes) : null;
      },
      ensureFolder: async (name) => {
        if (!this.folders.has(name)) {
          this.folders.set(name, []);
          this.made.push(name);
        }
      },
      move: async (uid, to) => {
        this.filings.push({ uid, how: 'move' });
        if (this.refuseFiling > 0) {
          this.refuseFiling -= 1;
          return false;
        }
        const m = take(uid);
        if (!m) return false;
        this.folders.get(to)?.push({ ...m, uid: this.nextUid++ });
        return true;
      },
      remove: async (uid) => {
        this.filings.push({ uid, how: 'remove' });
        if (this.refuseFiling > 0) {
          this.refuseFiling -= 1;
          return false;
        }
        return take(uid) !== null;
      },
      close: async () => undefined,
    };
  }
}
