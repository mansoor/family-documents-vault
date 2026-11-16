import { randomBytes } from 'node:crypto';
import type { Db } from '@fdv/db';
import { attachmentDisposition } from '@fdv/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { AuthService, Principal, RequestMeta } from '../auth/service.js';
import type { StepUpAction, StepUpService } from '../auth/step-up.js';
import { ApiError } from '../errors.js';
import { errorForLog } from '../log-redaction.js';
import { zipStream, type ZipAsk, type ZipPlan, type ZipService } from './zip.js';

/**
 * Several documents as one ZIP, for somebody signed in (0.9.0, DL).
 *
 * `POST /documents/download` and `POST /collections/{id}/download` answer
 * the ZIP itself, streamed: for a client that saves a response as it comes
 * (a phone, a script). A browser cannot — a `fetch` holds the whole answer
 * in the tab before it can be saved — so it asks for a **ticket** first
 * (`POST …/download/ticket`, the same body): everything a ZIP would refuse
 * or ask (`404`, `422`, `403 step_up_required`) is answered there, as JSON,
 * with nothing written down; and given one, it follows `GET
 * /downloads/{ticket}` as a plain link, which the browser saves to disk as
 * it comes. A ticket is good once, for a minute, for that request and the
 * session that asked for it: the ZIP is made as that session, asked afresh
 * (signed out, demoted, or no longer fresh since, it is refused), and only
 * then written down. Nothing but a request with the session's bearer token
 * makes one, so another site cannot; the ticket is in the address, which is
 * why it is kept nowhere but in this process's memory, ends at its first
 * use, and its answer is sent with `Referrer-Policy: no-referrer`.
 */

/** How long a ticket waits for its download. */
export const DOWNLOAD_TICKET_MS = 60_000;
/** At most this many waiting at once: past it, the oldest go. */
const TICKETS_MAX = 1_000;

type Asked = { kind: 'selection'; ids: string[] } | { kind: 'collection'; id: string };

interface Ticket {
  bearer: string;
  asked: Asked;
  until: number;
}

/** Tickets waiting for their download, in this process's memory alone. */
export class DownloadTickets {
  private readonly waiting = new Map<string, Ticket>();
  constructor(private readonly now: () => number = Date.now) {}

  make(bearer: string, asked: Asked): { ticket: string; expires_at: string } {
    const now = this.now();
    for (const [k, t] of this.waiting) if (t.until <= now) this.waiting.delete(k);
    while (this.waiting.size >= TICKETS_MAX) {
      const oldest = this.waiting.keys().next().value;
      if (oldest === undefined) break;
      this.waiting.delete(oldest);
    }
    const ticket = randomBytes(32).toString('base64url');
    const until = now + DOWNLOAD_TICKET_MS;
    this.waiting.set(ticket, { bearer, asked, until });
    return { ticket, expires_at: new Date(until).toISOString() };
  }

  /** The ticket, once: taken away as it is read, and nothing once it has run out. */
  take(ticket: string): Ticket | null {
    const found = this.waiting.get(ticket);
    if (!found) return null;
    this.waiting.delete(ticket);
    return found.until > this.now() ? found : null;
  }
}

/** A ticket used, run out or never made: said the same way, so nothing is told apart. */
const ticketGone = () =>
  new ApiError(
    404,
    'download_ticket_gone',
    'This download has expired. Go back and press Download again.',
  );

export function registerZips(
  app: FastifyInstance,
  zips: ZipService,
  auth: Pick<AuthService, 'authenticate'>,
  stepUp?: StepUpService,
  tickets: DownloadTickets = new DownloadTickets(),
): void {
  const signedIn = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  /**
   * Asked in the ZIP's own transaction, once it knows what goes in: a
   * Sensitive document asks `download_sensitive`, an Only me or an
   * Essential one what opening it asks (SEC-17).
   */
  const askOf =
    (p: Principal): ZipAsk =>
    async (action: StepUpAction, trx: Db) => {
      if (stepUp) await stepUp.require(p, action, trx);
    };
  const zipBody = z
    .object({
      // More than a ZIP holds is said so in words (zip_too_large), not here.
      document_ids: z.array(z.string().uuid()).min(1).max(1000),
    })
    .strict();
  const idParam = z.object({ id: z.string().uuid() });

  const planFor = (p: Principal, asked: Asked, meta: RequestMeta, checkOnly = false) =>
    asked.kind === 'selection'
      ? zips.selection(p, asked.ids, askOf(p), meta, { checkOnly })
      : zips.collection(p, asked.id, askOf(p), meta, { checkOnly });

  /** The Documents table's ticked rows, as one ZIP (FND-05). */
  app.post('/api/v1/documents/download', signedIn, async (req, reply) => {
    const body = parse(zipBody, req.body ?? {});
    const plan = await planFor(
      principal(req),
      { kind: 'selection', ids: body.document_ids },
      metaOf(req),
    );
    return sendZip(req, reply, plan);
  });

  /** Every document of a collection the caller is given, as one ZIP. */
  app.post<{ Params: { id: string } }>(
    '/api/v1/collections/:id/download',
    signedIn,
    async (req, reply) => {
      const id = parse(idParam, req.params).id;
      const plan = await planFor(principal(req), { kind: 'collection', id }, metaOf(req));
      return sendZip(req, reply, plan);
    },
  );

  /** A ticket: everything a ZIP would refuse or ask, asked now; nothing written down. */
  const ticketFor = async (req: FastifyRequest, asked: Asked) => {
    await planFor(principal(req), asked, metaOf(req), true);
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const made = tickets.make(bearer, asked);
    return { url: `/api/v1/downloads/${made.ticket}`, expires_at: made.expires_at };
  };

  app.post('/api/v1/documents/download/ticket', signedIn, async (req, reply) => {
    const body = parse(zipBody, req.body ?? {});
    reply.header('cache-control', 'no-store');
    return reply
      .status(201)
      .send(await ticketFor(req, { kind: 'selection', ids: body.document_ids }));
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/collections/:id/download/ticket',
    signedIn,
    async (req, reply) => {
      const id = parse(idParam, req.params).id;
      reply.header('cache-control', 'no-store');
      return reply.status(201).send(await ticketFor(req, { kind: 'collection', id }));
    },
  );

  /**
   * The ZIP a ticket was made for, as a plain link a browser saves as it
   * comes: as the session that asked for it, now.
   */
  app.get<{ Params: { ticket: string } }>('/api/v1/downloads/:ticket', async (req, reply) => {
    const ticket = parse(z.object({ ticket: z.string().min(20).max(100) }), req.params).ticket;
    const found = tickets.take(ticket);
    if (!found) throw ticketGone();
    const p = await auth.authenticate(found.bearer);
    const plan = await planFor(p, found.asked, metaOf(req));
    reply.header('referrer-policy', 'no-referrer');
    return sendZip(req, reply, plan);
  });
}

/**
 * A ZIP, as a browser saves it: streamed, so it has no length. A file that
 * fails part-way ends it, and the operator is told why — never what it held.
 */
export function sendZip(req: FastifyRequest, reply: FastifyReply, plan: ZipPlan) {
  reply.header('content-type', 'application/zip');
  reply.header('content-disposition', attachmentDisposition(plan.filename));
  reply.header('cache-control', 'private, no-store');
  return reply.send(
    zipStream(plan, (err) => req.log.error({ error: errorForLog(err) }, 'a ZIP was not finished')),
  );
}
