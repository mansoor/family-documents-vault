import { describe, expect, it } from 'vitest';
import { isLoopbackName, isPrivateAddress, pushAddressProblem, pushTopic } from './push.js';

describe('where a push may go', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.4.1',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00:ec2::254',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    // IPv4 inside IPv6, as `new URL` and DNS write it (hex), and every other way.
    '::ffff:7f00:1',
    '[::ffff:a9fe:a9fe]',
    '0:0:0:0:0:ffff:0a01:0203',
    '::ffff:0:7f00:1',
    '::7f00:1',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::10.0.0.5',
    '64:ff9b:1::808:808',
    '2002:7f00:1::1',
    '2002:c0a8:0101::1',
    '2001:0db8::1',
    '2001:db8::1',
    'fec0::1',
    '100::1',
    'fe80::1%eth0',
    // Not addresses at all.
    '1::2::3',
    '1:2:3:4:5:6:7:8:9',
    '12345::1',
    ':1::2',
    '1:2:3:4:5:6:7:8::',
    'not an address',
  ])('%s is refused', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '172.32.0.1',
    '192.169.0.1',
    '2606:4700:4700::1111',
    '::ffff:1.1.1.1',
    '::ffff:808:808',
    '64:ff9b::808:808',
    '2002:808:808::1',
    '2a00:1450:4001:80b::200e',
    '2606:4700:4700:0:0:0:0:1111',
  ])('%s may be tried', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('localhost is this machine, whatever DNS says', () => {
    for (const name of [
      'localhost',
      'LOCALHOST',
      'localhost.',
      'vault.localhost',
      'a.b.localhost',
    ]) {
      expect(isLoopbackName(name), name).toBe(true);
    }
    for (const name of ['ntfy.sh', 'localhost.example.com', 'notlocalhost', 'mylocalhost']) {
      expect(isLoopbackName(name), name).toBe(false);
    }
  });

  it('only https', () => {
    expect(pushAddressProblem('https://ntfy.sh/up123')).toBeNull();
    expect(pushAddressProblem('http://ntfy.sh/up123')).toBe('not_https');
    expect(pushAddressProblem('ntfy.sh/up123')).toBe('not_https');
  });

  it('one topic per kind of message', () => {
    expect(pushTopic('session_ended')).toBe('fdv-session-ended');
    expect(pushTopic('digest')).toBe('fdv-digest');
  });
});
