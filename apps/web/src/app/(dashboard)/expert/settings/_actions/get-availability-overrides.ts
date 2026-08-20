'use server';
import 'server-only';

import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';
import type { AvailabilityOverrideDto } from '../_types/availability-override';

interface GetOverridesResponse {
  overrides: AvailabilityOverrideDto[];
}

/**
 * `getAvailabilityOverridesAction`'s result, WIDENED by BAL-416 to carry the session-derived
 * `expertProfileId` alongside the list — the same shape `getScheduleAction`'s
 * `ScheduleLoadResult` uses. `DateOverridesCard` needs the id purely as an analytics
 * dimension for the "Add time off" popover's conflict-warning events; this avoids a THIRD
 * fetch (`getCalendarConnectionAction` carries no id either) just to thread one uuid.
 */
export interface AvailabilityOverridesLoadResult {
  overrides: AvailabilityOverrideDto[];
  expertProfileId: string;
}

/**
 * Lists the expert's upcoming time-off blocks. Read path degrades gracefully:
 * on any error (or no expert profile) it returns `null` so the card can render
 * its empty state rather than crashing the Schedule tab.
 * `expertProfileId` is derived from the trusted session — never a client id.
 */
export const getAvailabilityOverridesAction = withAuth(
  async (session): Promise<AvailabilityOverridesLoadResult | null> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      return null;
    }

    try {
      const data = await calendarApiFetch<GetOverridesResponse>(
        `/api/experts/availability-overrides?expertProfileId=${expertProfileId}`
      );
      return { overrides: data.overrides, expertProfileId };
    } catch (err: unknown) {
      log.error('Failed to fetch availability overrides', {
        userId: session.user.id,
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return null;
    }
  }
);
