import {
  CHECKLIST_COUNT_MAX,
  CHECKLIST_ITEMS_MAX,
  CHECKLIST_LINE_MAX,
  CHECKLIST_MONTH_NAMES_MAX,
  CHECKLIST_MONTHS_MAX,
  CHECKLIST_TEXT_MAX,
  CHECKLIST_TITLE_WORD_MAX,
  CHECKLIST_TITLE_WORDS_MAX,
  CHECKLIST_YEARS_MAX,
  COLLECTION_AUDIENCES,
  COLLECTION_ITEMS_PAGE_MAX,
} from '@fdv/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import type { Principal } from '../auth/service.js';
import { needs } from '../authz.js';
import type { CollectionService } from './service.js';

/**
 * Collections of documents (5.14). Everybody signed in reads them — a viewer is
 * given none (A17) — and the changes ask `collection.manage` before they read
 * the body, so somebody who may not is told that first. Only a collection's
 * maker changes it (A18): the service says so, once it has found the collection.
 * A delete has no body, and its maker may delete their collection whatever their
 * role now, so the service asks `collection.manage` of anybody else.
 */

// Tidied and measured by the service, which says what is wrong in words.
const collectionBody = z
  .object({
    name: z.string().max(1000),
    description: z.string().max(5000).nullable(),
    audience: z.enum(COLLECTION_AUDIENCES),
  })
  .partial()
  .strict();

const itemsBody = z.object({ document_ids: z.array(z.string().uuid()).min(1).max(200) }).strict();

/** A checklist's item, as the API gives it back and the person changes it (0.9.0, C1). */
const checklistItem = z
  .object({
    line: z.string().max(CHECKLIST_LINE_MAX * 2),
    heading: z
      .string()
      .max(CHECKLIST_LINE_MAX * 2)
      .nullable(),
    type_key: z.string().max(64).nullable(),
    member_id: z.string().uuid().nullable(),
    count: z.number().int().min(1).max(CHECKLIST_COUNT_MAX).nullable(),
    months: z.number().int().min(1).max(CHECKLIST_MONTHS_MAX).nullable(),
    years: z.array(z.number().int().min(1900).max(2100)).max(CHECKLIST_YEARS_MAX),
    current: z.boolean(),
    form: z.string().max(16).nullable(),
    skipped: z.boolean(),
    unresolved: z.enum(['person_unknown', 'person_shared']).nullable().optional(),
    in_months: z
      .array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/))
      .max(CHECKLIST_MONTH_NAMES_MAX)
      .optional(),
    within: z.number().int().min(1).max(CHECKLIST_MONTHS_MAX).nullable().optional(),
    person_choices: z.array(z.string().uuid()).max(20).optional(),
    // What a line is looked for by in titles (0.9.0).
    title_words: z
      .array(z.string().min(1).max(CHECKLIST_TITLE_WORD_MAX))
      .max(CHECKLIST_TITLE_WORDS_MAX)
      .nullable()
      .optional(),
  })
  // What the API answers with beside it (its summary, its matches) is let go.
  .strip();

/** POST /collections/{id}/checklist: a list to read, or items to match again. */
const checklistBody = z.union([
  z.object({ text: z.string().max(CHECKLIST_TEXT_MAX) }).strict(),
  z.object({ items: z.array(checklistItem).max(CHECKLIST_ITEMS_MAX) }).strict(),
]);
const checklistSave = z.object({ items: z.array(checklistItem).max(CHECKLIST_ITEMS_MAX) }).strict();
const checklistAdd = z
  .object({ document_ids: z.array(z.string().uuid()).min(1).max(200) })
  .strict();

const idParam = z.object({ id: z.string().uuid() });
const itemParam = z.object({ id: z.string().uuid(), documentId: z.string().uuid() });

/** A page of a collection's documents, as GET /documents pages its own. */
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(COLLECTION_ITEMS_PAGE_MAX).optional(),
  cursor: z.string().max(512).optional(),
});

export function registerCollections(app: FastifyInstance, collections: CollectionService): void {
  const auth = { preHandler: app.requireAuth };
  const manage = { preHandler: [app.requireAuth, needs('collection.manage')] };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const idOf = (req: FastifyRequest) => parse(idParam, req.params).id;

  app.get('/api/v1/collections', auth, async (req) => ({
    items: await collections.collections(principal(req)),
  }));

  app.post('/api/v1/collections', manage, async (req, reply) => {
    const made = await collections.create(
      principal(req),
      parse(collectionBody, req.body ?? {}),
      metaOf(req),
    );
    reply.header('etag', made.etag);
    return reply.status(201).send(made);
  });

  app.get('/api/v1/collections/:id', auth, async (req, reply) => {
    const collection = await collections.get(
      principal(req),
      idOf(req),
      parse(pageQuery, req.query ?? {}),
    );
    reply.header('etag', collection.etag);
    return collection;
  });

  /**
   * Its name, words or audience, made to the collection as the caller saw it: a
   * stale If-Match is `409 conflict`, with the collection as it now is in `detail`.
   */
  app.patch('/api/v1/collections/:id', manage, async (req, reply) => {
    const ifMatch = req.headers['if-match'];
    const changed = await collections.update(
      principal(req),
      idOf(req),
      parse(collectionBody, req.body ?? {}),
      typeof ifMatch === 'string' ? ifMatch : undefined,
      metaOf(req),
    );
    reply.header('etag', changed.etag);
    return changed;
  });

  app.delete('/api/v1/collections/:id', auth, async (req, reply) => {
    await collections.remove(principal(req), idOf(req), metaOf(req));
    return reply.status(204).send();
  });

  app.post('/api/v1/collections/:id/items', manage, async (req, reply) => {
    const collection = await collections.addItems(
      principal(req),
      idOf(req),
      parse(itemsBody, req.body ?? {}).document_ids,
      metaOf(req),
    );
    reply.header('etag', collection.etag);
    return collection;
  });

  app.delete('/api/v1/collections/:id/items/:documentId', manage, async (req, reply) => {
    const { id, documentId } = parse(itemParam, req.params);
    await collections.removeItem(principal(req), id, documentId, metaOf(req));
    return reply.status(204).send();
  });

  app.get('/api/v1/documents/:id/collections', auth, async (req) => ({
    items: await collections.ofDocument(principal(req), idOf(req)),
  }));

  // ------------------------------------------------- a checklist (0.9.0, C1)

  /** The checklist kept on it, matched again for the reader: the family who see it. */
  app.get('/api/v1/collections/:id/checklist', auth, async (req) =>
    collections.checklists.get(principal(req), idOf(req)),
  );

  /** A list read, or items as the person set them, and matched: nothing is written. */
  app.post('/api/v1/collections/:id/checklist', manage, async (req) =>
    collections.checklists.check(principal(req), idOf(req), parse(checklistBody, req.body ?? {})),
  );

  /** The checklist kept, by the collection's maker. */
  app.put('/api/v1/collections/:id/checklist', manage, async (req) =>
    collections.checklists.save(
      principal(req),
      idOf(req),
      parse(checklistSave, req.body ?? {}).items,
      metaOf(req),
    ),
  );

  /** The documents ticked, put in by the collection's own rules: what was, and what was not. */
  app.post('/api/v1/collections/:id/checklist/add', manage, async (req) =>
    collections.checklists.add(
      principal(req),
      idOf(req),
      parse(checklistAdd, req.body ?? {}).document_ids,
      metaOf(req),
    ),
  );
}
