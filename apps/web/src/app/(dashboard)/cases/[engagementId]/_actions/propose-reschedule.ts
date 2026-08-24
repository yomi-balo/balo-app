'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { partyMembershipsRepository } from '@balo/db';
import { RESCHEDULE_PROPOSAL_MAX_OPTIONS } from '@balo/shared/meetings';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { hasEngagementCapability } from '@/lib/authz/engagement';
import type { SessionUser } from '@/lib/auth/session';
import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import {
  postProposeReschedule,
  postWithdrawRescheduleProposal,
} from '@/lib/meetings/reschedule-proposal-api-client';
import { authorizeCaseMutation } from '../_lib/authorize-case-mutation';
import { resolveNotificationLabels } from '../_lib/reschedule-notification-labels';
import { resolveBoundMeeting } from '../_lib/resolve-bound-meeting';
import type {
  ProposeRescheduleInput,
  ProposeRescheduleResult,
  RescheduleProposalFailureCode,
  WithdrawRescheduleProposalInput,
  WithdrawRescheduleProposalResult,
} from './_types/case-action-types';

/**
 * BAL-411 (§D8) — the EXPERT'S two mutations: propose up to three alternative times, and
 * withdraw an outstanding ask. ENGAGEMENT axis, never membership — mirrors
 * `request-resolution.ts`'s order exactly (it is BAL-421's first `manage_engagement` consumer;
 * this is the second):
 *
 *   1. `requireOnboardedUser()` — own call, for a specific `unauthenticated` code (the
 *      `reschedule-consultation.ts` precedent; `authorizeCaseMutation` also enforces this, but
 *      its refusal collapses to a generic `not_permitted`).
 *   2. Strict Zod on the FULL trusted input (`authorizeCaseMutation` only re-validates
 *      `engagementId`).
 *   3. `authorizeCaseMutation({ engagementId })` — discharges the READ obligation that
 *      `hasEngagementCapability` explicitly does NOT (`lib/authz/engagement.ts`'s docblock).
 *   4. `lens !== 'expert'` — the lens assertion FIRST, turning a confusing `false` from the
 *      engagement resolver (structurally excluded for a client-side actor) into a legible rule.
 *   5. `hasEngagementCapability(user, MANAGE_ENGAGEMENT, { contextType: 'case', contextId })` —
 *      from `apps/web/src/lib/authz/engagement.ts`, which ALREADY EXISTS and ALREADY admits
 *      `'case'` in `EngagementGrainHostSubject`. No widening, no new file.
 *   6. THE B3 MEETING↔ENGAGEMENT BINDING PROOF (`reschedule-consultation.ts:160-194`) —
 *      `meetingId` is a SEPARATE subject from `engagementId`; `authorizeCaseMutation` says
 *      nothing about which meeting the caller may act on. `findWithContexts` reads the
 *      meeting's LIVE context rows directly and requires a live `case` context whose
 *      `contextId` is exactly this `engagementId`.
 *   7. The Bearer hop — `apps/api`'s `authorizeMeetingRescheduleProposal` re-derives the SAME
 *      engagement axis from the meeting's own context row and is the ACTUAL authority; this
 *      gate exists so a caller with no engagement-axis grant anywhere cannot even reach it.
 *
 * ⚠ `reschedule_proposal.sent` is published from HERE, post-200 — the same posture
 * `booking.rescheduled` takes (§D2). `reschedule_proposal.unanswered` is SERVER-ONLY
 * (BAL-420's dispatch tick) and is never touched by this file.
 *
 * ⚠ WITHDRAW PUBLISHES NOTHING (§D5) — the ask disappearing from the client's nudge IS the
 * whole delivery mechanism. Do not add an event for it.
 */

const GENERIC_FAILURE = 'Something went wrong. Please try again.';

const proposeInputSchema = z
  .object({
    engagementId: z.uuid(),
    meetingId: z.uuid(),
    // Item 19 (security LOW) — `z.iso.datetime()`, not a bare `z.string().min(1)`. Every other
    // id on this action is `z.uuid()`; this one carried no shape check at all, unlike the api's
    // own boundary (`reschedule-proposals.schema.ts`'s `z.string().datetime()`).
    optionStartIsos: z.array(z.iso.datetime()).min(1).max(RESCHEDULE_PROPOSAL_MAX_OPTIONS),
  })
  .strict();

const withdrawInputSchema = z
  .object({
    engagementId: z.uuid(),
    meetingId: z.uuid(),
    proposalId: z.uuid(),
  })
  .strict();

/** The api's fixed literal → this action's failure vocabulary + copy. */
function mapProposeApiFailure(
  status: number,
  code: string
): { code: RescheduleProposalFailureCode; error: string } {
  if (status === 401 || code === 'unauthenticated') {
    return { code: 'unauthenticated', error: 'You are not signed in.' };
  }
  if (status === 400) {
    return { code: 'invalid_request', error: 'One of those times is not valid.' };
  }
  if (status === 404) {
    return { code: 'meeting_not_found', error: "We couldn't find that consultation." };
  }
  if (code === 'meeting_not_reschedulable') {
    return {
      code: 'meeting_not_reschedulable',
      error: 'This consultation can no longer be moved.',
    };
  }
  if (code === 'proposal_already_pending') {
    return {
      code: 'proposal_already_pending',
      error: 'You already have a proposal waiting on this consultation.',
    };
  }
  if (code === 'window_not_available') {
    return { code: 'slot_unavailable', error: 'One of those times was just taken.' };
  }
  if (code === 'case_closed') {
    return { code: 'case_closed', error: 'This case is no longer open.' };
  }
  if (status === 429 || code === 'rate_limited') {
    return { code: 'rate_limited', error: 'Too many changes just now — try again shortly.' };
  }
  return { code: 'unknown', error: GENERIC_FAILURE };
}

function mapWithdrawApiFailure(
  status: number,
  code: string
): { code: RescheduleProposalFailureCode; error: string } {
  if (status === 401 || code === 'unauthenticated') {
    return { code: 'unauthenticated', error: 'You are not signed in.' };
  }
  if (status === 404) {
    return { code: 'meeting_not_found', error: "We couldn't find that consultation." };
  }
  if (code === 'proposal_not_answerable') {
    return {
      code: 'proposal_not_answerable',
      error: 'This proposal has already been answered.',
    };
  }
  if (status === 429 || code === 'rate_limited') {
    return { code: 'rate_limited', error: 'Too many changes just now — try again shortly.' };
  }
  return { code: 'unknown', error: GENERIC_FAILURE };
}

export async function proposeRescheduleAction(
  input: ProposeRescheduleInput
): Promise<ProposeRescheduleResult> {
  let user: SessionUser;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, code: 'unauthenticated', error: 'You are not signed in.' };
  }

  const parsed = proposeInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, code: 'invalid_request', error: 'Invalid request.' };
  }
  const { engagementId, meetingId, optionStartIsos } = parsed.data;

  const gate = await authorizeCaseMutation({ engagementId });
  if (!gate.ok) {
    return { success: false, code: 'not_permitted', error: gate.error };
  }
  const denied = "You don't have permission to propose a new time for this consultation.";
  if (gate.lens !== 'expert') {
    return { success: false, code: 'not_permitted', error: denied };
  }
  const { companyId, expertProfileId, caseRow } = gate;

  try {
    const allowed = await hasEngagementCapability(user, ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT, {
      contextType: 'case',
      contextId: engagementId,
    });
    if (!allowed) {
      return { success: false, code: 'not_permitted', error: denied };
    }

    const bound = await resolveBoundMeeting(
      meetingId,
      engagementId,
      user.id,
      'Reschedule proposal'
    );
    if (!bound.ok) {
      return { success: false, code: bound.code, error: bound.error };
    }
    const { meeting } = bound;

    const result = await postProposeReschedule(meetingId, {
      options: optionStartIsos.map((scheduledStart) => ({ scheduledStart })),
    });

    if (!result.ok) {
      const mapped = mapProposeApiFailure(result.status, result.code);
      log.error('Reschedule proposal api hop failed', {
        meetingId,
        engagementId,
        status: result.status,
        code: result.code,
      });
      return { success: false, ...mapped };
    }

    revalidatePath(`/cases/${engagementId}`);
    log.info('Reschedule proposal proposed', {
      meetingId,
      engagementId,
      userId: user.id,
      proposalId: result.data.proposalId,
      optionCount: result.data.options.length,
    });

    const durationMinutes = Math.round(
      (meeting.scheduledEnd.getTime() - meeting.scheduledStart.getTime()) / 60_000
    );
    const nowMs = Date.now();

    const [labels, recipientUserIds] = await Promise.all([
      resolveNotificationLabels(companyId, expertProfileId).catch((error: unknown) => {
        log.error('Failed to resolve reschedule_proposal.sent labels — publishing with fallbacks', {
          meetingId,
          engagementId,
          error: errorMessage(error),
        });
        return {
          clientCompanyName: 'your company',
          expertPartyLabel: 'Your expert',
          expertPersonLabel: 'Your expert',
        };
      }),
      partyMembershipsRepository.listAdminUserIds('company', companyId).catch((error: unknown) => {
        log.error('Failed to resolve reschedule_proposal.sent recipients', {
          meetingId,
          engagementId,
          error: errorMessage(error),
        });
        return [] as string[];
      }),
    ]);

    // Item 7 — a `published` row that reached nobody is the worst possible shape (the
    // `scheduling/reschedule-proposal.ts` recheck's own rule, mirrored here at the FIRST
    // publish): skip rather than publish-and-lie when the client company resolved zero live
    // admin/owner recipients (a DB error already degrades to `[]` above; no live owner/admin at
    // all does too).
    if (recipientUserIds.length === 0) {
      log.warn(
        'Reschedule proposal has no live recipient on the client company — skipping the publish rather than recording a delivery that reached nobody',
        { meetingId, engagementId, companyId, proposalId: result.data.proposalId }
      );
    } else {
      // Fire-and-forget by contract — `publishNotificationEvent` never throws.
      publishNotificationEvent('reschedule_proposal.sent', {
        correlationId: result.data.proposalId,
        proposalId: result.data.proposalId,
        meetingId,
        engagementId,
        recipientUserIds,
        expertPartyLabel: labels.expertPartyLabel,
        expertPersonLabel: labels.expertPersonLabel,
        clientCompanyName: labels.clientCompanyName,
        caseTitle: caseRow.title,
        originalScheduledStartIso: meeting.scheduledStart.toISOString(),
        optionStartIsos: result.data.options.map((option) => option.scheduledStart),
        durationMinutes,
        // Item 5 — FRACTIONAL, never rounded: `rules.ts` gates the <2h SMS arm on
        // `hoursToStart < 2`, and rounding 1.83h up to 2 would silently disarm SMS in exactly
        // the urgent band the arm exists for. `hoursToStart` is `z.number()`, not `.int()`
        // (`schema.ts:589`) — a fractional value is already in contract. The rounded
        // `hoursBetween` shape used for the `hours_before_start` / `hours_to_respond`
        // ANALYTICS properties (`propose-times-dialog.tsx`, `reschedule-proposal-card.tsx`) is
        // deliberately unaffected — this is the ONE consumer of a wire value, not an analytics
        // property.
        hoursToStart: (meeting.scheduledStart.getTime() - nowMs) / 3_600_000,
        expiresAtIso: result.data.expiresAtIso,
      });
    }

    return {
      success: true,
      proposalId: result.data.proposalId,
      meetingId: result.data.meetingId,
      expiresAtIso: result.data.expiresAtIso,
      options: result.data.options,
    };
  } catch (error) {
    log.error('Failed to propose a reschedule', {
      meetingId,
      engagementId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, code: 'unknown', error: GENERIC_FAILURE };
  }
}

export async function withdrawRescheduleProposalAction(
  input: WithdrawRescheduleProposalInput
): Promise<WithdrawRescheduleProposalResult> {
  let user: SessionUser;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, code: 'unauthenticated', error: 'You are not signed in.' };
  }

  const parsed = withdrawInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, code: 'invalid_request', error: 'Invalid request.' };
  }
  const { engagementId, meetingId, proposalId } = parsed.data;

  const gate = await authorizeCaseMutation({ engagementId });
  if (!gate.ok) {
    return { success: false, code: 'not_permitted', error: gate.error };
  }
  const denied = "You don't have permission to withdraw this proposal.";
  if (gate.lens !== 'expert') {
    return { success: false, code: 'not_permitted', error: denied };
  }

  try {
    const allowed = await hasEngagementCapability(user, ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT, {
      contextType: 'case',
      contextId: engagementId,
    });
    if (!allowed) {
      return { success: false, code: 'not_permitted', error: denied };
    }

    const bound = await resolveBoundMeeting(
      meetingId,
      engagementId,
      user.id,
      'Withdraw reschedule proposal'
    );
    if (!bound.ok) {
      return { success: false, code: bound.code, error: bound.error };
    }

    const result = await postWithdrawRescheduleProposal(meetingId, proposalId);
    if (!result.ok) {
      const mapped = mapWithdrawApiFailure(result.status, result.code);
      log.error('Withdraw reschedule proposal api hop failed', {
        meetingId,
        engagementId,
        proposalId,
        status: result.status,
        code: result.code,
      });
      return { success: false, ...mapped };
    }

    revalidatePath(`/cases/${engagementId}`);
    log.info('Reschedule proposal withdrawn', {
      meetingId,
      engagementId,
      proposalId,
      userId: user.id,
    });

    // ⚠ NO PUBLISH — withdraw notifies nobody (§D5).
    return { success: true, proposalId: result.data.proposalId };
  } catch (error) {
    log.error('Failed to withdraw a reschedule proposal', {
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
