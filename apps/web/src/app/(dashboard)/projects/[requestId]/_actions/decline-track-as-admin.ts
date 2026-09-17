'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
  InvalidRelationshipTransitionError,
} from '@balo/db';
import type { DeclinableRelationshipStatus } from '@balo/shared/project-requests';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { actorHoldsPlatformCapability } from '@/lib/authz/live-platform-capability';
import { log } from '@/lib/logging';
import { publishNotificationEventNow } from '@/lib/notifications/publish';
import { runAfterResponse } from '@/lib/after-response';
import { toDeclineTrackStage } from './_shared/decline-track-stage';
import { deadlockFailure } from './_shared/deadlock';

const inputSchema = z
  .object({
    requestId: z.uuid(),
    // A CLAIM — validated against the loaded request's own relationships array below.
    relationshipId: z.uuid(),
  })
  .strict();

const NOT_SIGNED_IN = 'You are not signed in.';
const PERMISSION_DENIED = 'You do not have permission to do this.';
const REQUEST_GONE = 'This request no longer exists.';
const NOT_DECLINABLE = 'This track can no longer be declined.';
const GENERIC_FAILURE = 'Could not decline this track. Please try again.';

export type DeclineTrackAsAdminActionResult =
  | {
      success: true;
      analytics: {
        stage: DeclinableRelationshipStatus;
        actorKind: 'balo';
        hadOpenProposal: boolean;
      };
    }
  | { success: false; error: string; code?: 'not_declinable' | 'gone' | 'denied' };

/**
 * Balo declines one expert's track on the client's behalf (BAL-540). Gated on the platform
 * capability `CLOSE_ANY_REQUEST` (D7) — the same admin token as `close-request-as-admin.ts`,
 * since both are Balo acting as the client's proxy on this request. NOT a platform-role set read
 * (the since-deleted `requireAdmin()`).
 *
 * Same non-effects as the client arm (V2, D9): no meeting cancellation, no file-grant
 * revocation — both flip for free / are out of scope, proved by test rather than by code.
 */
export async function declineTrackAsAdminAction(
  input: z.infer<typeof inputSchema>
): Promise<DeclineTrackAsAdminActionResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.CLOSE_ANY_REQUEST)) {
    return { success: false, error: PERMISSION_DENIED, code: 'denied' };
  }
  // ⚠ BAL-560 fix round 3 (R3) — THE SESSION GATE ABOVE IS NOT A REVOCATION BOUNDARY.
  // `checkSessionDrift` only runs during a page RENDER; this action POSTs straight to its own
  // endpoint, so a per-user override revoked days ago is still sealed in the cookie. Re-read the
  // LIVE row before mutating — the same reason, and the same shape, as the eight actions
  // converted in fix round 1 and as the impersonation entry point
  // (`lib/auth/actions/impersonation.ts`). The cheap synchronous check above stays: it fails
  // closed on an unauthenticated caller before this query is spent.
  if (!(await actorHoldsPlatformCapability(user.id, PLATFORM_CAPABILITIES.CLOSE_ANY_REQUEST))) {
    return { success: false, error: PERMISSION_DENIED, code: 'denied' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, relationshipId } = parsed.data;

  try {
    // BAL-546 (D4) — the read and the IDOR guard below were PREVIOUSLY outside this try: a
    // rejected read (e.g. a connection reset) threw an unhandled rejection instead of the
    // generic failure below.
    const request = await projectRequestsRepository.findByIdWithRelations(requestId);
    if (request === undefined) {
      return { success: false, error: REQUEST_GONE, code: 'gone' };
    }

    // IDOR guard — the relationship must belong to THIS request, even for the Balo proxy arm.
    const relationship = request.relationships.find((r) => r.id === relationshipId);
    if (relationship === undefined) {
      return { success: false, error: NOT_DECLINABLE, code: 'not_declinable' };
    }

    const result = await requestExpertRelationshipsRepository.declineTrack({
      relationshipId,
      actorUserId: user.id,
      reason: 'balo_declined',
    });

    const stage = toDeclineTrackStage(result.previousStatus);

    log.info('Request track declined', {
      requestId,
      relationshipId,
      actorUserId: user.id,
      actorKind: 'balo',
      previousStatus: result.previousStatus,
      hadOpenProposal: result.hadOpenProposal,
    });

    // ⚠ DEFERRED, NOT FIRE-AND-FORGET (BAL-279) — identical reasoning to the client arm:
    // an un-awaited promise is at-most-once on Vercel, and the decline has already COMMITTED,
    // so a dropped publish is a permanently un-sent expert notice with nothing to retry it.
    // ONE deferral, not two: this `runAfterResponse` is the deferral, so the POST inside it is
    // the awaitable `publishNotificationEventNow` rather than the self-deferring wrapper.
    // Neither ever throws to us; both log their own failures, so no `.catch` is needed here.
    runAfterResponse('track decline fan-out', async () => {
      await publishNotificationEventNow('project.track_declined', {
        correlationId: result.declineAuditId,
        projectRequestId: requestId,
        relationshipId,
        expertProfileId: result.relationship.expertProfileId,
        title: request.title,
        clientCompanyName: request.company.name,
        declinedBy: 'balo',
        stage,
        hadOpenProposal: result.hadOpenProposal,
      });
    });

    revalidatePath(`/projects/${requestId}`);

    return {
      success: true,
      analytics: {
        stage,
        actorKind: 'balo',
        hadOpenProposal: result.hadOpenProposal,
      },
    };
  } catch (error) {
    if (error instanceof InvalidRelationshipTransitionError) {
      return { success: false, error: NOT_DECLINABLE, code: 'not_declinable' };
    }
    // See `decline-track.ts` (F6) — BAL-546's per-request advisory lock makes the AB/BA cycle
    // this used to describe against `promoteToSubmit` unreachable; the mapping stays as a
    // cheap backstop over the residual left by writers outside the serialised set
    // (orchestrator D6). Expected-rare, self-healing, nothing written. Neutral "lock contention"
    // message, not a hardcoded SQLSTATE (fix round R5) — the actual code is logged as its own
    // `sqlstate` field instead.
    const deadlock = deadlockFailure(
      error,
      'Request track decline aborted by lock contention — retryable',
      { requestId, relationshipId, actorUserId: user.id }
    );
    if (deadlock !== null) return deadlock;
    log.error('Failed to decline request track as admin', {
      requestId,
      relationshipId,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
