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
 * "Fix permissions" re-runs OAuth: it calls `POST /api/calendar/connect` for the given
 * `provider`, and `relinkUrl` carries the connect response's `authUrl`.
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

      // Like initial connect, this mints a fresh state/nonce pair, so it needs the same
      // provider-scoped CSRF nonce cookie — see initiate-calendar-connect.ts.
      await setCalendarConnectNonceCookie(data.nonce, provider);

      log.info('Calendar fix permissions initiated', {
        userId: session.user.id,
        expertProfileId,
        provider,
      });

      return { success: true, relinkUrl: data.authUrl };
    } catch (error: unknown) {
      log.error('Failed to get relink URL', {
        userId: session.user.id,
        expertProfileId,
        provider,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { success: false, error: 'Failed to generate permission fix link' };
    }
  }
);
