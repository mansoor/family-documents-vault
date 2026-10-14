import { describe, expect, it } from 'vitest';
import { normalisePairingCode } from './devices.js';
import {
  normalisePairingAddress,
  pairingAddressCheck,
  punycode,
  sha256,
  showPairingCodeFor,
  utf8,
} from './pairing-address.js';

/**
 * A pairing code's address check (0.8.0, D1). The test vectors below are
 * published for the desktop uploader, whose Rust mirrors the rule exactly:
 * each address as typed, the form the check reads, and its three
 * characters. They were worked out apart from this code too (Python's
 * hashlib and IDNA codec), so this file holds the rule, not itself.
 */
export const PAIRING_ADDRESS_VECTORS: ReadonlyArray<{
  address: string;
  normalised: string;
  check: string;
}> = [
  { address: 'https://vault.seikh.family', normalised: 'https://vault.seikh.family', check: '44K' },
  // Upper-case scheme and host, a trailing slash.
  {
    address: 'HTTPS://Vault.Seikh.Family/',
    normalised: 'https://vault.seikh.family',
    check: '44K',
  },
  // Plain http on the LAN, with a port.
  { address: 'http://192.168.1.20:8080', normalised: 'http://192.168.1.20:8080', check: 'MD4' },
  // A default port is no port.
  { address: 'http://192.168.1.20:80/', normalised: 'http://192.168.1.20', check: 'CKQ' },
  {
    address: 'https://example.com:443/vault/',
    normalised: 'https://example.com/vault',
    check: 'CT6',
  },
  // An IDN host, a path, a query and a fragment.
  {
    address: 'https://Bücher.example/vault?x=1#y',
    normalised: 'https://xn--bcher-kva.example/vault',
    check: 'XN3',
  },
  { address: 'https://фото.рф', normalised: 'https://xn--n1aalg.xn--p1ai', check: 'YRE' },
  // An IPv6 literal, in brackets, with a port.
  { address: 'http://[FE80::1]:8443', normalised: 'http://[fe80::1]:8443', check: 'HN4' },
  // A path keeps its case; the query goes.
  {
    address: 'https://vault.local:8443/fdv/Docs?token=1',
    normalised: 'https://vault.local:8443/fdv/Docs',
    check: 'D7N',
  },
  // No scheme: https.
  { address: 'vault.example.org', normalised: 'https://vault.example.org', check: 'E44' },
];

describe('a pairing code’s address check (0.8.0, D1)', () => {
  it.each(PAIRING_ADDRESS_VECTORS)('$address → $normalised → $check', (v) => {
    expect(normalisePairingAddress(v.address)).toBe(v.normalised);
    expect(pairingAddressCheck(v.address)).toBe(v.check);
  });

  it('a look-alike or a mistyped address has another check', () => {
    const real = pairingAddressCheck('https://vault.seikh.family');
    for (const other of [
      'https://vault.seikh.familly',
      'https://vau1t.seikh.family',
      'http://vault.seikh.family',
      'https://vault.seikh.family:8443',
      'https://vault.seikh.family/other',
      'https://vаult.seikh.family', // a Cyrillic а
    ]) {
      expect(pairingAddressCheck(other), other).not.toBe(real);
    }
  });

  it('is shown after the code, and the vault takes the code with it or without it', () => {
    expect(showPairingCodeFor('KX7P-3M9Q', 'https://vault.seikh.family')).toBe('KX7P-3M9Q-44K');
    expect(normalisePairingCode('KX7P-3M9Q-44K')).toBe('KX7P3M9Q');
    expect(normalisePairingCode('kx7p 3m9q 44k')).toBe('KX7P3M9Q');
    expect(normalisePairingCode('KX7P-3M9Q')).toBe('KX7P3M9Q');
    // Not a code: too short, too long, or a character it never uses.
    expect(normalisePairingCode('KX7P-3M9Q-44')).toBeNull();
    expect(normalisePairingCode('KX7P-3M9Q-44KK')).toBeNull();
    expect(normalisePairingCode('KX7P-3M9Q-40K')).toBeNull();
  });

  it('its parts are the standard ones: SHA-256, UTF-8 and punycode', () => {
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    expect(hex(sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hex(sha256(utf8('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    // Two blocks.
    expect(hex(sha256(utf8('a'.repeat(64))))).toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    );
    expect(hex(utf8('€𝄞'))).toBe('e282acf09d849e');
    expect(punycode('bücher')).toBe('bcher-kva');
    expect(punycode('münchen')).toBe('mnchen-3ya');
  });
});
