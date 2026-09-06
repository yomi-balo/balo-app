import 'server-only';

import type { CloseRequestResult } from '@balo/db';
import type { ProjectRequestCloseReason } from '@balo/shared/project-requests';
import { runAfterResponse } from '@/lib/after-response';
import { publishNotificationEventNow } from '@/lib/notifications/publish';
import { postCancelledTeardown } from '@/lib/meetings/cancelled-teardown-api-client';

/**
 * BAL-540 — everything a `close()` commit still owes AFTER the transaction has landed:
 * the `project.request_closed` telling, and the api teardown for meetings the cascade
 * cancelled. Server-only, NOT a `'use server'` module — it exports a non-async value
 * (`CloseRequestFanoutContext`), which a `'use server'` file may not do
 * (memory `reference_use_server_no_value_exports`).
 *
 * Deferred to `runAfterResponse` (BAL-279) so a Vercel function freeze right after the
 * Server Action returns cannot drop it — matching every other post-commit fan-out in this
 * directory (`request-proposal.ts`'s publish, `close()`'s own docblock).
 *
 * ⚠ IT PERFORMS NO READ OF ITS OWN, AND THAT IS THE DESIGN. `runAfterResponse` only LOGS a
 * rejected callback — there is no retry, and the close has already COMMITTED — so anything
 * this callback had to look up was a permanent way to lose the notice. The expert recipient
 * ids therefore arrive as COMMITTED STATE on `result.declinedTrackUserIds`, resolved inside
 * `close()`'s own transaction (step 7b). Nothing here can fail except the publish itself.
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
    // ⚠ THE TELLING GOES FIRST, THE JANITORIAL VENDOR CALLS SECOND — and it is the awaitable
    // `publishNotificationEventNow` precisely so that ordering is REAL. The plain
    // `publishNotificationEvent` only REGISTERS its POST with `runAfterResponse` and resolves
    // eagerly, so awaiting it here would have ordered the registration, not the request: the
    // POST would then have run after this whole callback, i.e. after the teardown. The `Now`
    // form performs the fetch inline, so it genuinely settles before the teardown starts. We
    // are already inside the deferred callback, which is the only place `Now` belongs.
    //
    // Why the telling first: people on those tracks matter more than a Daily room a lifecycle
    // sweep will reap anyway. Neither half throws (both log and swallow), so the ordering
    // costs the teardown nothing.
    //
    // Residual, stated honestly: this buys ORDER, not durability. `after()` is best-effort —
    // a hard kill (OOM / max-duration / eviction) still drops whatever has not run, with no
    // retry (BAL-279's documented caveat). A transactional outbox is the target; nothing here
    // is claimed to survive that.
    //
    // Edge case 1 (decisions-bal-540.md, Observability) — a close with zero live tracks
    // resolves nobody to tell, so the publish is SKIPPED rather than sent empty, UNLESS
    // Balo closed it: the client arm (gated on `recipientId`) must still fire. Expressed as
    // a condition rather than an early `return` precisely so the teardown below still runs.
    //
    // The `project.request_closed` payload has NO `.min(1)` on `recipientUserIds`
    // (`apps/api/src/routes/notifications/schema.ts` — `z.array(z.uuid()).max(50)`), which is
    // what makes the empty list on the Balo arm a valid, meaningful payload rather than a
    // schema violation.
    if (result.declinedTrackUserIds.length > 0 || context.closedBy === 'balo') {
      await publishNotificationEventNow('project.request_closed', {
        correlationId: result.closeAuditId,
        projectRequestId: result.request.id,
        title: context.title,
        clientCompanyName: context.clientCompanyName,
        closedBy: context.closedBy,
        reason: context.reason,
        // Copied, not aliased: the payload type is mutable and the result's is `readonly`.
        recipientUserIds: [...result.declinedTrackUserIds],
        ...(context.closedBy === 'balo' ? { recipientId: context.createdByUserId } : {}),
      });
    }

    // The post-commit halves of every meeting the cascade cancelled: the availability-cache
    // rebuild and the Daily room teardown. Best-effort, non-fatal — see
    // `postCancelledTeardown`'s docblock. No-ops on an empty list (nothing was live).
    await postCancelledTeardown(
      result.cancelledMeetings.map((meeting) => ({
        meetingId: meeting.meetingId,
        expertProfileId: meeting.expertProfileId,
      }))
    );
  });
}
