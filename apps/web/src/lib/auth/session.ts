import 'server-only';

import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import type { ActiveWorkspacePointer } from '@balo/shared/workspaces';
import { sessionConfig } from './config';
import { impersonatedSessionConfig } from './session-config';
import { isImpersonatedSession } from './impersonation';
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

  // BAL-553 — the staff member operating this session. Present iff `isImpersonating` is true;
  // written ONLY by markSessionAsImpersonated() in ./impersonation.ts. An ID, not an email:
  // the refusal log line and the audit row both need something that JOINS (ruling R2).
  impersonatorUserId?: string;

  // BAL-553 — ABSOLUTE deadline (epoch ms) for this impersonated session. Every save recomputes
  // the cookie maxAge AND the iron seal ttl as the remaining time, so re-saving cannot extend
  // the window past this deadline. ⚠ (fix round 2, F2) — that guarantee needs a SECOND part,
  // enforced in `getSession()` below: `iron-webcrypto` applies a fixed 60s clock-skew allowance
  // on top of `ttl`, so a seal issued at t=1799s with `ttl` floored to 1s is still ACCEPTED (not
  // yet expired) at t=1800..1860s — and without the guard, saving inside that window would
  // re-seal with a FRESH `exp = now + 1s`, itself valid for another ~61s, repeatable forever.
  // `getSession()` closes this by comparing this field against `Date.now()` directly and
  // deleting the in-memory session once it has passed, rather than trusting iron's ttl-derived
  // expiry alone.
  impersonationExpiresAt?: number;

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
  // A browser SILENTLY DISCARDS a `Set-Cookie` whose name+value exceeds 4096 bytes. Measured
  // against this repo's `iron-session@8.0.4` and the exact payload in
  // `apps/web/src/lib/auth/session-cookie-size.test.ts`: the fully-populated baseline seals to
  // 2817 bytes, and a hypothetical `role`-bearing workspace list grows it ~290 bytes per
  // company workspace — so it crosses 4096 at FIVE company memberships. Such a user would
  // sign in, get a cookie the browser throws away, be bounced to `/login`, and re-run the
  // identical path forever with no server-side error. Capping or truncating the list is
  // forbidden (orchestrator ruling R2 — it would hide a workspace the user legitimately holds).
  //
  // Nothing is lost: `checkSessionDrift` already calls `deriveWorkspacesForUser` on EVERY
  // page render (the accepted R4 cost) and that function is React-`cache()`d per request, so
  // the full list is derived server-side on every request regardless. Sealing it bought pure
  // redundancy. Consumers that need the list (BAL-496's switcher) call
  // `getWorkspacesForCurrentUser()` in `@/lib/workspaces/get-workspaces`.
  // `apps/web/src/lib/auth/session-cookie-size.test.ts` pins the 4096-byte budget.
  //
  // ⚠ BAL-507 — the field is an `ActiveWorkspacePointer`, NOT a `Workspace`. `getIronSession`
  // is a type assertion over cookie JSON with no runtime validation, so a `Workspace`-typed
  // field would claim things about seven-day-old cookies the type cannot honour — see
  // `ActiveWorkspacePointer`'s docblock. Everything the pointer carries is identity or
  // display; nothing on it is an authorization input.
  activeWorkspace?: ActiveWorkspacePointer;
}

export interface SessionData {
  user?: SessionUser;
  accessToken?: string;
  refreshToken?: string;
}

export async function getSession() {
  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, sessionConfig);
  // BAL-553 — arm the short config BEFORE anything can call save(). Every save() in the app
  // (the sync route's repair, switch-workspace, complete-onboarding, …) goes through a session
  // obtained here, so this is the ONE place that has to know, and no call site can forget.
  // Driven by the SEALED session's own content, never by the presence of the preserved cookie:
  // a cookie the browser controls must not be able to promote an impersonated session back to
  // seven days. Remaining time, not a fresh 30 minutes — the deadline is absolute.
  const user = session.user;
  if (user !== undefined && isImpersonatedSession(user)) {
    const remaining = ((user.impersonationExpiresAt ?? 0) - Date.now()) / 1000;
    // ⚠⚠ (fix round 2, F2) — PAST THE DEADLINE, DO NOT ARM: `impersonatedSessionConfig` floors
    // `ttl` at 1s, and `iron-webcrypto` grants a further fixed 60s clock-skew allowance on TOP
    // of that — so arming with a non-positive `remaining` would still produce a seal that
    // unseals successfully for up to ~61s, and (because `save()` is called unconditionally
    // downstream, e.g. by the session-sync route) a client polling inside that window could
    // re-trigger a save and get ANOTHER ~61s, indefinitely. Once the absolute deadline has
    // passed, the ONLY correct move is to make this render see no session at all.
    //
    // IN-MEMORY DELETION ONLY — NEVER `session.destroy()` HERE. `getSession()` is called from
    // React Server Component renders (the root layout, `checkSessionDrift`, …), where
    // `cookies().set()` — which `destroy()` calls under the hood — throws
    // ("Cookies can only be modified in a Server Action or Route Handler"). Deleting the
    // in-memory fields makes every downstream reader (`getCurrentUser`, `requireUser`, …) see
    // no user, which is fail-closed and safe from an RSC context; a Route Handler that wants
    // the cookie itself cleared (e.g. session-sync's `!session?.user?.id` arm) already redirects
    // to `/login`, which converges to the same place on the next request regardless.
    if (remaining <= 0) {
      delete session.user;
      delete session.accessToken;
      delete session.refreshToken;
    } else {
      session.updateConfig(impersonatedSessionConfig(remaining));
    }
  }
  return session;
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
