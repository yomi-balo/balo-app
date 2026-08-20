'use server';
import 'server-only';

import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';
import type {
  AvailabilityConflictCheckInput,
  AvailabilityConflictReportDto,
} from '../_types/availability-conflict';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const checkConflictsSchema = z
  .object({
    startDate: isoDate,
    endDate: isoDate,
  })
  // String comparison is valid for zero-padded ISO dates.
  .refine((v) => v.endDate >= v.startDate, {
    message: 'End date must be on or after start date',
    path: ['endDate'],
  });

/** @deprecated use {@link AvailabilityConflictCheckInput} — kept as an alias so existing callers don't churn. */
export type GetOverrideConflictsInput = AvailabilityConflictCheckInput;

/**
 * BAL-416 — does a proposed time-off block collide with any confirmed consultation?
 * `expertProfileId` is derived from the trusted session — never a client id (this is a
 * READ action, so `withAuth` is correct; `requireOnboardedUser()` is the rule for MUTATING
 * actions, and the sibling `getAvailabilityOverridesAction` sets this precedent).
 *
 * ⚠ D10 — FAIL-OPEN. Any failure (validation, no expert profile, network, a 4xx/5xx from
 * the Fastify route) returns `null`, never a false "no conflicts". The popover's contract is
 * that `null` behaves exactly like a zero-conflict report: the commit proceeds and nothing
 * renders. Refusing a legitimate time-off block because a WARNING read failed would be new
 * friction from an unrelated failure.
 */
export const getOverrideConflictsAction = withAuth(
  async (
    session,
    input: GetOverrideConflictsInput
  ): Promise<AvailabilityConflictReportDto | null> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      return null;
    }

    const parsed = checkConflictsSchema.safeParse(input);
    if (!parsed.success) {
      return null;
    }

    try {
      const params = new URLSearchParams({
        expertProfileId,
        // S1 — the route asserts this against `expertProfiles.userId` before returning any
        // counterparty identity (client company names).
        userId: session.user.id,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
      });
      return await calendarApiFetch<AvailabilityConflictReportDto>(
        `/api/experts/availability-overrides/conflicts?${params.toString()}`
      );
    } catch (err: unknown) {
      log.error('Failed to check time-off conflicts', {
        userId: session.user.id,
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return null;
    }
  }
);
