'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';

export interface DisconnectCalendarResult {
  success: boolean;
  error?: string;
}

export const disconnectCalendarAction = withAuth(
  async (session): Promise<DisconnectCalendarResult> => {
    try {
      log.info('Calendar disconnect attempted (stub)', {
        userId: session.user.id,
      });

      return { success: false, error: 'Calendar integration is not yet available.' };
    } catch (error) {
      log.error('Failed to disconnect calendar', {
        userId: session.user.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return { success: false, error: 'Failed to disconnect calendar. Please try again.' };
    }
  }
);
