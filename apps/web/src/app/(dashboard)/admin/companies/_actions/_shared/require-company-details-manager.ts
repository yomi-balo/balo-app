import 'server-only';

import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { getCurrentUser, type SessionUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { actorHoldsPlatformCapability } from '@/lib/authz/live-platform-capability';

/**
 * The auth preamble for every company-details staff mutation: `getCurrentUser()`, the session
 * `hasPlatformCapability(MANAGE_COMPANY_DETAILS)` check, then the LIVE `actorHoldsPlatformCapability`
 * read. Same idiom as `requirePartyDomainsManager` — `/admin/*` actions gate on a capability, not
 * `requireOnboardedUser()`.
 *
 * Each action calls this as its FIRST statement, so it re-resolves the capability itself rather
 * than leaning on `admin/layout.tsx`'s `VIEW_PLATFORM_ADMIN` gate (reachability, a different
 * token). The session check alone is not a revocation boundary: a Server Action never runs
 * `checkSessionDrift`, so a per-user override revoked days ago is still sealed in the cookie.
 *
 * One generic denial string for every arm, so a signed-out caller and a non-holder are
 * indistinguishable from the outside.
 */
export const COMPANY_DETAILS_DENIED = 'You do not have permission to do this.';

export async function requireCompanyDetailsManager(): Promise<
  { ok: true; user: SessionUser } | { ok: false; error: string }
> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: COMPANY_DETAILS_DENIED };
  // Under impersonation `getCurrentUser()` is the IMPERSONATED account, never the staff member:
  // refuse explicitly rather than rely on that account happening to lack the capability.
  if (isImpersonatedSession(user)) return { ok: false, error: COMPANY_DETAILS_DENIED };
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_COMPANY_DETAILS)) {
    return { ok: false, error: COMPANY_DETAILS_DENIED };
  }
  if (
    !(await actorHoldsPlatformCapability(user.id, PLATFORM_CAPABILITIES.MANAGE_COMPANY_DETAILS))
  ) {
    return { ok: false, error: COMPANY_DETAILS_DENIED };
  }
  return { ok: true, user };
}
