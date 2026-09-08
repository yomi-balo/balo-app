import 'server-only';

import { usersRepository } from '@balo/db';
import { deriveWorkspacesForUser } from '@/lib/workspaces/derive-workspaces';
import { applyWorkspaceDerivationToSessionUser } from '@/lib/workspaces/session-workspace';
import type { SessionUser } from './session';

/**
 * BAL-553 — build the impersonation TARGET's `SessionUser`, mirroring `createSession` in
 * `app/api/auth/callback/route.ts`. This module deliberately never mentions `isImpersonating` —
 * marking the flag is `markSessionAsImpersonated`'s job alone (`./impersonation.ts`, invariant
 * I2/⟦R4⟧); this file only builds an ordinary, unmarked `SessionUser` for the target.
 *
 * `null` for: the target missing, soft-deleted, non-`active`, or with no derivable company
 * workspace (`SessionUser.companyId` is required and there is nothing honest to put in it).
 */
export async function buildImpersonatedSessionUser(
  targetUserId: string
): Promise<SessionUser | null> {
  const syncRow = await usersRepository.findForSessionSync(targetUserId);
  if (syncRow === null || syncRow.deletedAt !== null || syncRow.status !== 'active') {
    return null;
  }

  // ⚠ `findById`, NEVER a spread of the full `User` row — it carries `workosId` and `phone`, and
  // this value is sealed into a cookie. Copy EXACTLY these four display fields.
  const displayUser = await usersRepository.findById(targetUserId);
  if (displayUser === undefined) return null;

  // `deriveWorkspacesForUser` is React `cache()`d by userId, so deriving for the TARGET inside
  // the staff member's own request cannot collide with the staff member's own derivation.
  // Derived FIRST — before the object literal below — because `SessionUser.companyId` is
  // required and there is nothing honest to put in it for a target with no derivable workspace.
  const derived = await deriveWorkspacesForUser(targetUserId);
  if (derived === null) return null;

  // ⚠⚠ SEAL THE TARGET'S OWN REAL DB VALUES ⟦R7b⟧ — this is not cosmetic. `checkSessionDrift`
  // compares each of these against `findForSessionSync(session.user.id)` for the IMPERSONATED
  // user's own row. Sealing the STAFF member's values here would mean permanent drift → sync →
  // drift, an infinite redirect loop. It is also the security model: the impersonated session
  // holds `platformRole: 'user'` (ordinarily), so it has no platform capability, cannot reach
  // `/admin`, and cannot start a second impersonation.
  //
  // ⚠⚠ (fix round 1, F7) — `activeMode` is initialized from `derived.session.activeMode`, NOT
  // `syncRow.activeMode`, and that is deliberate, not an oversight: `applyWorkspaceDerivationToSessionUser`
  // below UNCONDITIONALLY overwrites `activeMode` (and `companyId`/`companyName`/`companyRole`)
  // from the same `derived.session` projection, so a raw copy of `syncRow.activeMode` here would
  // be a dead write — worse, a MISLEADING one, because `resolveActiveWorkspace`
  // (`@balo/shared/workspaces`) fails safe: a target whose stored `activeMode` is `'expert'` but
  // who holds no (approved) expert profile derives `'client'`, so the two values are NOT always
  // equal. `derived.session.activeMode` is still self-consistent with the target's own row —
  // `deriveWorkspacesForUser` reads that row's OWN stored `activeMode` as its input — so R7b's
  // no-drift guarantee holds either way; this is about which value is HONEST to write here, not
  // a change to which user's data drives the derivation.
  const sessionUser: SessionUser = {
    id: targetUserId,
    email: displayUser.email,
    firstName: displayUser.firstName,
    lastName: displayUser.lastName,
    avatarUrl: displayUser.avatarUrl,
    activeMode: derived.session.activeMode,
    onboardingCompleted: syncRow.onboardingCompleted,
    platformRole: syncRow.platformRole,
    // `authMethod` is deliberately NOT carried — it describes how THIS BROWSER authenticated,
    // and nobody authenticated as the target.
    companyId: derived.session.companyId,
    companyName: derived.session.companyName,
    companyRole: derived.session.companyRole,
    ...(syncRow.expertProfileId !== null && {
      expertProfileId: syncRow.expertProfileId,
      verticalId: syncRow.verticalId ?? undefined,
    }),
  };

  applyWorkspaceDerivationToSessionUser(sessionUser, derived);

  return sessionUser;
}
