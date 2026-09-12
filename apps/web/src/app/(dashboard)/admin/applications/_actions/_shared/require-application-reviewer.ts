import 'server-only';

import { getCurrentUser, type SessionUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';

/**
 * BAL-549 (orchestrator D7) — THE `/admin/*` AUTH IDIOM, in one place.
 *
 * `getCurrentUser()` + `hasPlatformCapability(REVIEW_EXPERT_APPLICATIONS)`, NOT
 * `requireOnboardedUser()`. `close-admin-alert.ts:40-44` states the ruling: "ADMIN SURFACES USE
 * `getCurrentUser()` + A CAPABILITY GATE, NOT `requireOnboardedUser()`". The `/admin/*` route
 * group has already decided this.
 *
 * ⚠ ONE GENERIC DENIAL STRING FOR BOTH ARMS — no existence leak. A signed-out caller and a
 * non-holder are indistinguishable from the outside.
 *
 * ⚠ EXTRACTED BECAUSE TWO ACTIONS NEED IT, NOT TO HIDE IT. Each action calls this as its FIRST
 * statement and therefore RE-RESOLVES the capability itself — neither leans on
 * `admin/layout.tsx`'s `VIEW_PLATFORM_ADMIN` gate, which is a different token gating
 * REACHABILITY, not this mutation. The extraction exists so the two actions do not ship a
 * byte-identical 20-line preamble into the SonarCloud new-code duplication gate.
 *
 * ⚠ NOT A WRAPPER / HOF. It returns a value the caller must branch on, so a caller that forgets
 * to check `ok` fails `tsc` on `result.user` rather than silently running unauthenticated.
 */
export const REVIEWER_DENIED = 'You do not have permission to do this.'; // pending-MJ

export async function requireApplicationReviewer(): Promise<
  { ok: true; user: SessionUser } | { ok: false; error: string }
> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: REVIEWER_DENIED };
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.REVIEW_EXPERT_APPLICATIONS)) {
    return { ok: false, error: REVIEWER_DENIED };
  }
  return { ok: true, user };
}
