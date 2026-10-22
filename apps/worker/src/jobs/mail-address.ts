import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { isLoopbackName, isPrivateAddress } from '@fdv/shared';

/**
 * Where a mailbox set up in Settings may be (0.9.0, the O1 review, M3): an
 * owner types its server, and the worker connects to it — so it must not
 * be a way into the server's own network, nor a port scanner. The server's
 * own FDV_MAIL_IN_* are the operator's, and stay as they are.
 *
 *  - Its port is one of FDV_MAIL_IN_ALLOWED_PORTS (993 alone by default).
 *  - Its name is resolved here, once, and every address it gives must be
 *    outside the server's own network — not loopback, link-local (cloud
 *    metadata among it), private, carrier-grade NAT, reserved, nor one of
 *    the worker's own addresses (a Docker network) — unless
 *    FDV_MAIL_IN_ALLOW_PRIVATE says so. A name that means this machine
 *    (localhost) is refused without asking DNS.
 *  - The worker then connects to the address it checked, keeping the name
 *    for SNI and the certificate (ImapSettings.address): the name is never
 *    looked up again, so it cannot be made to point elsewhere in between.
 */

export interface MailHostRules {
  /** FDV_MAIL_IN_ALLOWED_PORTS. */
  allowedPorts: readonly number[];
  /** FDV_MAIL_IN_ALLOW_PRIVATE. */
  allowPrivate: boolean;
  /** How a name is resolved: DNS, unless a test stands in. */
  resolve?: (host: string) => Promise<string[]>;
}

/** The address to connect to, or why not: a port or an address refused, or a name that resolves to nothing. */
export type MailHostAnswer =
  { address: string } | { refused: 'port' | 'address' } | { unresolved: true };

const dns = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** The worker's own addresses: a Docker network's among them. */
function ownAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) out.add(a.address.toLowerCase());
  }
  return out;
}

export async function mailHostAddress(
  host: string,
  port: number,
  rules: MailHostRules,
): Promise<MailHostAnswer> {
  if (!rules.allowedPorts.includes(port)) return { refused: 'port' };
  if (!rules.allowPrivate && isLoopbackName(host)) return { refused: 'address' };
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await (rules.resolve ?? dns)(host);
    } catch {
      return { unresolved: true };
    }
  }
  if (addresses.length === 0) return { unresolved: true };
  if (!rules.allowPrivate) {
    const own = ownAddresses();
    if (addresses.some((a) => isPrivateAddress(a) || own.has(a.toLowerCase()))) {
      return { refused: 'address' };
    }
  }
  return { address: addresses[0] as string };
}
