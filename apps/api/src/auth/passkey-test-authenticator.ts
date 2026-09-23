import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

/**
 * A passkey in software, for tests.
 *
 * WebAuthn cannot be faked with fixtures without also faking the thing
 * under test: the point of the server code is that it checks a signature
 * over a challenge, an origin and a relying party. So this builds real
 * ones — a real P-256 key, real client data, real authenticator data, a
 * real ECDSA signature — and the tests drive the same code paths a phone
 * would. It is also how the failure cases get tested honestly: sign the
 * wrong origin, or replay yesterday's challenge, and see what the server
 * does.
 *
 * Test-only. Nothing imports this outside a test file.
 */
export class SoftwareAuthenticator {
  readonly credentialId: Buffer;
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  private counter = 0;

  constructor(credentialId = randomBytes(16)) {
    this.credentialId = credentialId;
  }

  get id(): string {
    return this.credentialId.toString('base64url');
  }

  /** Answers a creation challenge, the way a browser's authenticator does. */
  register(
    options: PublicKeyCredentialCreationOptionsJSON,
    over: { origin?: string; rpId?: string; challenge?: string } = {},
  ): RegistrationResponseJSON {
    const clientData = this.clientData(
      'webauthn.create',
      over.challenge ?? options.challenge,
      over,
    );
    const authData = Buffer.concat([
      rpIdHash(over.rpId ?? options.rp.id ?? 'localhost'),
      Buffer.from([0x45]), // user present, user verified, attested data included
      counterBytes(++this.counter),
      Buffer.alloc(16), // AAGUID: this authenticator says nothing about itself
      lengthBytes(this.credentialId.length),
      this.credentialId,
      this.coseKey(),
    ]);
    const attestationObject = Buffer.from(
      isoCBOR.encode(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', new Uint8Array(authData)],
        ]) as never,
      ),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: clientData.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
    };
  }

  /** Answers a sign-in challenge. */
  authenticate(
    options: PublicKeyCredentialRequestOptionsJSON,
    over: { origin?: string; rpId?: string; challenge?: string; counter?: number } = {},
  ): AuthenticationResponseJSON {
    const clientData = this.clientData('webauthn.get', over.challenge ?? options.challenge, over);
    if (over.counter !== undefined) this.counter = over.counter;
    else this.counter += 1;
    const authData = Buffer.concat([
      rpIdHash(over.rpId ?? options.rpId ?? 'localhost'),
      Buffer.from([0x05]), // user present, user verified
      counterBytes(this.counter),
    ]);
    const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
    const signature = createSign('sha256').update(signed).sign(this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
    };
  }

  private clientData(type: string, challenge: string, over: { origin?: string } = {}): Buffer {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: over.origin ?? 'http://localhost:8080',
        crossOrigin: false,
      }),
      'utf8',
    );
  }

  /** The public key in the COSE form WebAuthn carries. */
  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return Buffer.from(
      isoCBOR.encode(
        new Map<number, unknown>([
          [1, 2], // kty: EC2
          [3, -7], // alg: ES256
          [-1, 1], // crv: P-256
          [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
          [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
        ]) as never,
      ),
    );
  }
}

const rpIdHash = (rpId: string) => createHash('sha256').update(rpId).digest();

function counterBytes(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function lengthBytes(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}
