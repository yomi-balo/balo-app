'use server';
import 'server-only';

import { z } from 'zod';
import { isValidTimezone } from '@balo/shared/timezone';
import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';
import type { TimezoneImpactCheckInput, TimezoneImpactReportDto } from '../_types/timezone-impact';

const checkImpactSchema = z.object({
  timezone: z.string().max(64).refine(isValidTimezone, 'Invalid timezone'),
});

/**
 * Which upcoming confirmed consultations would fall outside the expert's weekly hours if
 * those hours were re-read in `timezone`? `expertProfileId` is derived from the trusted
 * session — never a client id. This is a READ action, so `withAuth` is correct.
 *
 * ⚠ FAIL-OPEN. Any failure (validation, no expert profile, network, a 4xx/5xx from the
 * Fastify route) returns `null`, never a false "nothing affected". The dialog treats `null`
 * as "we couldn't check" and still lets the expert switch: the check is a warning, and
 * refusing a legitimate switch because a warning read failed would be new friction from an
 * unrelated failure.
 */
export const getTimezoneImpactAction = withAuth(
  async (session, input: TimezoneImpactCheckInput): Promise<TimezoneImpactReportDto | null> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      return null;
    }

    const parsed = checkImpactSchema.safeParse(input);
    if (!parsed.success) {
      return null;
    }

    try {
      const params = new URLSearchParams({
        expertProfileId,
        // The route asserts this against `expertProfiles.userId` before returning any
        // counterparty identity (client company names).
        userId: session.user.id,
        timezone: parsed.data.timezone,
      });
      return await calendarApiFetch<TimezoneImpactReportDto>(
        `/api/experts/timezone-impact?${params.toString()}`
      );
    } catch (err: unknown) {
      log.error('Failed to check timezone impact', {
        userId: session.user.id,
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return null;
    }
  }
);
