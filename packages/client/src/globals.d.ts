/**
 * The handful of globals every runtime this client runs on has — a
 * browser, React Native's Hermes, and Node for the tests — declared here
 * so the package can compile against ES2022 alone. Nothing exported may
 * mention these: a package compiling this one's source (the web app does)
 * does not see this file, and uses its own platform's declarations. Pulling in the DOM or
 * Node type libraries instead would let code that only one of them has
 * slip in unnoticed.
 */

declare function setTimeout(handler: () => void, ms?: number): number;

/**
 * Web Crypto: its random numbers — a browser's, Hermes' (its polyfill),
 * Node's — and, for a connected app's signer alone (`@fdv/client/apps`),
 * SHA-256 and Ed25519 (Node 22, and the browsers that have them).
 */
declare const crypto: {
  getRandomValues<T extends Uint8Array>(array: T): T;
  readonly subtle: {
    digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
    importKey(
      format: 'pkcs8' | 'raw',
      keyData: Uint8Array,
      algorithm: { name: 'Ed25519' },
      extractable: boolean,
      usages: string[],
    ): Promise<unknown>;
    sign(algorithm: { name: 'Ed25519' }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
    /** The fake vault's check of an app's signature. */
    verify(
      algorithm: { name: 'Ed25519' },
      key: unknown,
      signature: Uint8Array,
      data: Uint8Array,
    ): Promise<boolean>;
    /** The contract's fresh key pairs, for an app's next key (CL2). */
    generateKey(
      algorithm: { name: 'Ed25519' },
      extractable: boolean,
      usages: string[],
    ): Promise<unknown>;
    exportKey(format: 'raw' | 'pkcs8', key: unknown): Promise<ArrayBuffer>;
  };
};
declare function clearTimeout(handle: number | undefined): void;

declare class AbortController {
  readonly signal: { readonly aborted: boolean };
  abort(reason?: unknown): void;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

/** UTF-8 only, which is all Hermes has and all the fake vault reads. */
declare class TextDecoder {
  decode(input?: Uint8Array): string;
}
