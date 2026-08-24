'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { companiesRepository, usersRepository } from '@balo/db';
import { personDisplayName, personWithOrgLabel } from '@balo/shared/parties';
import type { SessionUser } from '@/lib/auth/session';
import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import {
  postAcceptRescheduleProposal,
  postDeclineRescheduleProposal,
} from '@/lib/meetings/reschedule-proposal-api-client';
import { authorizeClientCaseMutation } from '../_lib/authorize-client-case-mutation';
import { publishBookingRescheduled } from '../_lib/publish-booking-rescheduled';
import { resolveBoundMeeting } from '../_lib/resolve-bound-meeting';
import type {
  AcceptRescheduleProposalInput,
  AcceptRescheduleProposalResult,
  DeclineRescheduleProposalInput,
  DeclineRescheduleProposalResult,
  RescheduleProposalFailureCode,
} from './_types/case-action-types';

/**
 * BAL-411 (§D8) — the CLIENT'S two answers to an outstanding proposal: accept one option, or
 * decline (keep the original time). MEMBERSHIP axis, never engagement — mirrors
 * `reschedule-consultation.ts`'s order exactly:
 *
 *   1. `requireOnboardedUser()` — own call, for a specific `unauthenticated` code.
 *   2. Strict Zod on the FULL trusted input.
 *   3. `authorizeCaseMutation({ engagementId })` — the shipped web-side case gate.
 *   4. `lens !== 'client'` — checked explicitly (N1: `lens` is a routing hint, never an
 *      authorization decision — CLAUDE.md).
 *   5. `hasCapability(user, CAPABILITIES.PARTICIPATE, { companyId })` — the ACTUAL
 *      membership-axis check, paired with the lens rather than substituting for it.
 *   6. THE B3 MEETING↔ENGAGEMENT BINDING PROOF — `meetingId` is a subject `engagementId`
 *      alone does not authorize.
 *   7. The Bearer hop — `apps/api`'s `authorizeMeetingReschedule` (REUSED VERBATIM from
 *      BAL-409) re-derives membership from the meeting's own context and is the ACTUAL
 *      authority.
 *
 * ⚠ ACCEPT publishes `booking.rescheduled` — NOT a new event. The BAL-409 fan-out already
 * notifies the expert (`booking-rescheduled-expert` fires on this SAME publish); a new
 * `reschedule_proposal.accepted` event would double-email them about one move (§Notifications).
 * `initiatedBy: 'expert'` records that the MOVE originated with the expert's ask, even though
 * the client's own click is what committed it.
 *
 * ⚠ DECLINE publishes `reschedule_proposal.declined` — the ONE new client-fired event this
 * file owns. No meeting mutation; nothing moves.
 */

const GENERIC_FAILURE = 'Something went wrong. Please try again.';

const acceptInputSchema = z
  .object({
    engagementId: z.uuid(),
    meetingId: z.uuid(),
    proposalId: z.uuid(),
    optionId: z.uuid(),
  })
  .strict();

const declineInputSchema = z
  .object({
    engagementId: z.uuid(),
    meetingId: z.uuid(),
    proposalId: z.uuid(),
  })
  .strict();

function mapAnswerApiFailure(
  status: number,
  code: string
): { code: RescheduleProposalFailureCode; error: string } {
  if (status === 401 || code === 'unauthenticated') {
    return { code: 'unauthenticated', error: 'You are not signed in.' };
  }
  if (status === 404) {
    return { code: 'meeting_not_found', error: "We couldn't find that consultation." };
  }
  if (code === 'proposal_stale') {
    return {
      code: 'proposal_stale',
      error: 'This proposal no longer matches the booking — refresh the page.',
    };
  }
  if (code === 'proposal_not_answerable') {
    return {
      code: 'proposal_not_answerable',
      error: 'This proposal has already been answered.',
    };
  }
  if (code === 'meeting_not_reschedulable') {
    return {
      code: 'meeting_not_reschedulable',
      error: 'This consultation can no longer be moved.',
    };
  }
  if (code === 'window_not_available') {
    return { code: 'slot_unavailable', error: 'That time was just taken.' };
  }
  if (status === 429 || code === 'rate_limited') {
    return { code: 'rate_limited', error: 'Too many changes just now — try again shortly.' };
  }
  return { code: 'unknown', error: GENERIC_FAILURE };
}

/** `resolveBoundMeeting` with this file's fixed action label — shared by accept and decline,
 *  both answering the SAME live proposal on the SAME B3 subject. Kept INSIDE each caller's own
 *  `try`, same as before this extraction — a thrown lookup error must stay caught by that
 *  caller's own `catch` (mapped to `'unknown'`), not escape from a shared preamble above it. */
function resolveAnswerBoundMeeting(
  meetingId: string,
  engagementId: string,
  userId: string
): ReturnType<typeof resolveBoundMeeting> {
  return resolveBoundMeeting(meetingId, engagementId, userId, 'Reschedule proposal answer');
}

export async function acceptRescheduleProposalAction(
  input: AcceptRescheduleProposalInput
): Promise<AcceptRescheduleProposalResult> {
  let user: SessionUser;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, code: 'unauthenticated', error: 'You are not signed in.' };
  }

  const parsed = acceptInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, code: 'invalid_request', error: 'Invalid request.' };
  }
  const { engagementId, meetingId, proposalId, optionId } = parsed.data;

  const gate = await authorizeClientCaseMutation(
    engagementId,
    user,
    "You don't have permission to accept this proposal."
  );
  if (!gate.ok) {
    return { success: false, code: 'not_permitted', error: gate.error };
  }
  const { companyId, expertProfileId, caseRow } = gate;

  try {
    const bound = await resolveAnswerBoundMeeting(meetingId, engagementId, user.id);
    if (!bound.ok) {
      return { success: false, code: bound.code, error: bound.error };
    }
    const { meeting } = bound;

    const result = await postAcceptRescheduleProposal(meetingId, proposalId, { optionId });
    if (!result.ok) {
      const mapped = mapAnswerApiFailure(result.status, result.code);
      log.error('Accept reschedule proposal api hop failed', {
        meetingId,
        engagementId,
        proposalId,
        status: result.status,
        code: result.code,
      });
      return { success: false, ...mapped };
    }

    revalidatePath(`/cases/${engagementId}`);
    log.info('Reschedule proposal accepted', {
      meetingId,
      engagementId,
      proposalId,
      userId: user.id,
    });

    const currentDurationMs = meeting.scheduledEnd.getTime() - meeting.scheduledStart.getTime();

    // Fix round 2 item 2 — the label resolution, the deploy-skew `rescheduleAuditId` fallback,
    // and the `booking.rescheduled` publish envelope are now `publishBookingRescheduled`, shared
    // with `reschedule-consultation.ts`'s own committed move. `initiatedBy: 'expert'` — THE MOVE
    // ORIGINATED WITH THE EXPERT'S ASK, even though the client's own click committed it — see
    // the module docblock.
    await publishBookingRescheduled({
      meetingId,
      engagementId,
      companyId,
      expertProfileId,
      caseTitle: caseRow.title,
      recipientId: user.id,
      previousScheduledStart: result.data.previousScheduledStart,
      scheduledStart: result.data.scheduledStart,
      durationMinutes: Math.round(currentDurationMs / 60_000),
      rescheduleAuditId: result.data.rescheduleAuditId,
      initiatedBy: 'expert',
      logContext: { proposalId },
    });

    return {
      success: true,
      proposalId: result.data.proposalId,
      scheduledStart: result.data.scheduledStart,
      scheduledEnd: result.data.scheduledEnd,
    };
  } catch (error) {
    log.error('Failed to accept a reschedule proposal', {
      meetingId,
      engagementId,
      proposalId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, code: 'unknown', error: GENERIC_FAILURE };
  }
}

export async function declineRescheduleProposalAction(
  input: DeclineRescheduleProposalInput
): Promise<DeclineRescheduleProposalResult> {
  let user: SessionUser;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, code: 'unauthenticated', error: 'You are not signed in.' };
  }

  const parsed = declineInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, code: 'invalid_request', error: 'Invalid request.' };
  }
  const { engagementId, meetingId, proposalId } = parsed.data;

  const gate = await authorizeClientCaseMutation(
    engagementId,
    user,
    "You don't have permission to decline this proposal."
  );
  if (!gate.ok) {
    return { success: false, code: 'not_permitted', error: gate.error };
  }
  const { companyId, expertProfileId, caseRow } = gate;

  try {
    const bound = await resolveAnswerBoundMeeting(meetingId, engagementId, user.id);
    if (!bound.ok) {
      return { success: false, code: bound.code, error: bound.error };
    }
    const { meeting } = bound;

    const result = await postDeclineRescheduleProposal(meetingId, proposalId);
    if (!result.ok) {
      const mapped = mapAnswerApiFailure(result.status, result.code);
      log.error('Decline reschedule proposal api hop failed', {
        meetingId,
        engagementId,
        proposalId,
        status: result.status,
        code: result.code,
      });
      return { success: false, ...mapped };
    }

    revalidatePath(`/cases/${engagementId}`);
    log.info('Reschedule proposal declined', {
      meetingId,
      engagementId,
      proposalId,
      userId: user.id,
    });

    const durationMinutes = Math.round(
      (meeting.scheduledEnd.getTime() - meeting.scheduledStart.getTime()) / 60_000
    );

    const [company, viewer] = await Promise.all([
      companiesRepository.findNameById(companyId).catch((error: unknown) => {
        log.error('Failed to resolve company name for decline notification — falling back', {
          meetingId,
          engagementId,
          proposalId,
          error: errorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return undefined;
      }),
      usersRepository.findDisplayById(user.id).catch((error: unknown) => {
        log.error(
          'Failed to resolve decliner display name for decline notification — falling back',
          {
            meetingId,
            engagementId,
            proposalId,
            error: errorMessage(error),
            stack: error instanceof Error ? error.stack : undefined,
          }
        );
        return undefined;
      }),
    ]);
    const clientCompanyName = company?.name ?? 'your company';
    const declinerPerson = personDisplayName(
      viewer?.firstName ?? null,
      viewer?.lastName ?? null,
      'A team member'
    );

    // Fire-and-forget by contract — `publishNotificationEvent` never throws.
    publishNotificationEvent('reschedule_proposal.declined', {
      correlationId: result.data.proposalId,
      proposalId: result.data.proposalId,
      meetingId,
      engagementId,
      expertProfileId,
      clientCompanyName,
      caseTitle: caseRow.title,
      declinedByLabel: personWithOrgLabel(declinerPerson, clientCompanyName),
      originalScheduledStartIso: meeting.scheduledStart.toISOString(),
      durationMinutes,
    });

    return { success: true, proposalId: result.data.proposalId };
  } catch (error) {
    log.error('Failed to decline a reschedule proposal', {
      meetingId,
      engagementId,
      proposalId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, code: 'unknown', error: GENERIC_FAILURE };
  }
}
