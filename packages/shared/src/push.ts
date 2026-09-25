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

/** An IPv6 address as its eight 16-bit groups ("::" and a dotted tail undone), or null. */
function v6(ip: string): number[] | null {
  // A zone (fe80::1%eth0) says nothing about where it goes.
  let s = ip.replace(/%.*$/, '');
  let tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const four = v4(dotted[2] as string);
    if (!four) return null;
    const [a = 0, b = 0, c = 0, d = 0] = four;
    tail = [(a << 8) | b, (c << 8) | d];
    const before = dotted[1] as string;
    s = before.endsWith('::') ? before : before.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (h: string | undefined) => (h ? h.split(':') : []);
  const head = groups(halves[0]);
  const rest = groups(halves[1]);
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const n = (g: string) => parseInt(g, 16);
  const count = head.length + rest.length + tail.length;
  if (halves.length === 1) return count === 8 ? [...head.map(n), ...tail] : null;
  // "::" stands for one group at least.
  if (count > 7) return null;
  return [...head.map(n), ...Array<number>(8 - count).fill(0), ...rest.map(n), ...tail];
}

/** The IPv4 ranges a push must not reach. */
function private4(four: number[]): boolean {
  const [a = 0, b = 0] = four;
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

const embedded = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

/**
 * An address a push must not be sent to unless the operator allows it:
 * loopback, private networks, link-local (cloud metadata at 169.254.169.254
 * among them), carrier-grade NAT, "this network", multicast and reserved —
 * for IPv6 too, and an IPv4 address inside an IPv6 one however it is
 * written (`new URL` writes [::ffff:127.0.0.1] as ::ffff:7f00:1). A vault
 * that would send to any of these could be pointed at its own network by
 * whoever registers a device (blind SSRF).
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const four = v4(addr);
  if (four) return private4(four);
  const g = v6(addr);
  if (!g) return true; // not an address at all: refused
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, hi = 0, lo = 0] = g;
  const zeros = a === 0 && b === 0 && c === 0 && d === 0;
  // Judged by the IPv4 address inside: mapped (::ffff:0:0/96), compatible
  // (::/96, where :: and ::1 are), translated (::ffff:0:0:0/96), the NAT64
  // well-known prefix (64:ff9b::/96) and 6to4 (2002::/16).
  if (zeros && e === 0 && (f === 0 || f === 0xffff)) return private4(embedded(hi, lo));
  if (zeros && e === 0xffff && f === 0) return private4(embedded(hi, lo));
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return private4(embedded(hi, lo));
  }
  if (a === 0x2002) return private4(embedded(b, c));
  return (
    a < 0x0100 || // the rest of ::/8, reserved — local-use NAT64 (64:ff9b:1::/48) among it
    (a === 0x0100 && b === 0 && c === 0 && d === 0) || // discard-only 100::/64
    (a === 0x2001 && b === 0x0db8) || // documentation
    (a & 0xfe00) === 0xfc00 || // unique local fc00::/7 (fd00:ec2::254 among them)
    (a & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (a & 0xffc0) === 0xfec0 || // site-local fec0::/10, deprecated
    (a & 0xff00) === 0xff00 // multicast ff00::/8
  );
}

/** Why a push address is refused at registration, or null when it is fine to try. */
export function pushAddressProblem(endpoint: string): 'not_https' | null {
  // An https address with a host: the vault sends nothing any other way.
  return /^https:\/\/[^/?#\s@]+(?:[/?#]|$)/i.test(endpoint.trim()) ? null : 'not_https';
}
