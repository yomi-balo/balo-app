import 'server-only';

import { usersRepository } from '@balo/db';
import type { StaffAccessPerson } from '@balo/shared/authz';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import type { SessionUser } from '@/lib/auth/session';

/**
 * BAL-561 — the authorization seam between `/admin/staff-access`'s page and
 * `usersRepository.listStaffAccessRoster`. The `admin/lookup` `load-lookup.ts` / `admin/
 * applications` `load-applications.ts` shape: re-resolve `MANAGE_STAFF_CAPABILITIES` here,
 * immediately before the call, and return a typed `forbidden` DTO with ZERO repository calls
 * when the check fails.
 *
 * ⚠ D5 — THIS IS WHERE "DENIED" DIVERGES FROM "NOT FOUND". The page itself gates on
 * `VIEW_PLATFORM_ADMIN` (reachability, like every `/admin/*` surface); a staff member who can open
 * the admin area but does not hold `MANAGE_STAFF_CAPABILITIES` sees the no-access state THIS
 * loader's `forbidden` DTO drives, never a 404.
 *
 * The session gate is correct at RENDER time: `(dashboard)/layout.tsx:28` runs
 * `checkSessionDrift()` first, and the live-gate invariant
 * (`platform-capability-live-gate.test.ts`) scopes render-time loaders like this one out of its
 * walk — a stale read here shows the same reachability the person already had one render ago.
 */
export type StaffAccessPageDTO =
  | { readonly ok: true; readonly people: readonly StaffAccessPerson[] }
  | { readonly ok: false; readonly reason: 'forbidden' };

export async function loadStaffAccess(user: SessionUser): Promise<StaffAccessPageDTO> {
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_STAFF_CAPABILITIES)) {
    return { ok: false, reason: 'forbidden' };
  }
  const people = await usersRepository.listStaffAccessRoster();
  return { ok: true, people };
}
