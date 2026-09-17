import { PLATFORM_ADMIN_ROLES, isPlatformAdminRole } from '@balo/shared/parties';
import type { SessionUser } from './session';

/**
 * is-admin — the client-safe web gate for "is this viewer a platform admin".
 * PURE + synchronous (no `server-only`, only a type-only `SessionUser` import),
 * so server code and client-safe resolvers (`resolve-portfolio-lens.ts`,
 * `promo-codes/page.tsx`) import it. The role SET itself lives once in
 * `@balo/shared/parties` (`PLATFORM_ADMIN_ROLES`) so web and the engagement
 * actor-attribution rule share a single source — this module just adapts it to a
 * `SessionUser`.
 *
 * ⚠ BAL-558 — `require-admin.ts`, the ROLE-SET Server Action gate this module used to feed, has
 * been DELETED. Its seven `projects/[requestId]/_actions` call sites moved to the platform
 * CAPABILITY axis (`MANAGE_ANY_REQUEST_SOURCING` / `MANAGE_ANY_KICKOFF_GATE`, via
 * `requireRequestStaffCapability`). This module is unaffected — it still backs
 * `resolve-portfolio-lens.ts` and `promo-codes/page.tsx`, which read the role SET, not a
 * capability.
 */

/** Platform roles that grant admin access to platform-wide surfaces. */
export const ADMIN_ROLES = PLATFORM_ADMIN_ROLES;

/** True when the viewer is a platform admin / super-admin. */
export function isPlatformAdmin(user: SessionUser): boolean {
  return isPlatformAdminRole(user.platformRole);
}
