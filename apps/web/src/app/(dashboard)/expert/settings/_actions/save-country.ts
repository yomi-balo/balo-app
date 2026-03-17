'use server';
import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { usersRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { getCountryByCode } from '@/lib/constants/countries';

const saveCountrySchema = z.object({
  countryCode: z.string().length(2).or(z.literal('')),
});

export interface SaveCountryResult {
  success: boolean;
  error?: string;
}

export const saveCountryAction = withAuth(
  async (session, input: { countryCode: string | null }): Promise<SaveCountryResult> => {
    try {
      const validated = saveCountrySchema.parse({ countryCode: input.countryCode ?? '' });
      const countryCodeToSave = validated.countryCode || null;
      const countryInfo = countryCodeToSave ? getCountryByCode(countryCodeToSave) : null;

      await usersRepository.update(session.user.id, {
        countryCode: countryCodeToSave,
        country: countryInfo?.name ?? null,
      });

      log.info('User country updated', {
        userId: session.user.id,
        countryCode: countryCodeToSave,
      });

      revalidatePath('/expert/settings');
      return { success: true };
    } catch (error) {
      log.error('Failed to save country', {
        userId: session.user.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (error instanceof z.ZodError) {
        return { success: false, error: error.issues[0]?.message ?? 'Invalid input' };
      }

      return { success: false, error: 'Failed to save country. Please try again.' };
    }
  }
);
