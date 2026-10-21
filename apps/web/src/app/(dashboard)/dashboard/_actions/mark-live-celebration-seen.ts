'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { resolveApprovedExpert } from '@/lib/auth/approved-expert';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { expertsRepository } from '@balo/db';
import { trackServerAndFlush, EXPERT_SETUP_SERVER_EVENTS } from '@/lib/analytics/server';
import { log, errorMessage } from '@/lib/logging';

/**
 * Stamps `expert_profiles.live_celebration_seen_at` once, after the go-live card has mounted.
 * Takes no input: the profile is resolved from the session, never a client-supplied id. The
 * stamp is a conditional UPDATE, so a repeat call (StrictMode, a second tab) is a no-op and fires
 * no event. An impersonated session never stamps, so staff cannot consume the expert's card.
 */
export const markLiveCelebrationSeenAction = withAuth(
  async (session): Promise<{ stamped: boolean }> => {
    if (isImpersonatedSession(session.user)) {
      return { stamped: false };
    }
    try {
      const gate = await resolveApprovedExpert(session.user);
      if (!gate.ok) {
        return { stamped: false };
      }
      const { expertProfileId } = gate;

      const stamped = await expertsRepository.markLiveCelebrationSeen({
        expertProfileId,
        userId: session.user.id,
      });

      if (stamped) {
        log.info('Expert live celebration seen', { expertProfileId });
        trackServerAndFlush(EXPERT_SETUP_SERVER_EVENTS.LIVE_CELEBRATION_VIEWED, {
          expert_id: expertProfileId,
          distinct_id: session.user.id,
        });
      }
      return { stamped };
    } catch (error: unknown) {
      log.error('Failed to mark live celebration seen', {
        userId: session.user.id,
        expertProfileId: session.user.expertProfileId,
        error: errorMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { stamped: false };
    }
  }
);
