'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';

export interface FixPermissionsResult {
  success: boolean;
  relinkUrl?: string;
  error?: string;
}

export const fixCalendarPermissionsAction = withAuth(
  async (session): Promise<FixPermissionsResult> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      return { success: false, error: 'No expert profile found' };
    }

    try {
      const data = await calendarApiFetch<{ relinkUrl: string }>(
        `/api/calendar/relink?expertProfileId=${expertProfileId}`
      );

      log.info('Calendar fix permissions initiated', {
        userId: session.user.id,
        expertProfileId,
      });

      return { success: true, relinkUrl: data.relinkUrl };
    } catch (err: unknown) {
      log.error('Failed to get relink URL', {
        userId: session.user.id,
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return { success: false, error: 'Failed to generate permission fix link' };
    }
  }
);
