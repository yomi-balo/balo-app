'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  proposalsRepository,
  proposalMilestonesRepository,
  proposalPaymentInstallmentsRepository,
  proposalDocumentsRepository,
  InvalidProposalTransitionError,
  InvalidRelationshipTransitionError,
  type Proposal,
  type ProposalMilestoneInput,
  type ProposalPaymentInstallmentInput,
} from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { sanitizeProjectHtml, sanitizeProposalOverviewHtml } from '@/lib/sanitize/project-html';
import {
  copyProposalDocumentObject,
  generateProposalDocumentKey,
} from '@/lib/storage/proposal-document';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { validateProposalReadiness } from './proposal-readiness';

// The composer payload — same field names / shape as `save-proposal-draft.ts`
// (reused intentionally so revise mode sends the EXACT same body), PLUS routing ids.
const milestoneSchema = z.object({
  title: z.string().max(200),
  descriptionHtml: z.string().max(20_000).nullable().optional(),
  acceptanceCriteria: z.string().max(2000).nullable().optional(),
  valueCents: z.number().int().nonnegative().nullable().optional(),
});

const installmentSchema = z.object({
  label: z.string().max(120),
  pct: z.number().int().min(0).max(100),
});

const inputSchema = z.object({
  requestId: z.uuid(),
  // A CLAIM — validated by the access guard.
  relationshipId: z.uuid(),
  // The current `changes_requested` (v1) proposal id — re-verified + used for
  // document carryover.
  fromProposalId: z.uuid(),
  overview: z.string().max(50_000),
  pricingMethod: z.enum(['fixed', 'tm']),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().min(1).max(8).optional(),
  timeframeWeeks: z.number().int().positive().optional(),
  exclusions: z.string().max(20_000).optional(),
  depositCents: z.number().int().nonnegative().optional(),
  rateCents: z.number().int().nonnegative().optional(),
  cadence: z.enum(['monthly', 'fortnightly']).optional(),
  milestones: z.array(milestoneSchema).max(50),
  installments: z.array(installmentSchema).max(50),
});

export type ResubmitProposalInput = z.infer<typeof inputSchema>;

export type ResubmitProposalResult =
  | {
      success: true;
      proposalId: string;
      version: number;
      /**
       * The relationship's expert profile id — the analytics `expert_id` dimension,
       * kept consistent with `PROJECT_PROPOSAL_SUBMITTED`/`ACCEPTED` (a real expert
       * profile id, never a relationship id).
       */
      expertProfileId: string;
      /** Server-computed — the island attaches these to `PROJECT_PROPOSAL_RESUBMITTED`. */
      analytics: { priceCents: number; currency: string };
    }
  | { success: false; error: string };

const NOT_SIGNED_IN = 'You are not signed in.';
const INVALID_REQUEST = 'Invalid request.';
const ONLY_EXPERT = 'Only the expert can resubmit a proposal.';
const STALE_PROPOSAL = 'This proposal has already been resubmitted. Refresh to continue.';
const GENERIC_FAILURE = 'Could not resubmit your proposal. Please try again.';

/** Display name for the resubmitting expert (notification body). */
function displayName(user: { firstName: string | null; lastName: string | null }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'Your expert';
}

/**
 * The atomic version bump — flips v1 → `resubmitted`, inserts v2 (fresh UUID,
 * version+1, is_current). Maps the typed stale-transition errors (a concurrent
 * accept / double-resubmit) to `null` so the caller surfaces friendly stale copy;
 * rethrows anything unexpected.
 */
async function resubmitWithStaleGuard(
  params: Parameters<typeof proposalsRepository.resubmit>[0]
): Promise<Proposal | null> {
  try {
    return await proposalsRepository.resubmit(params);
  } catch (error) {
    if (
      error instanceof InvalidProposalTransitionError ||
      error instanceof InvalidRelationshipTransitionError
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Re-load + verify the relationship's CURRENT proposal — never trust the client's
 * claim. Returns it ONLY when it is the claimed `fromProposalId`, live, current, and
 * `changes_requested` (the only state a resubmit is legal from); otherwise
 * `undefined` (the action maps that to stale copy).
 */
async function loadCurrentChangesRequestedProposal(
  fromProposalId: string,
  relationshipId: string
): Promise<Proposal | undefined> {
  const proposal = await proposalsRepository.findCurrentByRelationship(relationshipId);
  if (
    proposal === undefined ||
    proposal.id !== fromProposalId ||
    proposal.status !== 'changes_requested' ||
    !proposal.isCurrent
  ) {
    return undefined;
  }
  return proposal;
}

/** The sanitised header + milestone/installment payload for the v2 write. */
interface SanitisedContent {
  overview: string;
  milestones: ProposalMilestoneInput[];
  installments: ProposalPaymentInstallmentInput[];
  exclusions?: string;
}

/**
 * Server-side sanitise (NEVER trust the client) of the rich-text fields, mirroring
 * `submit-proposal.ts`'s sanitise step: the overview via `sanitizeProposalOverviewHtml`
 * and each milestone description + the exclusions via `sanitizeProjectHtml`.
 */
function sanitiseContent(input: ResubmitProposalInput): SanitisedContent {
  return {
    overview: sanitizeProposalOverviewHtml(input.overview),
    exclusions:
      input.exclusions === undefined || input.exclusions.length === 0
        ? undefined
        : sanitizeProjectHtml(input.exclusions),
    milestones: input.milestones.map((m) => ({
      title: m.title,
      descriptionHtml:
        m.descriptionHtml === undefined || m.descriptionHtml === null
          ? null
          : sanitizeProjectHtml(m.descriptionHtml),
      acceptanceCriteria: m.acceptanceCriteria ?? null,
      valueCents: m.valueCents ?? null,
    })),
    installments: input.installments.map((i) => ({ label: i.label, pct: i.pct })),
  };
}

/**
 * Best-effort carryover of v1's documents onto v2. Each v1 R2 object is copied to a
 * FRESH key (the `proposal_documents.r2Key` index is globally unique, so the source
 * key can't be reused) and re-registered on v2. A per-doc failure is warn-logged and
 * skipped — a missing attachment must NEVER fail the resubmit (the header + children
 * are already committed).
 */
async function carryOverDocuments(fromProposalId: string, toProposalId: string): Promise<void> {
  const v1Docs = await proposalDocumentsRepository.listByProposal(fromProposalId);
  for (const doc of v1Docs) {
    try {
      const destKey = generateProposalDocumentKey(toProposalId, doc.uploadedByUserId);
      await copyProposalDocumentObject(doc.r2Key, destKey);
      await proposalDocumentsRepository.addDocument({
        proposalId: toProposalId,
        r2Key: destKey,
        fileName: doc.fileName,
        contentType: doc.contentType,
        sizeBytes: doc.sizeBytes,
        kind: doc.kind,
        uploadedByUserId: doc.uploadedByUserId,
      });
    } catch (error) {
      log.warn('Proposal document carryover failed (skipped)', {
        fromProposalId,
        toProposalId,
        sourceDocumentId: doc.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Expert resubmits a revised proposal as a new version (A6.4 / BAL-290) — the
 * EXPERT-lens sibling of `submit-proposal.ts`. Re-validates readiness + re-sanitises
 * the client payload server-side, then atomically writes a fresh v(n+1) proposal row
 * (the repo flips v1 → `resubmitted`, inserts v2 as `submitted`/`is_current`),
 * re-parents milestones + installments, carries over documents (best-effort), and
 * notifies the CLIENT.
 *
 * Control flow: requireUser → validate input → `resolveConversationAccess` →
 * EXPERT-lens gate → re-load + verify the current proposal (`changes_requested`,
 * current, == fromProposalId) → sanitise → readiness re-validation → `resubmit`
 * (typed transition errors → friendly stale copy) → re-parent children → document
 * carryover → log → notify the client (fire-and-forget) → revalidate → return
 * analytics for the island.
 *
 * BOUNDARY: does NOT advance the relationship or the request aggregate — the
 * relationship stays `proposal_submitted` throughout the changes loop.
 */
export async function resubmitProposalAction(
  input: ResubmitProposalInput
): Promise<ResubmitProposalResult> {
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
  const data = parsed.data;
  const { requestId, relationshipId, fromProposalId } = data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }
    if (access.ctx.lens !== 'expert') {
      return { success: false, error: ONLY_EXPERT };
    }

    // Re-load + verify the current proposal (live, changes_requested, current,
    // == the claimed fromProposalId) — never trust the client's claim.
    const current = await loadCurrentChangesRequestedProposal(fromProposalId, relationshipId);
    if (current === undefined) {
      return { success: false, error: STALE_PROPOSAL };
    }

    // Sanitise the client's rich text server-side (never trust the client).
    const sanitised = sanitiseContent(data);

    // Server-side readiness re-validation (post-sanitise — a sanitiser can empty
    // the overview). Mirrors the composer's gating + submit-proposal's re-check.
    const readiness = validateProposalReadiness({
      overview: sanitised.overview,
      pricingMethod: data.pricingMethod,
      milestones: sanitised.milestones.map((m) => ({
        title: m.title,
        valueCents: m.valueCents ?? null,
      })),
      installments: sanitised.installments,
      depositCents: data.depositCents ?? null,
      rateCents: data.rateCents ?? null,
    });
    if (!readiness.ready) {
      return { success: false, error: readiness.error };
    }

    // (a) Atomic version bump — flips v1 → `resubmitted`, inserts v2 (fresh UUID,
    //     version+1, is_current). A stale double-resubmit trips the typed transition
    //     errors → friendly stale copy.
    const v2 = await resubmitWithStaleGuard({
      relationshipId,
      overview: sanitised.overview,
      pricingMethod: data.pricingMethod,
      priceCents: data.priceCents,
      currency: data.currency,
      timeframeWeeks: data.timeframeWeeks,
      exclusions: sanitised.exclusions,
      depositCents: data.depositCents,
      rateCents: data.rateCents,
      cadence: data.cadence,
    });
    if (v2 === null) {
      return { success: false, error: STALE_PROPOSAL };
    }

    // (b) + (c) Re-parent the child sets onto v2 (replace-all).
    await proposalMilestonesRepository.setForProposal({
      proposalId: v2.id,
      milestones: sanitised.milestones,
    });
    await proposalPaymentInstallmentsRepository.setForProposal({
      proposalId: v2.id,
      installments: sanitised.installments,
    });

    // (d) Document carryover (best-effort, after the header + children commit).
    await carryOverDocuments(fromProposalId, v2.id);

    // Key business event (after the version bump).
    log.info('Proposal resubmitted', {
      requestId,
      relationshipId,
      fromProposalId,
      newProposalId: v2.id,
      version: v2.version,
    });

    // Notify the CLIENT (fire-and-forget) — AFTER the commit. `recipient` for the
    // expert lens is `{ role:'client', userId: request.createdByUserId }`.
    const recipientId = access.recipient.role === 'client' ? access.recipient.userId : undefined;
    if (recipientId !== undefined) {
      publishNotificationEvent('project.proposal_resubmitted', {
        correlationId: `${v2.id}--v${v2.version}`,
        projectRequestId: requestId,
        relationshipId,
        recipientId,
        expertName: displayName(user),
        projectTitle: access.request.title,
        version: v2.version,
        priceCents: v2.priceCents,
        currency: v2.currency,
      }).catch(() => {
        // publishNotificationEvent logs internally.
      });
    }

    // Revalidate the request-detail page AND the proposal surface.
    revalidatePath(`/projects/${requestId}`);
    revalidatePath(`/projects/${requestId}/proposal/${relationshipId}`);

    return {
      success: true,
      proposalId: v2.id,
      version: v2.version,
      expertProfileId: access.relationship.expertProfileId,
      analytics: { priceCents: v2.priceCents, currency: v2.currency },
    };
  } catch (error) {
    log.error('Resubmit proposal failed', {
      requestId,
      relationshipId,
      fromProposalId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
