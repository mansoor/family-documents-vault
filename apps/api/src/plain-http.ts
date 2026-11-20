import { isIP } from 'node:net';

/**
 * Whether FDV_BASE_URL says the vault is reached over plain http from
 * another machine: then every password, sign-in token and document crosses
 * the network unencrypted, readable by anybody on the same Wi-Fi. Said once,
 * plainly, as the API starts. On this machine alone — localhost, 127.0.0.1,
 * ::1 — browsers treat http as secure and nothing crosses a network. Over
 * Tailscale — a 100.64.0.0/10 address, or a name under ts.net — what crosses
 * the network is already encrypted by Tailscale itself, so nothing is said.
 */
export function plainHttpWarning(baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  if (isIP(host) === 4 && host.startsWith('127.')) return null;
  if (host === '::1') return null;
  // Tailscale: its addresses (100.64.0.0/10) and its MagicDNS names.
  if (host.endsWith('.ts.net')) return null;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 100 && (b ?? 0) >= 64 && (b ?? 0) <= 127) return null;
  }
  return (
    `FDV_BASE_URL is ${u.origin}, plain http to another machine, and not over Tailscale: passwords, sign-in tokens ` +
    'and documents cross the network unencrypted. Reach the vault over HTTPS instead — ' +
    'Tailscale, or the bundled Caddy (docker-compose.tls.yml) — and set FDV_BASE_URL to ' +
    'its https:// address. See "Security checklist" in the README.'
  );
}
