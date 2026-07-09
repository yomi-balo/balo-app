import type { SessionUser } from '@/lib/auth/session';
import {
  platformRoleHasCapability,
  PLATFORM_CAPABILITIES,
  type PlatformCapability,
} from '@balo/shared/authz';

/**
 * platform-capability web seam (BAL-358) — the client-safe gate for "does this
 * viewer hold a platform-staff capability". PURE + synchronous: it reads
 * `SessionUser.platformRole` (already on the session — no DB round-trip) and
 * delegates to the pure `@balo/shared/authz` platform map, the single place a
 * platform role is interpreted. NO `server-only` and only a TYPE-only
 * `SessionUser` import (mirrors `lib/auth/is-admin.ts`), so both server gates
 * (Server Actions) and any client-safe resolver can import it.
 *
 * This governs MUTATION authorization only. The observer-LENS view gate (who can
 * SEE the admin surface) stays on `resolveRequestLens`'s `platformRole` set
 * membership — a separate boundary.
 */

export { PLATFORM_CAPABILITIES };
export type { PlatformCapability };

/** True when the viewer's platform role grants `capability`. */
export function hasPlatformCapability(
  user: Pick<SessionUser, 'platformRole'>,
  capability: PlatformCapability
): boolean {
  return platformRoleHasCapability(user.platformRole, capability);
}
