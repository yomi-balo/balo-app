import 'server-only';

import { expertsRepository, type CloseRequestResult } from '@balo/db';
import type { ProjectRequestCloseReason } from '@balo/shared/project-requests';
import { runAfterResponse } from '@/lib/after-response';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { postCancelledTeardown } from '@/lib/meetings/cancelled-teardown-api-client';
import { log } from '@/lib/logging';

/**
 * BAL-540 — everything a `close()` commit still owes AFTER the transaction has landed:
 * the api teardown for meetings the cascade cancelled, and the `project.request_closed`
 * telling. Server-only, NOT a `'use server'` module — it exports a non-async value
 * (`CloseRequestFanoutContext`), which a `'use server'` file may not do
 * (memory `reference_use_server_no_value_exports`).
 *
 * Deferred to `runAfterResponse` (BAL-279) so a Vercel function freeze right after the
 * Server Action returns cannot drop it — matching every other post-commit fan-out in this
 * directory (`request-proposal.ts`'s publish, `close()`'s own docblock).
 */
export interface CloseRequestFanoutContext {
  title: string;
  clientCompanyName: string;
  /** The request owner's user id — used as `recipientId` ONLY when Balo closed it. */
  createdByUserId: string;
  closedBy: 'client' | 'balo';
  reason: ProjectRequestCloseReason;
}

export function runCloseRequestFanout(
  result: CloseRequestResult,
  context: CloseRequestFanoutContext
): void {
  runAfterResponse('close fan-out', async () => {
    // The post-commit halves of every meeting the cascade cancelled: the availability-cache
    // rebuild and the Daily room teardown. Best-effort, non-fatal — see
    // `tearDownCancelledMeetings`'s docblock. No-ops on an empty list (nothing was live).
    await postCancelledTeardown(
      result.cancelledMeetings.map((meeting) => ({
        meetingId: meeting.meetingId,
        expertProfileId: meeting.expertProfileId,
      }))
    );

    // Resolve the USER ids behind every track that was live at close — the payload carries
    // USER ids, never expert-profile ids (BAL-408's `meeting_party_participants` precedent).
    //
    // ⚠ ISOLATED, DELIBERATELY. `runAfterResponse` only LOGS a rejected callback — there is no
    // retry — so letting this lookup throw would kill the WHOLE deferred callback, including
    // the client arm of a Balo-initiated close, which needs no expert ids at all. Degrade to an
    // empty recipient list instead: the skip logic below then does exactly the right thing
    // (empty + not-Balo ⇒ nothing to tell anyone, skip; Balo ⇒ the client is still emailed).
    // The `project.request_closed` payload has NO `.min(1)` on `recipientUserIds` for precisely
    // this reason — an empty list is a valid, meaningful payload on the Balo arm.
    // Cost of the degradation, stated: the experts on those tracks are not told. Their tracks
    // ARE declined (the transaction committed), so the request detail view already shows it.
    const expertProfileIds = result.declinedTracks.map((track) => track.expertProfileId);
    let recipientUserIds: string[] = [];
    try {
      recipientUserIds = await expertsRepository.findUserIdsByProfileIds(expertProfileIds);
    } catch (error) {
      log.error('Close fan-out could not resolve expert user ids — publishing without them', {
        projectRequestId: result.request.id,
        closeAuditId: result.closeAuditId,
        closedBy: context.closedBy,
        expertProfileCount: expertProfileIds.length,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }

    // Edge case 1 (decisions-bal-540.md, Observability) — a close with zero live tracks
    // resolves nobody to tell. Skip the publish entirely rather than sending an empty one,
    // UNLESS Balo closed it: the client arm (gated on `recipientId`) must still fire.
    if (recipientUserIds.length === 0 && context.closedBy !== 'balo') {
      return;
    }

    await publishNotificationEvent('project.request_closed', {
      correlationId: result.closeAuditId,
      projectRequestId: result.request.id,
      title: context.title,
      clientCompanyName: context.clientCompanyName,
      closedBy: context.closedBy,
      reason: context.reason,
      recipientUserIds,
      ...(context.closedBy === 'balo' ? { recipientId: context.createdByUserId } : {}),
    });
  });
}
