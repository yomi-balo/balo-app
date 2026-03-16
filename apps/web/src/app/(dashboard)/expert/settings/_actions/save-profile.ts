'use server';
import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { expertsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { USERNAME_REGEX, RESERVED_USERNAMES, USERNAME_MIN, USERNAME_MAX } from './username-rules';

const saveProfileSchema = z.object({
  headline: z.string().max(100).optional(),
  bio: z.string().max(1000).optional(),
  username: z
    .string()
    .min(USERNAME_MIN)
    .max(USERNAME_MAX)
    .regex(USERNAME_REGEX, 'Username must be lowercase letters, numbers, and hyphens')
    .optional()
    .nullable()
    .or(z.literal('')),
  industryIds: z.array(z.string().uuid()).max(20).optional(),
  languages: z
    .array(
      z.object({
        languageId: z.string().uuid(),
        proficiency: z.enum(['beginner', 'intermediate', 'advanced', 'native']),
      })
    )
    .max(10)
    .optional(),
});

export interface SaveProfileInput {
  headline?: string;
  bio?: string;
  username?: string | null;
  industryIds?: string[];
  languages?: Array<{
    languageId: string;
    proficiency: 'beginner' | 'intermediate' | 'advanced' | 'native';
  }>;
}

export interface SaveProfileResult {
  success: boolean;
  error?: string;
}

export const saveProfileAction = withAuth(
  async (session, input: SaveProfileInput): Promise<SaveProfileResult> => {
    try {
      const validated = saveProfileSchema.parse(input);

      if (session.user.activeMode !== 'expert' || !session.user.expertProfileId) {
        return { success: false, error: 'Expert profile required' };
      }

      const expertProfileId = session.user.expertProfileId;

      // Check username availability if provided
      const usernameToSave = validated.username || null;
      if (usernameToSave) {
        if (RESERVED_USERNAMES.has(usernameToSave)) {
          return { success: false, error: 'This username is reserved' };
        }
        const isAvailable = await expertsRepository.checkUsernameAvailability(
          usernameToSave,
          expertProfileId
        );
        if (!isAvailable) {
          return { success: false, error: 'Username already taken' };
        }
      }

      // Update profile scalars
      await expertsRepository.updateProfile(expertProfileId, {
        headline: validated.headline ?? null,
        bio: validated.bio ?? null,
        username: usernameToSave,
      });

      // Sync industries if provided
      if (validated.industryIds) {
        await expertsRepository.syncIndustries(expertProfileId, validated.industryIds);
      }

      // Sync languages if provided
      if (validated.languages) {
        await expertsRepository.syncLanguages(expertProfileId, validated.languages);
      }

      log.info('Expert profile saved', {
        expertProfileId,
        userId: session.user.id,
        hasHeadline: !!validated.headline,
        hasBio: !!validated.bio,
        hasUsername: !!usernameToSave,
      });

      revalidatePath('/expert/settings');

      return { success: true };
    } catch (error) {
      log.error('Failed to save expert profile', {
        userId: session.user.id,
        expertProfileId: session.user.expertProfileId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (error instanceof z.ZodError) {
        return { success: false, error: error.issues[0]?.message ?? 'Invalid input' };
      }

      return { success: false, error: 'Failed to save profile. Please try again.' };
    }
  }
);
