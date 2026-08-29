import 'server-only';

import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import type { Workspace } from '@balo/shared/workspaces';
import { sessionConfig } from './config';
import type { AuthMethodSignal } from './auth-method';

export interface SessionUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  activeMode: 'client' | 'expert';
  onboardingCompleted: boolean;
  platformRole: 'user' | 'admin' | 'super_admin';

  // BAL-350: coarse auth method for onboarding analytics. Optional — pre-existing
  // sessions and unknown providers are undefined.
  authMethod?: AuthMethodSignal;

  // Admin impersonation (workos-auth skill, "Admin Impersonation"): `true` for the duration of
  // an admin's impersonated session. Optional — undefined for every normal session.
  isImpersonating?: boolean;

  // Company context (always present - personal workspace or real company)
  companyId: string;
  companyName: string;
  companyRole: 'owner' | 'admin' | 'member';

  // Expert context (only if user has expert profile)
  expertProfileId?: string;
  verticalId?: string;

  // BAL-494 / ADR-1053 — the workspace the user is acting AS. OPTIONAL on purpose: sessions
  // sealed before BAL-494 carry it not at all (7-day cookie), so a required field would be a
  // runtime lie. Absent ⇒ `checkSessionDrift` reports drift and the sync route repopulates on
  // the next dashboard render — self-healing, one extra redirect, once per session.
  // `activeMode` / `companyId` / `companyName` / `companyRole` above stay in the session too,
  // now as the PROJECTION of `activeWorkspace` (expand/contract — no existing consumer is
  // edited to read `activeWorkspace`).
  //
  // ⚠⚠ THE FULL WORKSPACE **LIST** IS DELIBERATELY NOT SEALED HERE — it is a POINTER, not a
  // cache. A `workspaces: Workspace[]` field shipped in the first cut of BAL-494 and was
  // removed in security fix round 2 because it is an UNBOUNDED, NON-SELF-HEALING LOCKOUT.
  // A browser SILENTLY DISCARDS a `Set-Cookie` whose name+value exceeds 4096 bytes, and
  // measured against this repo's `iron-session@8.0.4` the sealed `balo_session` cookie is
  // 2326 bytes with no list on a minimal session (2859 on a fully-populated one) and grows
  // ~270 bytes per company workspace — so it crosses 4096 somewhere between FIVE and EIGHT
  // company memberships, depending on the rest of the payload. Such a user would sign in,
  // get a cookie the browser throws away, be bounced to `/login`, and re-run the identical
  // path forever with no server-side error. Capping or truncating the list is forbidden
  // (orchestrator ruling R2 — it would hide a workspace the user legitimately holds).
  //
  // Nothing is lost: `checkSessionDrift` already calls `deriveWorkspacesForUser` on EVERY
  // page render (the accepted R4 cost) and that function is React-`cache()`d per request, so
  // the full list is derived server-side on every request regardless. Sealing it bought pure
  // redundancy. Consumers that need the list (BAL-496's switcher) call
  // `getWorkspacesForCurrentUser()` in `@/lib/workspaces/get-workspaces`.
  // `apps/web/src/lib/auth/session-cookie-size.test.ts` pins the 4096-byte budget.
  activeWorkspace?: Workspace;
}

export interface SessionData {
  user?: SessionUser;
  accessToken?: string;
  refreshToken?: string;
}

export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionConfig);
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await getSession();
  return session.user ?? null;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error('Unauthorized');
  }
  return user;
}

/**
 * Fail-closed sibling of requireUser(): asserts the user has completed onboarding.
 * Throws 'Unauthorized' when no user (via requireUser), 'Onboarding not completed'
 * when onboardingCompleted !== true. Use in privileged MUTATION Server Actions that
 * call the session directly (not via withAuth). Reads/layouts keep using requireUser().
 */
export async function requireOnboardedUser(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.onboardingCompleted !== true) {
    throw new Error('Onboarding not completed');
  }
  return user;
}

// Helper to check if user is in expert mode with active profile
export async function requireExpert(): Promise<SessionUser & { expertProfileId: string }> {
  const user = await requireUser();
  if (user.activeMode !== 'expert' || !user.expertProfileId) {
    throw new Error('Expert profile required');
  }
  return user as SessionUser & { expertProfileId: string };
}

// Helper to get company context
export async function getCompanyContext() {
  const user = await requireUser();
  return {
    companyId: user.companyId,
    companyName: user.companyName,
    companyRole: user.companyRole,
  };
}
