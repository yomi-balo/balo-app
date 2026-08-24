'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { SessionUser } from '@/lib/auth/session';
import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { postRescheduleMeeting } from '@/lib/meetings/reschedule-api-client';
import { authorizeClientCaseMutation } from '../_lib/authorize-client-case-mutation';
import { publishBookingRescheduled } from '../_lib/publish-booking-rescheduled';
import { resolveBoundMeeting } from '../_lib/resolve-bound-meeting';
import type {
  RescheduleConsultationInput,
  RescheduleConsultationResult,
  RescheduleFailureCode,
} from './_types/case-action-types';

/**
 * BAL-409 — THE CLIENT-INITIATED RESCHEDULE, FROM THE CASE SURFACE.
 *
 * ── ORDER ────────────────────────────────────────────────────────────────────────────────
 *   1. `requireOnboardedUser()` — MANDATORY for a mutation (enforced by
 *      `invariants/onboarding-mutation-gate.test.ts`).
 *   2. Strict Zod on the three trusted inputs.
 *   3. `authorizeCaseMutation(engagementId)` — the shipped web-side case gate: onboarded
 *      session, tenancy re-run (Server Actions bypass middleware), case-type coherence.
 *      ⚠ THIS IS NOT THE AUTHORITATIVE GATE FOR THE MEETING ITSELF — `apps/api`'s
 *      `authorizeMeetingReschedule` re-derives tenancy from the MEETING's own context and is
 *      the seam that actually protects the write. This gate exists so a member of NO case
 *      anywhere cannot even reach the api hop, and so `revalidatePath`/the notification
 *      payload have a company/case to work with.
 *   4. Read the meeting's CURRENT window server-side (never trust a client-submitted
 *      duration) and compute `scheduledEnd = startIso + currentDurationMinutes` — the
 *      SERVER, not the picker, pins the length. A reschedule MOVES a booking; it does not
 *      resize it.
 *   5. `postRescheduleMeeting` — the Bearer hop. NOTHING THROWS; every failure is a typed
 *      result.
 *   6. On success: `revalidatePath` (the resolve-case.ts pattern — the user STAYS on this
 *      page), `log.info`, publish `booking.rescheduled` fire-and-forget, return the SERVER's
 *      committed window (never the client's submitted slot).
 */
const inputSchema = z
  .object({
    engagementId: z.uuid(),
    meetingId: z.uuid(),
    startIso: z.string().min(1),
  })
  .strict();

/** One literal for every unmapped/unexpected failure. Never `err.message` — see below. */
const GENERIC_FAILURE = 'Something went wrong. Please try again.';

/** The api's fixed literal → this action's failure vocabulary + copy. */
function mapApiFailure(
  status: number,
  code: string
): { code: RescheduleFailureCode; error: string } {
  if (status === 401 || code === 'unauthenticated') {
    return { code: 'unauthenticated', error: 'You are not signed in.' };
  }
  if (status === 400) {
    return { code: 'invalid_request', error: 'That time is not valid.' };
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
  if (code === 'window_not_available') {
    return { code: 'slot_unavailable', error: 'That time was just taken. Pick another.' };
  }
  if (status === 429) {
    return { code: 'rate_limited', error: 'Too many changes just now — try again shortly.' };
  }
  return { code: 'unknown', error: GENERIC_FAILURE };
}

export async function rescheduleConsultationAction(
  input: RescheduleConsultationInput
): Promise<RescheduleConsultationResult> {
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
  const { engagementId, meetingId, startIso } = parsed.data;

  // BAL-411 shipped the expert-side propose-and-wait as its OWN action (`propose-reschedule.ts`),
  // on the ENGAGEMENT axis — a different axis, a different route, and (fix round 2 item 2) now
  // the same `authorizeClientCaseMutation` CLIENT-lens gate as this action's siblings in
  // `respond-to-reschedule-proposal.ts`, not a separate copy of it. This action stays the
  // client-initiated, auto-approving path only.
  const gate = await authorizeClientCaseMutation(
    engagementId,
    user,
    "You don't have permission to reschedule this consultation."
  );
  if (!gate.ok) {
    return { success: false, code: 'not_permitted', error: gate.error };
  }
  const { companyId, expertProfileId, caseRow } = gate;

  try {
    // Step 3b — B3: PROVE `meetingId` BELONGS TO `engagementId` BEFORE ANYTHING ELSE.
    // `authorizeCaseMutation(engagementId)` authorizes CASE `engagementId`; on its own, reading
    // `meetingId` off the client-submitted input and handing it to the API re-derives tenancy
    // from THAT MEETING's own context — a completely different subject. Two gates, two
    // subjects, and nothing joining them: a client could submit `{engagementId: A, meetingId:
    // B}` (any two cases they can each individually reach) and both gates would pass — pairing
    // case A's `expertProfileId`/`caseTitle` with case B's `meetingId`/join link in the
    // notification, and revalidating case A's page for a move that actually happened on case B.
    // `resolveBoundMeeting` reads the meeting's LIVE context rows directly (never re-derived
    // from `engagementId`) and requires a live `case` context whose `contextId` is exactly this
    // `engagementId` — closing the join the two independent gates leave open. Fix round 1 item
    // 9 — extracted; was a byte-identical inline copy shared with `propose-reschedule.ts` and
    // `respond-to-reschedule-proposal.ts`.
    const bound = await resolveBoundMeeting(meetingId, engagementId, user.id, 'Reschedule');
    if (!bound.ok) {
      return { success: false, code: bound.code, error: bound.error };
    }
    const { meeting } = bound;

    // Step 4 — the CURRENT window, read fresh. Never trust a client-submitted duration.
    const currentDurationMs = meeting.scheduledEnd.getTime() - meeting.scheduledStart.getTime();
    const startMs = Date.parse(startIso);
    if (!Number.isFinite(startMs)) {
      return { success: false, code: 'invalid_request', error: 'That time is not valid.' };
    }
    const endIso = new Date(startMs + currentDurationMs).toISOString();

    const result = await postRescheduleMeeting(meetingId, {
      scheduledStart: startIso,
      scheduledEnd: endIso,
    });

    if (!result.ok) {
      const mapped = mapApiFailure(result.status, result.code);
      log.error('Reschedule api hop failed', {
        meetingId,
        engagementId,
        status: result.status,
        code: result.code,
      });
      return { success: false, ...mapped };
    }

    // N4 — THE NO-OP GUARD, RE-CHECKED HERE. The api's own no-op guard already refused to
    // WRITE anything when the requested window equals the current one, and echoes that back as
    // `changed: false` — but until this fix, this action never read the field: a same-window
    // resubmit still `revalidatePath`d, toasted "Consultation moved", and published
    // `booking.rescheduled` with `previousScheduledStartIso === scheduledStartIso`. Nothing
    // moved, so nothing below this point may run.
    if (!result.data.changed) {
      return {
        success: true,
        scheduledStart: result.data.scheduledStart,
        scheduledEnd: result.data.scheduledEnd,
      };
    }

    revalidatePath(`/cases/${engagementId}`);
    log.info('Consultation rescheduled', { meetingId, engagementId, userId: user.id });

    // Fix round 2 item 2 — the label resolution, the deploy-skew `rescheduleAuditId` fallback,
    // and the `booking.rescheduled` publish envelope are now `publishBookingRescheduled` (own
    // docblock covers the "labels awaited, publish itself not" ordering requirement this used to
    // explain inline) — shared with `respond-to-reschedule-proposal.ts`'s accept path, the other
    // COMMITTED-move caller of this exact event.
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
      initiatedBy: 'client',
    });

    return {
      success: true,
      scheduledStart: result.data.scheduledStart,
      scheduledEnd: result.data.scheduledEnd,
    };
  } catch (error) {
    log.error('Failed to reschedule consultation', {
      meetingId,
      engagementId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, code: 'unknown', error: GENERIC_FAILURE };
  }
}
