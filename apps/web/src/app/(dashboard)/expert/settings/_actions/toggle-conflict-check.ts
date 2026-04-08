'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';

export interface ToggleConflictCheckInput {
  subCalendarId: string;
  conflictChecking: boolean;
}

export interface ToggleConflictCheckResult {
  success: boolean;
  error?: string;
}

export const toggleConflictCheckAction = withAuth(
  async (session, input: ToggleConflictCheckInput): Promise<ToggleConflictCheckResult> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      return { success: false, error: 'No expert profile found' };
    }

    try {
      await calendarApiFetch<{ success: boolean }>('/api/calendar/toggle-conflict-check', {
        method: 'POST',
        body: JSON.stringify({
          expertProfileId,
          calendarId: input.subCalendarId,
          conflictCheck: input.conflictChecking,
        }),
      });

      log.info('Calendar conflict check toggled', {
        userId: session.user.id,
        expertProfileId,
        subCalendarId: input.subCalendarId,
        conflictChecking: input.conflictChecking,
      });

      return { success: true };
    } catch (err: unknown) {
      log.error('Failed to toggle conflict check', {
        userId: session.user.id,
        expertProfileId,
        subCalendarId: input.subCalendarId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to toggle conflict check',
      };
    }
  }
);
