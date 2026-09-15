import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  proposalsRepository,
  projectRequestsRepository,
  ensureClientBillingGateConfirmed,
  InvalidProposalTransitionError,
  InvalidRelationshipTransitionError,
  ProposalCoherenceError,
  type Proposal,
} from '@balo/db';
import { applyBaloFee } from '@balo/shared/pricing';
import type { SessionUser } from '@/lib/auth/session';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { log } from '@/lib/logging';
import { trackServerAndFlush, PROJECT_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { lockContentionFailure } from './deadlock';

const inputSchema = z.object({
  requestId: z.uuid(),
  // A CLAIM — validated by the access guard.
  relationshipId: z.uuid(),
  // The submitted proposal to accept — validated to be live, submitted, current,
  // and belong to the claimed relationship.
  proposalId: z.uuid(),
});

export type AcceptProposalInput = z.infer<typeof inputSchema>;

/**
 * Structured payload attached to a FAILURE result when the `@balo/db` coherence
 * guard (`ProposalCoherenceError`) rejected the accept. The island fires
 * `PROPOSAL_COHERENCE_REJECTED` from it — the raw `rule` is analytics-only and is
 * NEVER rendered in the UI (the generic `error` copy is shown instead).
 */
export interface ProposalCoherenceFailure {
  rule: string;
  pricingMethod: 'fixed' | 'tm';
  proposalId: string;
  relationshipId: string;
}

export type AcceptProposalResult =
  | {
      success: true;
      proposalId: string;
      expertProfileId: string;
      /** Whether the REQUEST aggregate advanced `proposal_submitted → accepted`. */
      transitioned: boolean;
    }
  | { success: false; error: string; coherence?: ProposalCoherenceFailure };

export const NOT_SIGNED_IN = 'You are not signed in.';
const INVALID_REQUEST = 'Invalid request.';
const ONLY_CLIENT = 'Only the client can accept a proposal.';
const STALE_PROPOSAL = 'This proposal can no longer be accepted.';
const GENERIC_FAILURE = 'Could not accept this proposal. Please try again.';
// The repo coherence guard firing on accept means the submitted proposal's
// snapshotted terms are inconsistent — generic copy; the raw rule is
// analytics-only, never shown.
const COHERENCE_COPY =
  "This proposal's pricing is incomplete or inconsistent. Refresh and ask the expert to re-check the pricing before accepting.";

/** Display name for the accepting client (notification body). */
function displayName(user: { firstName: string | null; lastName: string | null }): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'The client';
}

/**
 * Re-source the `transitioned` analytics flag from the now-coherent stored column
 * (ADR-1025 / BAL-295). The request rollup `proposal_submitted → accepted` advances
 * ATOMICALLY inside `proposalsRepository.accept`; this is a read-only, best-effort
 * `findById` compare of the pre-op floor against a fresh re-read.
 *
 * Best-effort and NEVER throws: the accept is already committed in its own tx and
 * is the source of truth, so a read hiccup on this analytics-only re-read must
 * never fail an already-committed accept — it is logged and reported as
 * `transitioned = false`. Returns whether the stored request status advanced.
 */
async function didRequestAdvance(requestId: string, beforeStatus: string): Promise<boolean> {
  try {
    const after = await projectRequestsRepository.findById(requestId);
    return after !== undefined && after.status !== beforeStatus;
  } catch (error) {
    log.error('Request status re-read failed after accept commit', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return false;
  }
}

/**
 * BAL-343 — confirm the `client_billing` kickoff gate at ACCEPTANCE time, so a
 * repeat-company client whose company already has billing on file sees the settled
 * gate on its own request immediately instead of waiting for an admin to open the
 * board (the BAL-324 admin-load path is retained as a backstop —
 * `lib/project-request/ensure-admin-billing-autoskip.ts`). The delegated primitive
 * self-guards every not-applicable case, so a new company with nothing captured
 * still falls through to the BAL-323 capture flow untouched.
 *
 * Best-effort and NEVER throws: the accept is ALREADY COMMITTED by the time this
 * runs, and the caller's boundary catch maps any throw to a user-facing "could not
 * accept" — which would tell the client an accept that succeeded had failed. WARN,
 * not ERROR: recoverable by three routes (the backstop, the client's own capture
 * form, the next accept on this request). ONE catch arm deliberately — a benign
 * `InvalidKickoffStateError` status race and a real DB failure have identical
 * consequences here, and the logged `error.message` names which one it was.
 */
async function confirmClientBillingGateBestEffort(requestId: string): Promise<void> {
  try {
    await ensureClientBillingGateConfirmed(requestId);
  } catch (error) {
    log.warn('Client billing gate auto-confirm failed after accept commit', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
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
 * copy); the `@balo/db` coherence guard (`ProposalCoherenceError`, defence-in-depth)
 * → a `{ coherence }` outcome so the caller surfaces friendly copy + the analytics
 * payload; any other error rethrows to the action's generic-failure boundary.
 */
async function commitAccept(
  proposalId: string,
  /** BAL-540 / ADR-1030 — the accepting client; attributes the relationship's audit row. */
  actorUserId: string
): Promise<'ok' | 'stale' | { coherence: ProposalCoherenceError }> {
  try {
    await proposalsRepository.accept({ id: proposalId, actorUserId });
    return 'ok';
  } catch (error) {
    if (error instanceof ProposalCoherenceError) {
      return { coherence: error };
    }
    if (
      error instanceof InvalidProposalTransitionError ||
      error instanceof InvalidRelationshipTransitionError
    ) {
      return 'stale';
    }
    throw error;
  }
}

export async function runAcceptProposal(
  user: SessionUser,
  input: AcceptProposalInput
): Promise<AcceptProposalResult> {
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
    // trips the typed transition errors → friendly stale copy; the repo coherence
    // guard (defence-in-depth) → generic copy + an analytics `coherence` payload.
    const committed = await commitAccept(proposalId, user.id);
    if (committed === 'stale') {
      return { success: false, error: STALE_PROPOSAL };
    }
    if (typeof committed === 'object') {
      log.warn('Proposal coherence rejected', {
        rule: committed.coherence.rule,
        pricingMethod: proposal.pricingMethod,
        proposalId,
        relationshipId,
      });
      return {
        success: false,
        error: COHERENCE_COPY,
        coherence: {
          rule: committed.coherence.rule,
          pricingMethod: proposal.pricingMethod,
          proposalId,
          relationshipId,
        },
      };
    }

    // Re-source `transitioned` from the stored column. Best-effort + never throws
    // — the accept above is already committed and derived the request rollup
    // atomically (ADR-1025 / BAL-295); a lagging/failed re-read of this
    // analytics-only flag must never re-toast a misleading retry for a state change
    // that succeeded.
    const transitioned = await didRequestAdvance(requestId, access.request.status);

    // Key business event (after the commit).
    log.info('Proposal accepted', {
      requestId,
      relationshipId,
      proposalId,
      userId: user.id,
      transitioned,
    });

    // BAL-357: emit PROJECT_PROPOSAL_ACCEPTED SERVER-SIDE (audience boundary). The
    // Balo fee + client-charged price are derived from the persisted proposal here
    // and NEVER returned to the client's browser. `distinct_id` is the acting client.
    const clientPriceCents = applyBaloFee(proposal.priceCents, proposal.baloFeeBps);
    trackServerAndFlush(PROJECT_SERVER_EVENTS.PROJECT_PROPOSAL_ACCEPTED, {
      request_id: requestId,
      relationship_id: relationshipId,
      expert_id: access.relationship.expertProfileId,
      proposal_id: proposalId,
      balo_fee_bps: proposal.baloFeeBps,
      client_price_cents: clientPriceCents,
      distinct_id: user.id,
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

    // BAL-343 — confirm the `client_billing` gate now the request is `accepted`.
    // AWAITED: the very next render reads this row. Self-swallowing: it must never
    // fail an accept that already committed. No-ops for a company with no billing.
    await confirmClientBillingGateBestEffort(requestId);

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
    // ⚠ fix round R1 — `proposalsRepository.accept` is one of the eleven writers serialised on
    // the per-request advisory lock (`_shared/request-lock.ts`); a 55P03 here means the accept
    // never wrote anything and a retry queues again. WARN + retryable copy, checked BEFORE the
    // generic fallback below — never `log.error` for an expected-rare, self-healing event.
    const lockContention = lockContentionFailure(
      error,
      'Proposal accept aborted by lock contention — retryable',
      { requestId, relationshipId, proposalId, userId: user.id }
    );
    if (lockContention !== null) return lockContention;
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
