import 'server-only';

import { getCurrentUser, type SessionUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { actorHoldsPlatformCapability } from '@/lib/authz/live-platform-capability';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
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
 *
 * ⚠⚠ C5 (user-ruled) — EXPLICIT REFUSAL UNDER IMPERSONATION, DEFENCE-IN-DEPTH ON TOP OF TWO
 * STRUCTURAL FACTS THAT ALREADY MAKE THIS UNREACHABLE, NOT A NEW HOLE THIS CLOSES:
 *   1. during an impersonated session, `SessionUser` (from `getCurrentUser()`) IS the
 *      IMPERSONATED account — the customer being acted on, never the staff member — so
 *      `hasPlatformCapability` below is already asking "is the CUSTOMER staff", which is false
 *      for any customer this feature would ever impersonate;
 *   2. even if that first check somehow passed, the caller passes `user.id` as `actorUserId` into
 *      `usersRepository.saveStaffAccess`, whose in-transaction actor re-check
 *      (`accountMayManageStaff`, M2/D6) re-resolves capabilities on the LOCKED row for that SAME
 *      id — the customer's row — and refuses there too.
 * This check makes the protection LOCAL and TESTABLE rather than resting on cross-file reasoning
 * about WorkOS's impersonation semantics — the same posture `refuseMoneyActionUnderImpersonation`
 * takes for money actions. Checked FIRST, before either capability read, so a signed-out check
 * and an impersonation check never race to explain the same generic denial differently.
 */
export async function requireStaffAccessManager(): Promise<
  { readonly ok: true; readonly user: SessionUser } | { readonly ok: false; readonly error: string }
> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: STAFF_ACCESS_SAVE_MESSAGES.denied };
  if (isImpersonatedSession(user)) {
    return { ok: false, error: STAFF_ACCESS_SAVE_MESSAGES.denied };
  }
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
