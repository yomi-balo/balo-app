'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  proposalsRepository,
  projectRequestsRepository,
  InvalidKickoffStateError,
  UpfrontInvoiceBeforeBillingError,
} from '@balo/db';
import { PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import {
  upfrontForProposal,
  type ResolvedKickoffUpfront,
} from '@/lib/project-request/kickoff-upfront';
import { requireRequestStaffCapability } from './_shared/require-request-staff-capability';

const inputSchema = z.object({
  requestId: z.uuid(),
  // A CLAIM — validated against the request's accepted relationship below.
  relationshipId: z.uuid(),
});

export type MarkUpfrontInvoiceRaisedInput = z.infer<typeof inputSchema>;

/** `changed: false` — the invoice was already marked raised; nothing was written. */
export type MarkUpfrontInvoiceRaisedResult =
  | { success: true; changed: boolean }
  | { success: false; error: string };

const INVALID_REQUEST = 'Invalid request.';
const STALE = 'This request is no longer awaiting kickoff.';
const BILLING_FIRST = 'The client needs to add billing details before the invoice is raised.';
const NOTHING_DUE = 'Nothing is due upfront on this deal — approve kickoff instead.';
const GENERIC_FAILURE = 'Could not record the invoice. Please try again.';

/**
 * Load + verify everything raising the invoice needs — never trust the admin's claim.
 * The request must be `accepted`, the claimed relationship must BE the accepted one, the
 * client's billing must be confirmed, and the accepted current proposal must have
 * something due upfront. Returns that amount, or a friendly error string.
 */
async function loadRaisableInvoice(
  requestId: string,
  relationshipId: string
): Promise<{ upfront: ResolvedKickoffUpfront } | { error: string }> {
  const request = await projectRequestsRepository.findByIdWithRelations(requestId);
  if (request === undefined) {
    return { error: INVALID_REQUEST };
  }
  const rel = request.relationships.find((r) => r.status === 'accepted');
  if (request.status !== 'accepted' || rel?.id !== relationshipId) {
    return { error: STALE };
  }
  if (request.clientBillingConfirmedAt === null) {
    return { error: BILLING_FIRST };
  }

  const proposal = await proposalsRepository.findCurrentByRelationship(relationshipId);
  if (proposal?.isCurrent !== true || proposal.status !== 'accepted') {
    return { error: STALE };
  }
  const upfront = await upfrontForProposal(proposal);
  return upfront === null ? { error: NOTHING_DUE } : { upfront };
}

/**
 * Record the raise — who raised it and for how much (audited in the repository, ADR-1030).
 * The repository's typed refusals map to friendly copy; anything else rethrows.
 */
async function recordInvoiceRaised(
  requestId: string,
  actorUserId: string,
  upfront: ResolvedKickoffUpfront
): Promise<{ changed: boolean } | { error: string }> {
  try {
    const { changed } = await projectRequestsRepository.markUpfrontInvoiceRaised({
      id: requestId,
      actorUserId,
      amountCents: upfront.amountCents,
      currency: upfront.currency,
    });
    return { changed };
  } catch (error) {
    if (error instanceof InvalidKickoffStateError) {
      return { error: STALE };
    }
    if (error instanceof UpfrontInvoiceBeforeBillingError) {
      return { error: BILLING_FIRST };
    }
    throw error;
  }
}

/**
 * Balo records that it has raised the upfront invoice — the kickoff checklist's
 * middle step, between the client's billing details and Balo confirming payment
 * (`approve-kickoff.ts`). The invoice itself is raised outside Balo for now; this
 * records the fact so the client sees it is theirs to pay.
 *
 * Control flow: requireRequestStaffCapability(MANAGE_ANY_KICKOFF_GATE) → validate
 * input → `loadRaisableInvoice` → `recordInvoiceRaised` (idempotent; typed errors →
 * friendly copy) → log → revalidate → return. Analytics fire client-side (PROJECT_UPFRONT_INVOICE_RAISED),
 * only when `changed`.
 */
export async function markUpfrontInvoiceRaisedAction(
  input: MarkUpfrontInvoiceRaisedInput
): Promise<MarkUpfrontInvoiceRaisedResult> {
  const auth = await requireRequestStaffCapability(PLATFORM_CAPABILITIES.MANAGE_ANY_KICKOFF_GATE);
  if (!auth.ok) {
    return { success: false, error: auth.error };
  }
  const admin = auth.user;

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: INVALID_REQUEST };
  }
  const { requestId, relationshipId } = parsed.data;

  try {
    const loaded = await loadRaisableInvoice(requestId, relationshipId);
    if ('error' in loaded) {
      return { success: false, error: loaded.error };
    }
    const { upfront } = loaded;

    const recorded = await recordInvoiceRaised(requestId, admin.id, upfront);
    if ('error' in recorded) {
      return { success: false, error: recorded.error };
    }

    // Key business event (after the commit).
    log.info('Upfront invoice marked raised', {
      requestId,
      relationshipId,
      amountCents: upfront.amountCents,
      currency: upfront.currency,
      changed: recorded.changed,
      userId: admin.id,
    });

    revalidatePath(`/projects/${requestId}`);

    return { success: true, changed: recorded.changed };
  } catch (error) {
    log.error('Failed to mark upfront invoice raised', {
      requestId,
      relationshipId,
      userId: admin.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
