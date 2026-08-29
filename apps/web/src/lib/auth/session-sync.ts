import 'server-only';

import { cache } from 'react';
import { usersRepository } from '@balo/db';
import { getSession } from './session';
import { deriveWorkspacesForUser } from '@/lib/workspaces/derive-workspaces';
import { activeWorkspaceKeyOf } from '@/lib/workspaces/session-workspace';

type CheckResult = { action: 'ok' } | { action: 'sync-needed' };

// React.cache wraps the DB query so multiple Server Components
// in the same request tree share a single DB roundtrip.
const getCachedUserForSync = cache(async (userId: string) => {
  return usersRepository.findForSessionSync(userId);
});

/**
 * Read-only session drift check for Server Components.
 * Does NOT mutate cookies — if drift or invalidation is detected,
 * returns 'sync-needed' so the caller can redirect to the route handler.
 */
export async function checkSessionDrift(): Promise<CheckResult> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { action: 'sync-needed' };
  }

  const dbUser = await getCachedUserForSync(session.user.id);

  // User not found, soft-deleted, or non-active → needs sync (route handler will destroy session)
  if (dbUser?.deletedAt !== null || dbUser?.status !== 'active') {
    return { action: 'sync-needed' };
  }

  // Drift detection: compare session fields vs DB
  if (
    session.user.activeMode !== dbUser.activeMode ||
    session.user.platformRole !== dbUser.platformRole ||
    session.user.onboardingCompleted !== dbUser.onboardingCompleted ||
    session.user.expertProfileId !== (dbUser.expertProfileId ?? undefined)
  ) {
    return { action: 'sync-needed' };
  }

  // BAL-494 / ADR-1053 — workspace drift. `activeWorkspaceKeyOf` is the single reader of the
  // session's active-workspace shape, so nothing here hand-destructures `activeWorkspace`;
  // it also yields a plain `string | undefined` local, which narrows without a non-null
  // assertion (memory `reference_sonar_nonnull_false_positive`).
  const activeWorkspaceKey = activeWorkspaceKeyOf(session.user);

  //  1. Bootstrap for a pre-BAL-494 cookie carrying no workspace.
  //     ⚠ The derivation MUST run BEFORE deciding — this cannot short-circuit. An active user
  //     with ZERO live company memberships derives `null`, and the sync route only populates
  //     the workspace fields when the derivation is non-null. Returning 'sync-needed' here
  //     unconditionally would bounce that user layout → sync → still undefined → layout …
  //     forever: an unbounded lockout. "No derivable workspace" is a stable, correct state.
  if (activeWorkspaceKey === undefined) {
    const bootstrap = await deriveWorkspacesForUser(session.user.id);
    return { action: bootstrap === null ? 'ok' : 'sync-needed' };
  }

  const derived = await deriveWorkspacesForUser(session.user.id);
  if (derived === null) {
    // No company workspace at all — today's behaviour for this (rare, defensive) case is
    // unaffected by BAL-494; the workspace fields simply stay as they are.
    return { action: 'ok' };
  }

  //  2. The active workspace's key is NOT in the freshly derived list — the mandatory case: a
  //     user removed from a company must not keep acting as it.
  const stillListed = derived.workspaces.some((w) => w.key === activeWorkspaceKey);
  if (!stillListed) {
    return { action: 'sync-needed' };
  }

  //  3. The RESOLVED active workspace disagrees with the session's. Strictly stronger than
  //     (2) — being in the list is not the same as being the one the server would pick — and
  //     it is what actually makes the stored choice cross-device: device 1 switches to B,
  //     device 2's 7-day cookie still says A, and only this comparison notices. It also
  //     closes the `via` blind spot: the key does not encode `via`, so a member who ALSO
  //     holds an org-scope representation for the same company and then LOSES membership
  //     stays `stillListed` while the derivation has already re-resolved elsewhere — leaving
  //     a stale `companyId` feeding `resolve-request-lens.ts`. No loop risk: the sync route
  //     patches from this same derivation, so one round converges.
  if (derived.activeWorkspace.key !== activeWorkspaceKey) {
    return { action: 'sync-needed' };
  }

  //  4. The PROJECTION invariant — the WHOLE projection, not just `activeMode`. Catches every
  //     writer that patches a legacy field without patching the workspace, catches an
  //     `owner → member` demotion (which would otherwise keep `companyRole:'owner'` in the
  //     cookie for the full 7 days), and — because `companyName` is compared too — notices a
  //     company RENAME, which the key comparison in (3) cannot.
  //
  //     ⚠ THERE IS DELIBERATELY NO "STALE SWITCHER LIST" CHECK. An earlier cut compared
  //     `workspaceKeys(session.user.workspaces)` against the derived list; that check existed
  //     only to keep a COOKIE-CACHED list fresh, and the list is no longer sealed into the
  //     cookie (it overran the 4096-byte browser limit at five to eight company workspaces —
  //     see `SessionUser`, and `session-cookie-size.test.ts` for the measurement).
  //     With the list always derived fresh per request there is nothing stale to detect, and
  //     the three checks that remain are the authz-relevant ones: (2) the active workspace is
  //     still held, (3) it is still the one the server would resolve, (4) its projection —
  //     which is what actually feeds `resolve-request-lens.ts` — matches.
  if (
    derived.session.activeMode !== session.user.activeMode ||
    derived.session.companyId !== session.user.companyId ||
    derived.session.companyName !== session.user.companyName ||
    derived.session.companyRole !== session.user.companyRole
  ) {
    return { action: 'sync-needed' };
  }

  return { action: 'ok' };
}
