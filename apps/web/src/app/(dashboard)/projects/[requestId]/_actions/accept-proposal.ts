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
  type Proposal,
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
 * Best-effort and NEVER throws: the accept is already committed in its own tx and
 * is the source of truth, so neither the benign already-advanced race
 * (`InvalidStatusTransitionError`) nor a transient failure may fail the action —
 * both are logged and reported as `transitioned = false`. Returns whether THIS
 * call performed the transition.
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
    } else {
      log.error('Request aggregate advance failed after accept commit', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
    return false;
  }
}

/**
 * Re-load + verify the claimed proposal — never trust the client's claim. Returns
 * the proposal ONLY when it is live, `submitted`, current, and belongs to the
 * claimed relationship; otherwise `undefined` (the action maps that to stale copy).
 */
async function loadCurrentSubmittedProposal(
  proposalId: string,
  relationshipId: string
): Promise<Proposal | undefined> {
  const proposal = await proposalsRepository.findById(proposalId);
  if (
    proposal === undefined ||
    proposal.status !== 'submitted' ||
    proposal.relationshipId !== relationshipId ||
    !proposal.isCurrent
  ) {
    return undefined;
  }
  return proposal;
}

/**
 * Commit the accept via the EXISTING repo method (proposal + relationship in ONE
 * tx). A stale double-accept trips the typed transition errors → `'stale'` (friendly
 * copy); any other error rethrows to the action's generic-failure boundary.
 */
async function commitAccept(proposalId: string): Promise<'ok' | 'stale'> {
  try {
    await proposalsRepository.accept({ id: proposalId });
    return 'ok';
  } catch (error) {
    if (
      error instanceof InvalidProposalTransitionError ||
      error instanceof InvalidRelationshipTransitionError
    ) {
      return 'stale';
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
    const proposal = await loadCurrentSubmittedProposal(proposalId, relationshipId);
    if (proposal === undefined) {
      return { success: false, error: STALE_PROPOSAL };
    }

    // Commit the accept (proposal + relationship in ONE tx). A stale double-accept
    // trips the typed transition errors → friendly stale copy.
    const committed = await commitAccept(proposalId);
    if (committed === 'stale') {
      return { success: false, error: STALE_PROPOSAL };
    }

    // Advance the REQUEST aggregate (first-accept-only). Best-effort + never
    // throws — the accept above is already committed and is the source of truth
    // (see `advanceRequestAggregate`); a lagging request status is tolerable and
    // must never re-toast a misleading retry for a state change that succeeded.
    const transitioned = await advanceRequestAggregate(requestId, access.request.status);

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

    // Revalidate the request-detail page AND the proposal surface the client
    // accepted from, so back-navigation there doesn't serve a stale
    // "still acceptable" state.
    revalidatePath(`/projects/${requestId}`);
    revalidatePath(`/projects/${requestId}/proposal/${relationshipId}`);

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
