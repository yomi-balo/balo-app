import type { SessionUser } from '@/lib/auth/session';
import {
  platformActorHasCapability,
  PLATFORM_CAPABILITIES,
  type PlatformCapability,
} from '@balo/shared/authz';

/**
 * platform-capability web seam (BAL-358 / ADR-1035) — the client-safe gate for "does this
 * viewer hold a platform-staff capability". PURE + synchronous: it reads
 * `SessionUser.platformRole` AND `SessionUser.platformCapabilities` (BOTH already on the
 * session — still no DB round-trip) and delegates to the pure `@balo/shared/authz` resolver,
 * the single place a platform role and its per-user override are interpreted. NO `server-only`
 * and only a TYPE-only `SessionUser` import (mirrors `lib/auth/is-admin.ts`), so both server
 * gates (Server Actions) and any client-safe resolver can import it.
 *
 * ⚠ BAL-560 — THE OVERRIDE COMES FROM THE SEALED SESSION HERE, AND FROM A LIVE ROW IN
 * `apps/api/src/authz/platform.ts`. That asymmetry is DELIBERATE AND PERMANENT (D6) — read that
 * module's docblock before "fixing" it. Synchrony is the hard constraint on this side: 48
 * production call sites depend on it, several inside lens resolvers whose own docblocks promise
 * "Pure + synchronous — no I/O", and `middleware.ts` runs on the Edge where a live read is
 * structurally impossible.
 *
 * ⚠⚠ THE COOKIE CAN BE UP TO SEVEN DAYS STALE, AND THIS SEAM CANNOT TELL (fix round 1, security
 * F2). `checkSessionDrift` repairs it on every PAGE RENDER — but a Server Action POSTs directly
 * to its own endpoint, so NO render runs first and drift NEVER fires on that path. A mutating,
 * capability-gated Server Action that gates on a session passed to this seam is therefore
 * enforcing a possibly-revoked override. Such actions must RE-READ the actor
 * (`usersRepository.findForSessionSync`) and gate on the live row, exactly as the impersonation
 * entry point does. This seam is correct for RENDER-time gating and for anything already holding
 * a fresh row; it is not, by itself, a revocation boundary for a POST.
 *
 * This governs MUTATION authorization only. The observer-LENS view gate (who can
 * SEE the admin surface) stays on `resolveRequestLens`'s `platformRole` set
 * membership — a separate boundary.
 */

export { PLATFORM_CAPABILITIES };
export type { PlatformCapability };

/**
 * True when the viewer's platform role AND per-user override grant `capability`.
 *
 * ⚠ `Pick<SessionUser, …>` rather than a structural interface, deliberately:
 * `SessionUser['platformRole']` is the literal union `'user'|'admin'|'super_admin'`, so a typo
 * like `'Admin'` is a compile error today. A structural `platformRole: string` would silently
 * lose that. `platformCapabilities` is OPTIONAL on `SessionUser`, so every existing caller —
 * whole-session or bare `{ platformRole }` — still type-checks unchanged.
 */
export function hasPlatformCapability(
  user: Pick<SessionUser, 'platformRole' | 'platformCapabilities'>,
  capability: PlatformCapability
): boolean {
  return platformActorHasCapability(user.platformRole, user.platformCapabilities, capability);
}
