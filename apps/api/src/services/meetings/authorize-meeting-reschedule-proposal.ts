/**
 * BAL-411 (§D8) — THE EXPERT-SIDE TENANCY GATE FOR A RESCHEDULE PROPOSAL. Resolve a bare
 * `meetingId` to its PRIMARY context, require that context to be a `case` (BAL-411's scope —
 * any other label denies), then ask the ENGAGEMENT axis whether the acting user holds
 * `manage_engagement` over that case — before any state check is touched.
 *
 * ── WHY THE ENGAGEMENT AXIS, NOT THE MEMBERSHIP AXIS ──────────────────────────────────────────
 *
 * Propose/withdraw are the EXPERT's acts. `authorize-meeting-reschedule.ts`'s docblock states
 * this by name: "manage_engagement … is BAL-411's expert-side token", and warns against folding
 * the two axes into one gate. This module builds ONLY the expert arm; the client's accept/
 * decline REUSE `authorizeMeetingReschedule` unchanged (§D7 step 2) — the two API gate modules
 * stay separate on purpose.
 *
 * ── STRUCTURALLY MIRRORS `authorize-meeting-reschedule.ts` ───────────────────────────────────
 *
 * Same ordering discipline: resolve the meeting → resolve the primary context →
 * AUTHORIZATION BEFORE ANY STATE CHECK → collapse every denial into ONE literal. `meetings`
 * carries no party column (ADR-1045 §2) and `meeting_contexts.context_id` has no FK and no RLS
 * — an unchecked id here is a direct IDOR, exactly as it is for the client arm.
 *
 * ⚠ EVERY DENIAL COLLAPSES INTO ONE `meeting_not_found` LITERAL. There is NO `403` on this
 * route. WHICH SHAPE IT WAS goes to the log only.
 *
 * ⚠ NOT THIS GATE'S JOB: case liveness (`closed_at IS NULL`) and meeting reschedulability
 * (`resolveRescheduleRefusal`). Both are BUSINESS-STATE checks, not tenancy — case liveness is
 * the PROPOSE route's own additional guard (its own 409 `case_closed`, since withdraw does NOT
 * carry that restriction — see the route), and meeting state is `resolveRescheduleRefusal`,
 * checked by the route strictly AFTER this gate returns `ok`, exactly as the client route
 * checks it after `authorizeMeetingReschedule`.
 *
 * ⚠ A `true` from `hasEngagementCapability` authorizes the ACT, never the READ
 * (`authorize-engagement-host.ts`'s own docblock). Here the read obligation is discharged BY
 * CONSTRUCTION: the subject (`engagementId`) is derived from the MEETING's own context row and
 * never taken from request input, so a `true` means "this actor delivers THIS engagement" —
 * which is precisely entitlement to know this meeting exists.
 */
import {
  engagementsRepository,
  meetingContextsRepository,
  meetingsRepository,
  type Meeting,
} from '@balo/db';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import { selectPrimaryMeetingContext } from '@balo/shared/meetings';
import { hasEngagementCapability } from './authorize-engagement-host.js';

const log = createLogger('meeting-reschedule-proposal-authz');

/** ⚠ ONE FAILURE LITERAL FOR EVERY DENIAL. There is deliberately no `forbidden`. */
export type AuthorizeMeetingRescheduleProposalErrorCode = 'meeting_not_found';

export type AuthorizeMeetingRescheduleProposalResult =
  | {
      ok: true;
      meeting: Meeting;
      /** The `case` engagement's id — the primary context's `contextId`. */
      engagementId: string;
      /** `engagements.expert_profile_id` — NOT NULL on the supertype for every engagement type
       *  (BAL-417), so this is never `null` on this axis. */
      expertProfileId: string;
      /** `engagements.company_id` — the CLIENT company. Threaded out for the propose route's
       *  BAL-420 reminder payload, so it does not re-read the engagement a third time. */
      companyId: string;
    }
  | { ok: false; code: AuthorizeMeetingRescheduleProposalErrorCode };

export interface AuthorizeMeetingRescheduleProposalInput {
  meetingId: string;
  userId: string;
}

/** Which read came back empty, or which axis refused — a LOG field, never a wire value. */
type DenialReason =
  | 'no_meeting'
  | 'no_context'
  | 'ambiguous_context'
  | 'unsupported_context_type'
  | 'no_engagement'
  | 'no_capability';

/** The single fail-closed exit. The SHAPE goes here; the wire gets one literal. */
function deny(
  reason: DenialReason,
  fields: Record<string, unknown>
): { ok: false; code: 'meeting_not_found' } {
  log.warn({ ...fields, reason }, 'Meeting reschedule-proposal denied');
  return { ok: false, code: 'meeting_not_found' };
}

/**
 * Fail-closed, engagement-axis authorization for proposing/withdrawing a reschedule on a
 * booked consultation. Expert arm only — see the module docblock for why there is no client
 * arm here.
 *
 * Returns the meeting, the case engagement id and the delivering expert's profile id, so the
 * route threads all three onward and none is read twice.
 */
export async function authorizeMeetingRescheduleProposal(
  input: AuthorizeMeetingRescheduleProposalInput
): Promise<AuthorizeMeetingRescheduleProposalResult> {
  const { meetingId, userId } = input;

  // 1. The meeting. `findById` filters `deleted_at IS NULL`, so missing and soft-deleted are
  //    one outcome.
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    return deny('no_meeting', { userId, meetingId });
  }

  // 2. The PRIMARY context. `listByMeeting` filters soft-deleted rows.
  const contexts = await meetingContextsRepository.listByMeeting(meetingId);
  const primary = selectPrimaryMeetingContext(contexts);
  if (!primary.ok) {
    return deny(primary.reason === 'ambiguous' ? 'ambiguous_context' : 'no_context', {
      userId,
      meetingId,
      contextCount: contexts.length,
    });
  }

  // 3. BAL-411's SCOPE FENCE — a reschedule proposal is a CASE-grain ask only. Any other
  //    context label (project_kickoff, package_session, retainer_checkin, the two request-grain
  //    arms, or admin) denies rather than silently widening to a subject this ticket never
  //    designed for.
  if (primary.context.contextType !== 'case') {
    return deny('unsupported_context_type', {
      userId,
      meetingId,
      contextType: primary.context.contextType,
    });
  }
  const engagementId = primary.context.contextId;

  // ── 4. AUTHORIZATION. Nothing below this point runs before the engagement-axis grant is
  //       proven. ──
  const allowed = await hasEngagementCapability(
    { id: userId },
    ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
    { contextType: 'case', contextId: engagementId }
  );
  if (!allowed) {
    return deny('no_capability', { userId, meetingId, engagementId });
  }

  // 5. The delivering expert's profile id, for the route's own availability/duration work.
  //    A second read of `engagements` (the resolver above already read it once, internally) —
  //    accepted, matching the `authorize-meeting-reschedule.ts` precedent's own
  //    `loadOwningParty` shape, which also re-reads rather than threading a resolver's
  //    internals back out.
  const engagement = await engagementsRepository.findById(engagementId);
  if (engagement === undefined) {
    return deny('no_engagement', { userId, meetingId, engagementId });
  }

  return {
    ok: true,
    meeting,
    engagementId,
    expertProfileId: engagement.expertProfileId,
    companyId: engagement.companyId,
  };
}
