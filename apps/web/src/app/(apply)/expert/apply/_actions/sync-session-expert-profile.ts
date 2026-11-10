import 'server-only';

import type { AuthenticatedSession } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';

/**
 * Keeps the sealed session's `expertProfileId` in step with the applicant row the wizard just
 * created or adopted. Without it the cookie lags the database and `checkSessionDrift` flags the
 * session as drifted on the next dashboard render.
 *
 * A failed `save()` is logged and swallowed: the database write already succeeded, so the caller
 * must still report success, and the dashboard layout's drift check heals the cookie.
 */
export async function syncSessionExpertProfileId(
  session: AuthenticatedSession,
  expertProfileId: string
): Promise<void> {
  if (session.user.expertProfileId === expertProfileId) return;

  session.user.expertProfileId = expertProfileId;
  try {
    await session.save();
  } catch (error) {
    log.warn('Session expertProfileId sync failed; drift check will heal it', {
      userId: session.user.id,
      expertProfileId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}
