'use server';
import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { expertsRepository } from '@balo/db';
import { log } from '@/lib/logging';

const dateFormatRegex = /^\d{4}-\d{2}-\d{2}$/;

const saveCertificationsSchema = z.object({
  certifications: z
    .array(
      z.object({
        certificationId: z.string().uuid(),
        earnedAt: z.string().regex(dateFormatRegex, 'Invalid date format').optional(),
        expiresAt: z.string().regex(dateFormatRegex, 'Invalid date format').optional(),
        credentialUrl: z.string().max(2000).optional(),
      })
    )
    .max(100),
  trailheadUrl: z.string().url().optional().nullable().or(z.literal('')),
});

export interface SaveCertificationsInput {
  certifications: Array<{
    certificationId: string;
    earnedAt?: string;
    expiresAt?: string;
    credentialUrl?: string;
  }>;
  trailheadUrl?: string | null;
}

export interface SaveCertificationsResult {
  success: boolean;
  error?: string;
}

export const saveCertificationsAction = withAuth(
  async (session, input: SaveCertificationsInput): Promise<SaveCertificationsResult> => {
    try {
      const validated = saveCertificationsSchema.parse(input);

      if (session.user.activeMode !== 'expert' || !session.user.expertProfileId) {
        return { success: false, error: 'Expert profile required' };
      }

      const expertProfileId = session.user.expertProfileId;

      // Guard: if skills are locked, all existing certifications must remain
      const profile = await expertsRepository.findProfileForSettings(expertProfileId);
      if (profile?.skillsLocked) {
        const existingCertIds = new Set(profile.certifications.map((c) => c.certificationId));
        const incomingCertIds = new Set(validated.certifications.map((c) => c.certificationId));
        for (const existingId of existingCertIds) {
          if (!incomingCertIds.has(existingId)) {
            return {
              success: false,
              error: 'Cannot remove locked certifications. Contact support for changes.',
            };
          }
        }
      }

      // Sync certifications
      await expertsRepository.syncCertifications(expertProfileId, validated.certifications);

      // Update trailhead URL
      const trailheadUrl = validated.trailheadUrl || null;
      await expertsRepository.updateProfile(expertProfileId, { trailheadUrl });

      log.info('Certifications saved', {
        expertProfileId,
        userId: session.user.id,
        certCount: validated.certifications.length,
      });

      revalidatePath('/expert/settings');

      return { success: true };
    } catch (error) {
      log.error('Failed to save certifications', {
        userId: session.user.id,
        expertProfileId: session.user.expertProfileId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (error instanceof z.ZodError) {
        return { success: false, error: error.issues[0]?.message ?? 'Invalid input' };
      }

      return { success: false, error: 'Failed to save certifications. Please try again.' };
    }
  }
);
