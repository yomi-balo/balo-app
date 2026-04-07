'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';

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
    try {
      log.info('Calendar conflict check toggle attempted (stub)', {
        userId: session.user.id,
        subCalendarId: input.subCalendarId,
        conflictChecking: input.conflictChecking,
      });

      return { success: false, error: 'Calendar integration is not yet available.' };
    } catch (error) {
      log.error('Failed to toggle conflict check', {
        userId: session.user.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return { success: false, error: 'Failed to update calendar settings. Please try again.' };
    }
  }
);
