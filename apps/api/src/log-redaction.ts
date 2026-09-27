import type { FastifyRequest } from 'fastify';

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
 * The share routes of 5.16 carry no secret in their paths — the token and
 * the PIN travel in a POST body, the session in a cookie, and the log keeps
 * neither — so their names are kept: /api/v1/shared/preview, /unlock and
 * /items.
 */
const SECRET_SEGMENT =
  /^(\/api\/v1\/(?:shared|password-resets|invitations)\/|\/(?:shared|reset|join)\/)(?!(?:preview|unlock|items)(?:[/?#]|$))[^/?#]+/;

export function loggableUrl(url: string): string {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const cut = path.replace(SECRET_SEGMENT, '$1[redacted]');
  return q === -1 ? cut : `${cut}?[redacted]`;
}

/** Fastify's own request serializer, with the URL made safe to keep. */
export function requestForLog(req: FastifyRequest) {
  return {
    method: req.method,
    url: loggableUrl(req.url),
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}
