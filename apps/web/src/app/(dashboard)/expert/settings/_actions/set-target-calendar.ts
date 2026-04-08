'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';

export interface SetTargetCalendarInput {
  targetCalendarId: string;
}

export interface SetTargetCalendarResult {
  success: boolean;
  error?: string;
}

export const setTargetCalendarAction = withAuth(
  async (session, input: SetTargetCalendarInput): Promise<SetTargetCalendarResult> => {
    log.info('Set target calendar attempted (stub)', {
      userId: session.user.id,
      targetCalendarId: input.targetCalendarId,
    });
    return { success: false, error: 'Calendar integration is not yet available.' };
  }
);
