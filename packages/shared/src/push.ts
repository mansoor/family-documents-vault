/**
 * Push to phones (4.13): what a UnifiedPush message may say, and where a
 * push may be sent.
 *
 * A UnifiedPush message goes through the person's own distributor (ntfy
 * and the like) and every server between. It is encrypted (RFC 8291), but
 * it still says nothing a lock screen should not: no titles, no names, no
 * document kinds — a count, a date, a word for what happened. The phone
 * asks the vault for the rest once it is unlocked.
 */
export type PushMessage =
  | { v: 1; type: 'digest'; count: number; date: string }
  | { v: 1; type: 'new_device' }
  | { v: 1; type: 'owner_change' }
  | { v: 1; type: 'session_ended' }
  | { v: 1; type: 'test' };

export type PushType = PushMessage['type'];

/** How long a push may wait for the phone: a week for a session that ended, a day for the rest. */
export const PUSH_TTL_SECONDS: Record<PushType, number> = {
  digest: 24 * 3600,
  new_device: 24 * 3600,
  owner_change: 24 * 3600,
  session_ended: 7 * 24 * 3600,
  test: 24 * 3600,
};

/** One Topic per type: a newer digest replaces an older one still waiting. */
export const pushTopic = (type: PushType): string => `fdv-${type.replace('_', '-')}`;

function v4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

/**
 * An address a push must not be sent to unless the operator allows it:
 * loopback, private networks, link-local (cloud metadata at 169.254.169.254
 * among them), carrier-grade NAT, "this network", multicast and reserved —
 * for IPv6 too, including IPv4 addresses written as IPv6. A vault that
 * would send to any of these could be pointed at its own network by
 * whoever registers a device (blind SSRF).
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const mapped =
    /^(?:0*:)*:ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  const four = v4(mapped?.[1] ?? addr);
  if (four) {
    const [a, b] = four as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (!addr.includes(':')) return true; // not an address at all: refused
  if (addr === '::' || addr === '::1') return true;
  const first = parseInt(addr.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7 (fd00:ec2::254 among them)
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 || // multicast ff00::/8
    (first === 0x2001 && addr.startsWith('2001:db8')) // documentation
  );
}

/** Why a push address is refused at registration, or null when it is fine to try. */
export function pushAddressProblem(endpoint: string): 'not_https' | null {
  // An https address with a host: the vault sends nothing any other way.
  return /^https:\/\/[^/?#\s@]+(?:[/?#]|$)/i.test(endpoint.trim()) ? null : 'not_https';
}
