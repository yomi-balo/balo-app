'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';
import { setCalendarConnectNonceCookie } from '../_lib/calendar-connect-cookie';
import type { CalendarProvider } from '../_types/calendar';

export interface InitiateCalendarConnectResult {
  success: boolean;
  connectUrl?: string;
  error?: string;
}

export const initiateCalendarConnectAction = withAuth(
  async (session, provider: CalendarProvider): Promise<InitiateCalendarConnectResult> => {
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

      // BAL-396 fix round, Finding 1 — bind this connect attempt to the browser that started
      // it, before the browser ever leaves for the vendor's OAuth page. Scoped by `provider`
      // (round 2, Finding 5) so an interleaved connect for the other provider cannot clobber it.
      await setCalendarConnectNonceCookie(data.nonce, provider);

      log.info('Calendar connect initiated', {
        userId: session.user.id,
        expertProfileId,
        provider,
      });

      return { success: true, connectUrl: data.authUrl };
    } catch (err: unknown) {
      log.error('Failed to initiate calendar connect', {
        userId: session.user.id,
        expertProfileId,
        provider,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return { success: false, error: 'Failed to initiate calendar connection' };
    }
  }
);
