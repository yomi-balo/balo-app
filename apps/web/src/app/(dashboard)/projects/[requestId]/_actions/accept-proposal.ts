'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  proposalsRepository,
  projectRequestsRepository,
  InvalidProposalTransitionError,
  InvalidRelationshipTransitionError,
  InvalidStatusTransitionError,
} from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';

const inputSchema = z.object({
  requestId: z.uuid(),
  // A CLAIM — validated by the access guard.
  relationshipId: z.uuid(),
  // The submitted proposal to accept — validated to be live, submitted, current,
  // and belong to the claimed relationship.
  proposalId: z.uuid(),
});

export type AcceptProposalInput = z.infer<typeof inputSchema>;

export type AcceptProposalResult =
  | {
      success: true;
      proposalId: string;
      expertProfileId: string;
      /** Whether the REQUEST aggregate advanced `proposal_submitted → accepted`. */
      transitioned: boolean;
    }
  | { success: false; error: string };

const NOT_SIGNED_IN = 'You are not signed in.';
const INVALID_REQUEST = 'Invalid request.';
const ONLY_CLIENT = 'Only the client can accept a proposal.';
const STALE_PROPOSAL = 'This proposal can no longer be accepted.';
const GENERIC_FAILURE = 'Could not accept this proposal. Please try again.';

/** Display name for the accepting client (notification body). */
function displayName(user: { firstName: string | null; lastName: string | null }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'The client';
}

/**
 * Advance the REQUEST aggregate `proposal_submitted → accepted` exactly once.
 * Race-tolerant: a concurrent accept that already advanced the aggregate trips
 * `InvalidStatusTransitionError`, which is benign. Returns whether THIS call
 * performed the transition.
 */
async function advanceRequestAggregate(requestId: string, currentStatus: string): Promise<boolean> {
  if (currentStatus !== 'proposal_submitted') {
    return false;
  }
  try {
    await projectRequestsRepository.transitionStatus({
      id: requestId,
      to: 'accepted',
      expectedFrom: 'proposal_submitted',
    });
    return true;
  } catch (error) {
    if (error instanceof InvalidStatusTransitionError) {
      log.warn('Proposal accept request transition skipped (already advanced)', { requestId });
      return false;
    }
    throw error;
  }
}

/**
 * Client accepts a submitted proposal (A6.4 / BAL-289) — the CLIENT mirror of the
 * expert's submit action. Commits the status flip through the EXISTING
 * `proposalsRepository.accept` (proposal `submitted → accepted` + relationship
 * `proposal_submitted → accepted`, one tx), advances the request aggregate
 * (race-tolerant), then publishes the client→expert acceptance notification
 * (fire-and-forget).
 *
 * Control flow: requireUser → validate input → `resolveConversationAccess`
 * (denies non-participants and foreign relationship ids) → CLIENT-lens gate →
 * re-load + verify the proposal (live, `submitted`, current, belongs to this
 * relationship) → `accept` (typed transition errors → friendly stale copy) →
 * advance the request aggregate → log → notify → revalidate → return.
 */
export async function acceptProposalAction(
  input: AcceptProposalInput
): Promise<AcceptProposalResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { requestId, relationshipId, proposalId } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }
    if (access.ctx.lens !== 'client') {
      return { success: false, error: ONLY_CLIENT };
    }

    // Re-load + verify the proposal (live, submitted, belongs to this
    // relationship, current) — never trust the client's claim.
    const proposal = await proposalsRepository.findById(proposalId);
    if (
      proposal === undefined ||
      proposal.status !== 'submitted' ||
      proposal.relationshipId !== relationshipId ||
      !proposal.isCurrent
    ) {
      return { success: false, error: STALE_PROPOSAL };
    }

    // Commit the accept via the EXISTING repo method (proposal + relationship in
    // ONE tx). A stale double-accept trips the typed transition errors → friendly
    // stale copy.
    try {
      await proposalsRepository.accept({ id: proposalId });
    } catch (error) {
      if (
        error instanceof InvalidProposalTransitionError ||
        error instanceof InvalidRelationshipTransitionError
      ) {
        return { success: false, error: STALE_PROPOSAL };
      }
      throw error;
    }

    // Advance the REQUEST aggregate (first-accept-only, race-tolerant). The accept
    // above is ALREADY committed in its own tx and is the source of truth — so this
    // separate-tx advance is best-effort: any failure (other than the benign
    // already-advanced race that `advanceRequestAggregate` swallows) must NOT fail
    // the action and re-toast a misleading retry. Mirror the fire-and-forget notify:
    // log and fall through to the success path with `transitioned = false`.
    let transitioned = false;
    try {
      transitioned = await advanceRequestAggregate(requestId, access.request.status);
    } catch (error) {
      log.error('Request aggregate advance failed after accept commit', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }

    // Key business event (after the commit).
    log.info('Proposal accepted', {
      requestId,
      relationshipId,
      proposalId,
      userId: user.id,
      transitioned,
    });

    // Notify the winning EXPERT (fire-and-forget) — AFTER the commit.
    publishNotificationEvent('project.proposal_accepted', {
      correlationId: proposalId,
      projectRequestId: requestId,
      relationshipId,
      expertProfileId: access.relationship.expertProfileId,
      clientName: displayName(user),
      clientCompanyName: access.request.company?.name ?? 'their company',
      title: access.request.title,
      priceCents: proposal.priceCents,
      currency: proposal.currency,
    }).catch(() => {
      // publishNotificationEvent logs internally.
    });

    // Revalidate the request-detail page.
    revalidatePath(`/projects/${requestId}`);

    return {
      success: true,
      proposalId,
      expertProfileId: access.relationship.expertProfileId,
      transitioned,
    };
  } catch (error) {
    log.error('Failed to accept proposal', {
      requestId,
      relationshipId,
      proposalId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
