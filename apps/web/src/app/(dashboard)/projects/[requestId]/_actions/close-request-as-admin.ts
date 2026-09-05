'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { projectRequestsRepository, InvalidStatusTransitionError } from '@balo/db';
import { BALO_CLOSE_REASONS, type BaloCloseReason } from '@balo/shared/project-requests';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { runCloseRequestFanout } from './_shared/close-request-fanout';

const inputSchema = z
  .object({
    requestId: z.uuid(),
    // ⚠ NEVER 'withdrawn' — that is the client's own reason (close-request.ts).
    reason: z.enum(BALO_CLOSE_REASONS),
    // REQUIRED, min 8 (design ref `request-close.jsx:690`) — staff-only, never client/expert
    // lens-serialised (D11).
    note: z.string().trim().min(8).max(2000),
  })
  .strict();

const NOT_SIGNED_IN = 'You are not signed in.';
const PERMISSION_DENIED = 'You do not have permission to do this.';
const REQUEST_GONE = 'This request no longer exists.';
const NOT_CLOSABLE = 'This request can no longer be closed.';
const GENERIC_FAILURE = 'Could not close the request. Please try again.';

export type CloseRequestAsAdminActionResult =
  | {
      success: true;
      analytics: {
        reason: BaloCloseReason;
        actorKind: 'balo';
        stageAtClose: string;
        openTracks: number;
        openProposals: number;
        expertsTold: number;
      };
    }
  | { success: false; error: string; code?: 'not_closable' | 'gone' | 'denied' };

/**
 * Balo closes a request on the client's behalf (BAL-540). Gated on the platform capability
 * `CLOSE_ANY_REQUEST` (D7) — the shape is `override-balo-fee.ts`'s (`hasPlatformCapability` +
 * `PLATFORM_CAPABILITIES`), NOT `request-proposal-as-admin.ts`'s `requireAdmin()`.
 *
 * The fan-out sets `recipientId = request.createdByUserId` — the client arm of the
 * `project.request_closed` rule is conditioned on it, so a Balo-initiated close is the ONLY
 * case that emails the client (a client closing their own request gets a toast, not an email).
 */
export async function closeRequestAsAdminAction(
  input: z.infer<typeof inputSchema>
): Promise<CloseRequestAsAdminActionResult> {
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
  const { requestId, reason, note } = parsed.data;

  const request = await projectRequestsRepository.findByIdWithRelations(requestId);
  if (request === undefined) {
    return { success: false, error: REQUEST_GONE, code: 'gone' };
  }

  try {
    const result = await projectRequestsRepository.close({
      requestId,
      actorUserId: user.id,
      actorKind: 'balo',
      reason,
      note,
    });

    // ⚠ NEVER `note` — the staff note stays in the DB only (D11).
    log.info('Project request closed', {
      requestId,
      actorUserId: user.id,
      actorKind: 'balo',
      reason,
      previousStatus: result.previousStatus,
      tracksDeclined: result.declinedTracks.length,
      proposalsWithdrawn: result.withdrawnProposalIds.length,
      meetingsCancelled: result.cancelledMeetings.length,
    });

    runCloseRequestFanout(result, {
      title: request.title,
      clientCompanyName: request.company.name,
      createdByUserId: request.createdByUserId,
      closedBy: 'balo',
      reason,
    });

    revalidatePath(`/projects/${requestId}`);
    revalidatePath('/projects');

    return {
      success: true,
      analytics: {
        reason,
        actorKind: 'balo',
        stageAtClose: result.previousStatus,
        openTracks: result.declinedTracks.length,
        openProposals: result.withdrawnProposalIds.length,
        expertsTold: result.declinedTracks.length,
      },
    };
  } catch (error) {
    if (error instanceof InvalidStatusTransitionError) {
      return { success: false, error: NOT_CLOSABLE, code: 'not_closable' };
    }
    log.error('Failed to close project request as admin', {
      requestId,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
