import 'server-only';

import { cache } from 'react';
import { usersRepository } from '@balo/db';
import { getSession } from './session';
import { log } from '@/lib/logging';

type SyncResult =
  | { action: 'ok' }
  | { action: 'updated'; driftFields: string[] }
  | { action: 'invalidated'; reason: 'suspended' | 'deleted' };

// React.cache wraps the DB query so multiple Server Components
// in the same request tree share a single DB roundtrip.
const getCachedUserForSync = cache(async (userId: string) => {
  return usersRepository.findForSessionSync(userId);
});

export async function syncSessionWithDb(): Promise<SyncResult> {
  const session = await getSession();

  if (!session?.user?.id) {
    // Defensive fallback — middleware redirects unauthenticated users before
    // the dashboard layout renders, so this should never reach the user.
    return { action: 'invalidated', reason: 'suspended' };
  }

  const dbUser = await getCachedUserForSync(session.user.id);

  // User not found in DB at all (hard deleted or ID mismatch)
  if (!dbUser) {
    log.warn('Session sync: user not found in DB, destroying session', {
      userId: session.user.id,
    });
    session.destroy();
    return { action: 'invalidated', reason: 'deleted' };
  }

  // Hard invalidation: soft-deleted user
  if (dbUser.deletedAt !== null) {
    log.info('Session invalidated: user deleted', {
      userId: session.user.id,
      reason: 'deleted',
    });
    session.destroy();
    return { action: 'invalidated', reason: 'deleted' };
  }

  // Hard invalidation: non-active status (suspended, inactive)
  if (dbUser.status !== 'active') {
    log.info('Session invalidated: user suspended', {
      userId: session.user.id,
      reason: 'suspended',
      status: dbUser.status,
    });
    session.destroy();
    return { action: 'invalidated', reason: 'suspended' };
  }

  // Drift detection: compare session fields vs DB
  const driftFields: string[] = [];

  if (session.user.activeMode !== dbUser.activeMode) {
    driftFields.push('activeMode');
  }
  if (session.user.platformRole !== dbUser.platformRole) {
    driftFields.push('platformRole');
  }
  if (session.user.onboardingCompleted !== dbUser.onboardingCompleted) {
    driftFields.push('onboardingCompleted');
  }

  // expertProfileId: session stores string|undefined, DB returns string|null
  const dbExpertProfileId = dbUser.expertProfileId ?? undefined;
  if (session.user.expertProfileId !== dbExpertProfileId) {
    driftFields.push('expertProfileId');
  }

  if (driftFields.length === 0) {
    return { action: 'ok' };
  }

  // Patch the session cookie with fresh DB values
  session.user.activeMode = dbUser.activeMode as 'client' | 'expert';
  session.user.platformRole = dbUser.platformRole as 'user' | 'admin' | 'super_admin';
  session.user.onboardingCompleted = dbUser.onboardingCompleted;
  session.user.expertProfileId = dbExpertProfileId;
  await session.save();

  log.info('Session synced: drift detected and patched', {
    userId: session.user.id,
    driftFields,
  });

  return { action: 'updated', driftFields };
}
