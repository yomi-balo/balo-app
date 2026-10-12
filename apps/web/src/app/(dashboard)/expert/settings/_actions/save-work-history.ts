'use server';
import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveApprovedExpert, APPROVED_EXPERT_REQUIRED_ERROR } from '@/lib/auth/approved-expert';
import { expertsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { responsibilitiesFieldSchema } from '@/lib/expert-profile/work-history-responsibilities';
import { sanitizeResponsibilitiesHtml } from '@/lib/sanitize/work-history-html';

const dateFormatRegex = /^\d{4}-\d{2}-\d{2}$/;

const saveWorkHistorySchema = z.object({
  entries: z
    .array(
      z.object({
        role: z.string().min(1).max(200),
        company: z.string().min(1).max(200),
        startedAt: z.string().regex(dateFormatRegex, 'Invalid date format'),
        endedAt: z.string().regex(dateFormatRegex, 'Invalid date format').optional(),
        isCurrent: z.boolean(),
        // Rich-text HTML (or a legacy plain-text value) — sanitised before persist.
        responsibilities: responsibilitiesFieldSchema.optional(),
      })
    )
    .max(50),
});

export interface SaveWorkHistoryInput {
  entries: Array<{
    role: string;
    company: string;
    startedAt: string;
    endedAt?: string;
    isCurrent: boolean;
    responsibilities?: string;
  }>;
}

export interface SaveWorkHistoryResult {
  success: boolean;
  error?: string;
}

export const saveWorkHistoryAction = withAuth(
  async (session, input: SaveWorkHistoryInput): Promise<SaveWorkHistoryResult> => {
    try {
      const validated = saveWorkHistorySchema.parse(input);

      const gate = await resolveApprovedExpert(session.user);
      if (!gate.ok) {
        return { success: false, error: APPROVED_EXPERT_REQUIRED_ERROR };
      }

      // BAL-557 — one transaction under the profile row lock, so this save and a staff edit
      // serialise instead of deadlocking.
      const saveResult = await expertsRepository.saveSettingsWorkHistory(
        gate.expertProfileId,
        validated.entries.map((entry) => ({
          ...entry,
          responsibilities: sanitizeResponsibilitiesHtml(entry.responsibilities),
        }))
      );

      if (saveResult.outcome === 'not_found') {
        return { success: false, error: 'Expert profile required' };
      }

      log.info('Work history saved', {
        expertProfileId: gate.expertProfileId,
        userId: session.user.id,
        entryCount: validated.entries.length,
      });

      revalidatePath('/expert/settings');

      return { success: true };
    } catch (error) {
      log.error('Failed to save work history', {
        userId: session.user.id,
        expertProfileId: session.user.expertProfileId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (error instanceof z.ZodError) {
        return { success: false, error: error.issues[0]?.message ?? 'Invalid input' };
      }

      return { success: false, error: 'Failed to save work history. Please try again.' };
    }
  }
);
