'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  companyBillingRepository,
  ensureClientBillingGateConfirmed,
  proposalsRepository,
  InvalidKickoffStateError,
} from '@balo/db';
import { requireUser, type SessionUser } from '@/lib/auth/session';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import { canManageBilling } from '@/lib/billing/billing-capture';
import { trackServerAndFlush, BILLING_SERVER_EVENTS } from '@/lib/analytics/server';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { log } from '@/lib/logging';
import { billingDetailsSchema } from './billing-details-schema';

// The billing fields + the request/relationship the capture belongs to. The
// `relationshipId` is a CLAIM — validated server-side by the access guard.
const inputSchema = billingDetailsSchema.extend({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
});

export type SubmitBillingDetailsInput = z.infer<typeof inputSchema>;

export type SubmitBillingDetailsResult = { success: true } | { success: false; error: string };

const NOT_SIGNED_IN = 'You are not signed in.';
const INVALID_REQUEST = 'Invalid request.';
const ONLY_CLIENT = 'Only the client can add billing details.';
const NOT_AUTHORIZED = 'Only a company owner or admin can add billing details.';
const STALE = 'This kickoff is no longer open.';
const GENERIC_FAILURE = 'Could not save your billing details. Please try again.';

const MS_PER_HOUR = 3_600_000;

/**
 * Whole hours between proposal acceptance and now, from the accepted proposal's
 * `acceptedAt`. Best-effort analytics input: any lookup failure or missing
 * timestamp degrades to 0 rather than failing the already-saved submission.
 */
async function hoursSinceAcceptance(relationshipId: string): Promise<number> {
  try {
    const proposal = await proposalsRepository.findCurrentByRelationship(relationshipId);
    const acceptedAt = proposal?.acceptedAt;
    if (!acceptedAt) return 0;
    return Math.max(0, Math.round((Date.now() - acceptedAt.getTime()) / MS_PER_HOUR));
  } catch {
    return 0;
  }
}

/**
 * BAL-323 — capture the client company's billing identity and auto-confirm the
 * `client_billing` kickoff gate. Owner/admin only. Validate-before-write; both the
 * upsert and the gate confirm are individually idempotent, so a retry is safe (the
 * repository surface exposes no shared transaction across the two writes).
 */
export async function submitBillingDetailsAction(
  input: SubmitBillingDetailsInput
): Promise<SubmitBillingDetailsResult> {
  let user: SessionUser;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { requestId, relationshipId, legalName, countryCode, taxId, address, billingEmail } =
    parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }
    // Billing is a client-owned concern; experts/admin never capture it here.
    if (access.ctx.lens !== 'client') {
      return { success: false, error: ONLY_CLIENT };
    }
    // Interim role gate — plain members lack authority to assert company legal
    // details, but see the step with a notice (never a hidden step).
    // TODO(BAL-314): replace the companyRole gate with hasCapability(user, 'manage_billing').
    if (!canManageBilling(user.companyRole)) {
      return { success: false, error: NOT_AUTHORIZED };
    }
    // The capture step exists only for the accepted deal: both the request AND the
    // accepted relationship must be `accepted` (mirrors complete-kickoff-task).
    if (access.request.status !== 'accepted' || access.relationship.status !== 'accepted') {
      return { success: false, error: STALE };
    }

    // First-time vs edit — drives analytics `is_first_time` and the one-shot admin
    // notification (never re-notify on an edit).
    const existing = await companyBillingRepository.findByCompanyId(user.companyId);
    const isFirstTime = existing === undefined;

    // 1. Upsert the company's billing identity (whole-row last-write-wins).
    await companyBillingRepository.upsertByCompanyId({
      companyId: user.companyId,
      legalName,
      countryCode,
      taxId,
      address: address && address.length > 0 ? address : null,
      billingEmail,
      submittedByUserId: user.id,
    });

    // 2. Auto-confirm the client_billing kickoff gate (BAL-322 idempotent primitive:
    // no-ops if already confirmed or the status advanced; confirms when applicable).
    try {
      await ensureClientBillingGateConfirmed(requestId);
    } catch (error) {
      if (error instanceof InvalidKickoffStateError) {
        return { success: false, error: STALE };
      }
      throw error;
    }

    // Analytics — server-side (props computed here). This is the client's kickoff
    // signal now that billing capture replaces the direct gate flip.
    trackServerAndFlush(BILLING_SERVER_EVENTS.DETAILS_SUBMITTED, {
      company_id: user.companyId,
      request_id: requestId,
      country_code: countryCode,
      is_first_time: isFirstTime,
      hours_since_acceptance: await hoursSinceAcceptance(relationshipId),
      distinct_id: user.id,
    });

    // Notify MJ once, on the FIRST capture only — via the engine (in-app to admins).
    if (isFirstTime) {
      void publishNotificationEvent('billing.details_confirmed', {
        correlationId: user.companyId,
        companyId: user.companyId,
        companyName: user.companyName,
        projectRequestId: requestId,
      });
    }

    log.info('Client billing details submitted', {
      requestId,
      companyId: user.companyId,
      userId: user.id,
      isFirstTime,
    });

    revalidatePath(`/projects/${requestId}`);

    return { success: true };
  } catch (error) {
    log.error('Failed to submit billing details', {
      requestId,
      companyId: user.companyId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
