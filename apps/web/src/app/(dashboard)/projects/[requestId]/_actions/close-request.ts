'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { projectRequestsRepository, InvalidStatusTransitionError } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';
import { runCloseRequestFanout } from './_shared/close-request-fanout';

const inputSchema = z.object({ requestId: z.uuid() }).strict();

const NOT_SIGNED_IN = 'You are not signed in.';
const PERMISSION_DENIED = 'You do not have permission to do this.';
const NOT_CLOSABLE = 'This request can no longer be closed.';
const GENERIC_FAILURE = 'Could not close the request. Please try again.';

export type CloseRequestActionResult =
  | {
      success: true;
      analytics: {
        reason: 'withdrawn';
        actorKind: 'client';
        stageAtClose: string;
        openTracks: number;
        openProposals: number;
        expertsTold: number;
      };
    }
  | { success: false; error: string; code?: 'not_closable' | 'denied' };

/**
 * Client closes their own request (BAL-540) — a withdrawal. `reason` is NOT an input: a
 * client's only reason is `'withdrawn'`, so it is STATED, not chosen (design ref
 * `request-close.jsx:849-852`), and there is no note field on this arm at all.
 *
 * Capability-gated on membership `MANAGE_REQUESTS` (D7) — its first gate call site — scoped to
 * the request's OWN company. No `requireAdmin()`, no `lens ===` anywhere. `relationshipId` is
 * not involved here — this ends the whole request, not one track.
 *
 * The cascade (`projectRequestsRepository.close`) does everything transactionally: declines
 * every live track, withdraws every open proposal, cancels every still-`scheduled` request-grain
 * meeting, revokes request-scoped representations, and writes the `project_request.closed`
 * audit row. This action's job after the commit is the POST-COMMIT fan-out (api teardown +
 * `project.request_closed`), deferred so a function freeze cannot drop it (BAL-279).
 */
export async function closeRequestAction(
  input: z.infer<typeof inputSchema>
): Promise<CloseRequestActionResult> {
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

  // ⚠ THE READ MUST PRECEDE THE GATE (it supplies `companyId`) — SO THE DENIAL MUST COLLAPSE.
  // "Missing" and "not yours" leave here as ONE opaque literal: a distinguishable `gone` would
  // be a pre-authorization existence oracle, telling any authenticated user holding a stale
  // request UUID whether that request still exists. Same discipline as `request-proposal.ts`'s
  // uniform non-leaking copy and `get-request-file-download.ts`'s byte-identical tombstone.
  // (The ADMIN arms keep their `gone` arm legitimately — they resolve `hasPlatformCapability`
  // BEFORE the read, so their distinction is post-authorization.)
  const request = await projectRequestsRepository.findByIdWithRelations(requestId);
  if (
    request === undefined ||
    !(await hasCapability(user, CAPABILITIES.MANAGE_REQUESTS, { companyId: request.companyId }))
  ) {
    return { success: false, error: PERMISSION_DENIED, code: 'denied' };
  }

  try {
    const result = await projectRequestsRepository.close({
      requestId,
      actorUserId: user.id,
      actorKind: 'client',
      reason: 'withdrawn',
      note: null,
    });

    log.info('Project request closed', {
      requestId,
      actorUserId: user.id,
      actorKind: 'client',
      reason: 'withdrawn',
      previousStatus: result.previousStatus,
      tracksDeclined: result.declinedTracks.length,
      proposalsWithdrawn: result.withdrawnProposalIds.length,
      meetingsCancelled: result.cancelledMeetings.length,
    });

    runCloseRequestFanout(result, {
      title: request.title,
      clientCompanyName: request.company.name,
      createdByUserId: request.createdByUserId,
      closedBy: 'client',
      reason: 'withdrawn',
    });

    revalidatePath(`/projects/${requestId}`);
    revalidatePath('/projects');

    return {
      success: true,
      analytics: {
        reason: 'withdrawn',
        actorKind: 'client',
        stageAtClose: result.previousStatus,
        openTracks: result.declinedTracks.length,
        openProposals: result.withdrawnProposalIds.length,
        // The tracks that were live at close, approximated to the underlying USER count the
        // fan-out resolves post-commit (a soft-deleted user is the only divergence).
        expertsTold: result.declinedTracks.length,
      },
    };
  } catch (error) {
    if (error instanceof InvalidStatusTransitionError) {
      return { success: false, error: NOT_CLOSABLE, code: 'not_closable' };
    }
    log.error('Failed to close project request', {
      requestId,
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
