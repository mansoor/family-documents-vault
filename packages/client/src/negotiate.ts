import { API_VERSION, meetsMinimum, PRODUCT_ID, type Capabilities } from '@fdv/shared';

/**
 * The first thing a client does with a server: decide whether they can
 * work together (API-01). One official app has to cope with self-hosted
 * vaults months or years apart from it, so each way this can go wrong has
 * its own answer, and each answer its own plain sentence on screen.
 */
export type Negotiation =
  | { kind: 'ok'; caps: Capabilities }
  | { kind: 'not_a_vault' }
  | { kind: 'api_version'; server: number }
  | { kind: 'server_too_old'; server: string; needed: string }
  | { kind: 'client_too_old'; client: string; needed: string }
  | { kind: 'setup_required'; caps: Capabilities };

export function negotiate(
  caps: unknown,
  mine: { clientVersion: string; minServerVersion: string },
): Negotiation {
  const c = caps as Partial<Capabilities> | null;
  if (!c || typeof c !== 'object' || c.product !== PRODUCT_ID) return { kind: 'not_a_vault' };
  if (c.api_version !== API_VERSION) return { kind: 'api_version', server: Number(c.api_version) };
  const full = c as Capabilities;
  if (!atLeast(full.server_version, mine.minServerVersion)) {
    return { kind: 'server_too_old', server: full.server_version, needed: mine.minServerVersion };
  }
  if (!atLeast(mine.clientVersion, full.min_client_version)) {
    return { kind: 'client_too_old', client: mine.clientVersion, needed: full.min_client_version };
  }
  if (full.setup_required) return { kind: 'setup_required', caps: full };
  return { kind: 'ok', caps: full };
}

/** A version that cannot be read counts as too old, never as a crash. */
function atLeast(actual: unknown, minimum: string): boolean {
  try {
    return typeof actual === 'string' && meetsMinimum(actual, minimum);
  } catch {
    return false;
  }
}
