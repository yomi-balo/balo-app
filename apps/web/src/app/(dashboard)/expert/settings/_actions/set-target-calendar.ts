'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';

export interface SetTargetCalendarInput {
  targetCalendarId: string;
}

export interface SetTargetCalendarResult {
  success: boolean;
  error?: string;
}

export const setTargetCalendarAction = withAuth(
  async (session, input: SetTargetCalendarInput): Promise<SetTargetCalendarResult> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      return { success: false, error: 'No expert profile found' };
    }

    try {
      await calendarApiFetch<{ success: boolean }>('/api/calendar/set-target-calendar', {
        method: 'POST',
        body: JSON.stringify({
          expertProfileId,
          targetCalendarId: input.targetCalendarId,
        }),
      });

      log.info('Target calendar set', {
        userId: session.user.id,
        expertProfileId,
        targetCalendarId: input.targetCalendarId,
      });

      return { success: true };
    } catch (err: unknown) {
      log.error('Failed to set target calendar', {
        userId: session.user.id,
        expertProfileId,
        targetCalendarId: input.targetCalendarId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to set target calendar',
      };
    }
  }
);
