'use server';
import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { isValidTimezone } from '@balo/shared/timezone';
import { withAuth } from '@/lib/auth/with-auth';
import { log, errorMessage } from '@/lib/logging';
import { internalApiFetch } from '../_lib/internal-api';
import { scheduleRulesSchema } from '../_lib/schedule-helpers';
import type { ScheduleData } from '../_types/schedule';

// Bounds mirror the CHECK constraints on `expert_profiles` and the API route.
const bookingSettingsSchema = z.object({
  bufferBeforeMinutes: z.number().int().min(0).max(120),
  bufferAfterMinutes: z.number().int().min(0).max(120),
  minimumNoticeMinutes: z.number().int().min(0).max(20160), // ≤ 14 days
});

const saveScheduleSchema = z.object({
  timezone: z.string().refine(isValidTimezone, 'Invalid timezone'),
  bookingSettings: bookingSettingsSchema,
  rules: scheduleRulesSchema,
});

export type SaveScheduleInput = ScheduleData;

export interface SaveScheduleResult {
  success: boolean;
  error?: string;
}

/**
 * Persists the signed-in expert's weekly hours, booking rules, and timezone.
 * IDOR gate: the expertProfileId is derived from the session, never the client body.
 */
export const saveScheduleAction = withAuth(
  async (session, input: SaveScheduleInput): Promise<SaveScheduleResult> => {
    if (session.user.activeMode !== 'expert' || !session.user.expertProfileId) {
      return { success: false, error: 'Expert profile required' };
    }
    const expertProfileId = session.user.expertProfileId;

    try {
      const payload = saveScheduleSchema.parse(input);

      await internalApiFetch<{ success: boolean }>(
        `/api/experts/${expertProfileId}/schedule`,
        // actorUserId is the session user (audit attribution only, ADR-1030) — the
        // IDOR gate remains the session-derived expertProfileId above.
        { method: 'POST', body: JSON.stringify({ ...payload, actorUserId: session.user.id }) },
        'schedule-api'
      );

      log.info('Expert schedule saved', {
        userId: session.user.id,
        expertProfileId,
        daysEnabled: new Set(payload.rules.map((rule) => rule.dayOfWeek)).size,
        ruleCount: payload.rules.length,
      });

      // Recompute the setup checklist (availability + searchable flip).
      revalidatePath('/expert/settings');

      return { success: true };
    } catch (err: unknown) {
      log.error('Failed to save expert schedule', {
        userId: session.user.id,
        expertProfileId,
        error: errorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });

      if (err instanceof z.ZodError) {
        return { success: false, error: err.issues[0]?.message ?? 'Invalid schedule' };
      }
      return { success: false, error: 'Failed to save schedule. Please try again.' };
    }
  }
);
