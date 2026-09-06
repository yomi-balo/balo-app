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
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { runAfterResponse } from '@/lib/after-response';
import { toDeclineTrackStage } from './_shared/decline-track-stage';
import { deadlockFailure } from './_shared/deadlock';

const inputSchema = z
  .object({
    requestId: z.uuid(),
    // A CLAIM — validated server-side against the loaded request's own relationships array,
    // never an authority (the IDOR discipline `request-proposal.ts:24-25` describes, without
    // importing `resolveConversationAccess` — that gate is a LENS gate and ADR-1029 forbids it
    // as an authorization input, D7).
    relationshipId: z.uuid(),
  })
  .strict();

const NOT_SIGNED_IN = 'You are not signed in.';
const PERMISSION_DENIED = 'You do not have permission to do this.';
const NOT_DECLINABLE = 'This track can no longer be declined.';
const GENERIC_FAILURE = 'Could not decline this track. Please try again.';

export type DeclineTrackActionResult =
  | {
      success: true;
      analytics: {
        stage: DeclinableRelationshipStatus;
        actorKind: 'client';
        hadOpenProposal: boolean;
      };
    }
  | { success: false; error: string; code?: 'not_declinable' | 'denied' };

/**
 * Client declines one expert's track on a request (BAL-540) — distinct from closing the whole
 * request. Capability-gated on membership `MANAGE_REQUESTS` (D7), scoped to the request's own
 * company. `relationshipId` is a CLAIM: after the capability gate, it must appear in the
 * loaded request's own `relationships` array before being touched — an IDOR guard that does
 * NOT route through a lens gate.
 *
 * Deliberately does NOT cancel the track's meetings (V2 — ADR-1046 "answers at call time
 * only") and does NOT revoke file grants (D9 — `resolveRequestTrackFileAccess` already flips
 * a declined track to historical-read, keyed off the columns this write stamps).
 */
export async function declineTrackAction(
  input: z.infer<typeof inputSchema>
): Promise<DeclineTrackActionResult> {
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
  const { requestId, relationshipId } = parsed.data;

  // ⚠ THE READ MUST PRECEDE THE GATE (it supplies `companyId`) — SO THE DENIAL MUST COLLAPSE.
  // "Missing" and "not yours" leave here as ONE opaque literal: a distinguishable `gone` would
  // be a pre-authorization existence oracle. Same discipline as `request-proposal.ts`'s uniform
  // non-leaking copy. The POST-authorization `NOT_DECLINABLE` below is a different thing and
  // stays: by then the caller has proven rights over this request.
  const request = await projectRequestsRepository.findByIdWithRelations(requestId);
  if (
    request === undefined ||
    !(await hasCapability(user, CAPABILITIES.MANAGE_REQUESTS, { companyId: request.companyId }))
  ) {
    return { success: false, error: PERMISSION_DENIED, code: 'denied' };
  }

  // IDOR guard — the relationship must belong to THIS request.
  const relationship = request.relationships.find((r) => r.id === relationshipId);
  if (relationship === undefined) {
    return { success: false, error: NOT_DECLINABLE, code: 'not_declinable' };
  }

  try {
    const result = await requestExpertRelationshipsRepository.declineTrack({
      relationshipId,
      actorUserId: user.id,
      reason: 'client_declined',
    });

    const stage = toDeclineTrackStage(result.previousStatus);

    log.info('Request track declined', {
      requestId,
      relationshipId,
      actorUserId: user.id,
      actorKind: 'client',
      previousStatus: result.previousStatus,
      hadOpenProposal: result.hadOpenProposal,
    });

    // ⚠ DEFERRED, NOT FIRE-AND-FORGET (BAL-279). An un-awaited promise started here is
    // at-most-once on Vercel: the Server Action returns, the instance freezes, and the expert
    // is never told their track ended — with the decline already COMMITTED, so nothing ever
    // retries it. `runAfterResponse` keeps the instance alive until the publish settles, the
    // same durability story the close cascade's fan-out uses (`_shared/close-request-fanout.ts`).
    // It never throws to us and logs its own rejections, so no `.catch` is needed here.
    runAfterResponse('track decline fan-out', async () => {
      await publishNotificationEvent('project.track_declined', {
        correlationId: result.declineAuditId,
        projectRequestId: requestId,
        relationshipId,
        expertProfileId: result.relationship.expertProfileId,
        title: request.title,
        clientCompanyName: request.company.name,
        declinedBy: 'client',
        stage,
        hadOpenProposal: result.hadOpenProposal,
      });
    });

    revalidatePath(`/projects/${requestId}`);

    return {
      success: true,
      analytics: {
        stage,
        actorKind: 'client',
        hadOpenProposal: result.hadOpenProposal,
      },
    };
  } catch (error) {
    if (error instanceof InvalidRelationshipTransitionError) {
      return { success: false, error: NOT_DECLINABLE, code: 'not_declinable' };
    }
    // `declineTrack` locks proposals → relationship → request; `promoteToSubmit` locks
    // relationship → request → proposal. Both statuses of the bridged proposal world are in
    // this cascade's lock set, so Postgres can abort this side with 40P01. Expected-rare and
    // self-healing (nothing was written) ⇒ WARN, and retryable copy. No new `code` value:
    // the result union is unchanged.
    const deadlock = deadlockFailure(
      error,
      'Request track decline aborted by a Postgres deadlock (40P01) — retryable',
      { requestId, relationshipId, actorUserId: user.id }
    );
    if (deadlock !== null) return deadlock;
    log.error('Failed to decline request track', {
      requestId,
      relationshipId,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
