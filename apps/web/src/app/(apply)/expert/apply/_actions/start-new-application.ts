'use server';
import 'server-only';

import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { expertsRepository, referenceDataRepository } from '@balo/db';
import { applicationWaitingDays } from '@balo/shared/experts';
import { formatLongUtc } from '@/lib/format/utc-date';
import { log } from '@/lib/logging';
import { trackServerAndFlush, EXPERT_SERVER_EVENTS } from '@/lib/analytics/server';
import { reopenCooldownError } from './declined-application-copy';

/**
 * BAL-557 — "Start a new application" (`rejected → draft`). The ONLY route back to a writable
 * row for a declined applicant.
 *
 * ⚠⚠ TAKES NO ARGUMENTS. `expertsRepository.reopenApplication` resolves the profile from
 * `session.user.id` under its own row lock — there is no caller-supplied profile id, so a
 * caller can only ever act on their own application (ownership holds by construction).
 */
export type StartNewApplicationResult =
  | { success: true; alreadyOpen: false; daysSinceDecision: number }
  | { success: true; alreadyOpen: true }
  | { success: false; code: 'cooldown_active'; availableOn: string; error: string }
  | { success: false; code: 'not_rejected' | 'not_found' | 'failed'; error: string };

export const startNewApplicationAction = withAuth(
  async (session): Promise<StartNewApplicationResult> => {
    try {
      const vertical = await referenceDataRepository.getSalesforceVertical();
      const now = new Date();
      const result = await expertsRepository.reopenApplication({
        applicantUserId: session.user.id,
        verticalId: vertical.id,
        now,
      });

      if (result.outcome === 'reopened') {
        log.info('Expert application reopened', {
          userId: session.user.id,
          expertProfileId: result.expertProfileId,
          auditEventId: result.auditEventId,
        });
        const daysSinceDecision = applicationWaitingDays(result.decidedAt, now);
        trackServerAndFlush(EXPERT_SERVER_EVENTS.APPLICATION_RESTARTED, {
          expert_profile_id: result.expertProfileId,
          days_since_decision: daysSinceDecision,
          distinct_id: session.user.id,
        });
        revalidatePath('/expert/apply');
        return {
          success: true,
          alreadyOpen: false,
          daysSinceDecision,
        };
      }

      if (result.outcome === 'not_rejected') {
        // A double click or a second tab: the row is already back to `draft`. Not an error.
        if (result.currentStatus === 'draft') {
          return { success: true, alreadyOpen: true };
        }
        log.warn('Start-new-application refused: application not rejected', {
          userId: session.user.id,
          currentStatus: result.currentStatus,
        });
        return {
          success: false,
          code: 'not_rejected',
          error: 'This application is not declined, so there is nothing to restart.',
        };
      }

      if (result.outcome === 'cooldown_active') {
        const availableOn = formatLongUtc(result.availableAt);
        log.warn('Start-new-application refused: cooldown active', {
          userId: session.user.id,
          availableAt: result.availableAt.toISOString(),
        });
        return {
          success: false,
          code: 'cooldown_active',
          availableOn,
          error: reopenCooldownError(availableOn),
        };
      }

      return {
        success: false,
        code: 'not_found',
        error: 'We could not find an application to restart.',
      };
    } catch (error) {
      log.error('Failed to start a new expert application', {
        userId: session.user.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return {
        success: false,
        code: 'failed',
        error: 'Something went wrong starting your new application. Please try again.',
      };
    }
  }
);
