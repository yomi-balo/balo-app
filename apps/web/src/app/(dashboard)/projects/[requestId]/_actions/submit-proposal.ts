'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  proposalsRepository,
  proposalMilestonesRepository,
  proposalPaymentInstallmentsRepository,
  projectRequestsRepository,
  InvalidProposalTransitionError,
  InvalidRelationshipTransitionError,
  InvalidStatusTransitionError,
  ProposalNotDraftError,
  type Proposal,
  type ProposalMilestone,
  type ProposalPaymentInstallment,
  type ProposalMilestoneInput,
  type ProposalPaymentInstallmentInput,
} from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { plainTextLength } from '@/components/balo/rich-text/plain-text';
import { sanitizeProjectHtml, sanitizeProposalOverviewHtml } from '@/lib/sanitize/project-html';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { validateProposalReadiness } from './proposal-readiness';

const inputSchema = z.object({
  requestId: z.uuid(),
  // A CLAIM — validated by the access guard.
  relationshipId: z.uuid(),
  // The draft to submit — validated to belong to the relationship + be a live draft.
  proposalId: z.uuid(),
});

export type SubmitProposalInput = z.infer<typeof inputSchema>;

export type SubmitProposalResult =
  | {
      success: true;
      proposalId: string;
      expertProfileId: string;
      /** Whether the REQUEST aggregate advanced `proposal_requested → proposal_submitted`. */
      transitioned: boolean;
      /** Server-computed — the island attaches these to `PROJECT_PROPOSAL_SUBMITTED`. */
      analytics: { priceCents: number; currency: string };
    }
  | { success: false; error: string };

const NOT_SIGNED_IN = 'You are not signed in.';
const INVALID_REQUEST = 'Invalid request.';
const ONLY_EXPERT = 'Only the expert can submit a proposal.';
const STALE_PROPOSAL = 'This proposal can no longer be submitted.';
const GENERIC_FAILURE = 'Could not submit your proposal. Please try again.';

/** Display name for the submitting expert (notification body). */
function displayName(user: { firstName: string | null; lastName: string | null }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'Your expert';
}

/**
 * Promote the draft → submitted + advance the relationship spine (one tx). Maps the
 * typed stale-transition errors (a concurrent / double-submit) to `'stale'` so the
 * caller surfaces friendly copy; rethrows anything unexpected.
 */
async function promoteToSubmitWithStaleGuard(params: {
  proposalId: string;
  relationshipId: string;
}): Promise<'ok' | 'stale'> {
  try {
    await proposalsRepository.promoteToSubmit(params);
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

type PersistResult = { ok: true } | { ok: false; error: string };

/**
 * Step 8 — re-sanitise every rich-text field and re-persist the draft so
 * "what's submitted equals what's stored". A concurrent submit can flip the row
 * out of `draft` between the initial `findById` and these writes; the repository
 * surfaces that as `ProposalNotDraftError` (TOCTOU), which maps to the friendly
 * stale-UI copy rather than the generic failure.
 */
async function sanitiseAndPersistDraft(
  draft: Proposal,
  milestones: ProposalMilestone[],
  installments: ProposalPaymentInstallment[]
): Promise<PersistResult> {
  const sanitisedOverview = sanitizeProposalOverviewHtml(draft.overview);
  // The overview can be emptied by the sanitiser (e.g. pasted-only-scripts) —
  // re-check after sanitising.
  if (plainTextLength(sanitisedOverview) === 0) {
    return { ok: false, error: 'Add an overview before submitting.' };
  }

  const sanitisedExclusions =
    draft.exclusions === null ? undefined : sanitizeProjectHtml(draft.exclusions);

  const sanitisedMilestones: ProposalMilestoneInput[] = milestones.map((m) => ({
    title: m.title,
    descriptionHtml: m.descriptionHtml === null ? null : sanitizeProjectHtml(m.descriptionHtml),
    acceptanceCriteria: m.acceptanceCriteria,
    valueCents: m.valueCents,
  }));

  const persistedInstallments: ProposalPaymentInstallmentInput[] = installments.map((i) => ({
    label: i.label,
    pct: i.pct,
  }));

  try {
    await proposalsRepository.updateDraft({
      proposalId: draft.id,
      overview: sanitisedOverview,
      pricingMethod: draft.pricingMethod,
      priceCents: draft.priceCents,
      currency: draft.currency,
      timeframeWeeks: draft.timeframeWeeks ?? undefined,
      exclusions: sanitisedExclusions,
      depositCents: draft.depositCents ?? undefined,
      rateCents: draft.rateCents ?? undefined,
      cadence: draft.cadence ?? undefined,
    });
  } catch (error) {
    if (error instanceof ProposalNotDraftError) {
      return { ok: false, error: STALE_PROPOSAL };
    }
    throw error;
  }

  await proposalMilestonesRepository.setForProposal({
    proposalId: draft.id,
    milestones: sanitisedMilestones,
  });
  await proposalPaymentInstallmentsRepository.setForProposal({
    proposalId: draft.id,
    installments: persistedInstallments,
  });

  return { ok: true };
}

/**
 * Step 10 — advance the REQUEST aggregate `proposal_requested → proposal_submitted`
 * exactly once. Race-tolerant: a concurrent first-submit that already advanced the
 * aggregate trips `InvalidStatusTransitionError`, which is benign. Returns whether
 * THIS call performed the transition.
 */
async function advanceRequestAggregate(requestId: string, currentStatus: string): Promise<boolean> {
  if (currentStatus !== 'proposal_requested') {
    return false;
  }
  try {
    await projectRequestsRepository.transitionStatus({
      id: requestId,
      to: 'proposal_submitted',
      expectedFrom: 'proposal_requested',
    });
    return true;
  } catch (error) {
    if (error instanceof InvalidStatusTransitionError) {
      log.warn('Proposal submit request transition skipped (already advanced)', { requestId });
      return false;
    }
    throw error;
  }
}

/**
 * Expert submits their built proposal (A6.2 / BAL-288) — the draft→submitted
 * commit. Trusts the SERVER-PERSISTED draft as the submit content (the client
 * flushes a final autosave before opening the confirm dialog, decided Q2): the
 * action re-reads the persisted milestones/installments, re-validates readiness
 * server-side, re-sanitises every rich-text field, re-persists, then promotes.
 *
 * Transactional ordering (per the plan, steps 5-14): load+verify the draft →
 * re-read children → readiness → sanitise → persist (`updateDraft` +
 * `setForProposal` ×2) → `promoteToSubmit` (relationship + proposal spine in one
 * tx) → advance the request aggregate (race-tolerant) → publish the client
 * notification (fire-and-forget) → revalidate → return analytics for the island.
 *
 * Expert-lens guarded; `resolveConversationAccess` denies non-participants and
 * foreign relationship ids. A stale double-submit maps to friendly copy.
 */
export async function submitProposalAction(
  input: SubmitProposalInput
): Promise<SubmitProposalResult> {
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
    if (access.ctx.lens !== 'expert') {
      return { success: false, error: ONLY_EXPERT };
    }

    // 5. Load + verify the draft (live, draft, belongs to this relationship, current).
    const draft = await proposalsRepository.findById(proposalId);
    if (
      draft === undefined ||
      draft.status !== 'draft' ||
      draft.relationshipId !== relationshipId ||
      !draft.isCurrent
    ) {
      return { success: false, error: STALE_PROPOSAL };
    }

    // 6. Re-read the persisted children — the action trusts the stored draft.
    const [milestones, installments] = await Promise.all([
      proposalMilestonesRepository.listByProposal(proposalId),
      proposalPaymentInstallmentsRepository.listByProposal(proposalId),
    ]);

    // 7. Server-side readiness re-validation (never trust the client).
    const readiness = validateProposalReadiness({
      overview: draft.overview,
      pricingMethod: draft.pricingMethod,
      milestones,
      installments,
      depositCents: draft.depositCents,
      rateCents: draft.rateCents,
    });
    if (!readiness.ready) {
      return { success: false, error: readiness.error };
    }

    // 8. Sanitise → persist (canonical "what's submitted equals what's stored").
    //    A concurrent submit can flip the row out of `draft` here (TOCTOU) →
    //    friendly stale copy via `ProposalNotDraftError`.
    const persisted = await sanitiseAndPersistDraft(draft, milestones, installments);
    if (!persisted.ok) {
      return { success: false, error: persisted.error };
    }

    // 9. Promote + advance the relationship spine (ONE tx). A stale double-submit
    //    trips the typed transition errors → friendly stale copy.
    const promotion = await promoteToSubmitWithStaleGuard({ proposalId, relationshipId });
    if (promotion === 'stale') {
      return { success: false, error: STALE_PROPOSAL };
    }

    // 10. Advance the REQUEST aggregate (first-submit-only, race-tolerant).
    const transitioned = await advanceRequestAggregate(requestId, access.request.status);

    // 12. Key business event (after promotion).
    log.info('Proposal submitted', {
      requestId,
      relationshipId,
      proposalId,
      userId: user.id,
      transitioned,
    });

    // 11. Notify the CLIENT (fire-and-forget). `recipient` for the expert lens is
    //     `{ role:'client', userId: request.createdByUserId }`.
    const recipientId = access.recipient.role === 'client' ? access.recipient.userId : undefined;
    if (recipientId !== undefined) {
      publishNotificationEvent('project.proposal_submitted', {
        correlationId: proposalId,
        projectRequestId: requestId,
        relationshipId,
        recipientId,
        expertName: displayName(user),
        title: access.request.title,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });
    }

    // 13. Revalidate the request-detail page.
    revalidatePath(`/projects/${requestId}`);

    // 14. Return success + analytics for the client island.
    return {
      success: true,
      proposalId,
      expertProfileId: access.relationship.expertProfileId,
      transitioned,
      analytics: { priceCents: draft.priceCents, currency: draft.currency },
    };
  } catch (error) {
    log.error('Failed to submit proposal', {
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
