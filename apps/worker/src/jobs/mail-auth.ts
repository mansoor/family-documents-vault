/**
 * Whether the household mailbox's provider vouched for a mail's sender
 * (0.8.0, S4): its Authentication-Results header (RFC 8601), read on the
 * mail thread (mail-parse-worker.ts) — never on the worker's own loop — as
 * a mail's every other header is.
 *
 * A sender writes whatever headers they like, an Authentication-Results
 * among them, naming any provider. Only the provider's own counts, and it
 * is the first Authentication-Results of all: a provider adds its own above
 * everything the mail arrived with. So the first must carry the id the
 * operator set (FDV_MAIL_IN_AUTHSERV_ID); one with no id, or another's, on
 * top, and nothing passes. Nothing below it is read.
 *
 * It is read strictly (the S4 review, F2): an authserv-id and version,
 * then each result as `method[/version]=result`, an optional
 * `reason=value` straight after it, then `keyword.property=value` (any
 * ptype, registered or `x-`) or a provider's own `keyword=value` (as
 * Fastmail's x-bits=2048), with comments and quoted strings as RFC 5322 has
 * them. Anything else — a stray `)`, an open quote or comment, a word or a
 * quote out of place — and the header says nothing: a sender's own words,
 * quoted into it by the provider (an smtp.mailfrom, say), can never be
 * taken for a result. Only `header.from` and `header.d` decide.
 *
 * In it, a DMARC result decides: exactly one, `pass`, for the From's own
 * domain (`header.from`, required). Without one, a DKIM signature passes
 * only when its `header.d` is exactly the From's domain. SPF alone, a
 * signature of another domain or of a domain above it, nothing at all: no.
 */

export type AuthVerdict = 'pass' | 'fail';

/** One header, as mailparser lists them: its name, lower-cased, and its whole line, folded. */
export interface HeaderLine {
  key: string;
  line: string;
}

const MAX_LENGTH = 16 * 1024;

/** A header's value: unfolded, its name gone. */
function valueOf(line: string): string {
  const unfolded = line.slice(0, MAX_LENGTH).replace(/\r?\n[ \t]+/g, ' ');
  const colon = unfolded.indexOf(':');
  return colon < 0 ? '' : unfolded.slice(colon + 1);
}

/** One method's result: `dkim=pass header.d=example.com` → method, result and properties. */
export interface AuthResult {
  method: string;
  result: string;
  /** `ptype.property` → its value, each once. */
  props: Record<string, string>;
}

/** An Authentication-Results header: who wrote it, and what it says. */
export interface AuthHeader {
  authservId: string;
  results: AuthResult[];
}

class Bad extends Error {}

/** A token's characters (RFC 2045's, less the specials). */
const TOKEN = /[A-Za-z0-9!#$%&'*+\-^_`{|}~.]/;
/** A value's characters besides: a domain's @, and base64's / and =. */
const VALUE = /[A-Za-z0-9!#$%&'*+\-^_`{|}~.@/=:]/;

/**
 * One Authentication-Results header's value read strictly: its authserv-id
 * and each result; null when anything in it is out of the grammar (a stray
 * `)`, an open quote or comment, a word out of place) or it has no id.
 */
export function parseAuthResults(header: string): AuthHeader | null {
  const v = header;
  let i = 0;
  const peek = () => v[i];
  /** Spaces and comments: nested, with quoted pairs; one left open is out of the grammar. */
  const cfws = () => {
    for (;;) {
      const c = v[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        i++;
        continue;
      }
      if (c === '(') {
        let depth = 0;
        do {
          const d = v[i];
          if (d === undefined) throw new Bad('a comment left open');
          if (d === '\\') {
            if (v[i + 1] === undefined) throw new Bad('a quoted pair cut short');
            i += 2;
            continue;
          }
          if (d === '(') depth++;
          else if (d === ')') depth--;
          i++;
        } while (depth > 0);
        continue;
      }
      if (c === ')') throw new Bad('a stray )');
      return;
    }
  };
  const run = (re: RegExp) => {
    const start = i;
    while (v[i] !== undefined && re.test(v[i] as string)) i++;
    return v.slice(start, i);
  };
  const quoted = () => {
    i++; // the opening quote
    let out = '';
    for (;;) {
      const c = v[i];
      if (c === undefined) throw new Bad('a quote left open');
      if (c === '\\') {
        const n = v[i + 1];
        if (n === undefined) throw new Bad('a quoted pair cut short');
        out += n;
        i += 2;
        continue;
      }
      i++;
      if (c === '"') return out;
      out += c;
    }
  };
  /** A value: a token, a quoted string, or a local part (either) @ a domain. */
  const pvalue = (): string => {
    if (peek() === '"') {
      const local = quoted();
      if (peek() === '@') {
        i++;
        const domain = run(TOKEN);
        if (!domain) throw new Bad('an address with no domain');
        return `"${local}"@${domain}`;
      }
      return local;
    }
    const word = run(VALUE);
    if (!word) throw new Bad('a value missing');
    // A quote straight after a word is no property of the grammar's: the
    // property that would follow it fails below, and the header with it.
    return word;
  };
  const expect = (c: string) => {
    if (v[i] !== c) throw new Bad(`${c} expected`);
    i++;
  };

  try {
    cfws();
    const id = peek() === '"' ? quoted() : run(TOKEN);
    if (!id || v[i] === '=') return null;
    cfws();
    // An optional version after the id.
    if (/[0-9]/.test(peek() ?? '')) {
      run(/[0-9]/);
      cfws();
    }
    const results: AuthResult[] = [];
    if (peek() === undefined) return { authservId: id.toLowerCase(), results };
    expect(';');
    cfws();
    // "none": nothing was checked.
    if (v.slice(i, i + 4).toLowerCase() === 'none') {
      i += 4;
      cfws();
      if (peek() !== undefined) throw new Bad('more after none');
      return { authservId: id.toLowerCase(), results };
    }
    for (;;) {
      const method = run(/[A-Za-z0-9_-]/).toLowerCase();
      if (!method) throw new Bad('a method missing');
      cfws();
      if (peek() === '/') {
        i++;
        cfws();
        if (!run(/[0-9]/)) throw new Bad('a version missing');
        cfws();
      }
      expect('=');
      cfws();
      const result = run(/[A-Za-z0-9_-]/).toLowerCase();
      if (!result) throw new Bad('a result missing');
      const props: Record<string, string> = {};
      let first = true;
      for (;;) {
        cfws();
        const c = peek();
        if (c === undefined || c === ';') break;
        // A keyword: `reason` straight after the result (its reasonspec), a
        // registered ptype or an extension one (`x-…`) before `.property=`,
        // or a provider's own `keyword=value` (Fastmail's x-bits=2048).
        const keyword = run(/[A-Za-z0-9_-]/).toLowerCase();
        if (!keyword) throw new Bad('a keyword missing');
        cfws();
        let key: string;
        if (peek() === '.') {
          i++;
          cfws();
          const property = run(/[A-Za-z0-9_-]/).toLowerCase();
          if (!property) throw new Bad('a property missing');
          cfws();
          key = `${keyword}.${property}`;
        } else if (keyword === 'reason' && !first) {
          throw new Bad('a reason out of place');
        } else {
          key = keyword;
        }
        expect('=');
        cfws();
        const got = pvalue();
        if (key in props) throw new Bad('a property twice');
        // A reason, or a provider's own word, is read and set aside: only a
        // `ptype.property` is a property the vault looks at.
        if (key.includes('.')) props[key] = got;
        else props[`\0${key}`] = got;
        first = false;
      }
      for (const k of Object.keys(props)) if (k.startsWith('\0')) delete props[k];
      results.push({ method, result, props });
      if (peek() === undefined) break;
      expect(';');
      cfws();
      if (peek() === undefined) break;
    }
    return { authservId: id.toLowerCase(), results };
  } catch (err) {
    if (err instanceof Bad) return null;
    throw err;
  }
}

/**
 * Whose the first Authentication-Results of all is (0.9.0, O1: Test the
 * mailbox): its authserv-id, lower-cased, read as strictly as the check
 * reads it — null when there is none, or it is out of the grammar.
 */
export function topAuthservId(lines: readonly HeaderLine[]): string | null {
  const first = lines.find((h) => h.key === 'authentication-results');
  if (!first) return null;
  return parseAuthResults(valueOf(first.line))?.authservId ?? null;
}

/** A domain as it is compared: lower case, no dot at its end. */
const domainOf = (d: string) => d.trim().toLowerCase().replace(/\.$/, '');

/**
 * The provider's word on the sender, from the mail's headers in order (top
 * first): `pass` only when the first Authentication-Results of all is the
 * provider's (`authservId`), read whole, and says DMARC passed for the
 * From's domain — or, with no DMARC result, a DKIM signature of exactly
 * that domain.
 */
export function authVerdict(
  lines: readonly HeaderLine[],
  authservId: string,
  fromDomain: string,
): AuthVerdict {
  const want = authservId.trim().toLowerCase();
  const from = domainOf(fromDomain);
  if (!want || !from) return 'fail';
  const first = lines.find((h) => h.key === 'authentication-results');
  if (!first) return 'fail';
  const parsed = parseAuthResults(valueOf(first.line));
  if (!parsed || parsed.authservId !== want) return 'fail';
  const dmarc = parsed.results.filter((r) => r.method === 'dmarc');
  if (dmarc.length > 1) return 'fail';
  const one = dmarc[0];
  if (one) {
    const said = one.props['header.from'];
    return one.result === 'pass' && said !== undefined && domainOf(said) === from ? 'pass' : 'fail';
  }
  for (const r of parsed.results) {
    if (r.method !== 'dkim' || r.result !== 'pass') continue;
    const d = r.props['header.d'];
    if (d !== undefined && domainOf(d) === from) return 'pass';
  }
  return 'fail';
}
