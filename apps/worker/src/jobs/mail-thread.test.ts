import { describe, expect, it } from 'vitest';
import { MailThread } from './mail-thread.js';
import { mail, pdf, png } from './mail-test-helper.js';

/**
 * The mail thread (S4): a mail's MIME read off the worker's loop. Its
 * header gives one From or none, the Message-ID, the codes in the subject
 * (never the subject), and the provider's word on the sender; a whole mail
 * gives its attachments — inside nested multiparts and forwarded mails too,
 * one too large said to be and not kept — and never its body. Broken MIME
 * is answered, never thrown; a mail that takes too long has the thread
 * ended; and the thread holds none of the environment.
 */

const ID = 'mx.provider.test';
const AR = (v: string) => `Authentication-Results: ${v}`;

const STAND_IN = new URL(
  `data:text/javascript,${encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (job) => {
  const text = Buffer.from(job.bytes).toString();
  if (text.includes('SPIN')) for (;;) {}
  const env = Object.keys(process.env).join(',');
  parentPort.postMessage({ id: job.id, head: { from: env, messageId: null, codes: [], auth: 'fail' }, parts: [] });
});
parentPort.postMessage({ ready: true });
`)}`,
);

describe('the mail thread (S4)', () => {
  it('reads a header: one From, its Message-ID, the codes in its subject, the provider’s word', async () => {
    const t = new MailThread();
    try {
      const raw = mail({
        above: [AR(`${ID}; dkim=pass header.d=example.test; dmarc=pass header.from=example.test`)],
        from: 'Ann Smith <Ann@Example.TEST>',
        subject: 'Confirm fdv-abcd-efgh-jkmn please',
        messageId: '<m1@example.test>',
      });
      const a = await t.head(Buffer.from(raw).subarray(0, 300), ID);
      expect(a).toEqual({
        state: 'done',
        head: {
          from: 'ann@example.test',
          messageId: '<m1@example.test>',
          codes: ['FDV-ABCD-EFGH-JKMN'],
          auth: 'pass',
        },
        parts: [],
      });
      // Nothing else of it comes back: not the subject, not the body.
      expect(JSON.stringify(a)).not.toContain('please');
      // A forged header of another provider's id is not read.
      const forged = await t.head(
        Buffer.from(mail({ below: [AR('mx.other.test; dmarc=pass')], from: 'ann@example.test' })),
        ID,
      );
      expect(forged.state === 'done' && forged.head.auth).toBe('fail');
      // No authserv-id set: never `pass`.
      const unset = await t.head(Buffer.from(raw), null);
      expect(unset.state === 'done' && unset.head.auth).toBe('fail');
    } finally {
      await t.close();
    }
  }, 60_000);

  it('a mail From several addresses, in several From headers, a group, or none, is From nobody', async () => {
    const t = new MailThread();
    try {
      for (const from of [
        ['ann@example.test', 'bob@example.test'],
        'ann@example.test, bob@example.test',
        'family: ann@example.test;',
        'not an address',
      ]) {
        const a = await t.head(Buffer.from(mail({ from })), null);
        expect(a.state === 'done' && a.head.from).toBeNull();
      }
    } finally {
      await t.close();
    }
  }, 60_000);

  it('takes attachments from nested multiparts and forwarded mails, attached or inline; says which are too large', async () => {
    const t = new MailThread();
    try {
      const inner = mail({
        from: 'bank@bank.test',
        parts: [{ name: 'statement.pdf', type: 'application/pdf', content: pdf('inner') }],
      });
      const deeper = mail({ from: 'x@x.test', parts: [{ forwarded: inner, name: 'inner.eml' }] });
      const raw = mail({
        from: 'ann@example.test',
        parts: [
          {
            parts: [
              { raw: 'Content-Type: text/plain\r\n\r\nplain' },
              {
                subtype: 'related',
                parts: [
                  { raw: 'Content-Type: text/html\r\n\r\n<p>hi</p>' },
                  { name: 'logo.png', type: 'image/png', content: png(200), inline: true },
                ],
              },
            ],
            subtype: 'alternative',
          },
          { name: 'passport.pdf', type: 'application/pdf', content: pdf('outer') },
          { forwarded: inner, inline: true },
          { forwarded: deeper, name: 'fwd.eml' },
          { name: 'huge.pdf', type: 'application/pdf', content: Buffer.alloc(5000, 7) },
        ],
      });
      const a = await t.message(Buffer.from(raw), null, 4000);
      expect(a.state).toBe('done');
      if (a.state !== 'done') return;
      const seen = a.parts.map((p) => [p.name, p.inline, p.tooLarge, p.content?.length ?? null]);
      expect(seen).toEqual(
        expect.arrayContaining([
          ['logo.png', true, false, 200],
          ['passport.pdf', false, false, pdf('outer').length],
          ['statement.pdf', false, false, pdf('inner').length],
          ['huge.pdf', false, true, null],
        ]),
      );
      // The statement, once inline-forwarded and once two mails deep.
      expect(a.parts.filter((p) => p.name === 'statement.pdf')).toHaveLength(2);
      expect(a.parts.find((p) => p.name === 'passport.pdf')?.content?.equals(pdf('outer'))).toBe(
        true,
      );
      // Its sender is the outer mail's, never a forwarded one's.
      expect(a.head.from).toBe('ann@example.test');
    } finally {
      await t.close();
    }
  }, 60_000);

  it('answers broken MIME — no boundary end, bad base64, garbage — without throwing', async () => {
    const t = new MailThread();
    try {
      const broken = [
        'From: ann@example.test\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: application/pdf; name="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n%%%not base64%%%',
        'From: ann@example.test\r\nContent-Type: multipart/mixed\r\n\r\nno boundary at all',
        '\u0000\u0001\u0002 not a mail',
        'From: ann@example.test\r\nContent-Type: multipart/mixed; boundary="y"\r\n\r\n--y\r\nContent-Type: multipart/mixed; boundary="y"\r\n\r\n--y\r\n--y--',
      ];
      for (const raw of broken) {
        const a = await t.message(Buffer.from(raw), null, 1_000_000);
        expect(['done', 'failed']).toContain(a.state);
      }
      // And the thread still reads the next one.
      const ok = await t.message(
        Buffer.from(
          mail({ from: 'ann@example.test', parts: [{ name: 'a.pdf', content: pdf('ok') }] }),
        ),
        null,
        1_000_000,
      );
      expect(ok.state === 'done' && ok.parts.length).toBe(1);
    } finally {
      await t.close();
    }
  }, 60_000);

  it('a mail that takes too long has the thread ended, and the thread holds none of the environment', async () => {
    const t = new MailThread({ entry: STAND_IN, messageDeadlineMs: 400 });
    try {
      process.env.FDV_MAIL_IN_PASSWORD_PROBE = 'should-not-be-seen';
      const env = await t.head(Buffer.from('From: a@b.test\r\n\r\n'), null);
      expect(env.state).toBe('done');
      if (env.state === 'done') expect(env.head.from).not.toContain('FDV_MAIL_IN_PASSWORD_PROBE');
      expect(await t.message(Buffer.from('SPIN'), null, 10)).toEqual({ state: 'too_slow' });
      expect(t.ended).toBe(1);
      // The next one gets a new thread.
      expect((await t.head(Buffer.from('From: a@b.test\r\n\r\n'), null)).state).toBe('done');
    } finally {
      delete process.env.FDV_MAIL_IN_PASSWORD_PROBE;
      await t.close();
    }
  }, 60_000);
});
