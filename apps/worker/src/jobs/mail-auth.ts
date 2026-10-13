/**
 * Whether the household mailbox's provider vouched for a mail's sender
 * (0.8.0, S4): its Authentication-Results header (RFC 8601), read on the
 * mail thread (mail-parse-worker.ts) — never on the worker's own loop — as
 * a mail's every other header is.
 *
 * A sender writes whatever headers they like, an Authentication-Results
 * among them, naming any provider. Only the provider's own counts: the
 * topmost Authentication-Results whose authserv-id is the one the operator
 * set (FDV_MAIL_IN_AUTHSERV_ID). A provider adds its own above everything
 * the mail arrived with, so a forged one with the same id is always below
 * it; one with any other id is never read at all.
 *
 * In it, the mail passes on `dmarc=pass` (for the From's own domain, where
 * it says which), or on `dkim=pass` signed by the From's domain or a domain
 * above it (`header.d`, or `header.i`'s): a signature of the domain the
 * mail says it is from. Anything else — SPF alone, a signature of another
 * domain, nothing from that id — does not.
 */

export type AuthVerdict = 'pass' | 'fail';

/** One header, as mailparser lists them: its name, lower-cased, and its whole line, folded. */
export interface HeaderLine {
  key: string;
  line: string;
}

/** At most this many Authentication-Results headers are looked at, and this long. */
const MAX_HEADERS = 50;
const MAX_LENGTH = 16 * 1024;

/** A header's value: unfolded, its name gone. */
function valueOf(line: string): string {
  const unfolded = line.slice(0, MAX_LENGTH).replace(/\r?\n[ \t]+/g, ' ');
  const colon = unfolded.indexOf(':');
  return colon < 0 ? '' : unfolded.slice(colon + 1);
}

/**
 * The value without its comments (RFC 5322: parenthesised, nested, with
 * quoted pairs), quoted strings kept as they are.
 */
export function withoutComments(v: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i] as string;
    if (c === '\\' && (quoted || depth > 0)) {
      if (depth === 0) out += c + (v[i + 1] ?? '');
      i++;
      continue;
    }
    if (depth === 0 && c === '"') {
      quoted = !quoted;
      out += c;
      continue;
    }
    if (!quoted && c === '(') {
      depth++;
      continue;
    }
    if (!quoted && c === ')' && depth > 0) {
      depth--;
      if (depth === 0) out += ' ';
      continue;
    }
    if (depth === 0) out += c;
  }
  return out;
}

/** Split on a character outside quotes. */
function splitOutside(v: string, at: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i] as string;
    if (c === '\\' && quoted) {
      cur += c + (v[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (!quoted && c === at) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

const unquote = (s: string) =>
  s.startsWith('"') && s.endsWith('"') && s.length >= 2
    ? s.slice(1, -1).replace(/\\(.)/g, '$1')
    : s;

/** One method's result: `dkim=pass header.d=example.com` → method, result and properties. */
export interface AuthResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

/** An Authentication-Results header: who wrote it, and what it says. */
export interface AuthHeader {
  authservId: string;
  results: AuthResult[];
}

/**
 * One Authentication-Results header's value read: its authserv-id and each
 * result. Null when it has no authserv-id (a value starting with a result).
 */
export function parseAuthResults(value: string): AuthHeader | null {
  const parts = splitOutside(withoutComments(value), ';').map((p) => p.trim());
  const first = (parts[0] ?? '').split(/\s+/).filter(Boolean);
  const id = first[0] ? unquote(first[0]) : '';
  if (!id || id.includes('=')) return null;
  const results: AuthResult[] = [];
  for (const part of parts.slice(1)) {
    const tokens = splitOutside(part, ' ')
      .map((t) => t.trim())
      .filter(Boolean);
    const head = tokens[0];
    if (!head) continue;
    const eq = head.indexOf('=');
    if (eq <= 0) continue;
    const method = (head.slice(0, eq).split('/')[0] ?? '').trim().toLowerCase();
    const result = unquote(head.slice(eq + 1).trim()).toLowerCase();
    const props: Record<string, string> = {};
    for (const t of tokens.slice(1)) {
      const e = t.indexOf('=');
      if (e <= 0) continue;
      const k = t.slice(0, e).toLowerCase();
      if (!(k in props)) props[k] = unquote(t.slice(e + 1));
    }
    if (method && result) results.push({ method, result, props });
  }
  return { authservId: id.toLowerCase(), results };
}

/** A domain as it is compared: lower case, no dot at its end. */
const domainOf = (d: string) => d.trim().toLowerCase().replace(/\.$/, '');

/**
 * Whether a signature of `signer` vouches for mail from `from`: the same
 * domain, or one above it (`example.com` for `mail.example.com`) — never a
 * single label, nor one below it.
 */
export function aligned(signer: string, from: string): boolean {
  const d = domainOf(signer);
  const f = domainOf(from);
  if (!d || !f || !d.includes('.')) return false;
  return f === d || f.endsWith(`.${d}`);
}

/**
 * The provider's word on the sender, from the mail's headers in order (top
 * first): `pass` only on the topmost Authentication-Results of `authservId`
 * saying dmarc=pass for the From's domain, or dkim=pass aligned with it.
 */
export function authVerdict(
  lines: readonly HeaderLine[],
  authservId: string,
  fromDomain: string,
): AuthVerdict {
  const want = authservId.trim().toLowerCase();
  if (!want || !fromDomain) return 'fail';
  let looked = 0;
  for (const h of lines) {
    if (h.key !== 'authentication-results') continue;
    if (++looked > MAX_HEADERS) break;
    const parsed = parseAuthResults(valueOf(h.line));
    if (!parsed || parsed.authservId !== want) continue;
    // The provider's own, topmost: the only one read.
    for (const r of parsed.results) {
      if (r.result !== 'pass') continue;
      if (r.method === 'dmarc') {
        const said = r.props['header.from'];
        if (said === undefined || domainOf(said) === domainOf(fromDomain)) return 'pass';
      }
      if (r.method === 'dkim') {
        const d = r.props['header.d'] ?? r.props['header.i']?.split('@').pop();
        if (d && aligned(d, fromDomain)) return 'pass';
      }
    }
    return 'fail';
  }
  return 'fail';
}
