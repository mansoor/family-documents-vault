import { describe, expect, it } from 'vitest';
import { aligned, authVerdict, parseAuthResults, withoutComments } from './mail-auth.js';

/**
 * Whether the mailbox's provider vouched for a sender (S4): only the
 * topmost Authentication-Results of the provider set (FDV_MAIL_IN_AUTHSERV_ID)
 * is read; one of any other id — which anybody can write into their mail —
 * never is; and it passes on DMARC for the From's domain, or DKIM signed by
 * that domain or one above it.
 */

const line = (v: string) => ({
  key: 'authentication-results',
  line: `Authentication-Results: ${v}`,
});
const other = (k: string, v: string) => ({ key: k, line: `${k}: ${v}` });

describe('Authentication-Results, as the vault reads them (S4)', () => {
  it('reads an id and its results, comments and quotes and all', () => {
    expect(withoutComments('a (b (c) d) e "f (g)"')).toBe('a   e "f (g)"');
    expect(
      parseAuthResults(
        ' mx.google.com (the provider);\r\n dkim=pass header.i=@example.com header.s=s1 header.b="ab;cd";\r\n spf=pass (google.com: domain of x@example.com) smtp.mailfrom=x@example.com;\r\n dmarc=pass (p=NONE) header.from=example.com',
      ),
    ).toEqual({
      authservId: 'mx.google.com',
      results: [
        {
          method: 'dkim',
          result: 'pass',
          props: { 'header.i': '@example.com', 'header.s': 's1', 'header.b': 'ab;cd' },
        },
        { method: 'spf', result: 'pass', props: { 'smtp.mailfrom': 'x@example.com' } },
        { method: 'dmarc', result: 'pass', props: { 'header.from': 'example.com' } },
      ],
    });
    // A value with no authserv-id (as some providers write it) is no word.
    expect(
      parseAuthResults(' spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com'),
    ).toBeNull();
  });

  it('passes on dmarc=pass for the From’s domain, or dkim=pass signed by it or a domain above it', () => {
    const id = 'mx.example.net';
    expect(
      authVerdict([line(`${id}; dmarc=pass header.from=example.com`)], id, 'example.com'),
    ).toBe('pass');
    expect(authVerdict([line(`${id}; dmarc=pass`)], id, 'example.com')).toBe('pass');
    // DMARC for another domain is not this one's.
    expect(authVerdict([line(`${id}; dmarc=pass header.from=evil.test`)], id, 'example.com')).toBe(
      'fail',
    );
    expect(authVerdict([line(`${id}; dkim=pass header.d=example.com`)], id, 'example.com')).toBe(
      'pass',
    );
    expect(
      authVerdict([line(`${id}; dkim=pass header.d=example.com`)], id, 'mail.example.com'),
    ).toBe('pass');
    expect(authVerdict([line(`${id}; dkim=pass header.i=@example.com`)], id, 'example.com')).toBe(
      'pass',
    );
    // A signature of another domain, of one below it, or of a bare label, vouches for nothing here.
    expect(authVerdict([line(`${id}; dkim=pass header.d=evil.test`)], id, 'example.com')).toBe(
      'fail',
    );
    expect(
      authVerdict([line(`${id}; dkim=pass header.d=mail.example.com`)], id, 'example.com'),
    ).toBe('fail');
    expect(authVerdict([line(`${id}; dkim=pass header.d=com`)], id, 'example.com')).toBe('fail');
    // SPF alone, a failing DKIM, nothing at all: not vouched for.
    expect(
      authVerdict([line(`${id}; spf=pass smtp.mailfrom=example.com`)], id, 'example.com'),
    ).toBe('fail');
    expect(
      authVerdict([line(`${id}; dkim=fail header.d=example.com; dmarc=fail`)], id, 'example.com'),
    ).toBe('fail');
    expect(authVerdict([], id, 'example.com')).toBe('fail');
    expect(aligned('Example.COM.', 'example.com')).toBe(true);
  });

  it('reads only the topmost header of the provider set: a forged one from another id, or below its own, counts for nothing', () => {
    const id = 'mx.google.com';
    // Forged by the sender with another provider's id: never read.
    expect(
      authVerdict(
        [
          line('mx.forger.test; dmarc=pass header.from=example.com'),
          other('from', 'a@example.com'),
        ],
        id,
        'example.com',
      ),
    ).toBe('fail');
    // The provider's own says fail; a forged pass with its id sits below it, as the sender wrote it.
    expect(
      authVerdict(
        [
          other('received', 'from mx'),
          line(`${id}; dkim=none; dmarc=fail header.from=example.com`),
          other('from', 'a@example.com'),
          line(`${id}; dkim=pass header.d=example.com; dmarc=pass header.from=example.com`),
        ],
        id,
        'example.com',
      ),
    ).toBe('fail');
    // The id is compared whole, in any case: a look-alike is another id.
    expect(authVerdict([line('MX.Google.com; dmarc=pass')], id, 'example.com')).toBe('pass');
    expect(authVerdict([line('mx.google.com.evil.test; dmarc=pass')], id, 'example.com')).toBe(
      'fail',
    );
    // No id set: nothing passes.
    expect(authVerdict([line(`${id}; dmarc=pass`)], '', 'example.com')).toBe('fail');
  });
});
