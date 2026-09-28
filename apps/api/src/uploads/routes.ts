import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { ApiError } from '../errors.js';
import {
  createBody,
  DROP_COOKIE_PATH,
  DROP_COOKIE_PREFIX,
  DROP_DEVICE_COOKIE,
  DROP_REQUEST_HEADER,
  dropCookieName,
  dropFinishBody,
  dropTokenBody,
  dropUnlockBody,
  type UploadRequestService,
} from './requests.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The session cookie a sender's call is for. Each request's has its own
 * name (a browser may have two open); the page says which with
 * `X-FDV-Drop-Request` (the `request_id` Open answered), and with one
 * session open it need not say.
 */
export function dropSessionCookie(req: FastifyRequest): string | undefined {
  const wanted = req.headers[DROP_REQUEST_HEADER];
  if (typeof wanted === 'string') {
    return UUID.test(wanted) ? req.cookies[dropCookieName(wanted)] : undefined;
  }
  const open = Object.entries(req.cookies).filter(
    ([name, value]) => name.startsWith(DROP_COOKIE_PREFIX) && value,
  );
  return open.length === 1 ? open[0]?.[1] : undefined;
}

/**
 * Asking somebody to send documents (5.21): the family's routes, and the
 * public ones a sender's page calls (`/api/v1/drop/*`, on the public-only
 * site). The token travels in a body, never a path; Open gives a cookie for
 * this path alone, whose hash is all the vault keeps. Nothing a sender sends
 * — the token, a password, a code, a file's name — is in a path, so none of
 * it reaches a log line (log-redaction.ts).
 */
export function registerUploads(app: FastifyInstance, uploads: UploadRequestService) {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const idParam = z.object({ id: z.string().uuid() });

  // ------------------------------------------------------------ the family
  // A teen or a viewer is answered as if none of this existed (404).

  app.post('/api/v1/upload-requests', auth, async (req, reply) => {
    const created = await uploads.create(
      principal(req),
      parse(createBody, req.body ?? {}),
      metaOf(req),
    );
    return reply.status(201).send(created);
  });

  app.get('/api/v1/upload-requests', auth, async (req) => ({
    items: await uploads.list(principal(req)),
    // Whether an emailed code can be offered: only with operator mail (A21).
    email_code_available: uploads.emailCodeAvailable,
  }));

  app.delete<{ Params: { id: string } }>(
    '/api/v1/upload-requests/:id',
    auth,
    async (req, reply) => {
      await uploads.revoke(principal(req), parse(idParam, req.params).id, metaOf(req));
      return reply.status(204).send();
    },
  );

  /** After a restore (A55): an owner turns a paused request back on. */
  app.post<{ Params: { id: string } }>('/api/v1/upload-requests/:id/resume', auth, async (req) =>
    uploads.resume(principal(req), parse(idParam, req.params).id, metaOf(req)),
  );

  // ------------------------------------------------------------ the sender
  // Nobody signs in for these. Opening one is 20 tries a minute from an
  // address (the preview, a code, Open), as a share link's, and so is
  // sending a file (a request takes 10 at most); inside an opened one,
  // anything else is 120 requests a minute. FDV_RATE_LIMIT_PER_MINUTE is the
  // ceiling above both.
  const tight = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const inSession = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.post('/api/v1/drop/preview', tight, async (req) =>
    uploads.preview(parse(dropTokenBody, req.body ?? {}).token),
  );

  app.post('/api/v1/drop/code', tight, async (req) =>
    uploads.sendCode(parse(dropTokenBody, req.body ?? {}).token, metaOf(req)),
  );

  const cookieOptions = (maxAge: number) => ({
    path: DROP_COOKIE_PATH,
    httpOnly: true,
    // Always: browsers keep a Secure cookie from http://localhost, and a
    // vault outsiders reach is reached over https (the public-only site).
    secure: true,
    sameSite: 'strict' as const,
    maxAge,
  });

  app.post('/api/v1/drop/unlock', tight, async (req, reply) => {
    const opened = await uploads.unlock(
      parse(dropUnlockBody, req.body ?? {}),
      req.cookies[DROP_DEVICE_COOKIE],
      metaOf(req),
    );
    void reply.setCookie(opened.cookieName, opened.cookie, cookieOptions(opened.maxAge));
    // One device cookie serves every request a browser opens, so a second
    // never unbinds the first: made once, and its life renewed by every
    // Open that uses it, so it outlives each request bound to it.
    if (opened.device) {
      void reply.setCookie(
        DROP_DEVICE_COOKIE,
        opened.device.cookie,
        cookieOptions(opened.device.maxAge),
      );
    }
    return opened.session;
  });

  app.get('/api/v1/drop/session', inSession, async (req) =>
    uploads.session(dropSessionCookie(req)),
  );

  /**
   * One file, multipart: an optional `item_id` field (which of the things
   * asked for it is), then the file as `file`, and nothing else. The session
   * is checked before a byte is read, and the file's room is reserved by
   * the upload's own length.
   */
  app.post('/api/v1/drop/files', tight, async (req, reply) => {
    const cookie = dropSessionCookie(req);
    const length = Number(req.headers['content-length']);
    const parts = req
      .parts({
        limits: { fileSize: uploads.maxFileBytes, files: 1, fields: 1, fieldSize: 64 },
      })
      [Symbol.asyncIterator]();
    const drainRest = async () => {
      for (;;) {
        const next = await parts.next().catch(() => ({ done: true as const, value: undefined }));
        if (next.done) return;
        if (next.value.type === 'file') next.value.file.resume();
      }
    };
    const order = () =>
      new ApiError(422, 'validation_failed', 'Send one file, named file, and nothing after it.');
    let file: MultipartFile;
    let itemId: string | null = null;
    try {
      await uploads.mayAdd(cookie);
      let next = await parts.next();
      if (!next.done && next.value.type === 'field') {
        if (next.value.fieldname !== 'item_id') throw order();
        itemId = parse(z.string().uuid(), next.value.value);
        next = await parts.next();
      }
      if (next.done) throw new ApiError(422, 'validation_failed', 'Choose a file to send.');
      if (next.value.type !== 'file' || next.value.fieldname !== 'file') {
        if (next.value.type === 'file') next.value.file.resume();
        throw order();
      }
      file = next.value;
    } catch (err) {
      // Answered now, the rest read to nowhere as it comes: a refusal does
      // not wait for a body a sender is still sending, or holding open.
      void drainRest();
      throw limitRefusal(err, order);
    }
    const theFile = file;
    const sent = await uploads
      .addFile(cookie, {
        filename: theFile.filename,
        stream: theFile.file,
        itemId,
        declaredBytes: Number.isSafeInteger(length) && length > 0 ? length : null,
        truncated: () => theFile.file.truncated,
        finished: async () => {
          const after = await parts.next().catch((err: unknown) => {
            throw limitRefusal(err, order);
          });
          if (after.done) return;
          if (after.value.type === 'file') after.value.file.resume();
          await drainRest();
          throw order();
        },
      })
      .catch((err: unknown) => {
        theFile.file.resume();
        void drainRest();
        throw limitRefusal(err, order);
      });
    return reply.status(201).send(sent);
  });

  app.delete<{ Params: { id: string } }>(
    '/api/v1/drop/files/:id',
    inSession,
    async (req, reply) => {
      await uploads.removeFile(dropSessionCookie(req), parse(idParam, req.params).id);
      return reply.status(204).send();
    },
  );

  app.post('/api/v1/drop/finish', inSession, async (req) =>
    uploads.finish(dropSessionCookie(req), parse(dropFinishBody, req.body ?? {}), metaOf(req)),
  );
}

/** The parser's own limits (a second file, a second field) are the order's refusal. */
function limitRefusal(err: unknown, order: () => ApiError): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'FST_FILES_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT'
    ? order()
    : err;
}
