import 'server-only';

import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
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

  // Company context (always present - personal workspace or real company)
  companyId: string;
  companyName: string;
  companyRole: 'owner' | 'admin' | 'member';

  // Expert context (only if user has expert profile)
  expertProfileId?: string;
  verticalId?: string;
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
