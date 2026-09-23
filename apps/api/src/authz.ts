import { can, refusalFor, type Capability } from '@fdv/shared';
import type { Principal } from './auth/service.js';
import { ApiError } from './errors.js';

/**
 * The one way a role is checked (SHR-03).
 *
 * The matrix itself lives in `@fdv/shared/roles` so the web app can hide
 * the buttons the server would refuse. Here it becomes an exception with
 * the refusal the matrix carries, so "no" always arrives as the same shape
 * and the same sentence regardless of which endpoint said it.
 */

export function requireCapability(p: Principal, capability: Capability): void {
  if (!can(p.role, capability)) {
    throw new ApiError(403, 'forbidden', refusalFor(capability));
  }
}

/** For the places where the answer is a filter rather than a refusal. */
export function allows(p: Principal, capability: Capability): boolean {
  return can(p.role, capability);
}

/**
 * The same check as a route hook, for endpoints whose capability does not
 * depend on the body.
 *
 * Order matters: as a `preHandler` this runs before the handler parses the
 * form, so someone who is not allowed to do a thing is told that, rather
 * than being told their form has a mistake in it. The service keeps its
 * own check — this is the polite door, not the lock.
 */
export function needs(capability: Capability) {
  return async (req: { principal: Principal | null }): Promise<void> => {
    if (req.principal) requireCapability(req.principal, capability);
  };
}
