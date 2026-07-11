'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { proposalsRepository, InvalidProposalTransitionError, type Proposal } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';

const inputSchema = z.object({
  requestId: z.uuid(),
  // A CLAIM — validated by the access guard.
  relationshipId: z.uuid(),
  // The submitted proposal to request changes on — validated to be live, submitted,
  // current, and belong to the claimed relationship.
  proposalId: z.uuid(),
  // Which part of the proposal needs work — the DB `proposalChangeSectionEnum`.
  section: z
    .enum(['general', 'milestones', 'pricing', 'payment_terms', 'timeline'])
    .default('general'),
  // Required free-text note to the expert.
  note: z.string().trim().min(1, 'A note is required').max(4000),
});

// `z.input` (not `z.infer`/`z.output`) so `section` is OPTIONAL for callers — the
// schema applies its `'general'` default. The action reads the resolved value.
export type RequestProposalChangesInput = z.input<typeof inputSchema>;

export type RequestProposalChangesResult =
  | {
      success: true;
      /**
       * The relationship's expert profile id — the analytics `expert_id` dimension,
       * kept consistent with the accept/submit/resubmit events (a real expert profile
       * id, never a relationship id).
       */
      expertProfileId: string;
    }
  | { success: false; error: string };

const NOT_SIGNED_IN = 'You are not signed in.';
const INVALID_REQUEST = 'Invalid request.';
const ONLY_CLIENT = 'Only the client can request changes on a proposal.';
const STALE_PROPOSAL = 'This proposal has already moved on. Refresh to see the latest.';
const GENERIC_FAILURE = 'Could not request changes. Please try again.';

/** Display name for the requesting client (notification body). */
function displayName(user: { firstName: string | null; lastName: string | null }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'The client';
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
 * Client requests changes on a submitted proposal (A6.4 / BAL-290) — the CLIENT-lens
 * sibling of `accept-proposal.ts`. Instead of accepting, the client picks a section
 * and writes a required note; this advances the current proposal
 * `submitted → changes_requested` (keeping it `is_current`) AND inserts the
 * change-request row in ONE atomic repo call, then notifies the EXPERT.
 *
 * Control flow: requireOnboardedUser → validate input → `resolveConversationAccess` (denies
 * non-participants and foreign relationship ids) → CLIENT-lens gate → re-load +
 * verify the proposal (live, `submitted`, current, belongs to this relationship) →
 * `proposalsRepository.requestChanges` (single tx — flip + insert; `InvalidProposal-
 * TransitionError` → friendly stale copy) → log → notify the expert
 * (fire-and-forget) → revalidate → return.
 *
 * BOUNDARY: does NOT advance the relationship or the request aggregate — the
 * relationship stays `proposal_submitted` throughout the changes loop.
 */
export async function requestProposalChangesAction(
  input: RequestProposalChangesInput
): Promise<RequestProposalChangesResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { requestId, relationshipId, proposalId, section, note } = parsed.data;

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

    // Single atomic call: advances `submitted → changes_requested` (stays current)
    // AND inserts the change-request row. A stale double-request trips the typed
    // transition error → friendly stale copy. (Do NOT also call
    // `proposalChangeRequestsRepository.create()` — that would double-insert.)
    try {
      await proposalsRepository.requestChanges({
        proposalId,
        requestedByUserId: user.id,
        section,
        note,
      });
    } catch (error) {
      if (error instanceof InvalidProposalTransitionError) {
        return { success: false, error: STALE_PROPOSAL };
      }
      throw error;
    }

    // Key business event (after the commit).
    log.info('Proposal changes requested', {
      requestId,
      relationshipId,
      proposalId,
      userId: user.id,
      section,
    });

    // Notify the EXPERT (fire-and-forget) — AFTER the commit.
    publishNotificationEvent('project.changes_requested', {
      correlationId: proposalId,
      projectRequestId: requestId,
      relationshipId,
      expertProfileId: access.relationship.expertProfileId,
      clientName: displayName(user),
      projectTitle: access.request.title,
      section,
      note,
    }).catch(() => {
      // publishNotificationEvent logs internally.
    });

    // Revalidate the request-detail page AND the proposal surface so a stale
    // "still acceptable / awaiting" state isn't served on back-navigation.
    revalidatePath(`/projects/${requestId}`);
    revalidatePath(`/projects/${requestId}/proposal/${relationshipId}`);

    return { success: true, expertProfileId: access.relationship.expertProfileId };
  } catch (error) {
    log.error('Request proposal changes failed', {
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
