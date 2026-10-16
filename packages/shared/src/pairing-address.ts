/**
 * A pairing code's address check (0.8.0, D1, from the desktop app's review).
 *
 * The pairing dialog shows the code as `KX7P-3M9Q-R4T`: the vault's eight
 * characters, then three worked out from the exact address the dialog
 * shows. The uploader app works the same three out from the address its
 * person typed, and refuses to pair — before it sends anything — when they
 * differ: a look-alike or mistyped address is caught on the computer, and
 * the code never reaches a vault that is not this one. The vault itself
 * takes the code with or without them (it never checks them: the address
 * is the app's to check).
 *
 * The rule, which the app's Rust mirrors to the byte (the test vectors in
 * pairing-address.test.ts hold both to it):
 *
 *  1. The address, trimmed; `https://` put before it when it names no scheme.
 *  2. Its scheme and host in lower case; each host label with anything but
 *     ASCII in it Unicode-normalised (NFC), lower-cased and written as
 *     punycode (`xn--…`, RFC 3492); a default port (80 for http, 443 for
 *     https) left out; its path kept as it is, but for any slash at its end;
 *     its query and fragment dropped.
 *  3. SHA-256 of that, as UTF-8; its first three bytes, each `byte % 23` an
 *     index into PAIRING_ALPHABET.
 *
 * Pure and synchronous, with no platform's crypto: a browser, a phone, Node
 * and the app all get the same three characters.
 */

import { PAIRING_ALPHABET } from './devices.js';

/** How long the check is: three characters after the code's eight. */
export const PAIRING_CHECK_LENGTH = 3;

/** An address as the check reads it: see the rule above. */
export function normalisePairingAddress(address: string): string {
  let rest = address.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  const proto = scheme ? (scheme[1] as string).toLowerCase() : 'https';
  rest = scheme ? rest.slice(scheme[0].length) : rest;
  // Query and fragment dropped.
  rest = rest.replace(/[?#].*$/s, '');
  const slash = rest.indexOf('/');
  let authority = slash === -1 ? rest : rest.slice(0, slash);
  let path = slash === -1 ? '' : rest.slice(slash);
  path = path.replace(/\/+$/, '');
  // Whatever came before an @ is kept, in lower case, as part of the host:
  // an address that has one is not this vault's, and should not match it.
  let port = '';
  if (authority.startsWith('[') || /@\[/.test(authority)) {
    const close = authority.lastIndexOf(']');
    const after = authority.slice(close + 1);
    if (/^:\d*$/.test(after)) {
      port = after.slice(1);
      authority = authority.slice(0, close + 1);
    }
  } else {
    const p = /:(\d*)$/.exec(authority);
    if (p) {
      port = p[1] as string;
      authority = authority.slice(0, p.index);
    }
  }
  const host = authority
    .split('.')
    .map((label) =>
      [...label].some((ch) => (ch.codePointAt(0) as number) > 0x7f)
        ? `xn--${punycode(label.normalize('NFC').toLowerCase())}`
        : label.toLowerCase(),
    )
    .join('.');
  port = port.replace(/^0+(?=\d)/, '');
  const defaultPort = proto === 'http' ? '80' : proto === 'https' ? '443' : null;
  const keepPort = port !== '' && port !== defaultPort;
  return `${proto}://${host}${keepPort ? `:${port}` : ''}${path}`;
}

/** The three characters a pairing code carries for an address. */
export function pairingAddressCheck(address: string): string {
  const digest = sha256(utf8(normalisePairingAddress(address)));
  return Array.from(digest.subarray(0, PAIRING_CHECK_LENGTH), (b) =>
    PAIRING_ALPHABET.charAt(b % PAIRING_ALPHABET.length),
  ).join('');
}

/** A code as the dialog shows it, with its address's check: `KX7P-3M9Q-R4T`. */
export function showPairingCodeFor(code: string, address: string): string {
  const plain = code.replace(/-/g, '');
  return `${plain.slice(0, 4)}-${plain.slice(4)}-${pairingAddressCheck(address)}`;
}

// ------------------------------------------------------------ the parts

/** A string as UTF-8 bytes, with no platform's TextEncoder. */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 (FIPS 180-4), small and synchronous. */
export function sha256(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64).fill(0);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[i] as number) + (w[i] as number)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = ((h[0] as number) + a) | 0;
    h[1] = ((h[1] as number) + b) | 0;
    h[2] = ((h[2] as number) + c) | 0;
    h[3] = ((h[3] as number) + d) | 0;
    h[4] = ((h[4] as number) + e) | 0;
    h[5] = ((h[5] as number) + f) | 0;
    h[6] = ((h[6] as number) + g) | 0;
    h[7] = ((h[7] as number) + hh) | 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((v, i) => outView.setUint32(i * 4, v >>> 0));
  return out;
}

/** A label's punycode (RFC 3492), without its `xn--`. */
export function punycode(label: string): string {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const skew = 38;
  const damp = 700;
  const codePoints = Array.from(label, (c) => c.codePointAt(0) as number);
  const digit = (d: number) => String.fromCharCode(d + (d < 26 ? 97 : 22));
  const adapt = (delta: number, points: number, first: boolean) => {
    let dlt = first ? Math.floor(delta / damp) : delta >> 1;
    dlt += Math.floor(dlt / points);
    let k = 0;
    while (dlt > ((base - tMin) * tMax) >> 1) {
      dlt = Math.floor(dlt / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * dlt) / (dlt + skew));
  };
  let out = codePoints
    .filter((c) => c < 0x80)
    .map((c) => String.fromCharCode(c))
    .join('');
  const basic = out.length;
  let handled = basic;
  if (basic > 0) out += '-';
  let n = 0x80;
  let delta = 0;
  let bias = 72;
  while (handled < codePoints.length) {
    const m = Math.min(...codePoints.filter((c) => c >= n));
    delta += (m - n) * (handled + 1);
    n = m;
    for (const c of codePoints) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = base; ; k += base) {
          const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
          if (q < t) break;
          out += digit(t + ((q - t) % (base - t)));
          q = Math.floor((q - t) / (base - t));
        }
        out += digit(q);
        bias = adapt(delta, handled + 1, handled === basic);
        delta = 0;
        handled++;
      }
    }
    delta++;
    n++;
  }
  return out;
}
