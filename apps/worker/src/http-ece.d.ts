/** http_ece (RFC 8188/8291), as the tests use it to open what a phone would receive. */
declare module 'http_ece' {
  import type { ECDH } from 'node:crypto';
  const ece: {
    decrypt(
      buffer: Buffer,
      params: { version: 'aes128gcm'; privateKey: ECDH; authSecret: string; dh?: string },
    ): Buffer;
  };
  export default ece;
}
