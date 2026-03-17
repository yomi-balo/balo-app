import 'server-only';

import { cache } from 'react';
import { usersRepository } from '@balo/db';
import { getSession } from './session';

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

  return { action: 'ok' };
}
