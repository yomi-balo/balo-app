'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';
import type { CalendarProvider } from '../_types/calendar';

export interface SetTargetCalendarInput {
  targetCalendarId: string;
  /**
   * BAL-397 §5.2 — the UI always knows which connection's panel is being edited, so it sends
   * `provider` explicitly. Without it the API resolves the owning connection by an N-query scan
   * over every live connection (`findConnectionOwningCalendar`), which is also ambiguous the
   * moment two providers ever expose the same calendar-id string. No API change was needed —
   * the route already accepts `provider` and takes the direct
   * `findConnectionByExpertAndProvider` path when given it.
   */
  provider: CalendarProvider;
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
          provider: input.provider,
        }),
      });

      log.info('Target calendar set', {
        userId: session.user.id,
        expertProfileId,
        targetCalendarId: input.targetCalendarId,
        provider: input.provider,
      });

      return { success: true };
    } catch (err: unknown) {
      log.error('Failed to set target calendar', {
        userId: session.user.id,
        expertProfileId,
        targetCalendarId: input.targetCalendarId,
        provider: input.provider,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      // ⚠ A FIXED LITERAL, NEVER `err.message` — see the identical note (and the four leaking
      // message classes it enumerates) in `disconnect-calendar.ts`.
      return { success: false, error: 'Failed to set target calendar' };
    }
  }
);
