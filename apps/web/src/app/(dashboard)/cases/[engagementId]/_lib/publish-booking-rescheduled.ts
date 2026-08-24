import 'server-only';

import { errorMessage, log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { resolveNotificationLabels } from './reschedule-notification-labels';

/**
 * Fix round 2 item 2 — THE SHARED LABEL-RESOLUTION + AUDIT-ID FALLBACK + `booking.rescheduled`
 * PUBLISH ENVELOPE, extracted. `reschedule-consultation.ts` (the client's direct move) and
 * `respond-to-reschedule-proposal.ts`'s accept path (the client committing the expert's ask) each
 * carried a byte-identical copy of this block — both are a COMMITTED move that fans out the SAME
 * event, differing only in `initiatedBy` and a caller-specific extra `logContext` field.
 * `declineRescheduleProposalAction` does NOT call this — nothing moved, and it publishes a
 * different event (`reschedule_proposal.declined`) with its own label resolution.
 * `withdrawRescheduleProposalAction` publishes nothing at all (§D5).
 *
 * ⚠ THE LABELS ARE AWAITED; THE PUBLISH ITSELF IS NOT. `publishNotificationEvent` must be
 * called SYNCHRONOUSLY within the caller's own await chain (the `book-consultation.ts`
 * precedent) so Next's `after()` (inside it) can still register against the live request
 * context — calling it from a `.then()` continuation on a promise created elsewhere risks that
 * context having already been torn down by the time the continuation runs. This function's own
 * `await` on the caller's side achieves that: resolving the labels first costs two small
 * column-projected reads, not a second network hop, and the publish call itself is never
 * awaited by anyone.
 *
 * ⚠ THE FALLBACK IS A DEPLOY-SKEW SAFETY NET, NOT A NORMAL PATH — so it is LOUD. A `changed:
 * true` / committed response always carries `rescheduleAuditId`; if it does not, the web is
 * running against an older API and every reschedule silently reverts to the window-derived key,
 * reinstating the A→B→C→B collision that drops both party emails. Silence there would make a
 * real regression indistinguishable from correct behaviour.
 */
export interface PublishBookingRescheduledInput {
  meetingId: string;
  engagementId: string;
  companyId: string;
  expertProfileId: string;
  caseTitle: string;
  recipientId: string;
  /** ISO. The server's committed PREVIOUS window start — never the client's submitted slot. */
  previousScheduledStart: string;
  /** ISO. The server's committed NEW window start — never the client's submitted slot. */
  scheduledStart: string;
  durationMinutes: number;
  /** The `meeting.rescheduled` audit row id — the dedup key. `undefined` ⇒ deploy-skew fallback. */
  rescheduleAuditId: string | undefined;
  /** `'client'` for a direct reschedule; `'expert'` when the move originated with their ask. */
  initiatedBy: 'client' | 'expert';
  /** Merged into the `rescheduleAuditId`-missing warn's log context (e.g. `{ proposalId }`). */
  logContext?: Record<string, unknown>;
}

export async function publishBookingRescheduled(
  input: PublishBookingRescheduledInput
): Promise<void> {
  const {
    meetingId,
    engagementId,
    companyId,
    expertProfileId,
    caseTitle,
    recipientId,
    previousScheduledStart,
    scheduledStart,
    durationMinutes,
    rescheduleAuditId,
    initiatedBy,
    logContext,
  } = input;

  const labels = await resolveNotificationLabels(companyId, expertProfileId).catch(
    (error: unknown) => {
      log.error('Failed to resolve booking.rescheduled labels — publishing with fallbacks', {
        meetingId,
        engagementId,
        error: errorMessage(error),
      });
      return {
        clientCompanyName: 'your company',
        expertPartyLabel: 'Your expert',
        expertPersonLabel: 'Your expert',
      };
    }
  );

  if (rescheduleAuditId === undefined) {
    log.warn('Reschedule response carried no rescheduleAuditId — falling back to a window key', {
      meetingId,
      engagementId,
      ...logContext,
    });
  }

  // Fire-and-forget by contract — `publishNotificationEvent` never throws (see its own
  // docblock); nothing here needs a `.catch()`.
  publishNotificationEvent('booking.rescheduled', {
    // ⚠ THE AUDIT ROW ID, NOT THE TARGET WINDOW — see this module's own docblock.
    correlationId: `${meetingId}:${rescheduleAuditId ?? scheduledStart}`,
    meetingId,
    engagementId,
    recipientId,
    expertProfileId,
    clientCompanyName: labels.clientCompanyName,
    expertPartyLabel: labels.expertPartyLabel,
    caseTitle,
    previousScheduledStartIso: previousScheduledStart,
    scheduledStartIso: scheduledStart,
    durationMinutes,
    initiatedBy,
  });
}
