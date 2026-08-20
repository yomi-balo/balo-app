'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';
import type { CalendarConnection } from '../_types/calendar';

interface GetConnectionsResponse {
  connections: CalendarConnection[];
}

export type GetCalendarConnectionsResult =
  | { readonly ok: true; readonly connections: CalendarConnection[] }
  | { readonly ok: false; readonly error: string };

/**
 * BAL-397 §5.1 (pre-flight item 2) — the ARRAY reaches the client now, not a single connection
 * swallowed down to `connection | null`. This is also the fix for §4.1's behaviour change: a
 * fetch failure returns `{ ok: false }` rather than swallowing the error into an empty/null
 * result — the old `getCalendarConnectionAction` turning a failure into `null` is exactly what
 * made a failed fetch indistinguishable from "no calendar connected", sending an expert who
 * already has a calendar connected through a second, unnecessary OAuth round trip.
 */
export const getCalendarConnectionsAction = withAuth(
  async (session): Promise<GetCalendarConnectionsResult> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      // Not an error — an expert without a profile genuinely has zero connections, and this
      // surface only ever renders for experts.
      return { ok: true, connections: [] };
    }

    try {
      const data = await calendarApiFetch<GetConnectionsResponse>(
        `/api/calendar/connection?expertProfileId=${expertProfileId}`
      );
      return { ok: true, connections: data.connections };
    } catch (err: unknown) {
      log.error('Failed to fetch calendar connections', {
        userId: session.user.id,
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return { ok: false, error: 'Failed to load calendar connections' };
    }
  }
);
