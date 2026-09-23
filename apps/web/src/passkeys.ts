import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { api } from './api.js';

/**
 * The browser half of a passkey. The ceremony itself belongs to the
 * platform — the authenticator checks the origin and asks for the face or
 * the fingerprint — so all this does is carry options there and the answer
 * back, and turn the ways it can fail into sentences.
 */

export function supported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/**
 * Passkeys need a secure origin. `localhost` counts; a plain http address
 * on the home network does not, which is what the TLS setup in the README
 * is for — so this is the one place that says so out loud.
 */
export function secureEnough(): boolean {
  return window.isSecureContext;
}

export async function enrol(token: string, label: string): Promise<void> {
  const options = await api.passkeyRegisterChallenge(token);
  const response = await startRegistration({ optionsJSON: options });
  await api.passkeyRegister(token, response, label);
}

export async function signIn(email?: string) {
  const options = await api.passkeyChallenge(email);
  const response = await startAuthentication({ optionsJSON: options });
  return api.passkeyVerify(response);
}

/**
 * An assertion for something other than signing in — confirming it is you
 * before a consequential action (SEC-17).
 */
export async function assert(options: Parameters<typeof startAuthentication>[0]['optionsJSON']) {
  return startAuthentication({ optionsJSON: options });
}

/** What went wrong, said the way a person would say it. */
export function describe(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError') {
    return 'Nothing was chosen, or it timed out. Try again when you are ready.';
  }
  if (name === 'InvalidStateError') {
    return 'This device already has a passkey for the vault.';
  }
  if (name === 'SecurityError') {
    return 'Passkeys need a secure connection (https). See the README for setting one up.';
  }
  if (name === 'NotSupportedError') {
    return 'This device cannot make a passkey.';
  }
  return err instanceof Error && err.message ? err.message : 'That did not work. Try again.';
}
