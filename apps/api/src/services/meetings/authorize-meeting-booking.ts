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
 * ⚠ AND A DECLINED `request_expert_relationships` ROW IS DELIBERATELY **NON-BLOCKING FOR
 * BOOKING**, which is a different ruling from the hosting one and must not be conflated with
 * it. `relationshipDeniesHosting` (`@balo/shared/authz`) denies on EVIDENCE, not absence —
 * precisely so it CAN be consulted safely on a path where no relationship row is expected. So
 * "it denies on evidence" is an argument the check would be SAFE here, never an argument
 * against making it; an earlier version of this block cited it the wrong way round.
 *   The real reason booking does not consult it is the SUBJECT. Hosting asks "may this expert
 *   deliver this call?", and an expert who declined the engagement must not hold the owner
 *   token — that is a fact about the relationship. Booking asks "may this company member place
 *   a slot on a calendar they can reach?", and a decline is not a withdrawal of published
 *   availability: an expert who declines a specific request keeps their published hours open to
 *   everyone, and the client may legitimately re-approach. If a decline should ALSO close
 *   booking, that is a PRODUCT decision (with a UX for it) and not something to bolt on here.
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
 * the rate limits, every slot the expert published is still consumable, and on this branch a
 * consumed slot STAYS consumed:
 *   · BOOKINGS ARE IRREVERSIBLE. `cancelMeeting` / `softDeleteMeeting` exist in
 *     `services/meetings/meeting-availability.ts` with ZERO production callers (tests only), so
 *     no shipped surface frees a slot again. Cancel is BAL-410's.
 *   · BOOKINGS ARE SILENT. Nothing publishes `booking.confirmed` — the rule and templates in
 *     `notifications/engine/rules.ts` are a documented orphan, and wiring them is BAL-400's —
 *     so the expert is not told their calendar is filling up.
 * A determined actor inside the limits can still take a marketplace expert's published slots
 * and neither the expert nor the platform undoes it. That residual is BAL-400's and BAL-410's,
 * and it is the reason the two rate limits fail CLOSED rather than open.
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
 * token. Three of the four contexts (kickoff, discovery, package session) carry NO CREDIT
 * HOLD AT ALL — gating them on a wallet token is a category error. The money gate for a Case
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
  type EngagementStatus,
  type EngagementType,
} from '@balo/db';
import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import type { MeetingBookingContextType } from '@balo/shared/meetings';

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

/**
 * The engagement `engagement_type` each ENGAGEMENT-anchored context label must name.
 *
 * `project_discovery` is absent BY CONSTRUCTION: it anchors on a `project_requests.id`, not
 * an `engagements.id`, so it has no supertype discriminator to agree with. Its owning party
 * is read from the request row instead.
 */
const ENGAGEMENT_TYPE_FOR_CONTEXT = {
  case: 'case',
  project_kickoff: 'project',
  package_session: 'package',
} as const satisfies Partial<Record<MeetingBookingContextType, EngagementType>>;

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
 * Per-context-type LOAD of the owning party — TOTAL over the four bookable labels, and
 * deliberately judgement-free: it reports what the row says and nothing about whether the
 * caller may see it. Both repository reads already filter `deleted_at IS NULL`, so
 * `undefined` (missing OR soft-deleted) is the single not-found outcome.
 */
async function loadSubject(
  contextType: MeetingBookingContextType,
  contextId: string
): Promise<LoadedSubject | undefined> {
  if (contextType === 'project_discovery') {
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

  if (contextType === 'project_discovery') {
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
