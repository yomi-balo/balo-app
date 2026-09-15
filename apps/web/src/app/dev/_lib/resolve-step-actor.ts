import 'server-only';

import { usersRepository, type ProjectRequestWithRelations } from '@balo/db';
import { buildImpersonatedSessionUser } from '@/lib/auth/impersonation-target';
import type { SessionUser } from '@/lib/auth/session';

/**
 * BAL-275 §5.2 — build the `SessionUser` the fast-forward hands to an extracted core in place of
 * the real caller, for the two non-staff parties a spine step can require (the client, the
 * expert). `markThreadRead`'s "either party" need is served by calling {@link resolveClientActor}
 * or {@link resolveExpertActor} directly, whichever side the operator picked.
 *
 * REUSES `buildImpersonatedSessionUser` (`@/lib/auth/impersonation-target`) UNCHANGED — it is
 * the only place in the codebase that builds a `SessionUser` for a user other than the
 * authenticated one, it seals only the target's own real DB values, and it copies exactly the
 * four display fields a session needs (never `workosId`/`phone`). Do not modify it. Do not copy
 * it — a second implementation of "build a SessionUser for someone else" is exactly the
 * duplication BAL-553 already paid down once.
 *
 * ⚠⚠ `isImpersonating` IS DELIBERATELY NEVER SET on the returned actor, because
 * `buildImpersonatedSessionUser` itself never sets it (see its own docblock: "this file only
 * builds an ordinary, unmarked `SessionUser`"). That is correct here, not merely inherited: that
 * flag means "a BROWSER SESSION is impersonating a target", and the fast-forward has no browser
 * session for the derived actor at all — it calls a core function in-process, once, for the
 * duration of one Server Action invocation, and nothing about that state survives past the
 * `return`. Setting `isImpersonating: true` on a value that is never sealed into a cookie would
 * be a lie about what happened, and worse, a LIVE one: `requireBillingActor()` and the other
 * impersonation refusal seams (BAL-528) key off that flag to refuse money-moving actions under a
 * real impersonated session — flipping it here for a derived actor that was never impersonating
 * anyone would either wrongly refuse (if any of these five cores ever grew a billing check) or,
 * if a reviewer "fixed" that by teaching those seams to ignore it, quietly widen a security
 * boundary this ticket has no business touching. Leave it unset.
 */

export type ActorResolution = { ok: true; user: SessionUser } | { ok: false; error: string };

const ROW_NOT_FOUND = "That party's user row could not be loaded.";
const CANNOT_BUILD_SESSION =
  'Could not build a session for that party — they may be soft-deleted, inactive, or have no derivable workspace.';
const NOT_ONBOARDED = 'That party has not completed onboarding.';

/**
 * The shared resolution: load the party's row, build their (unmarked) `SessionUser`, then
 * RE-ASSERT `requireOnboardedUser()`'s own predicate on the DERIVED actor
 * (`user.onboardingCompleted !== true` — the exact check in `@/lib/auth/session.ts`). That last
 * step is what makes the fast-forward STRICTER THAN OR EQUAL TO production at every step: it
 * never skips a gate the real action's authentication step would have applied, it re-runs it.
 */
async function resolveActorForUserId(userId: string): Promise<ActorResolution> {
  const row = await usersRepository.findForSessionSync(userId);
  if (row === null) {
    return { ok: false, error: ROW_NOT_FOUND };
  }

  const user = await buildImpersonatedSessionUser(userId, row);
  if (user === null) {
    return { ok: false, error: CANNOT_BUILD_SESSION };
  }

  if (user.onboardingCompleted !== true) {
    return { ok: false, error: NOT_ONBOARDED };
  }

  return { ok: true, user };
}

/** The client party on a request: `projectRequests.createdByUserId`. */
export async function resolveClientActor(
  request: ProjectRequestWithRelations
): Promise<ActorResolution> {
  return resolveActorForUserId(request.createdByUserId);
}

/** The expert party on one track: `relationship.expertProfile.user.id` — already on the hydrated graph. */
export async function resolveExpertActor(
  relationship: ProjectRequestWithRelations['relationships'][number]
): Promise<ActorResolution> {
  return resolveActorForUserId(relationship.expertProfile.user.id);
}
