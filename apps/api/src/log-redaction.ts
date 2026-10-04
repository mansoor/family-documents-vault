import type { FastifyRequest } from 'fastify';
import { clientAddressOf } from './client-address.js';

/**
 * What the log may say about a request (0.5.0).
 *
 * A share link's token, a password reset's and an invitation's are each the
 * whole secret, and a share's download carries its PIN on the query string:
 * logs get copied into bug reports and shipped to other machines, and a
 * line with a working link in it is a working link. So the path keeps its
 * shape with the secret cut, and no query string is logged at all — one
 * can also carry what somebody searched for.
 *
 * The routes of 5.16 and 5.17 carry no secret in their paths — the token,
 * the PIN and the password travel in a POST body, a share's session in a
 * cookie, and the log keeps none of them — so their names are kept:
 * /api/v1/shared/preview, /unlock and /items; /api/v1/password-resets/lookup
 * and /complete; /api/v1/invitations/lookup and /accept. Only the exact
 * name is kept: a token that merely starts like one is still cut. So is
 * 5.20's /api/v1/shared/code, which sends a code: the token in its body, the
 * code in an email, the address in the vault, and none in the log. No
 * request's headers are logged, so no cookie is either (the session's, or
 * a link's device cookie).
 *
 * So do 5.21's, a sender's (/api/v1/drop/preview, /code, /unlock,
 * /session, /files and /finish): the token, the password and the code in a
 * body, the session in a cookie, a file's name inside the upload. Anything
 * else under /api/v1/drop/, and anything after /drop/ (a token pasted into
 * the path by mistake), is cut the same way.
 */
const kept = (names: string) => `(?!(?:${names})(?:[/?#]|$))`;

const SECRET_SEGMENT = new RegExp(
  '^(' +
    [
      `/api/v1/shared/${kept('preview|unlock|items|code')}`,
      `/api/v1/password-resets/${kept('lookup|complete')}`,
      `/api/v1/invitations/${kept('lookup|accept')}`,
      `/api/v1/drop/${kept('preview|code|unlock|session|files|finish')}`,
      // The pages a browser opens from links made before 0.5.14 (a share's)
      // and 0.5.17 (a reset's, an invitation's); and a request's page with
      // something after it that it never has (5.21).
      `/(?:shared|reset|join|drop)/`,
    ].join('|') +
    ')[^/?#]+',
);

export function loggableUrl(url: string): string {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const cut = path.replace(SECRET_SEGMENT, '$1[redacted]');
  return q === -1 ? cut : `${cut}?[redacted]`;
}

/**
 * What is cut from any log line that carries it, whatever wrote it: the
 * headers @fastify/multipart writes at trace level before it parses an
 * upload (a bearer token, a sender's or a link's session cookie, 5.21), and
 * a request's own headers wherever a line includes them.
 */
export const LOG_REDACTED_PATHS = [
  'busboyOptions.headers',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
];

/** Fastify's own request serializer, with the URL made safe to keep. */
export function requestForLog(req: FastifyRequest) {
  return {
    method: req.method,
    url: loggableUrl(req.url),
    remoteAddress: clientAddressOf(req),
    remotePort: req.socket?.remotePort,
  };
}

/**
 * Anything that looks like an email address: a name, an @, and a domain
 * whose last part is letters. Not a package in a stack trace's path
 * (`pg-boss@10.1.6/…`, `@fdv/db`), which a debugger needs to read.
 */
const ADDRESS = /[^\s@<>"'(),;:[\]/\\]+@[^\s@<>"'(),;:[\]/\\]*\.[A-Za-z][A-Za-z0-9-]*/g;

/** What a logged error may keep of PostgreSQL's fields: names, never values. */
const ERROR_FIELDS = ['code', 'statusCode', 'constraint', 'table', 'column', 'routine', 'severity'];

/**
 * An error as the log may keep it (5.20). An error from the database can
 * carry the row it refused — "Failing row contains (…)" in its `detail`,
 * with an address a share link's code goes to in it — and a mail server's
 * can name the recipient in its message. So an error keeps its kind, its
 * message and stack with any address cut out, and PostgreSQL's names for
 * what failed (constraint, table, column), never its values.
 */
export function errorForLog(err: unknown): Record<string, unknown> {
  const scrub = (s: string) => s.replace(ADDRESS, '[address]');
  if (!(err instanceof Error)) return { message: scrub(String(err)) };
  const e = err as Error & Record<string, unknown>;
  const out: Record<string, unknown> = {
    type: e.constructor?.name ?? 'Error',
    message: scrub(e.message),
  };
  if (typeof e.stack === 'string') out.stack = scrub(e.stack);
  for (const k of ERROR_FIELDS) if (e[k] !== undefined) out[k] = e[k];
  return out;
}
