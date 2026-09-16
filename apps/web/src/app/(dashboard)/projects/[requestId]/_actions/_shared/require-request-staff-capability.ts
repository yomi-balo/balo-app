import 'server-only';

import { getCurrentUser, type SessionUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { actorHoldsPlatformCapability } from '@/lib/authz/live-platform-capability';
import { log } from '@/lib/logging';

/**
 * BAL-558 — THE `projects/[requestId]/_actions` STAFF-GATE IDIOM, in one place.
 *
 * (a) WHY A SHARED HELPER RATHER THAN INLINING THE GATE IN EACH OF THE SIX MUTATING ACTIONS.
 * Measured, not guessed: the inlined variant of the six actions was generated in the
 * architecture scratchpad and run through `jscpd --min-tokens 100 --format typescript` — SonarCloud's
 * own new-code duplication threshold. Result: 5 clones of 118-136 tokens, 93 duplicated lines,
 * almost all new code, against a gate of <3% new-code duplication. The in-repo precedent hit the
 * same wall: `admin/applications/_actions/_shared/require-application-reviewer.ts` exists, in its
 * own words, "so the two actions do not ship a byte-identical 20-line preamble into the
 * SonarCloud new-code duplication gate" — for two callers. This ticket has six.
 *
 * (b) WHY `getCurrentUser()` AND NOT `requireOnboardedUser()`. The removed `requireAdmin()`
 * never checked onboarding, and this ticket's job is a capability-axis migration, not a
 * narrowing of who can act — an onboarding gate here would refuse a staff member the old helper
 * admitted.
 *
 * (c) WHY THE `try`. The removed `requireAdmin()` sat inside each action's own `try` block, so a
 * throwing session read fell through to that action's generic denial rather than an unhandled
 * rejection. This helper preserves that: a thrown session read is caught HERE and denied, so
 * every caller inherits the same fail-closed behaviour without repeating the `try`.
 *
 * (d) THE SESSION GATE ABOVE IS **NOT** A REVOCATION BOUNDARY — the live gate below is (BAL-560
 * R3). `checkSessionDrift` only runs during a page RENDER; every caller of this helper is a
 * Server Action that POSTs straight to its own endpoint, so a per-user override (or a role
 * demotion) revoked days ago is still sealed in the cookie. The cheap synchronous session check
 * stays first: it fails closed on an unauthenticated or session-uncapable caller before the live
 * DB read is spent.
 *
 * (e) ONE GENERIC DENIAL STRING FOR EVERY ARM — unauthenticated, session-uncapable, and
 * live-revoked are indistinguishable from the outside. No existence leak.
 *
 * (f) NOT A WRAPPER / HOF. It returns a value the caller must branch on, so a caller that forgets
 * to check `ok` fails `tsc` on `result.user` rather than silently running unauthenticated.
 *
 * (g) ⚠ AN ACTION GATING THROUGH THIS HELPER DOES NOT ITSELF NAME `hasPlatformCapability(` OR
 * `actorHoldsPlatformCapability(` — both calls live HERE, not at each call site — so the
 * repo-wide live-gate source scan (`invariants/platform-capability-live-gate.test.ts`), which is
 * keyed on those literal call names per file, CANNOT SEE an action that gates only through this
 * helper. That scan's own docblock lists this file as a named blind spot.
 * `request-staff-capability-gated.test.ts` is the positive proof instead: it pins, per migrated
 * file, that the helper is called with the RIGHT token before the parse — stronger per-file
 * evidence than a name scan would give.
 *
 * The file name deliberately does NOT end in `-core.ts` — `action-cores-take-their-actor.test.ts`
 * collects files with that suffix under a different contract (an actor threaded as a parameter,
 * not resolved via a session read), which this helper is not.
 */
export const REQUEST_STAFF_DENIED = 'You do not have permission to do this.';

/** Narrowed on purpose: this helper is the gate for BAL-558's seven acts, not a generic bypass. */
export type RequestStaffCapability =
  | typeof PLATFORM_CAPABILITIES.MANAGE_ANY_REQUEST_SOURCING
  | typeof PLATFORM_CAPABILITIES.MANAGE_ANY_KICKOFF_GATE;

export async function requireRequestStaffCapability(
  capability: RequestStaffCapability
): Promise<{ ok: true; user: SessionUser } | { ok: false; error: string }> {
  let user: SessionUser | null;
  try {
    user = await getCurrentUser();
  } catch (error) {
    log.error('Session read failed at the request staff-capability gate — denying', {
      capability,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, error: REQUEST_STAFF_DENIED };
  }
  if (user === null || !hasPlatformCapability(user, capability)) {
    return { ok: false, error: REQUEST_STAFF_DENIED };
  }
  if (!(await actorHoldsPlatformCapability(user.id, capability))) {
    return { ok: false, error: REQUEST_STAFF_DENIED };
  }
  return { ok: true, user };
}
