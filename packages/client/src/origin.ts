/**
 * Turning what somebody typed or pasted into the address of a vault.
 *
 * People paste whatever they have: `vault.local`, an IP address, or a link
 * from an invitation or a reset email. The last one carries a secret in its
 * path, so only the origin is kept and the rest is dropped on the floor —
 * never stored, never logged, never sent anywhere.
 *
 * Parsed by hand rather than with `URL`, which React Native has only ever
 * partly implemented.
 */

export interface ServerAddress {
  /** scheme://host[:port], nothing else. */
  origin: string;
  host: string;
  /** True when a path, query or fragment was thrown away. */
  trimmed: boolean;
  /** No scheme was typed; https was assumed. */
  assumedScheme: boolean;
}

const DEFAULT_PORT: Record<string, string> = { http: '80', https: '443' };

export function serverOriginFrom(input: string): ServerAddress | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const typed = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  const scheme = (typed?.[1] ?? 'https').toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') return null;
  const rest = typed ? text.slice(typed[0].length) : text;
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const tail = cut === -1 ? '' : rest.slice(cut);
  // "trusted.example@elsewhere" goes to elsewhere; nobody means that.
  if (!authority || authority.includes('@')) return null;
  const hp = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/i.exec(authority);
  if (!hp) return null;
  const host = (hp[1] as string).toLowerCase();
  if (
    !host.startsWith('[') &&
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)
  ) {
    return null;
  }
  // A host whose last label is a number is an IPv4 address to a browser,
  // which also reads 010 as octal and 0x7f as hex: "010.0.0.1" is
  // 8.0.0.1, a public address that merely looks private. Only plain
  // dotted-decimal is accepted, so what is shown is what is reached.
  if (!host.startsWith('[') && /^(0x[0-9a-f]*|\d+)$/i.test(host.split('.').pop() ?? '')) {
    if (!isDottedDecimal(host)) return null;
  }
  const port = hp[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  const shownPort = port !== undefined && port !== DEFAULT_PORT[scheme] ? `:${Number(port)}` : '';
  return {
    origin: `${scheme}://${host}${shownPort}`,
    host: host.replace(/^\[|\]$/g, ''),
    trimmed: tail.replace(/^\/+$/, '') !== '',
    assumedScheme: !typed,
  };
}

/**
 * Whether a host is on a private network: the only places a vault may be
 * reached over plain http, and where "is this really my vault?" matters
 * most. RFC 1918, carrier-grade NAT (which is where Tailscale lives),
 * loopback, link-local, and the local-only names.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || /\.(local|lan|home\.arpa|localhost)$/.test(h)) return true;
  const v4 = isDottedDecimal(h) ? /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h) : null;
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(':')) {
    return h === '::1' || /^fe[89ab][0-9a-f]:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h);
  }
  return false;
}

/** Four numbers 0–255, written without leading zeros. */
function isDottedDecimal(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}
