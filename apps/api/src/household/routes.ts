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
import { lockBody, type LockService } from './locks.js';
import { ownerResetBody, type OwnerResetService } from './owner-resets.js';
import {
  identityAudienceBody,
  identityRevealBody,
  identityWriteBody,
  type IdentityService,
} from './identity.js';
import {
  accessPreviewQuery,
  accessPutBody,
  grantOf,
  type RestrictionService,
} from './restrictions.js';
import { renewBody, type GuestService } from './guests.js';

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
 * is none (404). Showing a masked value asks who is asking: another person's,
 * with a passkey or a code and never the password, whoever asks — somebody
 * with neither is refused it; one's own, with any credential. Changing who
 * sees them is an owner's, asked with a passkey or a code (A54).
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
    // Somebody else's numbers: a passkey or a code, whoever asks (the 5.26
    // review). One's own: any credential.
    if (!self) await stepUp.requireFactor(p, 'open_identity');
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

/**
 * Locking a sign-in (5.28): owners only (A52), and an owner power (A54) —
 * an owner with only a password is refused it, and any other is asked for a
 * passkey or a code, never the password. What is sent is checked first
 * (422), then who is asking, then whom it is about (404, 409). Turning a
 * sign-in back on after a restore asks the same.
 */
export function registerLocks(app: FastifyInstance, locks: LockService, stepUp: StepUpService) {
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const idParam = z.object({ id: z.string().uuid() });
  const guard = (c: Capability) => ({ preHandler: [app.requireAuth, needs(c)] });

  app.post('/api/v1/members/:id/lock', guard('member.suspend'), async (req) => {
    const p = principal(req);
    const id = parse(idParam, req.params).id;
    const body = parse(lockBody, req.body ?? {});
    await stepUp.requireOwnerPower(p, 'manage_sign_ins');
    return locks.lock(p, id, body, metaOf(req));
  });

  app.delete('/api/v1/members/:id/lock', guard('member.suspend'), async (req, reply) => {
    const p = principal(req);
    const id = parse(idParam, req.params).id;
    await stepUp.requireOwnerPower(p, 'manage_sign_ins');
    await locks.unlock(p, id, metaOf(req));
    return reply.status(204).send();
  });

  app.post('/api/v1/members/:id/resume', guard('restore.review'), async (req, reply) => {
    const p = principal(req);
    const id = parse(idParam, req.params).id;
    await stepUp.requireOwnerPower(p, 'manage_sign_ins');
    await locks.resume(p, id, metaOf(req));
    return reply.status(204).send();
  });

  // Signing somebody out everywhere (5.30, A53): asked as a lock is. A
  // co-owner too, who is told; oneself, every device but this one.
  app.delete('/api/v1/members/:id/sessions', guard('member.sign_out'), async (req) => {
    const p = principal(req);
    const id = parse(idParam, req.params).id;
    await stepUp.requireOwnerPower(p, 'manage_sign_ins');
    return locks.signOutEverywhere(p, id, metaOf(req));
  });
}

/**
 * A password reset an owner starts (5.29): owners only, and an owner power
 * (A54) asked as a lock is — an owner with only a password is refused it,
 * and any other is asked for a passkey or a code, never the password. What
 * is sent is checked first (422), then who is asking, then whom it is about
 * (404, 409).
 */
export function registerOwnerResets(
  app: FastifyInstance,
  resets: OwnerResetService,
  stepUp: StepUpService,
) {
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const idParam = z.object({ id: z.string().uuid() });

  app.post(
    '/api/v1/members/:id/password-reset',
    { preHandler: [app.requireAuth, needs('member.reset_password')] },
    async (req) => {
      const p = principal(req);
      const id = parse(idParam, req.params).id;
      const body = parse(ownerResetBody, req.body ?? {});
      await stepUp.requireOwnerPower(p, 'manage_sign_ins');
      return resets.start(p, id, body, metaOf(req));
    },
  );
}

/**
 * What a viewer can see, limited by an owner (5.33, D6, A56–A59). Changing
 * it is an owner power (A54). Refused in this order, by the fake vault and
 * the api-changelog too (the 5.33 review, L533-06): anybody but an owner
 * `403 forbidden`; a body of the wrong shape `422`; no passkey or code
 * within five minutes `403` (`totp_required_for_owner`, `step_up_required`
 * with `limit_access`); nobody of the family `404`; anybody but a viewer
 * `409 not_a_viewer`; what the grant names `422` (people, kinds,
 * collections of the family, a collection for Everyone, an end in the
 * future or the one it has); somebody who keeps Only me documents `409
 * confirm_private`. Confirming it after their sign-in was given back is
 * putting the same grant again.
 *
 * The preview counts a grant not yet saved: an owner's, or an adult's
 * inviting a viewer (A27). `/access/preview`, with no person, is for
 * somebody not yet in the family. Whether somebody keeps Only me documents
 * is said only to an owner who gave a passkey or a code within five
 * minutes (S533-05).
 */
export function registerAccess(
  app: FastifyInstance,
  restrictions: RestrictionService,
  stepUp: StepUpService,
  guests?: GuestService,
): void {
  const auth = { preHandler: app.requireAuth };
  const owners = { preHandler: [app.requireAuth, needs('role.change')] };
  const principal = (req: FastifyRequest) => req.principal as Principal;
  const idParam = z.object({ id: z.string().uuid() });

  /**
   * A guest's sign-in renewed (5.34, A28): owners only (`403 forbidden`); a
   * body of the wrong shape `422`; an owner power (A54) — `403
   * totp_required_for_owner`, or `step_up_required` with `renew_guest`, a
   * passkey or a code; an end not in the future, or more than a year away,
   * `422`; nobody with a sign-in `404`; somebody of the family `409
   * not_a_guest`.
   */
  if (guests) {
    // A guest who never signed in, removed (the 5.34 review): owners, asked
    // as taking a sign-in away is (change_people).
    app.delete(
      '/api/v1/members/:id',
      { preHandler: [app.requireAuth, needs('member.remove')] },
      async (req, reply) => {
        const p = principal(req);
        const id = parse(idParam, req.params).id;
        await stepUp.require(p, 'change_people');
        await guests.remove(p, id, metaOf(req));
        return reply.status(204).send();
      },
    );

    app.post('/api/v1/members/:id/renew', owners, async (req) => {
      const p = principal(req);
      const id = parse(idParam, req.params).id;
      const body = parse(renewBody, req.body ?? {});
      await stepUp.requireOwnerPower(p, 'renew_guest');
      return guests.renew(p, id, new Date(body.access_expires_at), metaOf(req));
    });
  }

  app.put('/api/v1/members/:id/access', owners, async (req) => {
    const p = principal(req);
    const id = parse(idParam, req.params).id;
    const { confirm_private, ...body } = parse(accessPutBody, req.body ?? {});
    await stepUp.requireOwnerPower(p, 'limit_access');
    const done = await restrictions.restrict(p, id, grantOf(body), {
      confirmPrivate: confirm_private === true,
      meta: metaOf(req),
    });
    return restrictions.access(p, done.member_id);
  });

  app.delete('/api/v1/members/:id/access', owners, async (req, reply) => {
    const p = principal(req);
    const id = parse(idParam, req.params).id;
    await stepUp.requireOwnerPower(p, 'limit_access');
    await restrictions.remove(p, id, metaOf(req));
    return reply.status(204).send();
  });

  app.get('/api/v1/members/:id/access/preview', auth, async (req) => {
    const p = principal(req);
    const id = parse(idParam, req.params).id;
    const query = parse(accessPreviewQuery, req.query ?? {});
    const tellPrivate = p.role === 'owner' && (await stepUp.factorFresh(p));
    return restrictions.preview(p, id, grantOf(query), { tellPrivate });
  });

  app.get('/api/v1/access/preview', auth, async (req) => {
    const query = parse(accessPreviewQuery, req.query ?? {});
    return restrictions.preview(principal(req), null, grantOf(query));
  });
}

export function registerHousehold(
  app: FastifyInstance,
  household: HouseholdService,
  stepUp?: StepUpService,
  invitations?: InvitationService,
  coOwners?: CoOwnerService,
  photos?: PhotoService,
  restrictions?: RestrictionService,
): void {
  const auth = { preHandler: app.requireAuth };
  const guard = (c: Capability) => ({ preHandler: [app.requireAuth, needs(c)] });
  const principal = (req: FastifyRequest) => req.principal as Principal;

  if (photos) registerPhotos(app, household, photos);

  app.get('/api/v1/profile', auth, async (req) => household.profile(principal(req)));
  app.put('/api/v1/profile', guard('profile.edit'), async (req) =>
    household.updateProfile(principal(req), parse(profileBody, req.body ?? {}), metaOf(req)),
  );

  // The family (5.34: a guest never among them, but for themselves); an
  // owner lists the people outside the family with ?kind=guest.
  const membersQuery = z.object({ kind: z.enum(['family', 'guest']).optional() });
  app.get('/api/v1/members', auth, async (req) => {
    const { kind } = parse(membersQuery, req.query ?? {});
    return {
      items: await household.members(principal(req), kind === 'guest' ? 'guests' : 'family'),
    };
  });
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
      const account = await household.account(p, id, metaOf(req));
      // A viewer's limits (5.33): what the card changes, with the same step-up.
      if (!restrictions) return account;
      return {
        ...account,
        // A guest's too (5.34): a viewer, always limited.
        access: account.role === 'viewer' ? await restrictions.access(p, account.member_id) : null,
      };
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
    // A guest's comes back with a new end (5.34, A28), renewed as a guest's
    // sign-in is: with a passkey or a code (`renew_guest`).
    app.post('/api/v1/members/:id/sign-in', guard('member.remove'), async (req) => {
      const p = principal(req);
      const id = params(idParam, req).id;
      const body = parse(
        z
          .object({
            role: z.enum(['adult', 'teen', 'viewer']),
            access_expires_at: z.string().datetime({ offset: true }).optional(),
          })
          .strict(),
        req.body,
      );
      // A guest's is asked as renewing is, and first: a passkey or a code
      // counts for the ordinary step-up too, so one confirmation is enough
      // (the 5.34 review, N534W-01), as an owner's invitation is asked.
      if (stepUp && (body.access_expires_at || (await coOwners.isGuest(p, id)))) {
        await stepUp.requireOwnerPower(p, 'renew_guest');
      }
      await stepUp?.require(p, 'change_people');
      return coOwners.restoreSignIn(
        p,
        id,
        body.role,
        metaOf(req),
        body.access_expires_at ? new Date(body.access_expires_at) : null,
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

  // An owner's decision about what a viewer sees (5.34, A27, D6, A54): a
  // viewer who sees every family document, Adults only documents for a
  // viewer or a guest, limits replacing those set on the person — asked
  // with a passkey or a code, never the password, as limiting is.
  const ownerDecides = (p: Principal) =>
    stepUp ? { ownerDecides: () => stepUp.requireOwnerPower(p, 'limit_access') } : {};

  // Asked once (the 5.34 review, W534-02): an owner's decision asks for a
  // passkey or a code first, which serves the ordinary step-up too, so a
  // browser is not asked for the password and then for a code.
  const invite = async (p: Principal, body: z.infer<typeof inviteBody>, req: FastifyRequest) => {
    if (stepUp && (await invitations.asksOwnerDecision(p, body))) {
      await stepUp.requireOwnerPower(p, 'limit_access');
    }
    await stepUp?.require(p, 'change_people');
    return invitations.create(p, body, metaOf(req), ownerDecides(p));
  };

  app.post('/api/v1/invitations', auth, async (req, reply) => {
    const created = await invite(principal(req), parse(inviteBody, req.body), req);
    return reply.status(201).send(created);
  });

  // The spelling the API specification uses, for an existing person.
  app.post('/api/v1/members/:id/invite', auth, async (req, reply) => {
    const body = parse(inviteExistingBody, req.body);
    const created = await invite(
      principal(req),
      { ...body, member_id: params(idParam, req).id },
      req,
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
