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
 * Lists the expert's upcoming time-off blocks. Read path degrades gracefully:
 * on any error (or no expert profile) it returns `[]` so the card can render
 * its empty state rather than crashing the Schedule tab.
 * `expertProfileId` is derived from the trusted session — never a client id.
 */
export const getAvailabilityOverridesAction = withAuth(
  async (session): Promise<AvailabilityOverrideDto[]> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      return [];
    }

    try {
      const data = await calendarApiFetch<GetOverridesResponse>(
        `/api/experts/availability-overrides?expertProfileId=${expertProfileId}`
      );
      return data.overrides;
    } catch (err: unknown) {
      log.error('Failed to fetch availability overrides', {
        userId: session.user.id,
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return [];
    }
  }
);
