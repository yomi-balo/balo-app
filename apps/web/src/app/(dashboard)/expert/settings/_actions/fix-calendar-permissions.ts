'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';
import { setCalendarConnectNonceCookie } from '../_lib/calendar-connect-cookie';
import type { CalendarProvider } from '../_types/calendar';

export interface FixPermissionsResult {
  success: boolean;
  relinkUrl?: string;
  error?: string;
}

/**
 * BAL-396 §8.5 — `GET /api/calendar/relink` is DELETED (a Cronofy `profile_relink_url` has
 * no Apiroc equivalent). "Fix permissions" in an Apiroc world IS re-running OAuth, so this
 * retargets to `POST /api/calendar/connect` and takes the `provider` the caller already
 * knows. The RESULT FIELD NAME stays `relinkUrl` (mapped from the connect response's
 * `authUrl`) deliberately — it keeps this action's consumer (BAL-397:
 * `calendar-connections-section.tsx`) identical.
 */
export const fixCalendarPermissionsAction = withAuth(
  async (session, provider: CalendarProvider): Promise<FixPermissionsResult> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      return { success: false, error: 'No expert profile found' };
    }

    try {
      const data = await calendarApiFetch<{ authUrl: string; nonce: string }>(
        '/api/calendar/connect',
        {
          method: 'POST',
          body: JSON.stringify({ expertProfileId, provider }),
        }
      );

      // BAL-396 fix round, Finding 1 — "fix permissions" re-runs OAuth (§8.5), so it mints a
      // fresh state/nonce pair exactly like initial connect and needs the same CSRF binding.
      // Scoped by `provider` (round 2, Finding 5) — see initiate-calendar-connect.ts.
      await setCalendarConnectNonceCookie(data.nonce, provider);

      log.info('Calendar fix permissions initiated', {
        userId: session.user.id,
        expertProfileId,
        provider,
      });

      return { success: true, relinkUrl: data.authUrl };
    } catch (err: unknown) {
      log.error('Failed to get relink URL', {
        userId: session.user.id,
        expertProfileId,
        provider,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return { success: false, error: 'Failed to generate permission fix link' };
    }
  }
);
