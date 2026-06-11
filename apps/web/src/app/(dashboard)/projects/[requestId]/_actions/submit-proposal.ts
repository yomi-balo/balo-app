'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  proposalsRepository,
  proposalMilestonesRepository,
  proposalPaymentInstallmentsRepository,
  projectRequestsRepository,
  installmentsSumTo100,
  InvalidProposalTransitionError,
  InvalidRelationshipTransitionError,
  InvalidStatusTransitionError,
  type ProposalMilestone,
  type ProposalPaymentInstallment,
  type ProposalMilestoneInput,
  type ProposalPaymentInstallmentInput,
} from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { sanitizeProjectHtml, sanitizeProposalOverviewHtml } from '@/lib/sanitize/project-html';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';

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

/** Plain-text length of HTML (cheap tag-strip) — gates a non-empty overview. */
function plainTextLength(html: string): number {
  return html
    .replaceAll(/<[^>]*>/g, '')
    .replaceAll(/&nbsp;/g, ' ')
    .trim().length;
}

type ReadinessResult = { ready: true } | { ready: false; error: string };

/**
 * Server-side readiness re-validation — never trust the client. Mirrors the
 * composer's `summaryReadiness` so a bypassed Submit is rejected here:
 *  - overview non-empty (post-sanitise);
 *  - ≥1 milestone, every milestone titled;
 *  - Fixed → installments sum to 100 (≥1) AND every milestone has a value;
 *  - T&M → deposit + rate present (installments not required).
 */
function validateReadiness(input: {
  overview: string;
  pricingMethod: 'fixed' | 'tm';
  milestones: ProposalMilestone[];
  installments: ProposalPaymentInstallment[];
  depositCents: number | null;
  rateCents: number | null;
}): ReadinessResult {
  if (plainTextLength(input.overview) === 0) {
    return { ready: false, error: 'Add an overview before submitting.' };
  }
  if (input.milestones.length === 0) {
    return { ready: false, error: 'Add at least one milestone before submitting.' };
  }
  if (input.milestones.some((m) => m.title.trim().length === 0)) {
    return { ready: false, error: 'Every milestone needs a title.' };
  }

  if (input.pricingMethod === 'fixed') {
    if (input.installments.length === 0 || !installmentsSumTo100(input.installments)) {
      return { ready: false, error: 'Payment installments must total 100%.' };
    }
    if (input.milestones.some((m) => m.valueCents === null)) {
      return { ready: false, error: 'Every milestone needs a value.' };
    }
    return { ready: true };
  }

  // T&M
  if (input.depositCents === null || input.rateCents === null) {
    return { ready: false, error: 'Add a deposit and an hourly rate before submitting.' };
  }
  return { ready: true };
}

/** Display name for the submitting expert (notification body). */
function displayName(user: { firstName: string | null; lastName: string | null }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'Your expert';
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
    const readiness = validateReadiness({
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
    const sanitisedOverview = sanitizeProposalOverviewHtml(draft.overview);
    // The overview can be emptied by the sanitiser (e.g. pasted-only-scripts) —
    // re-check after sanitising.
    if (plainTextLength(sanitisedOverview) === 0) {
      return { success: false, error: 'Add an overview before submitting.' };
    }

    const sanitisedExclusions =
      draft.exclusions === null ? undefined : sanitizeProjectHtml(draft.exclusions);

    await proposalsRepository.updateDraft({
      proposalId,
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

    const sanitisedMilestones: ProposalMilestoneInput[] = milestones.map((m) => ({
      title: m.title,
      descriptionHtml: m.descriptionHtml === null ? null : sanitizeProjectHtml(m.descriptionHtml),
      acceptanceCriteria: m.acceptanceCriteria,
      valueCents: m.valueCents,
    }));
    await proposalMilestonesRepository.setForProposal({
      proposalId,
      milestones: sanitisedMilestones,
    });

    const persistedInstallments: ProposalPaymentInstallmentInput[] = installments.map((i) => ({
      label: i.label,
      pct: i.pct,
    }));
    await proposalPaymentInstallmentsRepository.setForProposal({
      proposalId,
      installments: persistedInstallments,
    });

    // 9. Promote + advance the relationship spine (ONE tx). A stale double-submit
    //    trips the typed transition errors → friendly stale copy.
    try {
      await proposalsRepository.promoteToSubmit({ proposalId, relationshipId });
    } catch (error) {
      if (
        error instanceof InvalidProposalTransitionError ||
        error instanceof InvalidRelationshipTransitionError
      ) {
        return { success: false, error: STALE_PROPOSAL };
      }
      throw error;
    }

    // 10. Advance the REQUEST aggregate (first-submit-only, race-tolerant).
    let transitioned = false;
    if (access.request.status === 'proposal_requested') {
      try {
        await projectRequestsRepository.transitionStatus({
          id: requestId,
          to: 'proposal_submitted',
          expectedFrom: 'proposal_requested',
        });
        transitioned = true;
      } catch (error) {
        if (error instanceof InvalidStatusTransitionError) {
          log.warn('Proposal submit request transition skipped (already advanced)', { requestId });
        } else {
          throw error;
        }
      }
    }

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
