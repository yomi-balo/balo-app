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
import { requireOnboardedUser, type SessionUser } from '@/lib/auth/session';
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

/** A pass/fail step result carrying a user-facing error on failure. */
type Guard = { ok: true } | { ok: false; error: string };

/** Normalise an optional free-text field to `null` at the persistence boundary. */
function normalizeOptionalText(value?: string): string | null {
  return value && value.length > 0 ? value : null;
}

/**
 * Authorize a client billing-details submission: the caller must be the client on
 * this request (relationshipId validated as a claim), a company owner/admin, and
 * the deal must still be at `accepted` (both the request and the accepted
 * relationship). Returns a friendly error otherwise.
 */
async function authorizeClientBillingSubmit(
  user: SessionUser,
  requestId: string,
  relationshipId: string
): Promise<Guard> {
  const access = await resolveConversationAccess(user, requestId, relationshipId);
  if (!access.ok) {
    return { ok: false, error: access.error };
  }
  // Billing is a client-owned concern; experts/admin never capture it here.
  if (access.ctx.lens !== 'client') {
    return { ok: false, error: ONLY_CLIENT };
  }
  // Interim role gate — `canManageBilling` documents the BAL-314 capability migration.
  // Plain members lack authority to assert company legal details, but see a notice
  // (never a hidden step) — the gate is enforced here authoritatively.
  if (!canManageBilling(user.companyRole)) {
    return { ok: false, error: NOT_AUTHORIZED };
  }
  // The capture step exists only for the accepted deal (mirrors complete-kickoff-task).
  if (access.request.status !== 'accepted' || access.relationship.status !== 'accepted') {
    return { ok: false, error: STALE };
  }
  return { ok: true };
}

/**
 * Auto-confirm the `client_billing` kickoff gate via the BAL-322 idempotent
 * primitive (no-ops if already confirmed or the status advanced). A status that
 * moved off `accepted` since the authorization read surfaces as friendly stale copy.
 */
async function confirmClientBillingGate(requestId: string): Promise<Guard> {
  try {
    await ensureClientBillingGateConfirmed(requestId);
    return { ok: true };
  } catch (error) {
    if (error instanceof InvalidKickoffStateError) {
      return { ok: false, error: STALE };
    }
    throw error;
  }
}

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
 * Fire the post-commit signals: the server-side `billing_details_submitted`
 * analytics event, and (first capture only) the in-app admin "ready to invoice"
 * nudge via the notification engine.
 *
 * The admin nudge is best-effort / at-most-once: it keys on the pre-upsert
 * first-time read, so a crash between the upsert and this publish (or a TOCTOU on
 * two concurrent first submits) can drop it. Acceptable for v1 — the kickoff board
 * (BAL-324) is the AUTHORITATIVE "ready to invoice" signal; this nudge only saves
 * MJ from polling.
 */
async function emitBillingSignals(params: {
  user: SessionUser;
  requestId: string;
  relationshipId: string;
  countryCode: string;
  isFirstTime: boolean;
}): Promise<void> {
  const { user, requestId, relationshipId, countryCode, isFirstTime } = params;

  trackServerAndFlush(BILLING_SERVER_EVENTS.DETAILS_SUBMITTED, {
    company_id: user.companyId,
    request_id: requestId,
    country_code: countryCode,
    is_first_time: isFirstTime,
    hours_since_acceptance: await hoursSinceAcceptance(relationshipId),
    distinct_id: user.id,
  });

  if (isFirstTime) {
    void publishNotificationEvent('billing.details_confirmed', {
      correlationId: user.companyId,
      companyId: user.companyId,
      companyName: user.companyName,
      projectRequestId: requestId,
    });
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
    user = await requireOnboardedUser();
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
    const authorized = await authorizeClientBillingSubmit(user, requestId, relationshipId);
    if (!authorized.ok) {
      return { success: false, error: authorized.error };
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
      address: normalizeOptionalText(address),
      billingEmail,
      submittedByUserId: user.id,
    });

    // 2. Auto-confirm the client_billing kickoff gate.
    const gate = await confirmClientBillingGate(requestId);
    if (!gate.ok) {
      return { success: false, error: gate.error };
    }

    await emitBillingSignals({ user, requestId, relationshipId, countryCode, isFirstTime });

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
