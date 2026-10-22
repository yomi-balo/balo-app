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
import { upfrontForProposal } from '@/lib/project-request/kickoff-upfront';
import { requireRequestStaffCapability } from './_shared/require-request-staff-capability';

const inputSchema = z.object({
  requestId: z.uuid(),
  // A CLAIM — validated against the request's accepted relationship below.
  relationshipId: z.uuid(),
});

export type MarkUpfrontInvoiceRaisedInput = z.infer<typeof inputSchema>;

export type MarkUpfrontInvoiceRaisedResult = { success: true } | { success: false; error: string };

const INVALID_REQUEST = 'Invalid request.';
const STALE = 'This request is no longer awaiting kickoff.';
const BILLING_FIRST = 'The client needs to add billing details before the invoice is raised.';
const NOTHING_DUE = 'Nothing is due upfront on this deal — approve kickoff instead.';
const GENERIC_FAILURE = 'Could not record the invoice. Please try again.';

/**
 * Balo records that it has raised the upfront invoice — the kickoff checklist's
 * middle step, between the client's billing details and Balo confirming payment
 * (`approve-kickoff.ts`). The invoice itself is raised outside Balo for now; this
 * records the fact so the client sees it is theirs to pay.
 *
 * Control flow: requireRequestStaffCapability(MANAGE_ANY_KICKOFF_GATE) → validate
 * input → request `accepted` and the claimed relationship is the accepted one →
 * billing confirmed → the accepted current proposal has something due upfront →
 * `markUpfrontInvoiceRaised` (idempotent; typed errors → friendly copy) → log →
 * revalidate → return. Analytics fire client-side (PROJECT_KICKOFF_GATE_CONFIRMED).
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
    const request = await projectRequestsRepository.findByIdWithRelations(requestId);
    if (request === undefined) {
      return { success: false, error: INVALID_REQUEST };
    }
    const rel = request.relationships.find((r) => r.status === 'accepted');
    if (request.status !== 'accepted' || rel === undefined || rel.id !== relationshipId) {
      return { success: false, error: STALE };
    }
    if (request.clientBillingConfirmedAt === null) {
      return { success: false, error: BILLING_FIRST };
    }

    const proposal = await proposalsRepository.findCurrentByRelationship(rel.id);
    if (proposal === undefined || !proposal.isCurrent || proposal.status !== 'accepted') {
      return { success: false, error: STALE };
    }
    const upfront = await upfrontForProposal(proposal);
    if (upfront === null) {
      return { success: false, error: NOTHING_DUE };
    }

    try {
      await projectRequestsRepository.markUpfrontInvoiceRaised({ id: requestId });
    } catch (error) {
      if (error instanceof InvalidKickoffStateError) {
        return { success: false, error: STALE };
      }
      if (error instanceof UpfrontInvoiceBeforeBillingError) {
        return { success: false, error: BILLING_FIRST };
      }
      throw error;
    }

    // Key business event (after the commit).
    log.info('Upfront invoice marked raised', {
      requestId,
      relationshipId,
      amountCents: upfront.amountCents,
      currency: upfront.currency,
      userId: admin.id,
    });

    revalidatePath(`/projects/${requestId}`);

    return { success: true };
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
