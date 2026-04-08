'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';
import type { CalendarConnection } from '../_types/calendar';

interface GetConnectionResponse {
  connection: CalendarConnection | null;
}

export const getCalendarConnectionAction = withAuth(
  async (session): Promise<CalendarConnection | null> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      return null;
    }

    try {
      const data = await calendarApiFetch<GetConnectionResponse>(
        `/api/calendar/connection?expertProfileId=${expertProfileId}`
      );
      return data.connection;
    } catch (err: unknown) {
      log.error('Failed to fetch calendar connection', {
        userId: session.user.id,
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return null;
    }
  }
);
