/**
 * BAL-408 (D3) — THE TWO-SIDED TENANCY GATE FOR MEETING PARTICIPATION. Resolve a
 * `meetingId` to its PRIMARY context, resolve that context to its OWNING PARTY, then decide
 * which SIDE the acting user is on — before any guest id, email or state check is touched.
 *
 * ⚠⚠ THE ACTOR'S RESOLVED SIDE IS THE LOAD-BEARING ANTI-CROSS-PARTY CONTROL. `party` is
 * NEVER a request field on any guest route; it is whatever this gate returns. That single
 * decision is what makes it structurally impossible for a client-side member to mint an
 * expert-side participant, or vice versa. If you ever find yourself reading `party` off a
 * request body, this gate has been bypassed.
 *
 * ── WHY A NEW GATE AND NOT `authorizeMeetingBooking` ────────────────────────────
 *
 * `authorizeMeetingBooking` (BAL-129) resolves COMPANY membership only and DELIBERATELY
 * denies every expert-side actor — correct there, because every bookable context is a
 * client-initiated purchase of time. Guests are invitable from BOTH sides, so that gate
 * cannot be widened without re-opening the hole it exists to close (its own docblock: "DO
 * NOT 'FIX' THIS BY ADDING AN AGENCY-MEMBERSHIP FALLBACK"). Hence a second gate, on two
 * axes, keyed by SUBJECT exactly as CLAUDE.md requires.
 *
 * ── THE TWO AXES ───────────────────────────────────────────────────────────────
 *
 *   · CLIENT SIDE → the MEMBERSHIP axis, COMPANY scope, `PARTICIPATE`. The same token and
 *     the same reasoning as booking: `PARTICIPATE` is the base member bundle held by every
 *     company role, so the effective rule is "a LIVE MEMBER of the company that owns the
 *     context". ⚠ NEVER `CONSUME_CREDITS` — that is the wallet-drawdown token, and inviting
 *     a guest spends nothing (the AC is "billing unaffected… never per-seat"). Gating a
 *     non-money action on a money token is a category error.
 *
 *   · EXPERT SIDE → the ENGAGEMENT axis (ADR-1046 / BAL-413), `manage_engagement`, via
 *     `hasEngagementCapability`. Inviting is an administrative ACT over an
 *     already-resolved meeting context, which is literally what that token is defined as.
 *     CONSEQUENCE, STATED SO NOBODY READS IT AS A MISS: an agency colleague whose agency
 *     role is `expert` CANNOT INVITE. The holder set is the delivering expert plus their
 *     agency `owner`/`admin`, and that is the correct, deliberate answer.
 *     ⚠ DO NOT WIDEN THIS TO `authorize-session-expert.ts`'s "any live agency member" set.
 *     CLAUDE.md is explicit (ADR-1046 §7, resolved 2026-08-03) that the wider set is a
 *     VISIBILITY rule and the narrow set is the ACT rule. Inviting is an act.
 *
 *   · NEITHER → `meeting_not_found`.
 *
 * ── THE ORDER OF THE CHECKS IS PART OF THE CONTRACT ────────────────────────────
 *
 * Copied verbatim from `authorize-meeting-booking.ts`, including its reasoning:
 * resolve the meeting → resolve the primary context → resolve the owning party →
 * **AUTHORIZATION BEFORE ANY COHERENCE OR STATE CHECK** → collapse every denial into ONE
 * literal. Running a state check (is the meeting `ended`? is the guest cap reached?) before
 * authorization would let an actor with no membership anywhere distinguish states of a
 * guessed `meetingId` by status code alone — an existence oracle over every meeting on the
 * platform, readable by any self-serve signup. Meeting state is therefore checked by the
 * SERVICE, after this gate returns `ok`.
 *
 * ⚠ AND EVERY DENIAL COLLAPSES INTO ONE `meeting_not_found` LITERAL. There is NO `403` on
 * any guest route, and no separate code for "not your party", "no such meeting",
 * "ambiguous contexts" or "no holder". WHICH SHAPE IT WAS GOES TO THE LOG — the `log.warn`
 * calls below stay distinct on purpose — NEVER TO THE WIRE. Precedents:
 * `sessionActorErrorStatus`'s `not_found → 404` "(also hides existence)" and
 * `openSession`'s `meeting_not_bookable` (six shapes, one literal).
 *
 * ⚠ DIVERGENCE FROM THE PLAN'S §4.1 ERROR TABLE, RECORDED AS A DECISION RATHER THAN LEFT
 * AS DRIFT. That table lists a distinct `409 meeting_context_ambiguous`. This gate returns
 * `meeting_not_found` for ambiguity instead, and logs `ambiguous_context`. Three reasons:
 *   1. A 409 pre-authorization confirms "this uuid is a real meeting carrying two
 *      engagement-grain contexts" to an actor who may be a member of nothing — precisely
 *      the oracle the ordering rule above exists to prevent. `authorize-meeting-booking`'s
 *      `context_type_mismatch` is distinct ONLY because it is reachable exclusively AFTER
 *      membership is proven; ambiguity is reachable BEFORE, because the ambiguity is what
 *      stops us resolving a party to check membership against.
 *   2. The plan's own §10 observability table already routes `ambiguous_context` to the
 *      LOG, which is the "shape to the log, one literal to the wire" pattern.
 *   3. The branch is defensively unreachable today: nothing attaches two engagement-grain
 *      contexts to one meeting (`POST /meetings` passes exactly one), so a distinct code
 *      buys no UX and costs an oracle.
 * If a product need for the distinct code appears, the correct shape is to return it ONLY
 * to an actor already proven authorized on one of the tied contexts.
 *
 * ⚠ THIS GATE DOES NOT DISCHARGE ENGAGEMENT LIFECYCLE. `hasEngagementCapability`'s own
 * header says `engagements.status` is never consulted, so the delivering expert of a
 * `completed`/`cancelled` engagement still holds `manage_engagement`. Callers that need
 * liveness check `meetings.status` themselves — the guest service does, against the
 * TERMINAL set (see `MEETING_CLOSED_TO_GUESTS`).
 */
import {
  engagementsRepository,
  meetingContextsRepository,
  meetingsRepository,
  partyMembershipsRepository,
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
  type Meeting,
  type MeetingContextType,
} from '@balo/db';
import { CAPABILITIES, ENGAGEMENT_CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import {
  selectPrimaryMeetingContext,
  type PrimaryMeetingContext,
  type MeetingContextTypeLabel,
  type MeetingGuestSide,
} from '@balo/shared/meetings';
import { hasEngagementCapability } from './authorize-engagement-host.js';

const log = createLogger('meeting-participation-authz');

/**
 * ⚠ THE DRIFT GUARD FOR `@balo/shared/meetings`'s HAND-RESTATED LABEL LIST.
 * `MEETING_CONTEXT_PRECEDENCE` restates the seven `meeting_context_type` labels in a package
 * that cannot import the pgEnum. These two `AssertNever`s make an EIGHTH label added to the
 * database fail `pnpm --filter api typecheck` RIGHT HERE until it is given a precedence —
 * the `AssertPublishCoverageComplete` idiom, split per direction so neither branch forms a
 * `never | never` union (S6571).
 */
type MissingContextLabel = Exclude<MeetingContextType, MeetingContextTypeLabel>;
type StrayContextLabel = Exclude<MeetingContextTypeLabel, MeetingContextType>;
type AssertNever<T extends never> = T;
export type AssertMeetingContextLabelsMatch = [
  AssertNever<MissingContextLabel>,
  AssertNever<StrayContextLabel>,
];

/** ⚠ ONE FAILURE LITERAL FOR EVERY DENIAL. There is deliberately no `forbidden`. */
export type AuthorizeMeetingParticipationErrorCode = 'meeting_not_found';

/** Which side of the meeting the actor was resolved onto. NEVER taken from request input. */
export type MeetingParticipationSide = MeetingGuestSide;

export type AuthorizeMeetingParticipationResult =
  | {
      ok: true;
      /** ⚠ The `party` every guest this actor invites will carry. */
      side: MeetingParticipationSide;
      /** Threaded back so the service never re-reads it (nor can disagree with itself). */
      meeting: Meeting;
      /** The PRIMARY context — directly assignable to `hasEngagementCapability`'s subject. */
      subject: PrimaryMeetingContext;
      /** The company that owns the primary context. Always resolved on both sides. */
      companyId: string;
      /** `null` for a `match`-routed `project_discovery`, which names nobody. */
      expertProfileId: string | null;
    }
  | { ok: false; code: AuthorizeMeetingParticipationErrorCode };

export interface AuthorizeMeetingParticipationInput {
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

/** The owning party of one resolved context. Judgement-free: what the row says, nothing more. */
interface OwningParty {
  companyId: string;
  /** `null` only for a `match`-routed project request. */
  expertProfileId: string | null;
}

/**
 * Per-context-type LOAD of the owning party — TOTAL over the six non-`admin` labels.
 *
 * Deliberately judgement-free (the `loadSubject` precedent): it reports which company owns
 * the row and says nothing about whether the caller may see it. Every repository read below
 * already filters `deleted_at IS NULL`, so `undefined` (missing OR soft-deleted) is the
 * single not-found outcome.
 *
 * ⚠ `request_interaction` COSTS TWO READS, and there is no shortcut. A
 * `request_expert_relationships` row names an expert and a REQUEST, not a company — the
 * company lives on the request. Reading the relationship alone and inferring tenancy from
 * the expert would authorize by DELIVERY IDENTITY on the membership axis, which is the axis
 * confusion CLAUDE.md forbids.
 */
async function loadOwningParty(subject: PrimaryMeetingContext): Promise<OwningParty | undefined> {
  switch (subject.contextType) {
    // Engagement grain — `engagements.company_id` / `.expert_profile_id` are both NOT NULL
    // on the supertype (BAL-417), so the four labels share one branch.
    case 'case':
    case 'project_kickoff':
    case 'package_session':
    case 'retainer_checkin': {
      const engagement = await engagementsRepository.findById(subject.contextId);
      if (engagement === undefined) return undefined;
      return {
        companyId: engagement.companyId,
        expertProfileId: engagement.expertProfileId,
      };
    }

    // Request grain — the request itself carries the company.
    case 'project_discovery': {
      const request = await projectRequestsRepository.findById(subject.contextId);
      if (request === undefined) return undefined;
      return { companyId: request.companyId, expertProfileId: request.expertProfileId };
    }

    // Relationship grain — the company is one hop away, on the request.
    case 'request_interaction': {
      const relationship = await requestExpertRelationshipsRepository.findById(subject.contextId);
      if (relationship === undefined) return undefined;
      const request = await projectRequestsRepository.findById(relationship.projectRequestId);
      if (request === undefined) return undefined;
      return { companyId: request.companyId, expertProfileId: relationship.expertProfileId };
    }

    default: {
      // Compile-time exhaustiveness over the SIX holder-bearing labels. `admin` cannot reach
      // here — `PrimaryMeetingContext.contextType` is `MeetingContextTypeWithHolder`, and
      // `selectPrimaryMeetingContext` drops admin rows — so this arm is unreachable today,
      // but a SEVENTH non-admin label stops typechecking right here until an arm is
      // consciously written.
      //
      // ⚠ THE WITNESS IS `subject.contextType`, NOT `subject`. `PrimaryMeetingContext` is a
      // plain interface rather than a discriminated union, so TS narrows the FIELD to
      // `never` in this arm but leaves the OBJECT fully typed. Asserting the object was the
      // first attempt and it does not compile.
      //
      // Fails CLOSED rather than throwing: this module is an authorization gate, and a
      // caller must never have to catch to stay safe.
      const exhaustive: never = subject.contextType;
      log.warn({ contextType: exhaustive }, 'Unhandled meeting context type — failing closed');
      return undefined;
    }
  }
}

/** The single fail-closed exit. The SHAPE goes here; the wire gets one literal. */
function deny(
  reason: DenialReason,
  fields: Record<string, unknown>
): { ok: false; code: 'meeting_not_found' } {
  log.warn({ ...fields, reason }, 'Meeting participation denied');
  return { ok: false, code: 'meeting_not_found' };
}

/**
 * Fail-closed, two-axis authorization for acting on a meeting's participant roster.
 *
 * Returns the actor's SIDE plus the meeting, the primary context and the owning party, so
 * the caller threads all four onward and none is read twice.
 */
export async function authorizeMeetingParticipation(
  input: AuthorizeMeetingParticipationInput
): Promise<AuthorizeMeetingParticipationResult> {
  const { meetingId, userId } = input;

  // 1. The meeting. `findById` filters `deleted_at IS NULL`, so missing and soft-deleted are
  //    one outcome — which is what lets them share one literal without extra work.
  const meeting = await meetingsRepository.findById(meetingId);
  if (meeting === undefined) {
    return deny('no_meeting', { userId, meetingId });
  }

  // 2. The PRIMARY context (D3's precedence rule). `listByMeeting` filters soft-deleted rows.
  const contexts = await meetingContextsRepository.listByMeeting(meetingId);
  const primary = selectPrimaryMeetingContext(contexts);
  if (!primary.ok) {
    // Both `none` (admin-only / empty) and `ambiguous` answer the SAME literal — see the
    // §4.1 divergence note in the module docblock. Only the log distinguishes them.
    return deny(primary.reason === 'ambiguous' ? 'ambiguous_context' : 'no_context', {
      userId,
      meetingId,
      contextCount: contexts.length,
    });
  }
  const subject = primary.context;

  // 3. The owning party, from the primary context.
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

  // ── 4. AUTHORIZATION. Nothing below this point runs before a side is proven. ──

  // CLIENT SIDE — membership axis, company scope. Role interpretation goes through
  // `@balo/shared/authz` (ADR-1029 HARD CONSTRAINT B); never `role === 'owner'`.
  const role = await partyMembershipsRepository.getMemberRole('company', companyId, userId);
  if (role !== undefined) {
    if (!roleHasCapability(role, CAPABILITIES.PARTICIPATE)) {
      // A live member whose role lacks the base bundle. Distinct in the log, identical on
      // the wire — the same treatment `authorize-meeting-booking` gives it.
      return deny('no_capability', { userId, meetingId, companyId, side: 'client' });
    }
    return { ok: true, side: 'client', meeting, subject, companyId, expertProfileId };
  }

  // EXPERT SIDE — engagement axis, `manage_engagement`. Reached only when the actor holds
  // NO company membership, so the two arms cannot both fire and the side is unambiguous.
  //
  // ⚠ Calling `hasEngagementCapability` here is safe SPECIFICALLY because step 3 already
  // resolved this context's owning party from its own row — the tenancy obligation that
  // seam's header block assigns to its callers. It is NOT safe to call on an unvetted
  // `contextId`; `resolveHostContext` is an identity oracle.
  const isHostSide = await hasEngagementCapability(
    { id: userId },
    ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
    subject
  );
  if (isHostSide) {
    return { ok: true, side: 'expert', meeting, subject, companyId, expertProfileId };
  }

  // THE CROSS-TENANT ATTEMPT — the thing worth seeing in Axiom. The log distinguishes it
  // from a genuinely missing meeting; the wire deliberately does not.
  return deny('cross_tenant', { userId, meetingId, companyId, contextType: subject.contextType });
}
