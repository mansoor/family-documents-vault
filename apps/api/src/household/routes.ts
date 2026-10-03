import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { metaOf, parse } from '../auth/routes.js';
import { ApiError, notFound } from '../errors.js';
import type { Principal } from '../auth/service.js';
import {
  memberBody,
  memberEditBody,
  memberEtag,
  profileBody,
  type HouseholdService,
} from './service.js';
import {
  acceptBody,
  acceptByBody,
  inviteBody,
  inviteExistingBody,
  lookupBody,
  type InvitationService,
} from './invitations.js';
import { roleChangeBody, type CoOwnerService } from './co-owners.js';
import type { StepUpService } from '../auth/step-up.js';
import type { Capability } from '@fdv/shared';
import type { MultipartFile } from '@fastify/multipart';
import { needs } from '../authz.js';
import { noPhoto, orderRefusal, parseCrop, photoOrder, type PhotoService } from './photos.js';
import {
  identityAudienceBody,
  identityRevealBody,
  identityWriteBody,
  type IdentityService,
} from './identity.js';

/**
 * A person's photo (5.17c). No step-up — a photo decides nobody's access —
 * and no idempotency key: the newest choice wins.
 */
function registerPhotos(app: FastifyInstance, household: HouseholdService, photos: PhotoService) {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const idParam = z.object({ id: z.string().uuid() });

  /**
   * PUT /members/{id}/photo, multipart: an optional `crop` field (JSON),
   * then the photo as `file`, and nothing else. The person first (404),
   * then who may (403), before a byte of the file is read; then the crop
   * (422), what the bytes are (415) and how many (413), as they arrive.
   */
  app.put('/api/v1/members/:id/photo', auth, async (req, reply) => {
    const p = principal(req);
    const id = parse(idParam, req.params).id;
    // One file, one field: a crop after the file, a second file or any
    // other part is refused, and nothing is kept.
    const parts = req
      .parts({ limits: { fileSize: photos.limit, files: 1, fields: 1, fieldSize: 1024 } })
      [Symbol.asyncIterator]();
    /** A refusal before the photo: the rest is read, to nowhere. */
    const drainRest = async () => {
      for (;;) {
        const next = await parts.next().catch(() => ({ done: true as const, value: undefined }));
        if (next.done) return;
        if (next.value.type === 'file') next.value.file.resume();
      }
    };
    let file: MultipartFile;
    let crop: ReturnType<typeof parseCrop> = null;
    try {
      await photos.mayChange(p, id);
      let next = await parts.next();
      if (!next.done && next.value.type === 'field') {
        if (next.value.fieldname !== 'crop') throw photoOrder();
        crop = parseCrop(next.value.value);
        next = await parts.next();
      }
      if (next.done) throw new ApiError(422, 'validation_failed', 'Choose a photo to send.');
      if (next.value.type !== 'file' || next.value.fieldname !== 'file') {
        if (next.value.type === 'file') next.value.file.resume();
        throw photoOrder();
      }
      file = next.value;
    } catch (err) {
      await drainRest();
      throw orderRefusal(err);
    }
    const theFile = file;
    // The person as the database spells them: the answer is theirs however
    // the address spelled the id (the 5.17c review).
    const memberId = await photos
      .accept(
        p,
        id,
        {
          crop,
          stream: theFile.file,
          truncated: () => theFile.file.truncated,
          // Nothing may follow the photo.
          finished: async () => {
            const after = await parts.next().catch((err: unknown) => {
              throw orderRefusal(err);
            });
            if (after.done) return;
            if (after.value.type === 'file') after.value.file.resume();
            await drainRest();
            throw photoOrder();
          },
        },
        metaOf(req),
      )
      .catch(async (err: unknown) => {
        theFile.file.resume();
        await drainRest();
        throw orderRefusal(err);
      });
    return reply.status(202).send(await household.member(p, memberId));
  });

  app.delete('/api/v1/members/:id/photo', auth, async (req, reply) => {
    await photos.remove(principal(req), parse(idParam, req.params).id, metaOf(req));
    return reply.status(204).send();
  });

  /**
   * The photo itself, with a sign-in, never kept by a cache. Not allowed,
   * no photo, an old id and a seal that does not open all answer the same.
   * Not audited, as a thumbnail is not.
   */
  app.get<{ Params: { id: string; photoId: string } }>(
    '/api/v1/members/:id/photo/:photoId',
    auth,
    async (req, reply) => {
      const got = await photos.photo(principal(req), req.params.id, req.params.photoId);
      if (got === 'unreadable') {
        req.log.warn(
          { member_id: req.params.id, photo_id: req.params.photoId },
          'photo_unreadable',
        );
      }
      if (got === null || got === 'unreadable') throw noPhoto();
      reply.header('content-type', 'image/jpeg');
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');
      return reply.send(got);
    },
  );
}

/**
 * People's identity details (5.26). Who is not given a record is told there
 * is none (404). Showing a masked value asks who is asking: an owner showing
 * another person's, with a passkey or a code and never the password (A54),
 * and an owner with neither is refused it; anybody else, with any
 * credential. Changing who sees them is an owner's, asked the same way.
 */
export function registerIdentity(
  app: FastifyInstance,
  identity: IdentityService,
  stepUp: StepUpService,
): void {
  const auth = { preHandler: app.requireAuth };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const idParam = z.object({ id: z.string().uuid() });

  app.get('/api/v1/members/:id/identity', auth, async (req) =>
    identity.get(principal(req), parse(idParam, req.params).id, metaOf(req)),
  );

  app.put('/api/v1/members/:id/identity', auth, async (req) =>
    identity.put(
      principal(req),
      parse(idParam, req.params).id,
      parse(identityWriteBody, req.body ?? {}),
      metaOf(req),
    ),
  );

  app.post('/api/v1/members/:id/identity/reveal', auth, async (req) => {
    const p = principal(req);
    const id = parse(idParam, req.params).id;
    const body = parse(identityRevealBody, req.body ?? {});
    const part = body.part ?? 'shared';
    // Whose they are first: what is not there for the caller is 404 before
    // anybody is asked to confirm who they are.
    const { self } = await identity.mayReveal(p, id, part);
    if (p.role === 'owner' && !self) await stepUp.requireOwnerPower(p, 'open_identity');
    else await stepUp.require(p, 'reveal_identity');
    return identity.reveal(p, id, part, body.keys, metaOf(req));
  });

  app.get('/api/v1/household/identity-audience', auth, async (req) =>
    identity.audience(principal(req)),
  );

  app.put(
    '/api/v1/household/identity-audience',
    { preHandler: [app.requireAuth, needs('identity.audience')] },
    async (req) => {
      const p = principal(req);
      const body = parse(identityAudienceBody, req.body ?? {});
      await stepUp.requireOwnerPower(p, 'identity_audience');
      return identity.setAudience(p, body.audience, metaOf(req));
    },
  );
}

export function registerHousehold(
  app: FastifyInstance,
  household: HouseholdService,
  stepUp?: StepUpService,
  invitations?: InvitationService,
  coOwners?: CoOwnerService,
  photos?: PhotoService,
): void {
  const auth = { preHandler: app.requireAuth };
  const guard = (c: Capability) => ({ preHandler: [app.requireAuth, needs(c)] });
  const principal = (req: FastifyRequest) => req.principal as Principal;

  if (photos) registerPhotos(app, household, photos);

  app.get('/api/v1/profile', auth, async (req) => household.profile(principal(req)));
  app.put('/api/v1/profile', guard('profile.edit'), async (req) =>
    household.updateProfile(principal(req), parse(profileBody, req.body ?? {}), metaOf(req)),
  );

  app.get('/api/v1/members', auth, async (req) => ({
    items: await household.members(principal(req)),
  }));
  app.post('/api/v1/members', guard('member.add'), async (req, reply) => {
    // Who is in the family decides who can see what, so it asks (SEC-17).
    await stepUp?.require(principal(req), 'change_people');
    const m = await household.addMember(principal(req), parse(memberBody, req.body), metaOf(req));
    return reply.status(201).send(m);
  });

  const params = <T>(schema: z.ZodType<T>, req: FastifyRequest) => parse(schema, req.params);
  const idParam = z.object({ id: z.string().uuid() });

  /**
   * A person's details (5.25): their name, date of birth and relationship,
   * by whoever may change them (A66), and that they have passed away, by an
   * owner who confirms it is them. Made to the person as the caller saw
   * them: If-Match on their `version`; an older one is `409 conflict`.
   */
  app.patch('/api/v1/members/:id', guard('member.edit'), async (req, reply) => {
    const ifMatch = req.headers['if-match'];
    const changed = await household.updateMember(
      principal(req),
      params(idParam, req).id,
      parse(memberEditBody, req.body ?? {}),
      typeof ifMatch === 'string' ? ifMatch : undefined,
      metaOf(req),
    );
    if (changed.version !== null) reply.header('etag', memberEtag(changed.version));
    return changed;
  });

  if (stepUp) {
    /**
     * The owner's view of somebody's sign-in (5.25), read-only. Anybody but
     * an owner is answered as if there were no such page. A new owner power
     * (A54): an owner with only a password is refused it, and any other is
     * asked for a passkey or a code, never the password.
     */
    app.get('/api/v1/members/:id/account', auth, async (req) => {
      const p = principal(req);
      if (p.role !== 'owner') throw notFound();
      const id = params(idParam, req).id;
      await stepUp.requireOwnerPower(p, 'manage_sign_ins');
      return household.account(p, id, metaOf(req));
    });
  }

  if (coOwners) {
    // Who can do what is the most consequential setting in the vault, so
    // every one of these asks for a credential again first (SEC-17).
    app.post('/api/v1/members/:id/role', auth, async (req) => {
      await stepUp?.require(principal(req), 'change_people');
      return coOwners.changeRole(
        principal(req),
        params(idParam, req).id,
        parse(roleChangeBody, req.body).role,
        metaOf(req),
      );
    });

    app.post('/api/v1/me/step-down', auth, async (req) => {
      await stepUp?.require(principal(req), 'change_people');
      return coOwners.stepDown(principal(req), parse(roleChangeBody, req.body).role, metaOf(req));
    });

    app.delete('/api/v1/members/:id/sign-in', auth, async (req, reply) => {
      await stepUp?.require(principal(req), 'change_people');
      await coOwners.removeSignIn(principal(req), params(idParam, req).id, metaOf(req));
      return reply.status(204).send();
    });

    // The way back from the one above: the same account, never a new one.
    app.post('/api/v1/members/:id/sign-in', guard('member.remove'), async (req) => {
      await stepUp?.require(principal(req), 'change_people');
      const body = parse(
        z.object({ role: z.enum(['adult', 'teen', 'viewer']) }).strict(),
        req.body,
      );
      return coOwners.restoreSignIn(
        principal(req),
        params(idParam, req).id,
        body.role,
        metaOf(req),
      );
    });

    // Everyone in the household can see these, including the person a
    // request is about — that is the whole point of the notice period.
    app.get('/api/v1/owner-changes', auth, async (req) => ({
      items: await coOwners.list(principal(req)),
    }));

    app.post('/api/v1/owner-changes/:id/refuse', auth, async (req) => {
      await stepUp?.require(principal(req), 'change_people');
      return coOwners.refuse(principal(req), params(idParam, req).id, metaOf(req));
    });

    app.post('/api/v1/owner-changes/:id/complete', auth, async (req) => {
      await stepUp?.require(principal(req), 'change_people');
      return coOwners.complete(principal(req), params(idParam, req).id, metaOf(req));
    });

    app.delete('/api/v1/owner-changes/:id', auth, async (req, reply) => {
      await coOwners.withdraw(principal(req), params(idParam, req).id, metaOf(req));
      return reply.status(204).send();
    });
  }

  if (!invitations) return;
  // A link secret, not a uuid: base64url of 32 bytes.
  const tokenParam = z.object({ token: z.string().min(16).max(256) });

  app.get('/api/v1/invitations', guard('member.invite'), async (req) => ({
    items: await invitations.list(principal(req)),
  }));

  app.post('/api/v1/invitations', auth, async (req, reply) => {
    await stepUp?.require(principal(req), 'change_people');
    const created = await invitations.create(
      principal(req),
      parse(inviteBody, req.body),
      metaOf(req),
    );
    return reply.status(201).send(created);
  });

  // The spelling the API specification uses, for an existing person.
  app.post('/api/v1/members/:id/invite', auth, async (req, reply) => {
    await stepUp?.require(principal(req), 'change_people');
    const body = parse(inviteExistingBody, req.body);
    const created = await invitations.create(
      principal(req),
      { ...body, member_id: params(idParam, req).id },
      metaOf(req),
    );
    return reply.status(201).send(created);
  });

  app.delete('/api/v1/invitations/:id', guard('member.invite'), async (req, reply) => {
    await invitations.revoke(principal(req), params(idParam, req).id, metaOf(req));
    return reply.status(204).send();
  });

  // The unauthenticated ones: the invitee has no account yet, by
  // definition. All are rate-limited like sign-in, because the link
  // secret and the code are the only things standing in front of them.
  const tight = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  // The link's token in a body, never a path (5.17). A link reads
  // /join#<token>, and no server is sent what follows the #; the page reads
  // it and posts it here. The same answers and refusals as the path forms
  // below.
  app.post('/api/v1/invitations/lookup', tight, async (req) =>
    invitations.preview(parse(lookupBody, req.body ?? {}).token),
  );

  app.post('/api/v1/invitations/accept', tight, async (req, reply) => {
    const { token, ...body } = parse(acceptByBody, req.body ?? {});
    const tokens = await invitations.accept(token, body, metaOf(req));
    return reply.status(201).send(tokens);
  });

  // The path forms, which links made before 0.5.17 (/join/<token>) were
  // looked up and accepted with. They keep working while those links live —
  // seven days, or up to thirty — and are listed in the capability
  // document's `deprecations`, to go in 0.9.0.
  app.get('/api/v1/invitations/:token', tight, async (req) =>
    invitations.preview(params(tokenParam, req).token),
  );

  app.post('/api/v1/invitations/:token/accept', tight, async (req, reply) => {
    const tokens = await invitations.accept(
      params(tokenParam, req).token,
      parse(acceptBody, req.body),
      metaOf(req),
    );
    return reply.status(201).send(tokens);
  });
}
