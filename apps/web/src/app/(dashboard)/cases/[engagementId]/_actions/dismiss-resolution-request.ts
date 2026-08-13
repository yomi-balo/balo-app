'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { caseEngagementsRepository } from '@balo/db';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { errorMessage, log } from '@/lib/logging';
import { trackServerAndFlush, RECAP_SERVER_EVENTS } from '@/lib/analytics/server';
import { authorizeCaseMutation } from '../_lib/authorize-case-mutation';
import type { CaseActionResult } from './_types/case-action-types';

/**
 * BAL-421 — THE CLIENT DISMISSES THE EXPERT'S RESOLUTION REQUEST, from the case surface. The
 * case stays OPEN. The second entry point onto BAL-388's shipped dismissal.
 *
 * ⚠ THE MEMBERSHIP AXIS, NOT THE ENGAGEMENT AXIS — the exact mirror of the ask. Answering
 * "is this resolved?" is a CLIENT-side act on the client's own company scope
 * (`PARTICIPATE`, with `companyId` re-derived from the loaded engagement row via the gate,
 * never from input — ADR-1029). The expert asks on the engagement axis; the client answers on
 * the membership axis. Two different questions, two different holder sets.
 *
 * ⚠⚠ NO NOTIFICATION, NO DOMAIN EVENT, NO TEMPLATE, NO RULE (owner decision D-E). Dismissal
 * clears the request and leaves the case open, SILENTLY — the expert is not told. The PostHog
 * event below is measurement, not a notification.
 *
 * ⚠ IDEMPOTENT. `clearResolutionRequest` nulls both PAIRED columns in one UPDATE (a one-column
 * update violates `case_engagement_resolution_request_paired`, 23514) and is a no-op when they
 * are already null, so a double-click produces exactly one outcome.
 *
 * ⚠ NO ENTRY IS NEEDED IN `_read-only-actions.ts`. That allowlist is for actions
 * authenticating with a BARE `requireUser(`; this one gates through `authorizeCaseMutation` ⇒
 * `requireOnboardedUser()`, which does not contain that substring — and adding an entry would
 * FAIL that allowlist's own no-stale-entries test.
 */
export async function dismissResolutionRequestAction(input: {
  engagementId: string;
}): Promise<CaseActionResult> {
  const gate = await authorizeCaseMutation(input);
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }
  const { user, engagementId, companyId, lens } = gate;

  const denied = "You don't have permission to do that.";
  if (lens !== 'client') {
    // Only the client can answer the question; the expert may only ask it.
    return { success: false, error: denied };
  }

  try {
    const allowed = await hasCapability(user, CAPABILITIES.PARTICIPATE, { companyId });
    if (!allowed) {
      return { success: false, error: denied };
    }

    const cleared = await caseEngagementsRepository.clearResolutionRequest({ engagementId });
    if (cleared === undefined) {
      return { success: false, error: 'This case is no longer open.' };
    }

    // ⚠ NO `meeting_id` — the case surface has none in scope, and the field is OPTIONAL for
    // exactly this caller. Fabricating one would attribute the dismissal to an unrelated
    // consultation. `engagement_id` is what identifies the case.
    trackServerAndFlush(RECAP_SERVER_EVENTS.CASE_RESOLUTION_REQUEST_DISMISSED, {
      engagement_id: engagementId,
      distinct_id: user.id,
    });
    log.info('Case resolution request dismissed', { engagementId, userId: user.id });

    revalidatePath('/cases/' + engagementId);
    return { success: true };
  } catch (error) {
    log.error('Failed to dismiss case resolution request', {
      engagementId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}
