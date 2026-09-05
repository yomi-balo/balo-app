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
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { toDeclineTrackStage } from './_shared/decline-track-stage';

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
 * since both are Balo acting as the client's proxy on this request. NOT `requireAdmin()`.
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

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, relationshipId } = parsed.data;

  const request = await projectRequestsRepository.findByIdWithRelations(requestId);
  if (request === undefined) {
    return { success: false, error: REQUEST_GONE, code: 'gone' };
  }

  // IDOR guard — the relationship must belong to THIS request, even for the Balo proxy arm.
  const relationship = request.relationships.find((r) => r.id === relationshipId);
  if (relationship === undefined) {
    return { success: false, error: NOT_DECLINABLE, code: 'not_declinable' };
  }

  try {
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

    publishNotificationEvent('project.track_declined', {
      correlationId: result.declineAuditId,
      projectRequestId: requestId,
      relationshipId,
      expertProfileId: result.relationship.expertProfileId,
      title: request.title,
      clientCompanyName: request.company.name,
      declinedBy: 'balo',
      stage,
      hadOpenProposal: result.hadOpenProposal,
    }).catch(() => {
      // publishNotificationEvent logs internally.
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
