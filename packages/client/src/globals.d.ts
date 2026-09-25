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
