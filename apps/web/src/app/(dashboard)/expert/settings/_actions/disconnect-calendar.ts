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
    log.info('Calendar disconnect requested (stub)', { userId: session.user.id });
    return { success: false, error: 'Calendar integration is not yet available.' };
  }
);
