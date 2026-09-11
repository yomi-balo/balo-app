'use server';
import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { expertsRepository } from '@balo/db';
import { EXPERT_DECLINE_REASONS, applicationWaitingDays } from '@balo/shared/experts';
import { personWithOrgLabel } from '@balo/shared/parties';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { DECLINE_NOTE_MIN_LENGTH } from '../_lib/decline-copy';
import { requireApplicationReviewer } from './_shared/require-application-reviewer';
import {
  APPLICATION_GONE,
  APPLICATION_NOT_PENDING,
  APPLICATION_GENERIC_FAILURE,
  type DecideApplicationActionResult,
} from './_shared/decision-outcome';

const inputSchema = z
  .object({
    expertProfileId: z.uuid(),
    reason: z.enum(EXPERT_DECLINE_REASONS),
    /*
      REQUIRED — staff-only, NEVER applicant-lens-serialised. The SHAPE is
      `close-request-as-admin.ts`'s; only the shape, not its auth idiom (D7).

      ⚠ THE MINIMUM IS IMPORTED, NOT RESTATED (fix round, F14). `DECLINE_NOTE_MIN_LENGTH` is
      what `decline-application-sheet.tsx` enables its Confirm button on; a hand-copied `8` here
      let the two drift, and the drift is silent in the worst direction — the sheet says
      "confirm", the server says "invalid request". `decline-copy.ts` is client-safe (no
      `server-only`, no `@balo/db`), so this import is one-directional and legal.
    */
    note: z.string().trim().min(DECLINE_NOTE_MIN_LENGTH).max(2000),
  })
  .strict();

/**
 * BAL-549 / ADR-1030 — decline an expert application. Gated on `REVIEW_EXPERT_APPLICATIONS`
 * (D7), re-resolved here rather than leaning on `admin/layout.tsx`'s `VIEW_PLATFORM_ADMIN` gate.
 *
 * The stored `application_status` is `'rejected'`; every surface — this log line, the audit
 * action, the notification event and the applicant email — says "declined" (D2), deliberately.
 *
 * ⚠ THE PAYLOAD CARRIES NO NOTE FIELD, AND NO ACTOR ID. No note field means the leak is
 * structurally unrepresentable. No actor id because `payload.userId` drives BOTH `data.user`
 * hydration and the `self` recipient path — carrying the staffer's id under any key the resolver
 * reads would risk mailing them.
 */
export async function declineExpertApplicationAction(
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
  const { expertProfileId, reason, note } = parsed.data;

  try {
    const result = await expertsRepository.decideApplication({
      expertProfileId,
      actorUserId: auth.user.id,
      decision: 'decline',
      reason,
      note,
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

    // ⚠ NEVER `note` — the staff note stays in the DB only.
    log.info('Expert application declined', {
      expertProfileId,
      actorUserId: auth.user.id,
      applicantUserId: result.applicantUserId,
      previousStatus: result.previousStatus,
      reason,
      auditEventId: result.auditEventId,
    });

    // ⚠ `.`-JOINED, NEVER `:`-JOINED — colon-free by construction. Per WRITE, not per state
    // (D5): a re-decline of the same profile must not be deduped away against a retained
    // completed BullMQ job.
    const correlationId = `expert-application-declined.${expertProfileId}.${result.auditEventId}`;
    publishNotificationEvent('expert.application_declined', {
      correlationId,
      userId: result.applicantUserId,
      expertProfileId,
      reason,
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
        decision: 'declined',
        days_waiting: applicationWaitingDays(result.submittedAt, new Date()),
        reason,
      },
      decidedByLabel,
    };
  } catch (error) {
    log.error('Failed to decline expert application', {
      expertProfileId,
      actorUserId: auth.user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: APPLICATION_GENERIC_FAILURE };
  }
}
