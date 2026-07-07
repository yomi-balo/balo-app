import { PLATFORM_ADMIN_ROLES, isPlatformAdminRole } from '@balo/shared/parties';
import type { SessionUser } from './session';

/**
 * is-admin — the client-safe web gate for "is this viewer a platform admin".
 * PURE + synchronous (no `server-only`, only a type-only `SessionUser` import),
 * so both server gates (`require-admin.ts`) and client-safe resolvers
 * (`resolve-portfolio-lens.ts`) import it. The role SET itself lives once in
 * `@balo/shared/parties` (`PLATFORM_ADMIN_ROLES`) so web and the engagement
 * actor-attribution rule share a single source — this module just adapts it to a
 * `SessionUser`.
 */

/** Platform roles that grant admin access to platform-wide surfaces. */
export const ADMIN_ROLES = PLATFORM_ADMIN_ROLES;

/** True when the viewer is a platform admin / super-admin. */
export function isPlatformAdmin(user: SessionUser): boolean {
  return isPlatformAdminRole(user.platformRole);
}
