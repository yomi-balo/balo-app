'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  agenciesRepository,
  companiesRepository,
  expertsRepository,
  meetingsRepository,
  usersRepository,
} from '@balo/db';
import { expertPartyDisplayName } from '@balo/shared/parties';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import type { SessionUser } from '@/lib/auth/session';
import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { postRescheduleMeeting } from '@/lib/meetings/reschedule-api-client';
import { authorizeCaseMutation } from '../_lib/authorize-case-mutation';
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

/**
 * The `booking.rescheduled` payload's two display labels, resolved the SAME way
 * `close-case-effects.ts`'s `publishCaseClosed` does — column-projected reads, never a full
 * row. Never throws: a publish is best-effort and must not fail an already-committed move.
 */
async function resolveNotificationLabels(
  companyId: string,
  expertProfileId: string
): Promise<{ clientCompanyName: string; expertPartyLabel: string }> {
  const [company, profile] = await Promise.all([
    companiesRepository.findNameById(companyId),
    expertsRepository.findDisplayProfileById(expertProfileId),
  ]);
  const [expertUser, agency] = await Promise.all([
    profile === undefined
      ? Promise.resolve(undefined)
      : usersRepository.findDisplayById(profile.userId),
    profile?.agencyId == null
      ? Promise.resolve(undefined)
      : agenciesRepository.getSummaryById(profile.agencyId),
  ]);
  return {
    clientCompanyName: company?.name ?? 'your company',
    expertPartyLabel: expertPartyDisplayName({
      type: profile?.type ?? 'freelancer',
      agencyName: agency?.name ?? null,
      firstName: expertUser?.firstName ?? null,
      lastName: expertUser?.lastName ?? null,
    }),
  };
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

  const gate = await authorizeCaseMutation({ engagementId });
  if (!gate.ok) {
    return { success: false, code: 'not_permitted', error: gate.error };
  }
  const denied = "You don't have permission to reschedule this consultation.";
  if (gate.lens !== 'client') {
    // BAL-411 (expert-side propose-and-wait) is a different axis and a different ticket.
    return { success: false, code: 'not_permitted', error: denied };
  }
  const { companyId, expertProfileId, caseRow } = gate;

  // N1 — CLAUDE.md bans gating on `lens ===` alone; `lens` is a routing hint, not an
  // authorization decision. Pair it with the actual MEMBERSHIP-axis capability check, the same
  // way the shipped sibling `resolve-case.ts` does for the close action.
  const allowed = await hasCapability(user, CAPABILITIES.PARTICIPATE, { companyId });
  if (!allowed) {
    return { success: false, code: 'not_permitted', error: denied };
  }

  try {
    // Step 3b — B3: PROVE `meetingId` BELONGS TO `engagementId` BEFORE ANYTHING ELSE.
    // `authorizeCaseMutation(engagementId)` authorizes CASE `engagementId`; on its own, reading
    // `meetingId` off the client-submitted input and handing it to the API re-derives tenancy
    // from THAT MEETING's own context — a completely different subject. Two gates, two
    // subjects, and nothing joining them: a client could submit `{engagementId: A, meetingId:
    // B}` (any two cases they can each individually reach) and both gates would pass — pairing
    // case A's `expertProfileId`/`caseTitle` with case B's `meetingId`/join link in the
    // notification, and revalidating case A's page for a move that actually happened on case B.
    // `findWithContexts` reads the meeting's LIVE context rows directly (never re-derived from
    // `engagementId`) and requires a live `case` context whose `contextId` is exactly this
    // `engagementId` — closing the join the two independent gates leave open.
    const meetingWithContexts = await meetingsRepository.findWithContexts(meetingId);
    if (meetingWithContexts === undefined) {
      return {
        success: false,
        code: 'meeting_not_found',
        error: "We couldn't find that consultation.",
      };
    }
    const { meeting, contexts } = meetingWithContexts;
    const belongsToThisCase = contexts.some(
      (context) => context.contextType === 'case' && context.contextId === engagementId
    );
    if (!belongsToThisCase) {
      log.error('Reschedule meetingId does not belong to engagementId — refusing', {
        meetingId,
        engagementId,
        userId: user.id,
      });
      return {
        success: false,
        code: 'meeting_not_found',
        error: "We couldn't find that consultation.",
      };
    }

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

    // ⚠ THE LABELS ARE AWAITED; THE PUBLISH ITSELF IS NOT. `publishNotificationEvent` must be
    // called SYNCHRONOUSLY within this action's own execution (the `book-consultation.ts`
    // precedent) so Next's `after()` (inside it) can still register against the live request
    // context — calling it from a `.then()` continuation on a promise created here risks that
    // context having already been torn down by the time the continuation runs. Resolving the
    // labels first costs two small column-projected reads, not a second network hop.
    const labels = await resolveNotificationLabels(companyId, expertProfileId).catch(
      (error: unknown) => {
        log.error('Failed to resolve booking.rescheduled labels — publishing with fallbacks', {
          meetingId,
          engagementId,
          error: errorMessage(error),
        });
        return { clientCompanyName: 'your company', expertPartyLabel: 'Your expert' };
      }
    );
    // ⚠ THE FALLBACK IS A DEPLOY-SKEW SAFETY NET, NOT A NORMAL PATH — so it is LOUD. A
    // `changed: true` response always carries `rescheduleAuditId`; if it does not, the web is
    // running against an older API and every reschedule silently reverts to the window-derived
    // key, reinstating the A→B→C→B collision that drops both party emails. Silence there would
    // make a real regression indistinguishable from correct behaviour.
    const rescheduleAuditId = result.data.rescheduleAuditId;
    if (rescheduleAuditId === undefined) {
      log.warn('Reschedule response carried no rescheduleAuditId — falling back to a window key', {
        meetingId,
        engagementId,
      });
    }

    // Fire-and-forget by contract — `publishNotificationEvent` never throws (see its own
    // docblock); nothing here needs a `.catch()`.
    publishNotificationEvent('booking.rescheduled', {
      // ⚠ THE AUDIT ROW ID, NOT THE TARGET WINDOW. `publisher.ts` turns `correlationId` into
      // the BullMQ jobId (`${event}--${correlationId}`) and the notification-events queue
      // RETAINS 100 completed jobs, so `${meetingId}:${scheduledStart}` would collide on a
      // move BACK to a previously-used window (A→B→C→B) and silently drop BOTH party emails.
      // Falls back to the window only on deploy skew — see the `log.warn` above.
      correlationId: `${meetingId}:${rescheduleAuditId ?? result.data.scheduledStart}`,
      meetingId,
      engagementId,
      recipientId: user.id,
      expertProfileId,
      clientCompanyName: labels.clientCompanyName,
      expertPartyLabel: labels.expertPartyLabel,
      caseTitle: caseRow.title,
      previousScheduledStartIso: result.data.previousScheduledStart,
      scheduledStartIso: result.data.scheduledStart,
      durationMinutes: Math.round(currentDurationMs / 60_000),
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
