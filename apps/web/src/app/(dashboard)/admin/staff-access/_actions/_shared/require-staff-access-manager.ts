import 'server-only';

import { getCurrentUser, type SessionUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { actorHoldsPlatformCapability } from '@/lib/authz/live-platform-capability';
import { STAFF_ACCESS_SAVE_MESSAGES } from '../../_lib/staff-access-outcome';

/**
 * BAL-561 — THE `/admin/staff-access` Server Action auth idiom, following the
 * `require-application-reviewer.ts` shape verbatim: `getCurrentUser()` + a session capability
 * check, NOT `requireOnboardedUser()` (the `/admin/*` ruling — `close-admin-alert.ts:40-44`,
 * `require-application-reviewer.ts`). Middleware already redirects un-onboarded page navigations.
 *
 * ⚠ ONE GENERIC DENIAL STRING FOR EVERY ARM — no existence leak. A signed-out caller, a caller
 * without `MANAGE_STAFF_CAPABILITIES` in their session, and a caller whose LIVE row no longer
 * grants it are indistinguishable from the outside. `STAFF_ACCESS_SAVE_MESSAGES.denied` is the
 * one string both actions use.
 *
 * ⚠ EXTRACTED BECAUSE TWO ACTIONS NEED IT, NOT TO HIDE IT. Each action calls this as its FIRST
 * statement and therefore RE-RESOLVES the capability itself — neither leans on
 * `admin/layout.tsx`'s `VIEW_PLATFORM_ADMIN` gate, a different token gating REACHABILITY, not
 * this mutation.
 *
 * ⚠ THE LIVE RE-READ IS NOT OPTIONAL (BAL-560 fix round 1, security F2 — the same reasoning as
 * `require-application-reviewer.ts`). The session gate above is not a revocation boundary: a
 * Server Action POSTs straight to its own endpoint, so `checkSessionDrift` never runs first, and
 * a `MANAGE_STAFF_CAPABILITIES` grant revoked days ago would otherwise still be honoured for up
 * to the full seven-day cookie lifetime — on the single most powerful token on this axis.
 *
 * ⚠ NOT A WRAPPER / HOF. It returns a value the caller must branch on, so a caller that forgets to
 * check `ok` fails `tsc` on `result.user` rather than silently running unauthenticated.
 */
export async function requireStaffAccessManager(): Promise<
  { readonly ok: true; readonly user: SessionUser } | { readonly ok: false; readonly error: string }
> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: STAFF_ACCESS_SAVE_MESSAGES.denied };
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES)) {
    return { ok: false, error: STAFF_ACCESS_SAVE_MESSAGES.denied };
  }
  if (
    !(await actorHoldsPlatformCapability(user.id, PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES))
  ) {
    return { ok: false, error: STAFF_ACCESS_SAVE_MESSAGES.denied };
  }
  return { ok: true, user };
}
