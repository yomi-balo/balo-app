'use server';
import 'server-only';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';
import type { AvailabilityOverrideDto } from '../_types/availability-override';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const createOverrideSchema = z
  .object({
    startDate: isoDate,
    endDate: isoDate,
    label: z.string().trim().max(80, 'Label must be 80 characters or fewer').optional(),
  })
  // String comparison is valid for zero-padded ISO dates.
  .refine((v) => v.endDate >= v.startDate, {
    message: 'End date must be on or after start date',
    path: ['endDate'],
  });

export interface CreateAvailabilityOverrideInput {
  startDate: string;
  endDate: string;
  label?: string;
}

export type CreateAvailabilityOverrideResult =
  | { success: true; override: AvailabilityOverrideDto }
  | { success: false; error: string };

/**
 * Creates a time-off block for the signed-in expert. Validates input locally
 * (friendly early errors) then proxies to the Fastify route, which owns the DB
 * write + availability-cache rebuild. `expertProfileId` is derived server-side.
 */
export const createAvailabilityOverrideAction = withAuth(
  async (
    session,
    input: CreateAvailabilityOverrideInput
  ): Promise<CreateAvailabilityOverrideResult> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      return { success: false, error: 'No expert profile found' };
    }

    const parsed = createOverrideSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid time-off dates',
      };
    }

    try {
      const data = await calendarApiFetch<{ override: AvailabilityOverrideDto }>(
        '/api/experts/availability-overrides',
        {
          method: 'POST',
          body: JSON.stringify({ expertProfileId, ...parsed.data }),
        }
      );

      log.info('Availability override created', {
        userId: session.user.id,
        expertProfileId,
        overrideId: data.override.id,
      });

      revalidatePath('/expert/settings');
      return { success: true, override: data.override };
    } catch (err: unknown) {
      log.error('Failed to create availability override', {
        userId: session.user.id,
        expertProfileId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to add time off',
      };
    }
  }
);
