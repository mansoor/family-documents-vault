import {
  createECDH,
  createHmac,
  createCipheriv,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import https from 'node:https';

/**
 * Sending a Web Push message, on node:crypto alone (0.9.0): the message
 * encrypted as RFC 8291 says (aes128gcm, RFC 8188, one record), and the
 * request signed with the vault's VAPID key as RFC 8292 says (an ES256
 * JWT). In place of the `web-push` package, with what the worker used of
 * it: the same keys (FDV_VAPID_PUBLIC_KEY, the 65-byte public point, and
 * FDV_VAPID_PRIVATE_KEY, its 32-byte scalar, both base64url) and the same
 * subscriptions (`p256dh` and `auth`, base64url, as the browser gives
 * them), so nothing stored changes.
 *
 * A browser's push service and a phone's UnifiedPush distributor take the
 * same request.
 */

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface SendOptions {
  /** How long the push service may keep it, in seconds. */
  TTL: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** A newer message with the same topic replaces one still waiting. */
  topic?: string;
  vapidDetails: VapidDetails;
  agent?: https.Agent;
  /** Milliseconds to wait for an answer. */
  timeout?: number;
}

export interface SendResult {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

/** A push service's answer other than 2xx: its status, for the caller to read. */
export class WebPushError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly headers: Record<string, string | string[] | undefined>,
    readonly body: string,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = 'WebPushError';
  }
}

/** The record size written in the header: one record, as every push service takes. */
export const RECORD_SIZE = 4096;
/**
 * The most a push may carry (RFC 8291, section 4): what the record size
 * leaves after the header (86 octets with the sender's key), the AEAD tag
 * (16) and the padding delimiter (1). Push services take no more.
 */
export const MAX_PLAINTEXT = 3993;
/** How long a VAPID signature is good for: twelve hours (RFC 8292 allows up to 24). */
const VAPID_SECONDS = 12 * 60 * 60;

const b64u = (s: string): Buffer => Buffer.from(s, 'base64url');

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();

/** HKDF-Expand for one block (RFC 5869), all RFC 8291 needs: at most 32 bytes. */
const expand = (prk: Buffer, info: Buffer, length: number): Buffer =>
  hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);

/** A P-256 public point as the browser writes it: 65 bytes, uncompressed. */
function publicPoint(s: string, what: string): Buffer {
  const p = b64u(s);
  if (p.length !== 65 || p[0] !== 0x04) {
    throw new Error(`${what} is not a P-256 public key (65 bytes, uncompressed)`);
  }
  return p;
}

/**
 * The message for one subscription, encrypted (RFC 8291, section 3.4):
 * the header (salt, record size, the sender's public key) and one record.
 * `salt` and `senderPrivateKey` are for the test vector alone: a message
 * sent has its own, new each time.
 */
export function encrypt(
  payload: string | Buffer,
  keys: { p256dh: string; auth: string },
  fixed: { salt?: Buffer; senderPrivateKey?: Buffer } = {},
): Buffer {
  const uaPublic = publicPoint(keys.p256dh, 'p256dh');
  const authSecret = b64u(keys.auth);
  if (authSecret.length !== 16) throw new Error('auth is not 16 bytes');
  const plain = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (plain.length > MAX_PLAINTEXT) throw new Error('payload too large for one record');

  const sender = createECDH('prime256v1');
  if (fixed.senderPrivateKey) sender.setPrivateKey(fixed.senderPrivateKey);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  const salt = fixed.salt ?? randomBytes(16);

  // The input key, mixed with the subscription's auth secret.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = expand(prkKey, keyInfo, 32);
  // RFC 8188: the content key and the nonce, from the salt.
  const prk = hmac(salt, ikm);
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([plain, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

/** The VAPID private key as a key node:crypto signs with. */
function vapidKey(v: VapidDetails): KeyObject {
  const pub = publicPoint(v.publicKey, 'the VAPID public key');
  const d = b64u(v.privateKey);
  if (d.length !== 32) throw new Error('the VAPID private key is not 32 bytes');
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: d.toString('base64url'),
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}

/**
 * The Authorization header for a push service (RFC 8292): `vapid t=<JWT>,
 * k=<public key>`, the JWT ES256 over the service's origin, an expiry and
 * the vault's contact.
 */
export function vapidAuthorization(endpoint: string, v: VapidDetails, now = Date.now()): string {
  if (!/^(mailto:|https:)/.test(v.subject)) {
    throw new Error('the VAPID subject must be a mailto: or https: address');
  }
  const aud = new URL(endpoint).origin;
  const part = (o: object) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const signing = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud,
    exp: Math.floor(now / 1000) + VAPID_SECONDS,
    sub: v.subject,
  })}`;
  const signature = sign('sha256', Buffer.from(signing, 'latin1'), {
    key: vapidKey(v),
    dsaEncoding: 'ieee-p1363',
  });
  // The key as the public point itself, written again: whatever padding or
  // alphabet it was configured in, a push service is given plain base64url.
  const k = publicPoint(v.publicKey, 'the VAPID public key').toString('base64url');
  return `vapid t=${signing}.${signature.toString('base64url')}, k=${k}`;
}

/** A Topic as RFC 8030 has it: at most 32 characters of the URL-safe base64 alphabet. */
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * One message to one subscription. Resolves on 2xx; otherwise rejects
 * with a WebPushError carrying the push service's status, or with the
 * connection's error (no status) when there was no answer.
 */
function sendNotification(
  sub: PushSubscription,
  payload: string | Buffer,
  o: SendOptions,
): Promise<SendResult> {
  return new Promise<SendResult>((resolve, reject) => {
    let url: URL;
    let body: Buffer;
    let authorization: string;
    try {
      url = new URL(sub.endpoint);
      if (o.topic !== undefined && !TOPIC.test(o.topic)) throw new Error('not a push topic');
      body = encrypt(payload, sub.keys);
      authorization = vapidAuthorization(sub.endpoint, o.vapidDetails);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          TTL: String(Math.max(0, Math.floor(o.TTL))),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(body.length),
          Urgency: o.urgency ?? 'normal',
          ...(o.topic ? { Topic: o.topic } : {}),
          Authorization: authorization,
        },
        ...(o.agent ? { agent: o.agent } : {}),
        ...(o.timeout ? { timeout: o.timeout } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          const headers = res.headers as SendResult['headers'];
          if (status >= 200 && status < 300) {
            resolve({ statusCode: status, body: text, headers });
          } else {
            reject(
              new WebPushError(
                `the push service answered ${status}`,
                status,
                headers,
                text,
                sub.endpoint,
              ),
            );
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('the push service did not answer in time')));
    req.on('error', reject);
    req.end(body);
  });
}

/** A new VAPID key pair, in the form FDV_VAPID_* hold (as scripts/gen-env.mjs makes them). */
function generateVAPIDKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: pub.toString('base64url'), privateKey: jwk.d as string };
}

/**
 * The sending, as one object the tests can stand in for
 * (`vi.spyOn(webPush, 'sendNotification')`).
 */
export const webPush = { sendNotification, generateVAPIDKeys };
