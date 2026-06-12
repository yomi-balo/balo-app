'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  proposalsRepository,
  projectRequestsRepository,
  engagementsRepository,
  InvalidStatusTransitionError,
  KickoffGatesIncompleteError,
} from '@balo/db';
import { requireAdmin } from '@/lib/auth/require-admin';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';

const inputSchema = z.object({
  requestId: z.uuid(),
  // A CLAIM — validated against the request's accepted relationship below.
  relationshipId: z.uuid(),
});

export type ApproveKickoffInput = z.infer<typeof inputSchema>;

export type ApproveKickoffResult =
  | { success: true; engagementId: string }
  | { success: false; error: string };

const NOT_ALLOWED = 'You do not have permission to do this.';
const INVALID_REQUEST = 'Invalid request.';
const STALE = 'This request is no longer awaiting kickoff approval.';
const GATES_INCOMPLETE = 'Client and expert must complete their steps first.';
const GENERIC_FAILURE = 'Could not approve this kickoff. Please try again.';

/** Display name for a person on the request graph (notification body). */
function displayName(firstName: string | null, lastName: string | null, fallback: string): string {
  return [firstName, lastName].filter(Boolean).join(' ').trim() || fallback;
}

/**
 * Admin approves a kickoff (BAL-291 / A6.5) — the third (settle-invoice +
 * approve) gate, collapsed into the request's `accepted → kickoff_approved`
 * transition. In ONE transaction (via `engagementsRepository.materializeFromKickoff`)
 * the request advances AND the engagement is materialised, snapshotting the
 * accepted proposal's commercial terms. Then notifies the client (and, via the
 * resolver, the delivering expert) — fire-and-forget, AFTER the commit.
 *
 * Control flow: requireAdmin → validate input → load the request graph →
 * verify the request is `accepted` and the claimed relationship is the accepted
 * one → verify both persisted gates are confirmed → re-load + verify the accepted
 * current proposal (its terms are snapshotted) → `materializeFromKickoff` (typed
 * transition errors → friendly copy) → log → notify → revalidate → return.
 *
 * Analytics are fired CLIENT-side by the component (PROJECT_KICKOFF_APPROVED);
 * this action does not track server-side.
 */
export async function approveKickoffAction(
  input: ApproveKickoffInput
): Promise<ApproveKickoffResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { success: false, error: NOT_ALLOWED };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { requestId, relationshipId } = parsed.data;

  try {
    const request = await projectRequestsRepository.findByIdWithRelations(requestId);
    if (request === undefined) {
      return { success: false, error: INVALID_REQUEST };
    }

    // Must be an accepted request, and the claimed relationship must BE the
    // accepted one (the winning expert).
    const rel = request.relationships.find((r) => r.status === 'accepted');
    if (request.status !== 'accepted' || rel === undefined || rel.id !== relationshipId) {
      return { success: false, error: STALE };
    }

    // Both persisted kickoff gates must be confirmed before approval.
    if (request.clientBillingConfirmedAt === null || request.expertTermsConfirmedAt === null) {
      return { success: false, error: GATES_INCOMPLETE };
    }

    // Re-load + verify the accepted current proposal — its commercial terms are
    // snapshotted into the engagement. Never trust a stale read.
    const proposal = await proposalsRepository.findCurrentByRelationship(rel.id);
    if (proposal === undefined || !proposal.isCurrent || proposal.status !== 'accepted') {
      return { success: false, error: STALE };
    }

    // Advance the request AND materialise the engagement in ONE transaction,
    // snapshotting the proposal's terms. A benign double-approve race (another
    // admin already advanced) trips `InvalidStatusTransitionError`; an unconfirmed
    // gate (lost between the read above and the locked write) trips
    // `KickoffGatesIncompleteError`.
    let engagement;
    try {
      const result = await engagementsRepository.materializeFromKickoff({
        requestId,
        companyId: request.companyId,
        expertProfileId: rel.expertProfileId,
        sourceProposalId: proposal.id,
        relationshipId: rel.id,
        pricingMethod: proposal.pricingMethod,
        priceCents: proposal.priceCents,
        currency: proposal.currency,
        depositCents: proposal.depositCents ?? undefined,
        rateCents: proposal.rateCents ?? undefined,
        cadence: proposal.cadence ?? undefined,
      });
      engagement = result.engagement;
    } catch (error) {
      if (error instanceof InvalidStatusTransitionError) {
        return { success: false, error: STALE };
      }
      if (error instanceof KickoffGatesIncompleteError) {
        return { success: false, error: GATES_INCOMPLETE };
      }
      throw error;
    }

    // Key business event (after the commit).
    log.info('Kickoff approved', {
      requestId,
      relationshipId: rel.id,
      engagementId: engagement.id,
      expertProfileId: rel.expertProfileId,
      userId: admin.id,
    });

    // Notify the client (and, via the resolver, the delivering expert) — AFTER
    // the commit, fire-and-forget. Names are derived from the request graph.
    const expertName = displayName(
      rel.expertProfile.user.firstName,
      rel.expertProfile.user.lastName,
      'the expert'
    );
    const clientName = displayName(
      request.createdByUser.firstName,
      request.createdByUser.lastName,
      'The client'
    );
    publishNotificationEvent('project.kickoff_approved', {
      correlationId: requestId,
      projectRequestId: requestId,
      relationshipId: rel.id,
      expertProfileId: rel.expertProfileId,
      recipientId: request.createdByUserId,
      title: request.title,
      expertName,
      clientName,
      clientCompanyName: request.company?.name ?? 'their company',
    }).catch(() => {
      // publishNotificationEvent logs internally.
    });

    // Revalidate the request-detail page AND the proposal surface, so
    // back-navigation there doesn't serve a stale "awaiting approval" state.
    revalidatePath(`/projects/${requestId}`);
    revalidatePath(`/projects/${requestId}/proposal/${rel.id}`);

    return { success: true, engagementId: engagement.id };
  } catch (error) {
    log.error('Failed to approve kickoff', {
      requestId,
      relationshipId,
      userId: admin.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
