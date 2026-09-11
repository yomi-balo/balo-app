'use server';
import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { expertsRepository } from '@balo/db';
import { applicationWaitingDays } from '@balo/shared/experts';
import { personWithOrgLabel } from '@balo/shared/parties';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { requireApplicationReviewer } from './_shared/require-application-reviewer';
import {
  APPLICATION_GONE,
  APPLICATION_NOT_PENDING,
  APPLICATION_GENERIC_FAILURE,
  type DecideApplicationActionResult,
} from './_shared/decision-outcome';

const inputSchema = z.object({ expertProfileId: z.uuid() }).strict();

/**
 * BAL-549 / ADR-1030 — approve an expert application. Gated on `REVIEW_EXPERT_APPLICATIONS`
 * (D7), re-resolved here rather than leaning on `admin/layout.tsx`'s `VIEW_PLATFORM_ADMIN` gate.
 *
 * Both pending labels are accepted (D4) — `decideApplication` itself decides what "pending"
 * means; this action does not narrow it.
 *
 * ⚠ `expert.approved`'s `correlationId` is the repository-returned `auditEventId`, NOT
 * `expertProfileId` (orchestrator §20.1 / plan §6.3) — a per-WRITE key, matching D5's reasoning
 * for the decline arm: a re-approve after a decline-and-reapply must not be deduped away against
 * a retained BullMQ job. Same payload type, same Zod arm (both uuids) — no schema change.
 */
export async function approveExpertApplicationAction(
  input: z.infer<typeof inputSchema>
): Promise<DecideApplicationActionResult> {
  const auth = await requireApplicationReviewer();
  if (!auth.ok) {
    return { success: false, error: auth.error, code: 'denied' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { expertProfileId } = parsed.data;

  try {
    const result = await expertsRepository.decideApplication({
      expertProfileId,
      actorUserId: auth.user.id,
      decision: 'approve',
    });

    switch (result.outcome) {
      case 'not_found':
        return { success: false, error: APPLICATION_GONE, code: 'gone' };
      case 'not_pending':
        return { success: false, error: APPLICATION_NOT_PENDING, code: 'not_pending' };
      case 'decided':
        break;
      default:
        return result satisfies never;
    }

    log.info('Expert application approved', {
      expertProfileId,
      actorUserId: auth.user.id,
      applicantUserId: result.applicantUserId,
      previousStatus: result.previousStatus,
      auditEventId: result.auditEventId,
    });

    // ⚠ POST-COMMIT. `correlationId` is the audit row id — per WRITE, never per state.
    publishNotificationEvent('expert.approved', {
      correlationId: result.auditEventId,
      userId: result.applicantUserId,
      expertProfileId,
    }).catch(() => {
      // publishNotificationEvent logs internally
    });

    revalidatePath('/admin/applications');
    revalidatePath(`/admin/applications/${expertProfileId}`);

    const decidedByLabel = personWithOrgLabel(
      [auth.user.firstName, auth.user.lastName].filter(Boolean).join(' '),
      'Balo'
    );

    return {
      success: true,
      analytics: {
        decision: 'approved',
        days_waiting: applicationWaitingDays(result.submittedAt, new Date()),
      },
      decidedByLabel,
    };
  } catch (error) {
    log.error('Failed to approve expert application', {
      expertProfileId,
      actorUserId: auth.user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: APPLICATION_GENERIC_FAILURE };
  }
}
