import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { lastAddress, ownNetworks, trustProxyFor } from './client-address.js';

/**
 * Whose X-Forwarded-For is believed (5.30): the networks the API's own
 * container is on, read from its interfaces, and an address only ever an
 * address. app.test.ts holds the API to them, request by request.
 */

const v4 = (address: string, cidr: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.0.0',
  family: 'IPv4',
  mac: '02:42:ac:12:00:03',
  internal,
  cidr,
});
const v6 = (address: string, cidr: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '02:42:ac:12:00:03',
  internal,
  cidr,
  scopeid: 0,
});

describe('the networks the API is on', () => {
  it("are its container's own subnets and loopback: the compose network, never the LAN", () => {
    // What a container on the compose network has: loopback, and eth0.
    const container = {
      lo: [v4('127.0.0.1', '127.0.0.1/8', true), v6('::1', '::1/128', true)],
      eth0: [
        v4('172.18.0.3', '172.18.0.3/16'),
        v6('fd00:1234::3', 'fd00:1234::3/64'),
        // Link-local names the wire, not a network: never trusted.
        v6('fe80::42:acff:fe12:3', 'fe80::42:acff:fe12:3/64'),
      ],
    };
    expect(ownNetworks(container).sort()).toEqual(
      ['127.0.0.1/8', '::1/128', '172.18.0.3/16', 'fd00:1234::3/64'].sort(),
    );
    // Nothing of 192.168/16 or 10/8 that the container is not on.
    expect(ownNetworks(container).some((n) => /^(192\.168|10\.)/.test(n))).toBe(false);
  });

  it('leave out an address with no subnet, and an IPv4 link-local one; keep loopback whatever', () => {
    const odd = {
      eth1: [
        { ...v4('169.254.10.2', '169.254.10.2/16') },
        { ...v4('172.20.0.9', '172.20.0.9/16'), cidr: null },
      ],
    };
    expect(ownNetworks(odd).sort()).toEqual(['127.0.0.1/8', '::1/128'].sort());
  });
});

describe('which proxies a mode believes', () => {
  const networks = () => ['172.18.0.3/16'];
  it('network: the ones the API is on; private: every private range; all; none', () => {
    expect(trustProxyFor('network', networks)).toEqual(['172.18.0.3/16']);
    expect(trustProxyFor('private', networks)).toEqual(
      expect.arrayContaining(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']),
    );
    expect(trustProxyFor('all', networks)).toBe(true);
    expect(trustProxyFor('none', networks)).toBe(false);
  });
});

describe('the address of a chain of hops', () => {
  it('is the furthest before anything that is not an address', () => {
    expect(lastAddress(['172.18.0.5', '192.168.1.50'])).toBe('192.168.1.50');
    expect(lastAddress(['172.18.0.5', '<script>', '203.0.113.9'])).toBe('172.18.0.5');
    expect(lastAddress(['172.18.0.5', '999.1.1.1'])).toBe('172.18.0.5');
    expect(lastAddress(['172.18.0.5', ''])).toBe('172.18.0.5');
    expect(lastAddress(['::ffff:172.18.0.5', '2001:db8::7'])).toBe('2001:db8::7');
  });

  it('is nothing when the first hop is not one; and an IPv6 zone is left off', () => {
    expect(lastAddress(['garbage'])).toBeNull();
    expect(lastAddress([undefined])).toBeNull();
    expect(lastAddress([])).toBeNull();
    expect(lastAddress(['fe80::1%eth0'])).toBe('fe80::1');
  });
});
