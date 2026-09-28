import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { deriveKey, OPERATOR_MAIL_KEY_PURPOSE, operatorMailBinding, sealBytes } from '@fdv/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isMailJob, sendToAddress, type MailJob } from './mail.js';

/**
 * One email to one address (`mail.to_address`, 5.20): a share link's code.
 *
 * It goes to the address sealed in the job and nowhere else, only through
 * the operator's mail server (A21), as plain text with no link in it; and
 * the worker's log says that it went, or why not, never to whom.
 */

const MASTER = 'mail-to-address-test-master-key-32-bytes!!';
const KEY = deriveKey(MASTER, OPERATOR_MAIL_KEY_PURPOSE);
const HOUSEHOLD = randomUUID();
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

/** A job as the API's mailJob() makes it (apps/api/src/mail-job.ts). */
function job(m: { to: string; subject: string; text: string }, household = HOUSEHOLD): MailJob {
  return {
    household_id: household,
    sealed: sealBytes(KEY, Buffer.from(JSON.stringify(m)), operatorMailBinding(household)).toString(
      'base64',
    ),
  };
}

const CODE_MAIL = {
  subject: 'Your code to open a shared link',
  text: 'Your code is 123 456.\n\nType it on the page where you opened the link you were sent.\n',
};

/** Just enough SMTP to take messages, or to refuse one recipient, keeping what it was sent. */
async function fakeSmtp(refuse: (address: string) => boolean = () => false) {
  const messages: Array<{ rcpt: string[]; data: string }> = [];
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    let data: string[] | null = null;
    let rcpt: string[] = [];
    const say = (line: string) => sock.write(`${line}\r\n`);
    say('220 fake ESMTP');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') {
            messages.push({ rcpt, data: data.join('\n') });
            data = null;
            rcpt = [];
            say('250 queued');
          } else data.push(line);
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'RCPT') {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (refuse(address)) say(`550 5.1.1 <${address}>: Recipient address rejected`);
          else {
            rcpt.push(address);
            say('250 ok');
          }
        } else if (verb === 'DATA') {
          data = [];
          say('354 go ahead');
        } else if (verb === 'QUIT') {
          say('221 bye');
          sock.end();
        } else say('250 ok');
      }
    });
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as net.AddressInfo).port;
  return { port, messages, close: () => new Promise((res) => server.close(res)) };
}

describe('one email to one address (5.20)', () => {
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  const logged: string[] = [];
  const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
    void logged.push(JSON.stringify({ level, msg, ...extra }));

  beforeAll(async () => {
    smtp = await fakeSmtp((a) => a.startsWith('refused'));
  });
  afterAll(() => smtp.close());

  it('goes to the sealed address alone, through the operator’s mail server, as plain text', async () => {
    const to = `jane.smith+${randomUUID().slice(0, 8)}@example.test`;
    const deps = {
      mailKey: KEY,
      operatorMail: { url: `smtp://127.0.0.1:${smtp.port}`, from: 'Vault <vault@op.test>' },
      log,
    };
    expect(await sendToAddress(deps, job({ to, ...CODE_MAIL }))).toBe(true);
    const sent = smtp.messages.at(-1);
    expect(sent?.rcpt).toEqual([to]);
    expect(sent?.data).toContain('123 456');
    expect(sent?.data).toMatch(/Subject: Your code to open a shared link/);
    // No HTML part, and nothing to follow.
    expect(sent?.data).not.toMatch(/text\/html|href|https?:/i);
  });

  it('without the operator’s mail server, nothing is sent, and the log says why', async () => {
    logged.length = 0;
    const before = smtp.messages.length;
    const to = `bob+${randomUUID().slice(0, 8)}@example.test`;
    expect(
      await sendToAddress({ mailKey: KEY, operatorMail: null, log }, job({ to, ...CODE_MAIL })),
    ).toBe(false);
    expect(smtp.messages.length).toBe(before);
    expect(logged.join('\n')).toMatch(/FDV_SMTP_URL is not set/);
    expect(logged.join('\n')).not.toContain(to);
  });

  it('a job sealed for another household, or not by the vault, does not open and is not sent', async () => {
    const before = smtp.messages.length;
    const deps = {
      mailKey: KEY,
      operatorMail: { url: `smtp://127.0.0.1:${smtp.port}`, from: 'vault@op.test' },
      log,
    };
    const moved = { ...job({ to: 'x@example.test', ...CODE_MAIL }), household_id: randomUUID() };
    expect(await sendToAddress(deps, moved)).toBe(false);
    const forged: MailJob = {
      household_id: HOUSEHOLD,
      sealed: sealBytes(
        deriveKey(`${MASTER}-other`, OPERATOR_MAIL_KEY_PURPOSE),
        Buffer.from(JSON.stringify({ to: 'x@example.test', ...CODE_MAIL })),
        operatorMailBinding(HOUSEHOLD),
      ).toString('base64'),
    };
    expect(await sendToAddress(deps, forged)).toBe(false);
    expect(smtp.messages.length).toBe(before);
    expect(isMailJob({ household_id: HOUSEHOLD })).toBe(false);
    expect(isMailJob(forged)).toBe(true);
  });

  it('a refused address is not named in the log', async () => {
    logged.length = 0;
    const to = `refused.person+${randomUUID().slice(0, 8)}@example.test`;
    const deps = {
      mailKey: KEY,
      operatorMail: { url: `smtp://127.0.0.1:${smtp.port}`, from: 'vault@op.test' },
      log,
    };
    expect(await sendToAddress(deps, job({ to, ...CODE_MAIL }))).toBe(false);
    const text = logged.join('\n');
    expect(text).toMatch(/failed/);
    expect(text).not.toContain(to);
    expect(text).not.toContain('refused.person');
    expect(text).not.toContain('123 456');
  });
});

async function mailpitUp(): Promise<boolean> {
  try {
    return (
      await fetch(`${MAILPIT}/api/v1/messages?limit=1`, { signal: AbortSignal.timeout(1500) })
    ).ok;
  } catch {
    return false;
  }
}
const withMailpit = await mailpitUp();

describe.skipIf(!withMailpit)('as Mailpit receives it (5.20)', () => {
  it('the email has no link and no title', async () => {
    // An address no other test sends to.
    const to = `b520-code-${randomUUID()}@example.test`;
    const deps = {
      mailKey: KEY,
      operatorMail: { url: 'smtp://localhost:1025', from: 'Vault <vault@example.test>' },
      log: () => undefined,
    };
    // What the API sends (ShareService.sendCode): the code, and nothing of what was shared.
    expect(
      await sendToAddress(
        deps,
        job({
          to,
          subject: 'Your code to open a shared link',
          text:
            'Your code is 482 915.\n\nType it on the page where you opened the link you were sent. ' +
            'It works once, for the next 10 minutes.\n',
        }),
      ),
    ).toBe(true);
    let found: Array<{ ID: string; To: Array<{ Address: string }> }> = [];
    for (let i = 0; i < 40 && found.length === 0; i++) {
      const r = await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}&limit=5`,
      );
      found = ((await r.json()) as { messages?: typeof found }).messages ?? [];
      if (!found.length) await new Promise((res) => setTimeout(res, 250));
    }
    expect(found).toHaveLength(1);
    expect(found[0]?.To.map((t) => t.Address)).toEqual([to]);
    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${found[0]?.ID}`)).json()) as {
      Text: string;
      HTML: string;
      Subject: string;
    };
    expect(full.Text).toContain('482 915');
    expect(full.HTML).toBe('');
    expect(`${full.Subject}\n${full.Text}`).not.toMatch(/https?:|www\.|\/s#|href/i);
  });
});
