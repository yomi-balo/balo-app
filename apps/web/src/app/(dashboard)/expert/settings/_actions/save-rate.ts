'use server';
import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { expertsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { PLATFORM_PRICING } from '@/lib/constants/platform';

const saveRateSchema = z.object({
  ratePerMinuteCents: z
    .number()
    .int('Rate must be a whole number of cents')
    .min(PLATFORM_PRICING.MIN_RATE_CENTS, 'Rate cannot be negative')
    .max(
      PLATFORM_PRICING.MAX_RATE_CENTS,
      `Rate cannot exceed ${PLATFORM_PRICING.CURRENCY_SYMBOL}${PLATFORM_PRICING.MAX_RATE_DOLLARS}/min`
    ),
});

export interface SaveRateInput {
  ratePerMinuteCents: number;
}

export interface SaveRateResult {
  success: boolean;
  error?: string;
}

export const saveRateAction = withAuth(
  async (session, input: SaveRateInput): Promise<SaveRateResult> => {
    try {
      // 1. Validate input
      const validated = saveRateSchema.parse(input);

      // 2. Verify expert mode
      if (session.user.activeMode !== 'expert' || !session.user.expertProfileId) {
        return { success: false, error: 'Expert profile required' };
      }

      // 3. Persist to database
      await expertsRepository.updateProfile(session.user.expertProfileId, {
        hourlyRate: validated.ratePerMinuteCents,
      });

      log.info('Expert rate saved', {
        expertProfileId: session.user.expertProfileId,
        userId: session.user.id,
        ratePerMinuteCents: validated.ratePerMinuteCents,
      });

      // 4. Revalidate the settings page so checklist picks up the new rate
      revalidatePath('/expert/settings');

      return { success: true };
    } catch (error) {
      log.error('Failed to save expert rate', {
        userId: session.user.id,
        expertProfileId: session.user.expertProfileId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (error instanceof z.ZodError) {
        return { success: false, error: error.issues[0]?.message ?? 'Invalid input' };
      }

      return { success: false, error: 'Failed to save rate. Please try again.' };
    }
  }
);
