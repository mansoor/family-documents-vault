import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import ece from 'http_ece';
import { describe, expect, it } from 'vitest';
import { encrypt, MAX_PLAINTEXT, RECORD_SIZE, vapidAuthorization, webPush } from './web-push.js';

/**
 * The vault's own Web Push (0.9.0): RFC 8291's message encryption and
 * RFC 8292's VAPID signature on node:crypto, in place of the web-push
 * package. Held to the RFC's published example, opened again as a phone
 * opens it, and signed so a push service's check of the signature passes.
 */

/** RFC 8291, Appendix A: the example's inputs and the message it gives. */
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const b64u = (s: string) => Buffer.from(s, 'base64url');

/** A browser's subscription keys, and its private key to open what it is sent. */
function subscriber() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    ecdh,
    keys: { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

describe('Web Push on node:crypto (RFC 8291, RFC 8292)', () => {
  it('gives exactly the message of RFC 8291, Appendix A', () => {
    const out = encrypt(
      RFC8291.plaintext,
      { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
      { salt: b64u(RFC8291.salt), senderPrivateKey: b64u(RFC8291.asPrivate) },
    );
    expect(out.toString('base64url')).toBe(RFC8291.message);
    // Its header: the salt, the record size (4096), the sender's key.
    expect(out.subarray(0, 16).toString('base64url')).toBe(RFC8291.salt);
    expect(out.readUInt32BE(16)).toBe(RECORD_SIZE);
    expect(out.readUInt8(20)).toBe(65);
    expect(out.subarray(21, 86).toString('base64url')).toBe(RFC8291.asPublic);
  });

  it('the RFC’s message opens with its receiver’s key, as a phone opens it', () => {
    const ua = createECDH('prime256v1');
    ua.setPrivateKey(b64u(RFC8291.uaPrivate));
    expect(ua.getPublicKey('base64url')).toBe(RFC8291.uaPublic);
    const opened = ece.decrypt(b64u(RFC8291.message), {
      version: 'aes128gcm',
      privateKey: ua,
      authSecret: RFC8291.authSecret,
    });
    expect(opened.toString('utf8')).toBe(RFC8291.plaintext);
  });

  it('what it sends opens with the subscription’s keys, new keys and salt each time', () => {
    const s = subscriber();
    const words = JSON.stringify({
      title: 'Family Document Vault',
      body: 'You have reminders today.',
    });
    const a = encrypt(words, s.keys);
    const b = encrypt(words, s.keys);
    expect(a.equals(b)).toBe(false);
    for (const m of [a, b]) {
      const opened = ece.decrypt(m, {
        version: 'aes128gcm',
        privateKey: s.ecdh,
        authSecret: s.keys.auth,
      });
      expect(opened.toString('utf8')).toBe(words);
    }
    // Another subscription's keys open nothing.
    const other = subscriber();
    expect(() =>
      ece.decrypt(a, { version: 'aes128gcm', privateKey: other.ecdh, authSecret: s.keys.auth }),
    ).toThrow();
  });

  it('refuses keys that are not a subscription’s, and a payload too large for one record', () => {
    const s = subscriber();
    expect(() => encrypt('x', { ...s.keys, p256dh: 'AAAA' })).toThrow(/p256dh/);
    expect(() => encrypt('x', { ...s.keys, auth: 'AAAA' })).toThrow(/auth/);
    // RFC 8291, section 4: 3993 octets at most, so the whole message is one 4096-byte record.
    expect(MAX_PLAINTEXT).toBe(RECORD_SIZE - 86 - 16 - 1);
    expect(() => encrypt(Buffer.alloc(MAX_PLAINTEXT + 1), s.keys)).toThrow(/too large/);
    const most = encrypt(Buffer.alloc(MAX_PLAINTEXT), s.keys);
    expect(most.length).toBe(RECORD_SIZE);
  });

  it('signs a VAPID JWT (ES256) for the push service’s origin that verifies with the public key', () => {
    const vapid = { ...webPush.generateVAPIDKeys(), subject: 'mailto:vault@example.test' };
    expect(b64u(vapid.publicKey)).toHaveLength(65);
    expect(b64u(vapid.privateKey)).toHaveLength(32);
    const now = Date.UTC(2026, 10, 20, 12, 0, 0);
    const header = vapidAuthorization(
      'https://push.example.test:8443/wpush/v2/abc?x=1',
      vapid,
      now,
    );
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, sig, k] = m as unknown as [string, string, string, string, string];
    expect(k).toBe(vapid.publicKey);
    expect(JSON.parse(b64u(h).toString('utf8'))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(b64u(c).toString('utf8'))).toEqual({
      aud: 'https://push.example.test:8443',
      exp: now / 1000 + 12 * 3600,
      sub: 'mailto:vault@example.test',
    });
    // The signature: raw r||s, 64 bytes, over "header.claims", by the public key.
    expect(b64u(sig)).toHaveLength(64);
    const pub = b64u(vapid.publicKey);
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key, dsaEncoding: 'ieee-p1363' },
      b64u(sig),
    );
    expect(ok).toBe(true);
    // k= is the point written again as plain base64url, whatever form it was set in.
    const padded = { ...vapid, publicKey: `${b64u(vapid.publicKey).toString('base64')}` };
    expect(vapidAuthorization('https://push.example.test/x', padded, now)).toMatch(
      new RegExp(`, k=${vapid.publicKey}$`),
    );
    // A key that is not the pair's, and a subject that is no contact: refused.
    expect(() =>
      vapidAuthorization('https://push.example.test/x', { ...vapid, subject: 'vault' }),
    ).toThrow(/subject/);
    expect(() =>
      vapidAuthorization('https://push.example.test/x', { ...vapid, privateKey: 'AAAA' }),
    ).toThrow(/private key/);
  });

  it('keeps the key form scripts/gen-env.mjs writes', async () => {
    // gen-env.mjs: the public point from SPKI, the private scalar as JWK d.
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const vapid = {
      publicKey: publicKey
        .export({ type: 'spki', format: 'der' })
        .subarray(-65)
        .toString('base64url'),
      privateKey: privateKey.export({ format: 'jwk' }).d as string,
      subject: 'mailto:vault@example.invalid',
    };
    expect(vapidAuthorization('https://push.example.test/x', vapid)).toMatch(/^vapid t=/);
  });

  it('a push service’s refusal carries its status; a 2xx is sent', async () => {
    const https = await import('node:https');
    const { readFileSync } = await import('node:fs');
    const cert = readFileSync(new URL('./testdata/push-tls.crt', import.meta.url));
    const key = readFileSync(new URL('./testdata/push-tls.key', import.meta.url));
    const answers = [201, 410];
    const seen: Array<Record<string, unknown>> = [];
    const server = https.createServer({ cert, key }, (req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push(req.headers);
        res.statusCode = answers.shift() ?? 500;
        res.end('said');
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    const agent = new https.Agent({ ca: cert, keepAlive: false });
    const s = subscriber();
    const vapid = { ...webPush.generateVAPIDKeys(), subject: 'mailto:vault@example.test' };
    const sub = { endpoint: `https://localhost:${port}/push/1`, keys: s.keys };
    try {
      const sent = await webPush.sendNotification(sub, 'hello', {
        TTL: 60,
        topic: 'fdv-test',
        urgency: 'high',
        vapidDetails: vapid,
        agent,
      });
      expect(sent.statusCode).toBe(201);
      expect(seen[0]).toMatchObject({
        ttl: '60',
        topic: 'fdv-test',
        urgency: 'high',
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
      });
      expect(String(seen[0]?.authorization)).toMatch(/^vapid t=.+, k=/);
      await expect(
        webPush.sendNotification(sub, 'hello', { TTL: 60, vapidDetails: vapid, agent }),
      ).rejects.toMatchObject({ statusCode: 410, body: 'said' });
      // A topic no push service takes is refused before anything is sent.
      await expect(
        webPush.sendNotification(sub, 'hello', {
          TTL: 60,
          topic: 'not a topic!',
          vapidDetails: vapid,
          agent,
        }),
      ).rejects.toThrow(/topic/);
      expect(seen).toHaveLength(2);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
