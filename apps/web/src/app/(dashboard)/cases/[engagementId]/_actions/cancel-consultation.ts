'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { CAPABILITIES, ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { hasCapability } from '@/lib/authz';
import { hasEngagementCapability } from '@/lib/authz/engagement';
import type { SessionUser } from '@/lib/auth/session';
import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { postCancelMeeting } from '@/lib/meetings/cancel-api-client';
import { authorizeCaseMutation } from '../_lib/authorize-case-mutation';
import { resolveBoundMeeting } from '../_lib/resolve-bound-meeting';
import type {
  CancelConsultationInput,
  CancelConsultationResult,
  CancelFailureCode,
} from './_types/case-action-types';

/**
 * BAL-410 — CANCEL A BOOKED CONSULTATION, FROM THE CASE SURFACE. Free until the scheduled start.
 *
 * ── ORDER ────────────────────────────────────────────────────────────────────────────────
 *   1. `requireOnboardedUser()` — MANDATORY for a mutation (enforced by
 *      `invariants/onboarding-mutation-gate.test.ts`). Its own call, so an unauthenticated
 *      caller gets the specific `unauthenticated` code rather than a generic `not_permitted`.
 *   2. Strict Zod on the two trusted inputs.
 *   3. `authorizeCaseMutation({ engagementId })` — the shipped web-side case gate: tenancy
 *      re-run (Server Actions bypass middleware) and case-type coherence. It also discharges
 *      the READ obligation `hasEngagementCapability` explicitly does NOT.
 *   4. THE AXIS, BY LENS — and this is the one thing that must not be simplified:
 *        · client lens → MEMBERSHIP axis, `hasCapability(user, PARTICIPATE, { companyId })`
 *        · expert lens → ENGAGEMENT axis, `hasEngagementCapability(user, MANAGE_ENGAGEMENT, …)`
 *      ⚠ `lens` ALONE IS NEVER AUTHORIZATION (CLAUDE.md bans gating on `lens ===`): it selects
 *      WHICH axis to ask, and the capability call is what answers. The expert term is required
 *      rather than decorative — `resolveCaseAccess` admits ANY live agency member INCLUDING
 *      role `expert` (`actorHasExpertSideVisibility`, deliberately wider — ADR-1046 §7), who is
 *      not a `manage_engagement` holder.
 *   5. `resolveBoundMeeting` — THE B3 MEETING↔ENGAGEMENT BINDING PROOF. `meetingId` is a
 *      SEPARATE subject from `engagementId`; step 3/4 say nothing about which MEETING the caller
 *      may act on. Without it a caller could submit `{engagementId: A, meetingId: B}` — two
 *      cases they can each reach on their own — and have this action treat B as though it
 *      belonged to A, revalidating case A's page for a cancel that happened on case B.
 *   6. `postCancelMeeting` — the Bearer hop. NOTHING THROWS; every failure is a typed result.
 *   7. On success: `revalidatePath` (the user STAYS on this page) + `log.info`.
 *
 * ⚠⚠ THIS GATE IS BELT-AND-BRACES, NOT THE AUTHORITY. `apps/api`'s `authorizeMeetingCancel`
 * re-derives all three axes independently from the MEETING's own context row and is the seam
 * that actually protects the write. This one exists so a member of no case anywhere gets a
 * clean, copy-bearing refusal instead of a bare 404 — the `propose-reschedule.ts` posture.
 *
 * ⚠⚠ IT PUBLISHES NOTHING, AND THAT IS A DECISION RATHER THAN AN OMISSION. `booking.cancelled`
 * is published by `apps/api`'s cancel ROUTE, because the ADMIN override arm is an explicit AC
 * and has no web surface at all — a web publisher would notify nobody on an admin cancel. See
 * `apps/api/src/services/meetings/publish-booking-cancelled.ts`. Do not add a publish here; it
 * would double-send on the two arms that DO have a web surface.
 */
const inputSchema = z
  .object({
    engagementId: z.uuid(),
    meetingId: z.uuid(),
  })
  .strict();

/** One literal for every unmapped/unexpected failure. Never `err.message`. */
const GENERIC_FAILURE = 'Something went wrong. Please try again.';

/** The api's fixed literal → this action's failure vocabulary + copy. */
function mapApiFailure(status: number, code: string): { code: CancelFailureCode; error: string } {
  if (status === 401 || code === 'unauthenticated') {
    return { code: 'unauthenticated', error: 'You are not signed in.' };
  }
  if (status === 400) {
    return { code: 'invalid_request', error: "That request wasn't valid." };
  }
  if (status === 404) {
    return { code: 'meeting_not_found', error: "We couldn't find that consultation." };
  }
  if (code === 'meeting_not_cancellable') {
    return {
      code: 'meeting_not_cancellable',
      error: 'This consultation has already started or was already cancelled.',
    };
  }
  if (status === 429 || code === 'rate_limited') {
    return { code: 'rate_limited', error: 'Too many changes just now — try again shortly.' };
  }
  return { code: 'unknown', error: GENERIC_FAILURE };
}

/**
 * Step 4 — resolve the axis the LENS selects, and ask it. Extracted so the action body stays a
 * linear read and under SonarCloud's cognitive-complexity ceiling.
 *
 * Returns `true` when the acting user holds the right this lens requires. There is deliberately
 * no third branch: `authorizeCaseMutation`'s `lens` is a two-member union, so an unhandled value
 * is unrepresentable rather than silently allowed.
 */
async function actorMayCancel(
  user: SessionUser,
  lens: 'client' | 'expert',
  engagementId: string,
  companyId: string
): Promise<boolean> {
  if (lens === 'client') {
    return hasCapability(user, CAPABILITIES.PARTICIPATE, { companyId });
  }
  return hasEngagementCapability(user, ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT, {
    contextType: 'case',
    contextId: engagementId,
  });
}

export async function cancelConsultationAction(
  input: CancelConsultationInput
): Promise<CancelConsultationResult> {
  let user: SessionUser;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, code: 'unauthenticated', error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, code: 'invalid_request', error: 'Invalid request.' };
  }
  const { engagementId, meetingId } = parsed.data;

  const gate = await authorizeCaseMutation({ engagementId });
  if (!gate.ok) {
    return { success: false, code: 'not_permitted', error: gate.error };
  }
  const denied = "You don't have permission to cancel this consultation.";
  const { lens, companyId } = gate;

  try {
    const allowed = await actorMayCancel(user, lens, engagementId, companyId);
    if (!allowed) {
      return { success: false, code: 'not_permitted', error: denied };
    }

    const bound = await resolveBoundMeeting(meetingId, engagementId, user.id, 'Cancel');
    if (!bound.ok) {
      return { success: false, code: bound.code, error: bound.error };
    }

    const result = await postCancelMeeting(meetingId);

    if (!result.ok) {
      const mapped = mapApiFailure(result.status, result.code);
      log.error('Cancel api hop failed', {
        meetingId,
        engagementId,
        status: result.status,
        code: result.code,
      });
      return { success: false, ...mapped };
    }

    revalidatePath(`/cases/${engagementId}`);
    log.info('Consultation cancelled', {
      meetingId,
      engagementId,
      userId: user.id,
      // ⚠ THE API'S ARM, never re-derived from the lens — the two must not be able to disagree.
      initiatedBy: result.data.initiatedBy,
      // The only observable evidence the money unwind ran; nothing on screen reflects it.
      holdReleased: result.data.holdReleased,
    });

    return {
      success: true,
      scheduledStart: result.data.scheduledStart,
      initiatedBy: result.data.initiatedBy,
      holdReleased: result.data.holdReleased,
    };
  } catch (error) {
    log.error('Failed to cancel consultation', {
      meetingId,
      engagementId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, code: 'unknown', error: GENERIC_FAILURE };
  }
}
