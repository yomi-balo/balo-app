/**
 * BAL-129 (D7) — THE TENANCY GATE FOR BOOKING. Resolve a `contextType`/`contextId` pair to
 * its OWNING PARTY, then check the acting user's capability against that party, BEFORE the
 * id ever reaches `meetingsRepository`.
 *
 * ⚠⚠ WHY THIS MODULE EXISTS AT ALL — it discharges the obligation
 * `schema/meeting-contexts.ts` assigns to BAL-129 by name. `meeting_contexts.context_id`
 * has NO FOREIGN KEY (it is polymorphic) and NO RLS behind it, so a uuid belonging to
 * ANOTHER TENANT does not fail — it succeeds silently and resolves to that tenant's expert.
 * The consultation projection then writes a `confirmed` row against that expert and the
 * availability resolver subtracts it from their open windows: a DENIAL-OF-SERVICE on a
 * marketplace expert's bookability, repeatable until their calendar reads as fully booked,
 * by an attacker who owns none of the rows involved. The projection is deliberately NOT the
 * place to fix that — it resolves the expert exactly as the seam says to, and a gate inside
 * a repository would be the deviation (ADR-1029). This is the fix.
 *
 * Structurally modelled on `services/credit-session/authorize-session-actor.ts`: load the
 * subject → resolve the party → resolve the role FAIL-CLOSED → check the capability →
 * thread the loaded row back so nobody re-reads it.
 *
 * ── THE ORDER OF THE CHECKS IS PART OF THE CONTRACT ──────────────────────────
 *
 * ⚠ THE MEMBERSHIP CHECK RUNS BEFORE BOTH SUBJECT-STATE CHECKS (engagement STATUS, then
 * engagement-TYPE coherence), AND MOVING EITHER IN FRONT OF IT RE-OPENS A CROSS-TENANT ORACLE. The first version ran coherence first, which let an actor
 * with NO membership anywhere distinguish three states of a guessed uuid by status code
 * alone: "not a live engagement" (404), "someone else's engagement, wrong label" (400
 * `context_type_mismatch`), and "someone else's engagement, right label" (403). That is an
 * existence AND type oracle over every `engagements.id` on the platform, readable by any
 * self-serve signup. `context_type_mismatch` is now only ever returned to a proven member of
 * the company that owns the row, for whom the row's existence is not a secret.
 *
 * ⚠ AND THE TWO DENIALS COLLAPSE INTO ONE LITERAL: a non-member gets `404
 * context_not_found`, IDENTICAL **ON THE WIRE** to a uuid that resolves to nothing. There is
 * no `forbidden` code on this gate. That is the house precedent, chosen deliberately over the
 * more "informative" pair:
 *   · `authorize-session-actor`'s `sessionActorErrorStatus` maps `not_found → 404` with the
 *     comment "(also hides existence)".
 *   · `openSession`'s `meeting_not_bookable` collapses SIX distinguishable failure shapes into
 *     one literal for exactly this reason.
 * A distinct 403 would confirm "this uuid is a live engagement belonging to a company you are
 * not in" — which is the whole of what a prober wants. WHICH shape it was goes to the LOG,
 * never to the wire; the `log.warn` calls below stay distinct on purpose.
 *
 * ⚠ "IDENTICAL ON THE WIRE" IS THE EXACT AND ONLY CLAIM — the two paths are NOT identical in
 * WORK, and pretending otherwise would be a side-channel argument this module has not made. A
 * uuid that resolves to nothing returns after ONE repository read; a live cross-tenant row
 * costs that read PLUS `getMemberRole` PLUS a `log.warn`. The response BODY and STATUS carry no
 * difference; the response TIME carries a small one, and the log carries a deliberate one. That
 * residual is accepted: timing a single extra indexed point-read across the internet is not a
 * practical oracle, and the alternative (padding the not-found path with a pointless membership
 * query) would buy noise rather than secrecy.
 *
 * ── ACCEPTED RESIDUAL: A SELF-MINTED `project_discovery` MAY NAME ANY EXPERT ──
 *
 * ⚠ READ THIS BEFORE "FIXING" THE `project_discovery` ARM. `project_requests` is a UNILATERAL
 * row: the web action that creates one validates `expertProfileId` with `z.string().uuid()`
 * and nothing more — no existence check, no expert assent, no `approvedAt` — and expert
 * profile ids are harvestable from the UNAUTHENTICATED `GET /experts/search`. So a self-serve
 * signup can mint a `send_to='direct'` request naming ANY expert and this arm will authorize
 * booking against it, because the actor genuinely owns the company that owns the request.
 *
 * THAT IS THE INTENDED PRODUCT FLOW, NOT A HOLE IN THIS GATE. Discovery is CLIENT-INITIATED,
 * and CLAUDE.md is explicit that on a direct request "the exploratory call can legitimately
 * precede any invite" — so requiring expert assent would break the feature rather than secure
 * it.
 *
 * ⚠ A DECLINED `request_expert_relationships` ROW IS NON-BLOCKING FOR BOOKING ON
 * `project_discovery` — SCOPED, as of BAL-283. `relationshipDeniesHosting` (`@balo/shared/authz`)
 * denies on EVIDENCE, not absence — precisely so it CAN be consulted safely on a path where no
 * relationship row is expected. So "it denies on evidence" is an argument the check would be
 * SAFE here, never an argument against making it; an earlier version of this block cited it the
 * wrong way round.
 *   The real reason `project_discovery` does not consult it is the SUBJECT. Hosting asks "may
 *   this expert deliver this call?", and an expert who declined the engagement must not hold the
 *   owner token — that is a fact about the relationship. `project_discovery` booking asks "may
 *   this company member place a slot on a calendar they can reach?" against a `project_requests`
 *   row that is a DIFFERENT row than any relationship, and a decline is not a withdrawal of
 *   published availability: an expert who declines a specific request keeps their published
 *   hours open to everyone, and the client may legitimately re-approach.
 *
 * ⚠ ON `request_interaction`, BAL-283 MADE THE OPPOSITE CALL, AND IT IS NOT A REVERSAL — THE
 * SUBJECT CHANGED. There the relationship **IS** the booking subject (not a fact about some
 * other row), so `loadSubject`'s `request_interaction` arm consults `relationshipDeniesHosting`
 * on the SAME row the two-hop reads, structurally identical to the `subject.status !== 'active'`
 * check this module already runs for engagements below. A declined thread is closed on every
 * shipped surface (`isThreadOpenStatus`), so there is no legitimate booking behind it. See
 * `@balo/shared/authz`'s `engagement.ts` docblock for the third call site this adds.
 *
 * ⚠⚠ AND THE SAME ARM CARRIES A **REQUEST-LIFECYCLE** GATE, WHICH IS A SEPARATE RULE FROM THE
 * DECLINE ONE (BAL-283 round 1). A `request_interaction` context has no engagement, so the
 * `subject.status !== 'active'` check below cannot reach it — leaving this label with NO
 * lifecycle gate at all, and reopening one grain up exactly the hole that check's own docblock
 * describes ("a `completed` CASE IS A PERMANENT BOOKING HANDLE ON THAT EXPERT'S CALENDAR").
 * `THREAD_OPEN_RELATIONSHIP_STATUSES` on the web side includes `'accepted'`, so an accepted
 * relationship's thread stays open and a client-company member could POST the Server Action
 * directly and book FREE calls against the DELIVERING expert — the hours that must route
 * through the BILLED `case`/`project_kickoff` path — and equally against a LOSING expert whose
 * thread also stays open. Both denials collapse into `context_not_found` (§3's oracle rule).
 *
 * The abuse this arm enables is therefore not "booking without authorization" but VOLUME:
 * consuming a stranger-to-you expert's calendar. That is **BOUNDED — not closed — on the
 * ECONOMICS**, in two places outside this module, and both are load-bearing for this arm
 * specifically:
 *   1. `isWindowAvailableForExpert` (`services/availability/window-availability.ts`) — the
 *      window must lie inside availability the expert PUBLISHED and be free, so each booking
 *      consumes exactly one slot the expert chose to offer.
 *   2. Per-user AND per-(user, expert) rate limits on `POST /meetings`, failing CLOSED.
 * Remove either and this arm becomes a calendar-DoS primitive again.
 *
 * ⚠ WHY "BOUNDED" AND NOT "CLOSED", STATED PLAINLY SO NOBODY CLOSES THE TICKET ON IT. Within
 * the rate limits, every slot the expert published is still consumable:
 *   · BOOKINGS ARE NO LONGER IRREVERSIBLE — ⚠ CORRECTED BY BAL-410, which shipped
 *     `POST /meetings/:meetingId/cancel` (`routes/meetings/cancel.ts`). `cancelMeeting` HAS
 *     production callers now, and the delivering EXPERT can cancel on the engagement axis, so
 *     an expert whose calendar is being walked can free the slots themselves. The un-freed
 *     residual is `softDeleteMeeting`, which still has no route.
 *   · BOOKINGS ARE STILL SILENT. Nothing publishes `booking.confirmed` — the rule and templates
 *     in `notifications/engine/rules.ts` are a documented orphan, and wiring them is BAL-400's —
 *     so the expert is not TOLD their calendar is filling up, which is what makes the undo a
 *     manual discovery rather than a prompt. That remaining residual is BAL-400's, and it is
 *     the reason the two rate limits fail CLOSED rather than open.
 *
 * ── THE AXIS ────────────────────────────────────────────────────────────────
 *
 * ⚠ THE CAPABILITY AXIS IS **MEMBERSHIP**, COMPANY SCOPE, `PARTICIPATE`. CLAUDE.md defines
 * three axes with three distinct subjects; pick by subject and never widen one to cover
 * another.
 *
 *   · NOT the PLATFORM axis (ADR-1035, `hasPlatformCapability`) — that gates Balo-STAFF
 *     mutations by `platformRole`. Booking is a customer action.
 *   · NOT the ENGAGEMENT axis (ADR-1046 / BAL-413, `hasEngagementCapability`) — that gates
 *     by DELIVERY IDENTITY on one already-resolved meeting context (`host_meetings` /
 *     `manage_engagement`, held by the delivering expert plus their agency owner/admin).
 *     Wrong subject twice over: booking is neither hosting nor administering an existing
 *     delivery, AND that axis yields NO HOLDER for contexts this route must serve — a
 *     `match`-routed `project_discovery` names no expert at all — so it would deny bookings
 *     AC #4 requires.
 *   · THE MEMBERSHIP AXIS. The subject is PARTY MEMBERSHIP, and the party that owns every
 *     context this route accepts is a COMPANY.
 *
 * ⚠ WHY `PARTICIPATE` AND NOT `CONSUME_CREDITS`. `CONSUME_CREDITS` is the WALLET-DRAWDOWN
 * token. Four of the five contexts (kickoff, discovery, package session, request_interaction
 * — BAL-283 Ruling 2: NO credit hold on an intro call, ever) carry NO CREDIT HOLD AT ALL —
 * gating them on a wallet token is a category error. The money gate for a Case
 * consultation is `openSession`'s own `CONSUME_CREDITS` check, which stays exactly where it
 * is. `PARTICIPATE` is the base-member token, held by every company role
 * (`owner`/`admin`/`member`), so the effective rule is "a LIVE MEMBER of the company that
 * owns the context" — precisely the tenancy statement the schema asks for.
 *
 * ⚠ AN EXPERT-SIDE ACTOR MAY NOT BOOK. DELIBERATELY. This resolves COMPANY membership only;
 * an expert is an agency member (or independent) and holds no `company_members` row on the
 * client's company, so `getMemberRole` returns `undefined` → `context_not_found`. That is
 * correct because every context this route accepts is a CLIENT-INITIATED booking (the client
 * buying time), and expert-initiated scheduling is a different axis and a different ticket
 * (`manage_engagement` on the engagement axis — BAL-409 / BAL-411).
 *   ⚠ DO NOT "FIX" THIS BY ADDING AN AGENCY-MEMBERSHIP FALLBACK. It would let an agency admin
 *   book time on their own expert's calendar against a company they have no membership in —
 *   trading one DoS for another, and re-opening exactly the hole D7 exists to close.
 *
 * Role interpretation goes through `@balo/shared/authz` (`roleHasCapability`), the single
 * place a role string is interpreted (ADR-1029 HARD CONSTRAINT B). Never `role === 'owner'`.
 */
import {
  engagementsRepository,
  partyMembershipsRepository,
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
  type EngagementStatus,
  type EngagementType,
} from '@balo/db';
import { CAPABILITIES, relationshipDeniesHosting, roleHasCapability } from '@balo/shared/authz';
import type { RelationshipHostingStatus } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import {
  resolveContextOwner,
  type MeetingBookingContextType,
  type MeetingContextOwnerReads,
} from '@balo/shared/meetings';

const log = createLogger('meeting-booking-authz');

/**
 * ⚠ ONE FAILURE LITERAL FOR EVERY DENIAL AN OUTSIDER CAN REACH. See the module docblock:
 * `context_type_mismatch` is reachable ONLY after membership has been proven, so it tells a
 * caller nothing they did not already know. There is deliberately no `forbidden`.
 */
export type AuthorizeMeetingBookingErrorCode = 'context_not_found' | 'context_type_mismatch';

export type AuthorizeMeetingBookingResult =
  | {
      ok: true;
      companyId: string;
      engagementType: BookableEngagementType | null;
      /**
       * The expert whose calendar this booking will block, read off the SAME row `companyId`
       * came from — so the caller's rate limit and availability check cannot disagree with
       * what the projection will resolve. `null` ONLY for a `match`-routed
       * `project_discovery`, which names nobody; the repository then throws
       * `MatchModeDiscoveryNotBookableError` and the route answers `409 discovery_not_routed`.
       */
      expertProfileId: string | null;
    }
  | { ok: false; code: AuthorizeMeetingBookingErrorCode };

export interface AuthorizeMeetingBookingInput {
  contextType: MeetingBookingContextType;
  contextId: string;
  userId: string;
}

/** The bookable labels that anchor on something OTHER than an `engagements.id`. */
const NON_ENGAGEMENT_CONTEXT_TYPES = ['project_discovery', 'request_interaction'] as const;
type NonEngagementContextType = (typeof NON_ENGAGEMENT_CONTEXT_TYPES)[number];

/**
 * BAL-283 (round-1 HIGH) — the `project_request_status` values at or past the client's
 * DECISION, on which a free `request_interaction` intro call is no longer legitimate.
 *
 * ⚠ A SET OF LITERALS, NOT A RANK COMPARISON, AND DELIBERATELY SO. `project_request_status`
 * is a pgEnum whose ORDER is not a lifecycle guarantee this module may rely on, and this gate
 * must fail in the SAFE direction on a value it does not recognise — an unknown status is NOT
 * in the set, so it stays bookable, which matches the pre-decision default rather than
 * bricking the feature on an enum addition. A NEW post-decision label must be added here
 * consciously; that is the intended cost.
 */
const POST_DECISION_REQUEST_STATUSES: ReadonlySet<string> = new Set([
  'accepted',
  'kickoff_approved',
]);

/**
 * The engagement `engagement_type` each ENGAGEMENT-anchored context label must name.
 *
 * `project_discovery` and `request_interaction` are absent BY CONSTRUCTION: neither anchors
 * on an `engagements.id` (the first on `project_requests.id`, the second on
 * `request_expert_relationships.id`), so neither has a supertype discriminator to agree
 * with. Their owning party is read from their own row instead (`loadSubject`).
 *
 * ⚠ `Record<Exclude<…>>`, NOT `Partial<Record<…>>` (BAL-283). Under `Partial` a sixth
 * bookable label needed no entry here and the TS7053 index error at this constant's use site
 * never fired — the constant silently agreed to know nothing about it. Non-partial makes a
 * sixth ENGAGEMENT-grain label a compile error in this object, and a sixth NON-engagement
 * label a compile error in the tuple above.
 */
const ENGAGEMENT_TYPE_FOR_CONTEXT = {
  case: 'case',
  project_kickoff: 'project',
  package_session: 'package',
} as const satisfies Record<
  Exclude<MeetingBookingContextType, NonEngagementContextType>,
  EngagementType
>;

/**
 * The engagement kinds reachable through this route — `EngagementType` MINUS `'retainer'`.
 *
 * ⚠ NARROWER THAN `EngagementType`, DELIBERATELY, AND DERIVED SO IT CANNOT DRIFT. There is
 * no bookable context label that names a `retainer` engagement (`retainer_checkin` is
 * excluded at the Zod boundary), so the coherence check below makes `'retainer'`
 * unreachable — and D4's `engagement_type` analytics property is typed to exactly these
 * three plus `null`. Widening this back to `EngagementType` would silently re-admit a value
 * the event map cannot carry.
 */
export type BookableEngagementType =
  (typeof ENGAGEMENT_TYPE_FOR_CONTEXT)[keyof typeof ENGAGEMENT_TYPE_FOR_CONTEXT];

/** The subject row's facts, RAW — no coherence judgement, which happens after the gate. */
interface LoadedSubject {
  companyId: string;
  /** `null` only for a `match`-routed project request. */
  expertProfileId: string | null;
  /** `null` for `project_discovery`; otherwise the engagement's own column, UNCHECKED. */
  engagementType: EngagementType | null;
  /**
   * `null` for `project_discovery` (a `project_requests` row has no engagement lifecycle);
   * otherwise the engagement's coarse supertype status, UNCHECKED here.
   */
  status: EngagementStatus | null;
}

/**
 * Per-context-type LOAD of the owning party — TOTAL over the FIVE bookable labels, and now
 * provably so: the switch's `default` arm assigns to `never`, so a sixth bookable label
 * fails `pnpm --filter api typecheck` HERE — at the load that must learn its subject shape —
 * instead of 120 lines downstream at `ENGAGEMENT_TYPE_FOR_CONTEXT`, or silently at runtime as
 * a 404 on every booking (BAL-283 plan §6.1: widening `BOOKABLE_CONTEXT_TYPES` alone raised no
 * error at the old binary `if/else` here — a `request_interaction` id was simply fed to
 * `engagementsRepository.findById`, missed, and returned `context_not_found` on every attempt,
 * indistinguishable on the wire from a cross-tenant probe).
 *
 * Deliberately judgement-free: it reports what the row says and nothing about whether the
 * caller may see it. Every repository read already filters `deleted_at IS NULL`, so
 * `undefined` (missing OR soft-deleted) is the single not-found outcome.
 */
async function loadSubject(
  contextType: MeetingBookingContextType,
  contextId: string
): Promise<LoadedSubject | undefined> {
  switch (contextType) {
    case 'project_discovery': {
      const request = await projectRequestsRepository.findById(contextId);
      if (request === undefined) {
        return undefined;
      }
      return {
        companyId: request.companyId,
        expertProfileId: request.expertProfileId,
        engagementType: null,
        status: null,
      };
    }

    case 'request_interaction': {
      // ⚠ ONE READ OF THE RELATIONSHIP **AND ONE OF THE REQUEST**, BOTH CAPTURED. The two
      // guards below and the shared two-hop must judge the SAME rows: a second `findById`
      // could observe a row that changed between them, and fail-open on exactly the state
      // these checks exist to catch. Routes through the EXISTING `resolveContextOwner` two-hop
      // (`@balo/shared/meetings`) rather than re-deriving it — see that module's axis
      // warning (the EXPERT comes from the relationship, the COMPANY from the request).
      let relationship: RelationshipHostingStatus | undefined;
      let request: { status: string } | undefined;
      const reads: MeetingContextOwnerReads = {
        findEngagement: (id) => engagementsRepository.findById(id),
        findProjectRequest: async (id) => {
          const row = await projectRequestsRepository.findById(id);
          request = row;
          return row;
        },
        findRelationship: async (id) => {
          const row = await requestExpertRelationshipsRepository.findById(id);
          relationship = row;
          return row;
        },
      };
      const owner = await resolveContextOwner({ contextType, contextId }, reads);
      if (owner.outcome !== 'resolved' || relationship === undefined || request === undefined) {
        return undefined; // missing OR soft-deleted (findById filters deleted_at)
      }
      if (relationshipDeniesHosting(relationship)) {
        log.warn(
          { contextType, contextId },
          'Meeting booking denied — the relationship that owns this context is declined'
        );
        return undefined; // §7 — collapses into `context_not_found` on the wire
      }
      /**
       * ⚠⚠ THE REQUEST-LIFECYCLE GATE — THE `subject.status !== 'active'` CHECK'S EXACT TWIN,
       * AT REQUEST GRAIN. Read the docblock further down that says, of an engagement:
       * "WITHOUT THIS, A `completed` CASE IS A PERMANENT BOOKING HANDLE ON THAT EXPERT'S
       * CALENDAR." A `request_interaction` context has no engagement lifecycle to consult, so
       * WITHOUT THIS LINE it had no lifecycle gate AT ALL, and the same hole reopened one
       * grain up.
       *
       * The chain that made it reachable: `THREAD_OPEN_RELATIONSHIP_STATUSES` (web) includes
       * `'accepted'`, so `resolveConversationAccess` passes an accepted relationship straight
       * through; the web UI hides the CTA (`callAllowed = beforeKickoff && stage === 'active'`)
       * but a Server Action is a PUBLIC ENTRY POINT — a client-company member who reads
       * `relationshipId`/`requestId` out of the rendered DOM can POST it directly. Past
       * acceptance the delivering expert's hours are supposed to route through the BILLED
       * `case`/`project_kickoff` path; free `request_interaction` bookings against them are
       * exactly the leak. It applies equally to a LOSING expert on a decided request, whose
       * thread also stays open.
       *
       * ⚠ AND IT IS NO LONGER IRREVERSIBLE — corrected by BAL-410, which shipped the cancel
       * route. A `request_interaction` booking IS reachable by that route's expert arm
       * (`authorize-engagement-host.ts` implements all seven context labels, including both
       * request-grain arms), so a slot consumed this way can be freed. The gate below still
       * matters: it stops the slot being taken in the first place.
       *
       * ⚠ THE THRESHOLD IS `accepted`, MATCHING THE WEB'S OWN `beforeKickoff` DERIVATION —
       * `deriveThreadActions` stops offering the CTA at `accepted`, and this is the server-side
       * statement of the same rule. `kickoff_approved` is denied by the same clause.
       *
       * ⚠ AND IT ANSWERS `context_not_found`, NOT A NEW LITERAL — §3's oracle decision is that
       * every denial an outsider can reach is indistinguishable. Same posture as the decline
       * check above.
       */
      if (POST_DECISION_REQUEST_STATUSES.has(request.status)) {
        log.warn(
          { contextType, contextId, requestStatus: request.status },
          'Meeting booking denied — the project request that owns this context is already decided'
        );
        return undefined; // §7 — collapses into `context_not_found` on the wire
      }
      return {
        companyId: owner.owner.companyId,
        expertProfileId: owner.owner.expertProfileId, // NOT NULL on the table; typed `| null` upstream
        engagementType: null,
        status: null,
      };
    }

    case 'case':
    case 'project_kickoff':
    case 'package_session': {
      const engagement = await engagementsRepository.findById(contextId);
      if (engagement === undefined) {
        return undefined;
      }
      return {
        companyId: engagement.companyId,
        expertProfileId: engagement.expertProfileId,
        engagementType: engagement.engagementType,
        status: engagement.status,
      };
    }

    default: {
      // ⚠ `never` TODAY, AND THAT IS THE POINT. A sixth bookable label widens this and fails
      // `pnpm --filter api typecheck` HERE. See the function docblock.
      const exhaustive: never = contextType;
      return exhaustive;
    }
  }
}

/**
 * Fail-closed context-vs-actor authorization for a booking. Returns the owning `companyId`,
 * the resolved `engagementType` and the `expertProfileId` on success, so the caller threads
 * all three onward and none is read twice (nor able to disagree with itself).
 */
export async function authorizeMeetingBooking(
  input: AuthorizeMeetingBookingInput
): Promise<AuthorizeMeetingBookingResult> {
  const { contextType, contextId, userId } = input;

  const subject = await loadSubject(contextType, contextId);
  if (subject === undefined) {
    // ⚠ THIS LINE DISCHARGES THE MODULE DOCBLOCK'S PROMISE THAT "WHICH SHAPE IT WAS GOES TO THE
    // LOG". Without it the log covered only the two CROSS-TENANT shapes, so the most ordinary
    // real-world 404 — a member whose engagement was soft-deleted under them, or a client
    // holding a stale id — produced a 404 with ZERO request-tagged lines in Axiom, and the
    // on-call engineer had nothing to correlate the user's report against.
    log.warn(
      { userId, contextType, contextId },
      'Meeting booking denied — context does not resolve to a live row'
    );
    return { ok: false, code: 'context_not_found' };
  }
  const { companyId, expertProfileId } = subject;

  // ── MEMBERSHIP FIRST. Everything below this point is member-only information. ──
  const role = await partyMembershipsRepository.getMemberRole('company', companyId, userId);
  if (role === undefined) {
    // THE CROSS-TENANT ATTEMPT — the thing worth seeing in Axiom. The LOG distinguishes this
    // from a genuinely missing row; the WIRE deliberately does not.
    log.warn(
      { userId, contextType, contextId, companyId },
      'Meeting booking denied — not a live member of the company that owns the context (cross-tenant)'
    );
    return { ok: false, code: 'context_not_found' };
  }

  if (!roleHasCapability(role, CAPABILITIES.PARTICIPATE)) {
    log.warn(
      { userId, contextType, contextId, companyId },
      'Meeting booking denied — role lacks PARTICIPATE'
    );
    return { ok: false, code: 'context_not_found' };
  }

  if (contextType === 'project_discovery' || contextType === 'request_interaction') {
    return { ok: true, companyId, engagementType: null, expertProfileId };
  }

  /**
   * ⚠ THE ENGAGEMENT MUST STILL BE `active`. WITHOUT THIS, A `completed` CASE IS A PERMANENT
   * BOOKING HANDLE ON THAT EXPERT'S CALENDAR.
   *
   * `engagement_status` is exactly `active | completed | cancelled` (`schema/enums.ts`), so
   * there is no legitimate non-`active` bookable state to weigh — this is not a product
   * question. `caseEngagementsRepository.close()` writes `completed` and nothing ever clears
   * it, so before this check a client could keep booking an expert's slots against a case that
   * finished months ago, forever, and every one of those bookings would write a `confirmed`
   * consultation the availability resolver subtracts from real availability.
   *
   * ⚠ IT COSTS NOTHING AND IT RUNS MEMBER-ONLY, for the same two reasons the coherence check
   * below does: the discriminator rides on the row already loaded for `companyId`, and running
   * it before the membership read would re-open the cross-tenant oracle the module docblock
   * describes.
   *
   * ⚠ AND IT ANSWERS `context_not_found`, NOT A NEW LITERAL. §3's oracle decision is that every
   * denial an outsider can reach is indistinguishable; a `context_completed` code would tell a
   * prober "that uuid is a real engagement, just a finished one". The member who legitimately
   * hits this learns the same thing the UI already knows — a closed case is not bookable.
   */
  if (subject.status !== 'active') {
    log.warn(
      { userId, contextType, contextId, companyId, status: subject.status },
      'Meeting booking denied — engagement is not active'
    );
    return { ok: false, code: 'context_not_found' };
  }

  /**
   * ⚠ COHERENCE CHECK — the engagement's TYPE must agree with the context LABEL, and it runs
   * ONLY for a proven member (see the module docblock: running it earlier made this gate a
   * cross-tenant existence-and-type oracle). It is beyond the tenancy requirement (tenancy
   * passes without it) and is included because it is free — the discriminator rides on the
   * row already loaded for `companyId` — and because it buys two things: the projection
   * resolves through a label that agrees with the engagement it names, and D4's
   * `engagement_type` analytics property becomes TRUSTWORTHY rather than being whatever the
   * client claimed. Without it a member could label their own `case` engagement
   * `project_kickoff` — harmless for tenancy, corrupting for the funnel the event exists to
   * measure.
   */
  const expected = ENGAGEMENT_TYPE_FOR_CONTEXT[contextType];
  if (subject.engagementType !== expected) {
    // Logged for the same reason as the two denials above: the module promises the SHAPE goes
    // to the log even when the wire cannot carry it. This one is member-only, so `companyId`
    // and both types are safe to record and are what a client-bug triage actually needs.
    log.warn(
      { userId, contextType, contextId, companyId, engagementType: subject.engagementType },
      'Meeting booking denied — context label disagrees with the engagement type'
    );
    return { ok: false, code: 'context_type_mismatch' };
  }
  // `expected`, not `subject.engagementType`: they are equal here by the guard above, and the
  // constant is precisely typed as `BookableEngagementType` while the column is the full
  // `EngagementType`. Same value, no widening, no assertion.
  return { ok: true, companyId, engagementType: expected, expertProfileId };
}
