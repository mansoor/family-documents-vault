import { isIP } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { FastifyRequest } from 'fastify';

/**
 * Who is asking, as an address (5.30).
 *
 * The audit log records where an action came from, the rate limiter counts
 * per address, and a browser's refresh grace compares with the address that
 * spent the token. All three read `X-Forwarded-For` through whichever
 * proxies are believed, so who may write it decides whose address they get.
 *
 * Until 5.30 every private address was believed (`private`), and nginx
 * added to whatever the caller sent: a device on the home Wi-Fi talking to
 * :8080 could be anybody it liked. Now nginx writes the address it was
 * reached from and nothing else (docker/nginx.conf), and the API believes
 * only the networks its own container is on (`network`, the default): in
 * the compose setup that is nginx and Caddy, and nothing on the LAN.
 *
 * An entry that is not an address at all ends the list where it stands:
 * what was written to the left of it is not believed, and the address is
 * the last good one — never the text itself, which the database refused
 * (a 500 until 5.30).
 */

export type TrustProxyMode = 'network' | 'private' | 'all' | 'none';

/** Every private range: the rule before 5.30, kept for whoever chose it. */
const PRIVATE = [
  '127.0.0.1/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
];

/**
 * The networks this process is on, as CIDRs: loopback and each interface's
 * own subnet. In the API's container that is the compose network, which
 * only the vault's own containers are on. A link-local address (fe80::,
 * 169.254.) names no network worth trusting, and is left out.
 */
export function ownNetworks(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const found = new Set<string>();
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (!i.cidr) continue;
      if (/^fe[89ab][0-9a-f]:/i.test(i.address) || i.address.startsWith('169.254.')) continue;
      found.add(i.cidr);
    }
  }
  // Loopback, whatever the interfaces say: a health check from inside.
  found.add('127.0.0.1/8');
  found.add('::1/128');
  return [...found];
}

/** Fastify's `trustProxy` for a mode: which peers may say who they forward for. */
export function trustProxyFor(mode: TrustProxyMode, networks: () => string[]): boolean | string[] {
  if (mode === 'all') return true;
  if (mode === 'none') return false;
  if (mode === 'private') return PRIVATE;
  return networks();
}

/**
 * The address a request came from, as the proxies believed say: Fastify's
 * chain (`req.ips`, nearest first), up to the first entry that is not an
 * address. Without trusted proxies, the connection's own.
 */
export function clientAddressOf(req: FastifyRequest): string | null {
  return lastAddress(req.ips ?? [req.ip]) ?? lastAddress([req.socket?.remoteAddress]);
}

/**
 * The furthest address of a chain, nearest first, before anything that is
 * not one. An IPv6 address's zone (`%eth0`) is no part of it for the
 * database, and is left off.
 */
export function lastAddress(chain: readonly (string | undefined)[]): string | null {
  let found: string | null = null;
  for (const hop of chain) {
    const bare = hop?.split('%')[0] ?? '';
    if (isIP(bare) === 0) break;
    found = bare;
  }
  return found;
}
