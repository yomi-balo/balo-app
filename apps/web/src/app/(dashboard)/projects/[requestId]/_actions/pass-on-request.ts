'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
  InvalidRelationshipTransitionError,
} from '@balo/db';
import { narrowToPassableRelationshipStatus } from '@balo/shared/project-requests';
import { requireOnboardedUser } from '@/lib/auth/session';
import { resolveApprovedExpert } from '@/lib/auth/approved-expert';
import { log } from '@/lib/logging';
import { publishNotificationEventNow } from '@/lib/notifications/publish';
import { runAfterResponse } from '@/lib/after-response';
import { trackServerAndFlush, PROJECT_SERVER_EVENTS } from '@/lib/analytics/server';
import { lockContentionFailure } from './_shared/deadlock';
import { expertDisplayName } from './_shared/expert-display-name';

// The relationship id is never client-supplied: it is derived server-side from the caller's own
// expert profile (mirrors `withdraw-eoi.ts`).
const inputSchema = z.object({ requestId: z.uuid() }).strict();

const NOT_SIGNED_IN = 'You are not signed in.';
const PERMISSION_DENIED = 'You do not have permission to do this.';
const NOT_PASSABLE = 'This project can no longer be passed on.';
const GENERIC_FAILURE = 'Could not pass on this project. Please try again.';

export type PassOnRequestActionResult =
  | { success: true }
  | { success: false; error: string; code?: 'denied' | 'not_passable' };

/**
 * An expert passes on a project request (BAL-604): their own live track ends as
 * `declined` / `expert_declined`, an open draft proposal is withdrawn, and the request status is
 * re-derived, all in one transaction under the per-request advisory lock.
 *
 * Authorized by identity: the loaded relationship's `expertProfileId` must be the caller's own
 * expert profile. The input is `{ requestId }` only. "Missing request", "not an expert" and "not
 * your track" leave as one opaque denial so the wire cannot be used as an existence oracle.
 *
 * Deliberately does NOT cancel the track's meetings or revoke file grants (decline precedent:
 * the file audience flips to historical-read off the columns this write stamps).
 */
export async function passOnRequestAction(
  input: z.infer<typeof inputSchema>
): Promise<PassOnRequestActionResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId } = parsed.data;

  try {
    const request = await projectRequestsRepository.findByIdWithRelations(requestId);
    if (request === undefined) {
      return { success: false, error: PERMISSION_DENIED, code: 'denied' };
    }

    const resolved = await resolveApprovedExpert(user);
    if (!resolved.ok) {
      return { success: false, error: PERMISSION_DENIED, code: 'denied' };
    }

    // One live row per expert per request, so `expertProfileId` alone finds the caller's track. A
    // row that is no longer passable (including `declined`) is a stale page, not a denial.
    const relationship = request.relationships.find(
      (r) => r.expertProfileId === resolved.expertProfileId
    );
    if (relationship === undefined) {
      return { success: false, error: PERMISSION_DENIED, code: 'denied' };
    }

    if (narrowToPassableRelationshipStatus(relationship.status) === null) {
      return { success: false, error: NOT_PASSABLE, code: 'not_passable' };
    }

    const relationshipId = relationship.id;
    const result = await requestExpertRelationshipsRepository.passTrack({
      relationshipId,
      actorUserId: user.id,
    });

    log.info('Request track passed', {
      requestId,
      relationshipId,
      actorUserId: user.id,
      fromStatus: result.previousStatus,
      withdrawnProposalCount: result.withdrawnProposalIds.length,
    });

    trackServerAndFlush(PROJECT_SERVER_EVENTS.PROJECT_TRACK_PASSED, {
      request_id: requestId,
      relationship_id: relationshipId,
      from_status: result.previousStatus,
      distinct_id: user.id,
    });

    // Deferred, not fire-and-forget: an un-awaited publish is at-most-once on Vercel and the pass
    // is already committed, so nothing would ever retry it. The publish helper logs its own
    // failures, so no `.catch` is needed.
    runAfterResponse('track pass fan-out', async () => {
      await publishNotificationEventNow('project.track_passed', {
        correlationId: result.auditId,
        projectRequestId: requestId,
        relationshipId,
        title: request.title,
        clientCompanyName: request.company.name,
        expertName: expertDisplayName(relationship),
        fromStatus: result.previousStatus,
        recipientId: request.createdByUserId,
        baloOwnerUserId: request.baloOwnerUserId,
      });
    });

    revalidatePath(`/projects/${requestId}`);
    revalidatePath('/projects');

    return { success: true };
  } catch (error) {
    if (error instanceof InvalidRelationshipTransitionError) {
      return { success: false, error: NOT_PASSABLE, code: 'not_passable' };
    }
    const contention = lockContentionFailure(
      error,
      'Request track pass aborted by lock contention — retryable',
      { requestId, actorUserId: user.id }
    );
    if (contention !== null) return contention;
    log.error('Failed to pass on request track', {
      requestId,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
