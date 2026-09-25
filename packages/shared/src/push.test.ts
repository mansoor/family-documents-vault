import { describe, expect, it } from 'vitest';
import { isPrivateAddress, pushAddressProblem, pushTopic } from './push.js';

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
  ])('%s may be tried', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
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
