'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';
import type { CalendarProvider } from '../_types/calendar';

export interface ToggleConflictCheckInput {
  subCalendarId: string;
  conflictChecking: boolean;
  /**
   * BAL-397 §5.2 — `POST /api/calendar/toggle-conflict-check` has NO `provider` field by
   * design (BAL-396 §8.4): it resolves the owning connection from `calendarId`, and the
   * primary-calendar refusal lives there. `provider` is used for LOGGING AND ANALYTICS ONLY
   * here — do NOT "helpfully" forward it into the request body.
   */
  provider: CalendarProvider;
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
        provider: input.provider,
      });

      return { success: true };
    } catch (err: unknown) {
      log.error('Failed to toggle conflict check', {
        userId: session.user.id,
        expertProfileId,
        subCalendarId: input.subCalendarId,
        provider: input.provider,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      // ⚠ A FIXED LITERAL, NEVER `err.message` — see the identical note (and the four leaking
      // message classes it enumerates) in `disconnect-calendar.ts`.
      return { success: false, error: 'Failed to toggle conflict check' };
    }
  }
);
