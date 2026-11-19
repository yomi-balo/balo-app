'use server';

import 'server-only';

import { getCurrentUser } from '@/lib/auth';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { loadIncomingCall } from '../load-incoming-call';
import type { IncomingCallView } from '../call-now-types';

/**
 * BAL-653 — the call toast's read of the live ring aimed at the signed-in user.
 *
 * ⚠ IT USES `getCurrentUser()`, NEVER `requireOnboardedUser()`. The bell also mounts on pages a
 * signed-out or half-onboarded viewer can reach, and `requireOnboardedUser` throws there. It
 * answers `null` for a signed-out viewer, one who has not finished onboarding, and an impersonated
 * session (staff viewing as the user must not see, or react to, the user's ring).
 */
export async function readIncomingCallAction(): Promise<IncomingCallView | null> {
  const user = await getCurrentUser();
  if (user === null || user.onboardingCompleted !== true) return null;
  if (isImpersonatedSession(user)) return null;
  return loadIncomingCall(user.id);
}
