/**
 * BAL-409 (§5) — THE CLIENT-SIDE TENANCY GATE FOR A MEETING RESCHEDULE. Resolve a bare
 * `meetingId` to its PRIMARY context, resolve that context to its OWNING PARTY, then require
 * the acting user to be a LIVE MEMBER of the owning company holding `participate` — before any
 * state check (status, wall clock, window availability) is touched.
 *
 * ── WHY THE MEMBERSHIP AXIS, NOT THE ENGAGEMENT AXIS (orchestrator D-A item 2) ─────────────
 *
 * A client-initiated reschedule is a MEMBERSHIP-axis act on the client company: `participate`,
 * the same base-bundle token `authorize-meeting-booking.ts` and `authorize-meeting-
 * participation.ts`'s client arm already use. It is deliberately NOT `manage_engagement` — that
 * is BAL-411's expert-side token (`ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT`,
 * `@balo/shared/authz/engagement.ts`). This module builds ONLY the client arm; BAL-411 owns the
 * expert-side propose-and-wait half on its own axis. Do not fold the two into one "reschedule"
 * gate — that would conflate two axes CLAUDE.md keeps separate.
 *
 * ── THE IDOR THIS GATE CLOSES ───────────────────────────────────────────────────────────────
 *
 * `meetings` carries NO party column at all (ADR-1045 §2, enforced by
 * `invariants/meetings-no-context-column.test.ts`), and `meeting_contexts.context_id` has NO
 * FK and NO RLS (`schema/meeting-contexts.ts`) — a uuid belonging to another tenant does not
 * fail, it succeeds silently. Unchecked, `POST /meetings/:meetingId/reschedule` would let any
 * authenticated user move ANY expert's booking, on any tenant, by guessing a uuid
 * (`services/meetings/meeting-availability.ts`'s obligation, discharged here). The owning party
 * is read OFF THE CONTEXT'S OWN ROW (an `engagements` / `project_requests` /
 * `request_expert_relationships` record that DOES carry `company_id`), and membership is then
 * proven against THAT company — never a party taken from request input.
 *
 * ── ORDERING IS PART OF THE CONTRACT (copied verbatim from `authorize-meeting-booking.ts` /
 * `authorize-meeting-participation.ts`, including the reasoning) ──────────────────────────────
 *
 * resolve the meeting → resolve the primary context → resolve the owning party →
 * AUTHORIZATION BEFORE ANY COHERENCE OR STATE CHECK → collapse every denial into ONE literal.
 * Running a state check (meeting status, wall clock, window availability) before authorization
 * would let an actor with no membership anywhere distinguish states of a guessed `meetingId` by
 * status code alone — an existence oracle over every meeting on the platform, readable by any
 * self-serve signup. Meeting state (`resolveRescheduleRefusal`) is therefore checked by the
 * ROUTE, strictly AFTER this gate returns `ok`.
 *
 * ⚠ EVERY DENIAL COLLAPSES INTO ONE `meeting_not_found` LITERAL, exactly as the participation
 * gate does. There is NO `403` on this route. WHICH SHAPE IT WAS goes to the log only.
 *
 * ⚠ NOT THIS GATE'S JOB: engagement liveness. `resolveContextOwner` consults no status, and a
 * reschedule of a `scheduled` meeting on a `completed` engagement is still a real booking that
 * should move — that is a different question from a join's liveness check.
 *
 * ⚠ A `true` here authorizes the ACT, never the READ of anything else. Resolving the context's
 * owning party remains the caller's obligation on every subsequent read — which is why this
 * gate threads `meeting`, `subject`, `companyId` and `expertProfileId` back out, so nothing
 * downstream re-reads them and nothing can disagree with itself.
 */
import {
  meetingContextsRepository,
  meetingsRepository,
  partyMembershipsRepository,
  type Meeting,
} from '@balo/db';
import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import { selectPrimaryMeetingContext, type PrimaryMeetingContext } from '@balo/shared/meetings';
// BAL-410 — EXTRACTED. This module's own copy of the `@balo/db` owning-party binding was the
// template BAL-410's cancel gate was modelled on; both now import the one definition rather than
// carrying two. Behaviour is unchanged.
import { loadOwningParty } from './resolve-meeting-owning-party.js';

const log = createLogger('meeting-reschedule-authz');

/** ⚠ ONE FAILURE LITERAL FOR EVERY DENIAL. There is deliberately no `forbidden`. */
export type AuthorizeMeetingRescheduleErrorCode = 'meeting_not_found';

export type AuthorizeMeetingRescheduleResult =
  | {
      ok: true;
      meeting: Meeting;
      /** The PRIMARY context — resolved once, threaded back so nothing downstream re-reads it. */
      subject: PrimaryMeetingContext;
      companyId: string;
      /** `null` for a `match`-routed `project_discovery`, which names nobody. */
      expertProfileId: string | null;
    }
  | { ok: false; code: AuthorizeMeetingRescheduleErrorCode };

export interface AuthorizeMeetingRescheduleInput {
  meetingId: string;
  userId: string;
}

/** Which read came back empty, or which axis refused — a LOG field, never a wire value. */
type DenialReason =
  | 'no_meeting'
  | 'no_context'
  | 'ambiguous_context'
  | 'subject_unresolvable'
  | 'cross_tenant'
  | 'no_capability';

/** The single fail-closed exit. The SHAPE goes here; the wire gets one literal. */
function deny(
  reason: DenialReason,
  fields: Record<string, unknown>
): { ok: false; code: 'meeting_not_found' } {
  log.warn({ ...fields, reason }, 'Meeting reschedule denied');
  return { ok: false, code: 'meeting_not_found' };
}

/**
 * Fail-closed, membership-axis authorization for rescheduling a booked consultation. Client
 * arm only — see the module docblock for why there is no expert arm here.
 *
 * Returns the meeting, the primary context, the owning company and the expert (if any), so the
 * route threads all four onward and none is read twice.
 */
export async function authorizeMeetingReschedule(
  input: AuthorizeMeetingRescheduleInput
): Promise<AuthorizeMeetingRescheduleResult> {
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
  const subject = primary.context;

  // 3. The owning party, from the primary context's own row.
  const owner = await loadOwningParty(subject);
  if (owner === undefined) {
    return deny('subject_unresolvable', {
      userId,
      meetingId,
      contextType: subject.contextType,
      contextId: subject.contextId,
    });
  }
  const { companyId, expertProfileId } = owner;

  // ── 4. AUTHORIZATION. Nothing below this point runs before membership is proven. ──
  const role = await partyMembershipsRepository.getMemberRole('company', companyId, userId);
  if (role === undefined) {
    return deny('cross_tenant', { userId, meetingId, companyId, contextType: subject.contextType });
  }
  if (!roleHasCapability(role, CAPABILITIES.PARTICIPATE)) {
    return deny('no_capability', { userId, meetingId, companyId });
  }

  return { ok: true, meeting, subject, companyId, expertProfileId };
}
