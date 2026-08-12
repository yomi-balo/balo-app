'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { caseEngagementsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { trackServerAndFlush, RECAP_SERVER_EVENTS } from '@/lib/analytics/server';
import { authorizeRecapCaseMutation } from '../_lib/authorize-recap-case-mutation';
import type { RecapActionResult } from './_types/recap-action-types';

/**
 * BAL-388 §R4 — the client dismisses the expert resolution request. The case stays OPEN.
 *
 * ⚠⚠ THE FOUR AUTHORIZATION GATES LIVE IN `authorizeRecapCaseMutation`, SHARED WITH
 * `resolve-case.ts` — signed-in wrapper, strict Zod, the recap read gate re-run in full
 * (client lens, `case` context), and `hasCapability(PARTICIPATE, companyId)` on the MEMBERSHIP
 * axis with the companyId taken from THE GATE (ADR-1029). Read that module for the ordering
 * contract; do NOT re-spell any of it here.
 *
 * ⚠ THE ENGAGEMENT ID COMES FROM THE GATE. A `case` context contextId IS the engagement id,
 * so the subject is derived, never supplied.
 *
 * ⚠⚠ NO NOTIFICATION, NO DOMAIN EVENT, NO TEMPLATE, NO RULE (owner decision D-E). Dismissal
 * clears the request and leaves the case open, SILENTLY — the expert is not told. The PostHog
 * event below is measurement, not a notification.
 *
 * ⚠ IDEMPOTENT. `clearResolutionRequest` nulls both PAIRED columns in one UPDATE (a
 * one-column update violates `case_engagement_resolution_request_paired`) and is a no-op when
 * they are already null, so a double-click produces exactly one outcome.
 *
 * ⚠ NO REGISTRATION IS NEEDED IN `_read-only-actions.ts`. That allowlist is for actions
 * authenticating with a BARE `requireUser(`; `requireOnboardedUser(` does not contain that
 * substring, and adding an entry there would FAIL that allowlist own no-stale-entries test.
 */
export async function dismissResolutionRequestAction(input: {
  meetingId: string;
}): Promise<RecapActionResult> {
  const gate = await authorizeRecapCaseMutation(input, "You don't have permission to do that.");
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }
  const { user, meetingId, engagementId } = gate;

  try {
    const cleared = await caseEngagementsRepository.clearResolutionRequest({ engagementId });
    if (cleared === undefined) {
      return { success: false, error: 'This case is no longer open.' };
    }

    trackServerAndFlush(RECAP_SERVER_EVENTS.CASE_RESOLUTION_REQUEST_DISMISSED, {
      meeting_id: meetingId,
      engagement_id: engagementId,
      distinct_id: user.id,
    });
    log.info('Case resolution request dismissed', { engagementId, meetingId, userId: user.id });

    revalidatePath('/meetings/' + meetingId);
    return { success: true };
  } catch (error) {
    log.error('Failed to dismiss case resolution request', {
      meetingId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}
