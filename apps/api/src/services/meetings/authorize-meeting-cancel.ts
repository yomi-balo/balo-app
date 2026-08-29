/**
 * BAL-410 (orchestrator D6) — THE TENANCY GATE FOR CANCELLING A BOOKED CONSULTATION. Resolve a
 * bare `meetingId` to its PRIMARY context, resolve that context to its OWNING PARTY, then try
 * THREE ARMS ON THREE DIFFERENT AXES — before any state check (status) is touched.
 *
 * ── THREE AXES, ONE PER ACTOR. NEVER A ROLE CHECK. ────────────────────────────────────────
 *
 * CLAUDE.md's authorization model keeps three capability axes apart by SUBJECT, and a cancel is
 * the first act in the codebase that legitimately needs all three:
 *
 *   · CLIENT — the MEMBERSHIP axis, `participate`, against the company that owns the primary
 *     context. The same base-bundle token `authorize-meeting-booking.ts` and
 *     `authorize-meeting-reschedule.ts` already use.
 *   · EXPERT — the ENGAGEMENT axis, `manage_engagement`, via `hasEngagementCapability`. ADR-1046
 *     names "expert-side cancel" as a `manage_engagement` act by name. The holder set is the
 *     delivering expert plus their agency `owner`/`admin` — never agency role `expert`, whose
 *     WIDER visibility is deliberate and permanent (ADR-1046 §7) and must not be aligned to
 *     this narrower ACT set.
 *   · ADMIN — the PLATFORM axis, `CANCEL_ANY_MEETING` (ADR-1035). The support-mediated override
 *     the ticket requires, audited with the acting admin's own user id.
 *
 * ⚠ THE AXES ARE SPELLED api-SIDE, WHICH IS NOT THE SAME AS BEING A DIFFERENT AXIS.
 * `hasCapability` and `hasPlatformCapability` are `apps/web`-only (`import 'server-only'`), so
 * the membership axis here is `partyMembershipsRepository.getMemberRole(...)` +
 * `roleHasCapability(...)` — exactly what `authorize-meeting-reschedule.ts` does — and the
 * platform axis is `platformRoleHasCapability(user.platformRole, …)` — exactly what
 * `routes/sessions/index.ts` does. Both read the SAME pure `@balo/shared/authz` maps. ⚠ There
 * is deliberately no `platformRole ===`, `role ===`, `lens ===` or `activeMode ===` anywhere in
 * this file.
 *
 * ── THE IDOR THIS GATE CLOSES ───────────────────────────────────────────────────────────────
 *
 * `meetings` carries NO party column at all (ADR-1045 §2, enforced by
 * `invariants/meetings-no-context-column.test.ts`), and `meeting_contexts.context_id` has NO FK
 * and NO RLS — a uuid belonging to another tenant does not fail, it succeeds silently.
 * Unchecked, `POST /meetings/:meetingId/cancel` would let any authenticated user CANCEL ANY
 * expert's booking, on any tenant, by guessing a uuid. That is the per-route obligation
 * `services/meetings/meeting-availability.ts` records; this module discharges it for the cancel
 * route the same way booking and reschedule discharged theirs. The repository is NOT touched.
 *
 * ── ORDERING IS PART OF THE CONTRACT ────────────────────────────────────────────────────────
 *
 * resolve the meeting → resolve the primary context → resolve the owning party →
 * AUTHORIZATION BEFORE ANY STATE CHECK → collapse every denial into ONE literal.
 * Running a state check (`resolveCancelRefusal`) before authorization would let an actor with
 * no membership anywhere distinguish states of a guessed `meetingId` by status code alone — an
 * existence oracle over every meeting on the platform, readable by any self-serve signup.
 * Meeting state is therefore checked by the ROUTE, strictly AFTER this gate returns `ok`.
 *
 * ⚠ ARM ORDER IS CLIENT → EXPERT → ADMIN, cheapest-first. The FIRST match wins and is what gets
 * audited and what drives the notification copy, so an actor who somehow holds two arms resolves
 * as `'client'`. The admin read (`usersRepository.findById`) only happens when both party arms
 * have already failed.
 *
 * ⚠ EVERY DENIAL COLLAPSES INTO ONE `meeting_not_found` LITERAL. There is NO `403` on this
 * route. WHICH SHAPE it was goes to the log only.
 *
 * ⚠ ONE DELIBERATE DIVERGENCE FROM `authorize-meeting-reschedule.ts`: an UNRESOLVABLE OWNER IS
 * NOT AN IMMEDIATE DENIAL. `resolveContextOwner` answers `not_found` when the subject's own row
 * (an `engagements` / `project_requests` / `request_expert_relationships` record) is missing or
 * soft-deleted — and the ADMIN override exists precisely for the bookings the party arms cannot
 * reach.
 *
 * ⚠ PRECISELY: ONLY THE **CLIENT** ARM IS SKIPPED (`companyId !== null` guards it). The EXPERT
 * arm runs regardless, and it is SELF-GATING rather than unguarded — `hasEngagementCapability`
 * re-resolves the host context from the same `deleted_at`-filtered rows and denies too. The two
 * resolvers agree on every label except ONE: for `request_interaction`, `resolveContextOwner`
 * needs the relationship AND its parent `project_requests` row, while the host resolver's
 * request-grain arm reads only the relationship. So a `request_interaction` whose parent request
 * is SOFT-DELETED grants the expert arm while the client arm is skipped. That is not an
 * escalation — the grantee is still the proven delivering expert on that meeting's own context,
 * the act only frees their own slot, nothing is returned to them, and `publishBookingCancelled`
 * skips a non-`case` context anyway. Recorded so no future ticket relies on a skip that does not
 * happen (security LOW-2).
 *
 * ⚠⚠ AND AN `admin`-CONTEXT MEETING IS DENIED FOR **EVERY** ARM, ADMIN INCLUDED — a corrected
 * reading, stated so nobody re-derives the wrong one. `selectPrimaryMeetingContext` scores
 * `admin` at precedence 0 and its result type (`PrimaryMeetingContext.contextType` is
 * `Exclude<MeetingContextTypeLabel, 'admin'>`) makes an admin subject UNREPRESENTABLE, so an
 * admin-only meeting yields `reason: 'none'` at step 2 and never reaches the arms at all. There
 * is deliberately no `contextType === 'admin'` branch below: it would be dead code the type
 * system already proves unreachable. The residual is harmless — `admin` is not in
 * `BOOKABLE_CONTEXT_TYPES`, so no such meeting can be created through `POST /meetings` in the
 * first place. If one ever can be, cancelling it is a conscious decision for that ticket, taken
 * with `selectPrimaryMeetingContext`'s fail-closed contract in hand rather than around it.
 *
 * ⚠ NOT THIS GATE'S JOB: engagement liveness. `resolveContextOwner` consults no status, and
 * cancelling a `scheduled` meeting on a `completed` engagement is still a real booking that
 * should be freed.
 *
 * ⚠ A `true` HERE AUTHORIZES THE ACT, NEVER THE READ of anything else. Resolving the context's
 * owning party remains the caller's obligation on every subsequent read — which is why this gate
 * threads `meeting`, `subject`, `actorRole`, `companyId` and `expertProfileId` back out, so
 * nothing downstream re-reads them and nothing can disagree with itself.
 */
import {
  meetingContextsRepository,
  meetingsRepository,
  partyMembershipsRepository,
  usersRepository,
  type Meeting,
} from '@balo/db';
import {
  CAPABILITIES,
  ENGAGEMENT_CAPABILITIES,
  PLATFORM_CAPABILITIES,
  platformRoleHasCapability,
  roleHasCapability,
} from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import { selectPrimaryMeetingContext, type PrimaryMeetingContext } from '@balo/shared/meetings';
import { hasEngagementCapability } from './authorize-engagement-host.js';
// ⚠ THE OWNING-PARTY BINDING IS SHARED, NOT COPIED. `authorize-meeting-reschedule.ts` carried the
// only other live copy; both now import this one, so the `@balo/db` binding has one definition.
import { loadOwningParty } from './resolve-meeting-owning-party.js';

const log = createLogger('meeting-cancel-authz');

/** ⚠ ONE FAILURE LITERAL FOR EVERY DENIAL. There is deliberately no `forbidden`. */
export type AuthorizeMeetingCancelErrorCode = 'meeting_not_found';

/**
 * WHICH ARM MATCHED. Server-derived — never taken from the wire. Drives the audit row's
 * `actorRole` metadata, the analytics `initiated_by`, and the notification copy's attribution.
 */
export type CancelActorRole = 'client' | 'expert' | 'admin';

export type AuthorizeMeetingCancelResult =
  | {
      ok: true;
      meeting: Meeting;
      /** The PRIMARY context — resolved once, threaded back so nothing downstream re-reads it. */
      subject: PrimaryMeetingContext;
      actorRole: CancelActorRole;
      /**
       * `null` when the subject's own row is missing or soft-deleted, which only the ADMIN arm
       * can reach (both party arms are skipped in that case). Never `null` on a client-arm
       * result, by construction.
       */
      companyId: string | null;
      /** `null` for a `match`-routed `project_discovery` or an `admin` meeting. */
      expertProfileId: string | null;
    }
  | { ok: false; code: AuthorizeMeetingCancelErrorCode };

export interface AuthorizeMeetingCancelInput {
  meetingId: string;
  userId: string;
}

/** Which read came back empty, or which axis refused — a LOG field, never a wire value. */
type DenialReason =
  | 'no_meeting'
  | 'no_context'
  | 'ambiguous_context'
  | 'subject_unresolvable'
  | 'no_capability';

/** The single fail-closed exit. The SHAPE goes here; the wire gets one literal. */
function deny(
  reason: DenialReason,
  fields: Record<string, unknown>
): { ok: false; code: 'meeting_not_found' } {
  log.warn({ ...fields, reason }, 'Meeting cancel denied');
  return { ok: false, code: 'meeting_not_found' };
}

/**
 * ARM 1 — the CLIENT, on the MEMBERSHIP axis. Skipped entirely when the primary context names
 * no owning party (an `admin` meeting).
 */
async function clientArmGrants(companyId: string, userId: string): Promise<boolean> {
  const role = await partyMembershipsRepository.getMemberRole('company', companyId, userId);
  return role !== undefined && roleHasCapability(role, CAPABILITIES.PARTICIPATE);
}

/**
 * ARM 3 — the ADMIN, on the PLATFORM axis. Runs regardless of whether an owning party resolved:
 * the override exists precisely for the meetings the party arms cannot reach.
 */
async function adminArmGrants(userId: string): Promise<boolean> {
  const user = await usersRepository.findById(userId);
  return (
    user !== undefined &&
    platformRoleHasCapability(user.platformRole, PLATFORM_CAPABILITIES.CANCEL_ANY_MEETING)
  );
}

/**
 * Fail-closed, three-axis authorization for cancelling a booked consultation.
 *
 * Returns the meeting, the primary context, WHICH ARM matched, the owning company (if any) and
 * the expert (if any), so the route threads all five onward and none is read twice.
 */
export async function authorizeMeetingCancel(
  input: AuthorizeMeetingCancelInput
): Promise<AuthorizeMeetingCancelResult> {
  const { meetingId, userId } = input;

  // 1. The meeting. `findById` filters `deleted_at IS NULL`, so missing and soft-deleted are
  //    one outcome.
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    return deny('no_meeting', { userId, meetingId });
  }

  // 2. The PRIMARY context. `listByMeeting` filters soft-deleted rows.
  //    ⚠ AMBIGUITY DENIES FOR EVERY ARM, INCLUDING ADMIN — fail-closed, same as reschedule. An
  //    admin override is still an override of ONE identified booking, not a licence to act on a
  //    meeting whose subject the platform cannot name.
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

  // 3. The owning party, from the primary context's own row. MAY be undefined (a missing or
  //    soft-deleted subject row) — see the docblock's "one deliberate divergence".
  const owner = await loadOwningParty(subject);
  const companyId = owner?.companyId ?? null;
  const expertProfileId = owner?.expertProfileId ?? null;

  // ── 4. AUTHORIZATION. Nothing below this point runs before an arm is proven; nothing
  //    state-shaped runs inside it. ──

  // ARM 1 — CLIENT, membership axis.
  if (companyId !== null && (await clientArmGrants(companyId, userId))) {
    return { ok: true, meeting, subject, actorRole: 'client', companyId, expertProfileId };
  }

  // ARM 2 — EXPERT, engagement axis. `subject` is structurally a holder-bearing context (never
  // `admin`), so it is passed straight to `hasEngagementCapability` with no re-shape and no
  // `admin` guard — see the docblock on why such a guard would be dead code.
  //
  // ⚠ THIS ARM IS NOT NARROWED TO THE ENGAGEMENT-GRAIN LABELS. `authorize-engagement-host.ts`
  // implements all seven arms, including the two REQUEST-grain ones and their shared
  // `relationshipDeniesHosting` predicate — so a `request_interaction` consultation (live since
  // BAL-283) is correctly gated here today. Only the WEB affordance is case-scoped.
  if (
    await hasEngagementCapability({ id: userId }, ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT, {
      contextType: subject.contextType,
      contextId: subject.contextId,
    })
  ) {
    return { ok: true, meeting, subject, actorRole: 'expert', companyId, expertProfileId };
  }

  // ARM 3 — ADMIN, platform axis.
  if (await adminArmGrants(userId)) {
    return { ok: true, meeting, subject, actorRole: 'admin', companyId, expertProfileId };
  }

  return deny('no_capability', {
    userId,
    meetingId,
    companyId,
    contextType: subject.contextType,
  });
}
