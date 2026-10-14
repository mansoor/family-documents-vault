import { describe, expect, it } from 'vitest';
import { authVerdict, parseAuthResults } from './mail-auth.js';
import { filingOf } from './mailbox.js';

/**
 * Whether the mailbox's provider vouched for a sender (S4, and the review's
 * F2): only the first Authentication-Results of all is read, and it must be
 * the provider's (FDV_MAIL_IN_AUTHSERV_ID); it is read strictly, so a
 * sender's own words quoted into it are never taken for a result; a single
 * DMARC result decides, for the From's own domain; without one, only a
 * DKIM signature of exactly that domain.
 */

const ID = 'mx.google.com';
const line = (v: string) => ({
  key: 'authentication-results',
  line: `Authentication-Results: ${v}`,
});
const other = (k: string, v: string) => ({ key: k, line: `${k}: ${v}` });
const verdict = (v: string, from = 'example.com') => authVerdict([line(v)], ID, from);

/** What Gmail writes, as it writes it. */
const GMAIL = `${ID};\r\n       dkim=pass header.i=@example.com header.s=20230601 header.b="dGh/pm+Q";\r\n       arc=pass (i=1 spf=pass spfdomain=example.com dkim=pass dkdomain=example.com dmarc=pass fromdomain=example.com);\r\n       spf=pass (google.com: domain of ann@example.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=ann@example.com;\r\n       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=example.com`;

describe('Authentication-Results, as the vault reads them (S4, F2)', () => {
  it('reads what a provider writes: its id, each result, comments and quoted values', () => {
    expect(parseAuthResults(GMAIL)).toEqual({
      authservId: 'mx.google.com',
      results: [
        {
          method: 'dkim',
          result: 'pass',
          props: { 'header.i': '@example.com', 'header.s': '20230601', 'header.b': 'dGh/pm+Q' },
        },
        { method: 'arc', result: 'pass', props: {} },
        { method: 'spf', result: 'pass', props: { 'smtp.mailfrom': 'ann@example.com' } },
        { method: 'dmarc', result: 'pass', props: { 'header.from': 'example.com' } },
      ],
    });
    expect(verdict(GMAIL)).toBe('pass');
    expect(parseAuthResults(' example.net 1; none')).toEqual({
      authservId: 'example.net',
      results: [],
    });
  });

  it('reads what RFC 8601 allows: a reason after the result, any ptype, a provider’s own words — and decides on header.from and header.d alone', () => {
    // Gmail's, with a reason (as it writes one for a DKIM signature it could not check).
    const gmail = `${ID};\r\n       dkim=neutral reason="invalid (public key: not available)" header.i=@other.test header.s=s1;\r\n       dkim=pass header.i=@example.com header.s=20230601 header.b=AbC1;\r\n       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com`;
    expect(parseAuthResults(gmail)?.results.map((r) => [r.method, r.result])).toEqual([
      ['dkim', 'neutral'],
      ['dkim', 'pass'],
      ['dmarc', 'pass'],
    ]);
    expect(verdict(gmail)).toBe('pass');
    // Fastmail's: x-bits=2048, policy.* and an x- ptype, its own methods.
    const fm = 'mx3.messagingengine.com';
    const fastmail = `${fm};\r\n    dkim=pass (2048-bit rsa key sha256) header.d=example.com header.i=@example.com header.b=AbCd header.a=rsa-sha256 header.s=fm1 x-bits=2048;\r\n    dmarc=pass policy.published-domain-policy=none policy.applied-disposition=none policy.evaluated-disposition=none (p=none,d=none,d.eval=none) policy.policy-from=p header.from=example.com;\r\n    iprev=pass smtp.remote-ip=192.0.2.1 (mail.example.com);\r\n    spf=pass smtp.mailfrom=ann@example.com smtp.helo=mail.example.com;\r\n    x-aligned-from=pass (Address match);\r\n    x-me-sender=none;\r\n    x-ptr=pass smtp.helo=mail.example.com x-ptr.ptr=mail.example.com`;
    expect(parseAuthResults(fastmail)?.results.map((r) => r.method)).toEqual([
      'dkim',
      'dmarc',
      'iprev',
      'spf',
      'x-aligned-from',
      'x-me-sender',
      'x-ptr',
    ]);
    expect(authVerdict([line(fastmail)], fm, 'example.com')).toBe('pass');
    // Only header.from decides DMARC: another ptype's from is not it.
    expect(verdict(`${ID}; dmarc=pass x-other.from=example.com`)).toBe('fail');
    expect(verdict(`${ID}; dmarc=pass reason="header.from=example.com"`)).toBe('fail');
    // And only header.d decides DKIM.
    expect(verdict(`${ID}; dkim=pass x-dkim.d=example.com`)).toBe('fail');
  });

  it('reads nothing of a header out of the grammar: a stray ), an open quote or comment, a word out of place', () => {
    for (const bad of [
      `${ID}; dmarc=pass header.from=example.com)`,
      `${ID}; dmarc=pass (unclosed header.from=example.com`,
      `${ID}; spf=pass smtp.mailfrom="open; dmarc=pass header.from=example.com`,
      `${ID}; dmarc=pass header.from=example.com header.from=evil.test`,
      `${ID}; dmarc pass header.from=example.com`,
      // A reason only straight after the result; a property with no name; a value missing.
      `${ID}; dmarc=pass header.from=example.com reason=late`,
      `${ID}; dmarc=pass .from=example.com`,
      `${ID}; dmarc=pass header.from=`,
    ]) {
      expect(parseAuthResults(bad), bad).toBeNull();
      expect(verdict(bad), bad).toBe('fail');
    }
  });

  it('the quoted mailfrom injection: a sender’s own words quoted in by the provider are never a result', () => {
    // A local part the sender chose, quoted: one value, not a dmarc result.
    const quotedIn = `${ID}; spf=pass smtp.mailfrom="x;dmarc=pass header.from=example.com"@evil.test; dmarc=fail header.from=evil.test`;
    expect(parseAuthResults(quotedIn)?.results.map((r) => r.method)).toEqual(['spf', 'dmarc']);
    expect(authVerdict([line(quotedIn)], ID, 'evil.test')).toBe('fail');
    expect(verdict(quotedIn)).toBe('fail');
    // The same words with the quote placed mid-word, as a careless provider might copy them.
    const midWord = `${ID}; spf=pass smtp.mailfrom=x"; dmarc=pass header.from=example.com"@evil.test`;
    expect(parseAuthResults(midWord)).toBeNull();
    expect(verdict(midWord)).toBe('fail');
    // Inside a comment, a quote is a comment's character: the comment still ends where it ends.
    const inComment = `${ID}; spf=pass (domain of "x(" designates) smtp.mailfrom=x@evil.test`;
    expect(parseAuthResults(inComment)).toBeNull();
  });

  it('DMARC decides: one result, pass, header.from required and the From’s domain', () => {
    expect(verdict(`${ID}; dmarc=pass header.from=example.com`)).toBe('pass');
    // A missing header.from vouches for nothing.
    expect(verdict(`${ID}; dmarc=pass`)).toBe('fail');
    expect(verdict(`${ID}; dmarc=pass header.from=evil.test`)).toBe('fail');
    // Two DMARC results: neither is believed.
    expect(
      verdict(`${ID}; dmarc=pass header.from=example.com; dmarc=fail header.from=example.com`),
    ).toBe('fail');
    // A DMARC fail is not saved by a DKIM pass.
    expect(
      verdict(`${ID}; dkim=pass header.d=example.com; dmarc=fail header.from=example.com`),
    ).toBe('fail');
  });

  it('without DMARC, only a DKIM signature of exactly the From’s domain: never d=co.uk, nor a parent', () => {
    expect(verdict(`${ID}; dkim=pass header.d=example.com`)).toBe('pass');
    expect(verdict(`${ID}; dkim=pass header.d=Example.COM.`)).toBe('pass');
    expect(verdict(`${ID}; dkim=pass header.d=example.com`, 'mail.example.com')).toBe('fail');
    expect(verdict(`${ID}; dkim=pass header.d=co.uk`, 'bank.co.uk')).toBe('fail');
    expect(verdict(`${ID}; dkim=pass header.d=mail.example.com`)).toBe('fail');
    expect(verdict(`${ID}; dkim=pass header.i=@example.com`)).toBe('fail');
    expect(verdict(`${ID}; spf=pass smtp.mailfrom=example.com`)).toBe('fail');
    expect(verdict(`${ID}; dkim=fail header.d=example.com`)).toBe('fail');
  });

  it('only the first Authentication-Results of all is read, and it must be the provider’s', () => {
    const pass = `${ID}; dmarc=pass header.from=example.com`;
    // An id-less header on top: nothing passes, whatever is below.
    expect(
      authVerdict(
        [
          line('spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com'),
          line(pass),
        ],
        ID,
        'example.com',
      ),
    ).toBe('fail');
    // Another provider's on top — a forged one — the same.
    expect(
      authVerdict(
        [line('mx.forger.test; dmarc=pass header.from=example.com'), line(pass)],
        ID,
        'example.com',
      ),
    ).toBe('fail');
    // The provider's own on top says fail; a forged pass below it is never read.
    expect(
      authVerdict(
        [
          other('received', 'from mx'),
          line(`${ID}; dmarc=fail header.from=example.com`),
          other('from', 'a@example.com'),
          line(pass),
        ],
        ID,
        'example.com',
      ),
    ).toBe('fail');
    // The id compared whole, in any case.
    expect(
      authVerdict([line('MX.Google.com; dmarc=pass header.from=example.com')], ID, 'example.com'),
    ).toBe('pass');
    expect(
      authVerdict(
        [line('mx.google.com.evil.test; dmarc=pass header.from=example.com')],
        ID,
        'example.com',
      ),
    ).toBe('fail');
    expect(authVerdict([line(pass)], '', 'example.com')).toBe('fail');
    expect(authVerdict([], ID, 'example.com')).toBe('fail');
  });
});

describe('what the vault asks of a mail server, by its capabilities (F10)', () => {
  it('moves one mail only with MOVE and UIDPLUS, deletes one only with UIDPLUS: never COPY and EXPUNGE', () => {
    const caps = (...c: string[]) => new Map(c.map((k) => [k, true]));
    expect(filingOf(caps('IMAP4rev1', 'MOVE', 'UIDPLUS'))).toEqual({
      canMove: true,
      canDelete: true,
    });
    expect(filingOf(caps('IMAP4rev1', 'MOVE'))).toEqual({ canMove: false, canDelete: false });
    expect(filingOf(caps('IMAP4rev1', 'UIDPLUS'))).toEqual({ canMove: false, canDelete: true });
    expect(filingOf(caps('IMAP4rev1'))).toEqual({ canMove: false, canDelete: false });
  });
});
