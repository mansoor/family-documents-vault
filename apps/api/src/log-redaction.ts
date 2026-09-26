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
 */
const SECRET_SEGMENT =
  /^(\/api\/v1\/(?:shared|password-resets|invitations)\/|\/(?:shared|reset|join)\/)[^/?#]+/;

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
