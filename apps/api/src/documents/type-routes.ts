import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { needs } from '../authz.js';
import type { TypeService } from './types.js';

/**
 * Kinds of document, managed (5.11). GET /document-types and
 * GET /document-attributes, which everybody reads, are with the documents
 * (routes.ts); these change them, and ask `types.manage` before they read
 * the body, so somebody who may not is told that first.
 */

const label = z.string().max(200);

const coreRule = z
  .object({ shown: z.boolean(), required: z.boolean(), label: label.nullable() })
  .partial()
  .strict();

const typeBody = z
  .object({
    label,
    category: z.string().max(64),
    short_label: label.nullable(),
    issuer_noun: label.nullable(),
    core: z
      .object({
        identifier: coreRule,
        issued_by: coreRule,
        issued: coreRule,
        expires: coreRule,
        physical_location: coreRule,
        tags: coreRule,
        notes: coreRule,
      })
      .partial()
      .strict(),
    fields: z
      .array(
        z
          .object({
            key: z.string().min(1).max(64),
            label: label.optional(),
            required: z.boolean().optional(),
          })
          .strict(),
      )
      .max(40),
    // Days before it expires, up to ten years; eight at most.
    reminder_leads: z.array(z.number().int().min(0).max(3650)).max(8),
    default_visibility: z.enum(['household', 'adults', 'private']),
    usually_essential: z.boolean(),
    hidden: z.boolean(),
  })
  .partial()
  .strict();

const attributeBody = z
  .object({
    label,
    kind: z.enum(['text', 'long_text', 'date', 'year', 'number', 'money', 'choice', 'yes_no']),
    choices: z.array(label).max(50).nullable().optional(),
  })
  .strict();

const keyParam = z.object({ key: z.string().min(1).max(64) });

export function registerTypes(app: FastifyInstance, types: TypeService): void {
  const manage = { preHandler: [app.requireAuth, needs('types.manage')] };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const keyOf = (req: FastifyRequest) => parse(keyParam, req.params).key;

  app.post('/api/v1/document-types', manage, async (req, reply) => {
    const made = await types.create(principal(req), parse(typeBody, req.body ?? {}), metaOf(req));
    if (made.etag) reply.header('etag', made.etag);
    return reply.status(201).send(made);
  });

  /**
   * A change, made to the kind as the caller saw it: a stale If-Match is
   * `409 conflict`, with the kind as it now is in `detail`. Letting more
   * people see it by default asks an owner to confirm it is them
   * (`403 step_up_required`, action `widen_type_visibility`).
   */
  app.patch('/api/v1/document-types/:key', manage, async (req, reply) => {
    const ifMatch = req.headers['if-match'];
    const changed = await types.update(
      principal(req),
      keyOf(req),
      parse(typeBody, req.body ?? {}),
      typeof ifMatch === 'string' ? ifMatch : undefined,
      metaOf(req),
    );
    if (changed.etag) reply.header('etag', changed.etag);
    return changed;
  });

  app.post('/api/v1/document-types/:key/archive', manage, async (req) =>
    types.archive(principal(req), keyOf(req), metaOf(req)),
  );

  app.post('/api/v1/document-types/:key/restore', manage, async (req) =>
    types.restore(principal(req), keyOf(req), metaOf(req)),
  );

  app.delete('/api/v1/document-types/:key', manage, async (req, reply) => {
    await types.remove(principal(req), keyOf(req), metaOf(req));
    return reply.status(204).send();
  });

  app.get('/api/v1/document-types/:key/impact', manage, async (req) =>
    types.impact(principal(req), keyOf(req)),
  );

  app.post('/api/v1/document-attributes', manage, async (req, reply) =>
    reply
      .status(201)
      .send(
        await types.createAttribute(
          principal(req),
          parse(attributeBody, req.body ?? {}),
          metaOf(req),
        ),
      ),
  );
}
