import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';

/**
 * For the tests of "Test the mailbox" (0.9.0, O1): an IMAP server on
 * 127.0.0.1, over TLS from the first byte, that answers what imapflow asks
 * and writes down every command it is sent — so a test can say what the
 * vault did, on the wire, to the mailbox: which commands, and which of
 * them could have changed a mail.
 *
 * The certificate is the tests' own, for localhost and 127.0.0.1 alone,
 * self-signed: it is handed to the client as the one certificate to trust
 * (ImapSettings.ca), and the client still verifies it and its name.
 */
export const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBmjCCAT+gAwIBAgIUIixKkfMKE78wU1ey+F2Hocex1WwwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAxNzIzMzE1N1oXDTQ2MTAxMjIz
MzE1N1owFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEXHddlWlTVbyLGwL6gC3L9FeJRsH1/oU5AyvYigSLehtH31HuMZqe+j/u
LvSSPkWP2OUO5/c5FXANwbwJyTLBXqNvMG0wHQYDVR0OBBYEFFaQwJ8EKyxuW9B/
ttNmfw3gWBRVMB8GA1UdIwQYMBaAFFaQwJ8EKyxuW9B/ttNmfw3gWBRVMBoGA1Ud
EQQTMBGCCWxvY2FsaG9zdIcEfwAAATAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49
BAMCA0kAMEYCIQCK1ubK1Js/WFvma4fDGYOx+9qOpvNWM/mbsfG8eGhaiwIhAIKE
lGqSyC9brRMyhxOKQMVRkb5UT2CbIoholDQ1GkBT
-----END CERTIFICATE-----
`;

/** Its key: for this test server on 127.0.0.1 alone, trusted by nothing else. */
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgiNRrdxwPHvXXdr9l
PIvAItC5wME/DS5EiSn5zZ0jIaOhRANCAARcd12VaVNVvIsbAvqALcv0V4lGwfX+
hTkDK9iKBIt6G0ffUe4xmp76P+4u9JI+RY/Y5Q7n9zkVcA3BvAnJMsFe
-----END PRIVATE KEY-----
`;

export interface TestImapOptions {
  user: string;
  password: string;
  /** Each mail's header block, oldest first. */
  mails: string[];
  /** The server's capabilities besides IMAP4rev1: MOVE, UIDPLUS, … */
  caps: string[];
  folder?: string;
}

export interface TestImap {
  port: number;
  /** Every command the client sent, but a LOGIN's arguments (said as `LOGIN`). */
  commands: string[];
  /** Whether a LOGIN came with the right sign-in and password. */
  signedIn: boolean;
  close(): Promise<void>;
}

/** The fields of a header block asked for: `HEADER.FIELDS (A B)`, each line with its folded ones. */
function fields(header: string, names: string[]): string {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const out: string[] = [];
  let on = false;
  for (const line of header.split(/\r\n/)) {
    if (/^[ \t]/.test(line)) {
      if (on) out.push(line);
      continue;
    }
    on = want.has(line.slice(0, line.indexOf(':')).toLowerCase());
    if (on) out.push(line);
  }
  return `${out.map((l) => `${l}\r\n`).join('')}\r\n`;
}

export async function startTestImap(o: TestImapOptions): Promise<TestImap> {
  const folder = o.folder ?? 'INBOX';
  const caps = ['IMAP4rev1', ...o.caps].join(' ');
  const state: TestImap = {
    port: 0,
    commands: [],
    signedIn: false,
    close: async () => undefined,
  };
  const server = tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, (sock) => {
    sock.on('error', () => undefined);
    sock.write(`* OK [CAPABILITY ${caps}] the tests' IMAP server\r\n`);
    let buf = '';
    const say = (s: string) => sock.write(s);
    const handle = (line: string) => {
      const sp = line.indexOf(' ');
      const tag = line.slice(0, sp);
      const rest = line.slice(sp + 1);
      const words = rest.split(' ');
      let cmd = (words[0] ?? '').toUpperCase();
      let args = words.slice(1).join(' ');
      if (cmd === 'UID') {
        cmd = `UID ${(words[1] ?? '').toUpperCase()}`;
        args = words.slice(2).join(' ');
      }
      state.commands.push(cmd === 'LOGIN' ? 'LOGIN' : `${cmd} ${args}`.trim());
      switch (cmd) {
        case 'CAPABILITY':
          return say(`* CAPABILITY ${caps}\r\n${tag} OK done\r\n`);
        case 'LOGIN': {
          const given = args.split(' ').map((a) => a.replace(/^"|"$/g, ''));
          if (given[0] === o.user && given[1] === o.password) {
            state.signedIn = true;
            return say(`${tag} OK [CAPABILITY ${caps}] signed in\r\n`);
          }
          return say(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        }
        case 'NAMESPACE':
          return say(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`);
        case 'ID':
          return say(`* ID NIL\r\n${tag} OK done\r\n`);
        case 'LIST':
          return say(
            `${args.includes(folder) || /"\*"|\*$/.test(args) ? `* LIST (\\HasNoChildren) "/" ${folder}\r\n` : ''}${tag} OK done\r\n`,
          );
        case 'SELECT':
        case 'EXAMINE': {
          if (!args.replace(/"/g, '').startsWith(folder)) {
            return say(`${tag} NO [NONEXISTENT] no such folder\r\n`);
          }
          const n = o.mails.length;
          return say(
            `* ${n} EXISTS\r\n* 0 RECENT\r\n* FLAGS (\\Seen \\Deleted)\r\n` +
              `* OK [PERMANENTFLAGS ()] none\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT ${n + 1}] ok\r\n` +
              `${tag} OK [${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] done\r\n`,
          );
        }
        case 'FETCH':
        case 'UID FETCH': {
          const n = o.mails.length;
          const asked = /HEADER\.FIELDS \(([^)]*)\)/i.exec(args);
          // `*`, `n`, or `from:*`: the messages asked for, by sequence number.
          const set = /^(\d+|\*)(?::(\d+|\*))?\s/.exec(args);
          const num = (v: string | undefined, d: number) => (!v || v === '*' ? d : Number(v));
          const from = set ? num(set[1], n) : n;
          const to = set && set[2] ? num(set[2], n) : from;
          if (n > 0 && asked) {
            for (
              let seq = Math.max(1, Math.min(from, to));
              seq <= Math.min(n, Math.max(from, to));
              seq++
            ) {
              const body = fields(o.mails[seq - 1] as string, (asked[1] as string).split(' '));
              const len = Buffer.byteLength(body, 'latin1');
              say(
                `* ${seq} FETCH (UID ${seq} BODY[HEADER.FIELDS (${asked[1]})] {${len}}\r\n${body})\r\n`,
              );
            }
          }
          return say(`${tag} OK done\r\n`);
        }
        case 'LOGOUT':
          say(`* BYE see you\r\n${tag} OK done\r\n`);
          sock.end();
          return;
        default:
          return say(`${tag} OK done\r\n`);
      }
    };
    sock.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line) handle(line);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  return state;
}
