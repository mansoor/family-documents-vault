import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { APP_SIGNATURE_LABEL, APP_SIGNATURE_TAG, APP_SIGNED_COMPONENTS } from '@fdv/shared';

/**
 * A connected app's signature (0.9.0, APP1): RFC 9421 HTTP Message
 * Signatures, one profile and nothing else.
 *
 * - One signature, labelled `fdv`, in `Signature-Input` and `Signature`.
 * - Exactly `("@method" "@path" "@query" "content-digest")`, in that order.
 * - Parameters `created`, `keyid`, `nonce`, `alg="ed25519"` and
 *   `tag="fdv-app"`, every one required, in any order; nothing else, and
 *   never `expires`.
 * - `Content-Digest` (RFC 9530) with `sha-256` alone, over the exact body
 *   bytes; a request with no body carries the digest of zero bytes.
 *
 * Host, scheme and port are not signed: proxies rewrite them. A request is
 * bound to this vault by its keyid, an app id and a key id this vault
 * made, and by TLS. `@path` and `@query` are taken from the request-target
 * as it arrived, which nginx and Caddy pass on unchanged.
 *
 * Pure: parsing, the signature base and verifying. Which app a keyid is,
 * its window and its nonce are the service's.
 */

/** A request's signature, as parsed: what the base is made of and what it is checked against. */
export interface ParsedSignature {
  appId: string;
  keyId: string;
  created: number;
  nonce: string;
  /** The `Signature-Input` member's value after `fdv=`, exactly as sent: the base's last line. */
  params: string;
  /** The 64 bytes of the Ed25519 signature. */
  signature: Buffer;
  /** `Content-Digest` exactly as sent, and the 32 bytes it says. */
  digestHeader: string;
  digest: Buffer;
}

/** Why a request's signature headers are refused, before anything is looked up. */
export type SignatureRefusal =
  { code: 'app_signature_required' } | { code: 'signature_malformed'; detail: string };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEYID = new RegExp(`^(${UUID})\\.(${UUID})$`);
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const COMPONENTS = `(${APP_SIGNED_COMPONENTS.map((c) => `"${c}"`).join(' ')})`;
const REQUIRED = ['created', 'keyid', 'nonce', 'alg', 'tag'] as const;

/** The header's value, when it was sent once: a header sent twice is joined, and refused. */
function header(headers: Record<string, string | string[] | undefined>, name: string) {
  const v = headers[name];
  if (Array.isArray(v)) return v.length === 1 ? v[0] : '\u0000twice';
  return v;
}

/** Whether a request carries any of an app's signature headers. */
export function presentsSignature(headers: Record<string, string | string[] | undefined>): boolean {
  return headers['signature'] !== undefined || headers['signature-input'] !== undefined;
}

/**
 * The three headers, parsed and held to the profile: `app_signature_required`
 * when one is missing; `signature_malformed`, saying which part, when one
 * is not as the profile says.
 */
export function parseSignature(
  headers: Record<string, string | string[] | undefined>,
): ParsedSignature | SignatureRefusal {
  const input = header(headers, 'signature-input');
  const sig = header(headers, 'signature');
  const digestHeader = header(headers, 'content-digest');
  if (input === undefined || sig === undefined || digestHeader === undefined) {
    return { code: 'app_signature_required' };
  }
  const malformed = (detail: string) => ({ code: 'signature_malformed' as const, detail });

  // Signature-Input: fdv=(...);created=...;keyid="...";...
  const label = `${APP_SIGNATURE_LABEL}=`;
  const inputText = input.trim();
  if (!inputText.startsWith(label))
    return malformed('Signature-Input: one signature, labelled fdv');
  const params = inputText.slice(label.length);
  if (!params.startsWith(COMPONENTS)) {
    return malformed(`Signature-Input: the components are exactly ${COMPONENTS}`);
  }
  let rest = params.slice(COMPONENTS.length);
  const found = new Map<string, string | number>();
  const param = /^;([a-z][a-z0-9_.*-]*)=("((?:[^"\\]|\\.)*)"|(-?\d{1,15}))/;
  while (rest.length > 0) {
    const m = param.exec(rest);
    if (!m) return malformed('Signature-Input: the parameters');
    const name = m[1] as string;
    if (found.has(name)) return malformed(`Signature-Input: ${name} twice`);
    if (name === 'expires') return malformed('Signature-Input: expires is not used');
    if (!(REQUIRED as readonly string[]).includes(name)) {
      return malformed(`Signature-Input: unknown parameter ${name}`);
    }
    found.set(name, m[4] !== undefined ? Number(m[4]) : (m[3] as string));
    rest = rest.slice(m[0].length);
  }
  for (const name of REQUIRED) {
    if (!found.has(name)) return malformed(`Signature-Input: ${name} is required`);
  }
  const created = found.get('created');
  if (typeof created !== 'number' || !Number.isSafeInteger(created) || created < 0) {
    return malformed('Signature-Input: created is an integer');
  }
  const keyid = KEYID.exec(String(found.get('keyid')));
  if (typeof found.get('keyid') !== 'string' || !keyid) {
    return malformed('Signature-Input: keyid is "<app_id>.<key_id>", lower-case UUIDs');
  }
  const nonce = found.get('nonce');
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) {
    return malformed('Signature-Input: nonce is 22 to 64 base64url characters');
  }
  if (found.get('alg') !== 'ed25519') return malformed('Signature-Input: alg is "ed25519"');
  if (found.get('tag') !== APP_SIGNATURE_TAG) return malformed('Signature-Input: tag is "fdv-app"');

  // Signature: fdv=:<base64>:
  const sigMatch = /^fdv=:([A-Za-z0-9+/]+={0,2}):$/.exec(sig.trim());
  const signature = sigMatch ? Buffer.from(sigMatch[1] as string, 'base64') : null;
  if (!signature || signature.length !== 64) {
    return malformed('Signature: fdv=:<base64 of 64 bytes>:');
  }

  // Content-Digest: sha-256=:<base64>:
  const digestMatch = /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(digestHeader.trim());
  if (!digestMatch) return malformed('Content-Digest: sha-256=:<base64 of 32 bytes>:, alone');
  return {
    appId: keyid[1] as string,
    keyId: keyid[2] as string,
    created,
    nonce,
    params,
    signature,
    digestHeader: digestHeader.trim(),
    digest: Buffer.from(digestMatch[1] as string, 'base64'),
  };
}

/** `@path` and `@query` from the request-target as it arrived: the query `?` when there is none. */
export function pathAndQuery(rawUrl: string): { path: string; query: string } {
  const q = rawUrl.indexOf('?');
  return q === -1
    ? { path: rawUrl, query: '?' }
    : { path: rawUrl.slice(0, q), query: rawUrl.slice(q) };
}

/** The signature base (RFC 9421 §2.5): five lines joined by LF, no newline at the end. */
export function signatureBase(r: {
  method: string;
  path: string;
  query: string;
  digestHeader: string;
  params: string;
}): string {
  return [
    `"@method": ${r.method.toUpperCase()}`,
    `"@path": ${r.path}`,
    `"@query": ${r.query}`,
    `"content-digest": ${r.digestHeader}`,
    `"@signature-params": ${r.params}`,
  ].join('\n');
}

/** An Ed25519 public key from its 32 raw bytes. */
export function publicKeyOf(raw: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
}

/** Whether the signature verifies over the base, under the key. */
export function verifies(raw: Buffer, base: string, signature: Buffer): boolean {
  try {
    return verify(null, Buffer.from(base, 'utf8'), publicKeyOf(raw), signature);
  } catch {
    return false;
  }
}

/**
 * A public key as an owner or an app gives it: `ed25519:` and the 32
 * raw bytes in base64url, or a PEM `PUBLIC KEY` (SPKI) block. Its 32 raw
 * bytes; null for anything else.
 */
export function rawPublicKey(text: string): Buffer | null {
  const t = text.trim();
  const short = /^ed25519:([A-Za-z0-9_-]{43})$/.exec(t);
  if (short) {
    const raw = Buffer.from(short[1] as string, 'base64url');
    return raw.length === 32 && rawIsKey(raw) ? raw : null;
  }
  if (/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(t)) {
    try {
      const key = createPublicKey({ key: t, format: 'pem' });
      if (key.asymmetricKeyType !== 'ed25519') return null;
      const x = key.export({ format: 'jwk' }).x;
      const raw = x ? Buffer.from(x, 'base64url') : null;
      return raw && raw.length === 32 ? raw : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Whether 32 bytes make a public key Node will take. */
function rawIsKey(raw: Buffer): boolean {
  try {
    publicKeyOf(raw);
    return true;
  } catch {
    return false;
  }
}

/** A key's fingerprint: the first 16 bytes of its SHA-256, in groups of four hex. */
export function fingerprintOf(raw: Buffer): string {
  const hex = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return (hex.match(/.{4}/g) as string[]).join(' ');
}

/** A body's `Content-Digest` value (RFC 9530, sha-256). */
export function contentDigest(body: Buffer | string): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}
