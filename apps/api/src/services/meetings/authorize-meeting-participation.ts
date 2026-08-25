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
 *     ⚠ DO NOT WIDEN THIS TO `actorHasExpertSideVisibility`'s (`@balo/shared/authz`) "any
 *     live agency member" set — the rule behind `authorizeSessionExpertVisibility` and the
 *     two `apps/web` visibility gates. CLAUDE.md is explicit (ADR-1046 §7, resolved
 *     2026-08-03) that the wider set is a VISIBILITY rule and the narrow set is the ACT
 *     rule. Inviting is an act.
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
 *
 * ── BAL-466 (D3) — THE RULE ITSELF NOW LIVES IN `@balo/shared/meetings` ────────────────────
 *
 * `apps/web`'s in-call money surface (`resolveInCallDrawdown`) needs this identical verdict,
 * so the two axes above were extracted, verbatim, into `resolveMeetingParticipation` — a pure
 * core over INJECTED reads. This module is now a THIN WRAPPER: it binds the shared core to
 * `@balo/db`'s repositories (`PARTICIPATION_READS`, below) and keeps only what cannot move —
 * the pgEnum drift-guard witnesses (they depend on `@balo/db` types, which `packages/shared`
 * cannot import) and the LOGGING (a pure rule with a logger stops being pure). There is now
 * exactly ONE definition of "is this actor a participant of this meeting", consumed by both
 * apps as fetch-and-call wrappers.
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
  type MeetingGuestInviteChannel,
} from '@balo/db';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import {
  resolveContextOwner,
  resolveMeetingParticipation,
  type MeetingContextOwner,
  type MeetingContextOwnerReads,
  type MeetingParticipationDenialReason,
  type MeetingParticipationOk,
  type MeetingParticipationReads,
  type PrimaryMeetingContext,
  type MeetingContextTypeLabel,
  type MeetingGuestInviteChannelLabel,
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

/**
 * ⚠ THE SAME DRIFT GUARD FOR `meeting_guest_invite_channel` (BAL-132).
 *
 * `@balo/shared/meetings` restates that pgEnum's two labels as
 * `MeetingGuestInviteChannelLabel` for the same reason it restates the context types — the
 * package cannot import a pgEnum — and `presencePartyForGuest` now BRANCHES ON THAT LABEL to
 * decide whether a guest reaches the billable clock. A THIRD label added to the database
 * without a decision here would silently fall into the `email` arm and be treated as a
 * RESOLVED party, which is the over-billing path the `link` arm exists to close.
 *
 * So it fails `pnpm --filter api typecheck` right here until somebody consciously decides
 * which side of the money rule the new label sits on. Split per direction so neither branch
 * forms a `never | never` union (S6571), exactly as the pair above.
 */
type MissingInviteChannelLabel = Exclude<MeetingGuestInviteChannel, MeetingGuestInviteChannelLabel>;
type StrayInviteChannelLabel = Exclude<MeetingGuestInviteChannelLabel, MeetingGuestInviteChannel>;
export type AssertMeetingGuestInviteChannelsMatch = [
  AssertNever<MissingInviteChannelLabel>,
  AssertNever<StrayInviteChannelLabel>,
];

/** ⚠ ONE FAILURE LITERAL FOR EVERY DENIAL. There is deliberately no `forbidden`. */
export type AuthorizeMeetingParticipationErrorCode = 'meeting_not_found';

/** Which side of the meeting the actor was resolved onto. NEVER taken from request input. */
export type MeetingParticipationSide = MeetingGuestSide;

/**
 * ⚠⚠ F16 (review fix round) — THE `ok: true` ARM IS `MeetingParticipationOk<Meeting>`, NOT A
 * HAND-RESTATED COPY. `apps/web`'s `lib/authz/meeting-participation.ts` composes the identical
 * shared shape — see that module's own type and `@balo/shared/meetings`'s docblock on
 * `MeetingParticipationOk` for why this is one definition rather than two.
 */
export type AuthorizeMeetingParticipationResult =
  | ({ ok: true } & MeetingParticipationOk<Meeting>)
  | { ok: false; code: AuthorizeMeetingParticipationErrorCode };

export interface AuthorizeMeetingParticipationInput {
  meetingId: string;
  userId: string;
}

/**
 * Which read came back empty, or which axis refused — a LOG field, never a wire value.
 *
 * ⚠⚠ NOW AN ALIAS OF THE SHARED SHAPE (BAL-466, D3) — one union, so a new denial shape cannot
 * drift between this app's wrapper and `apps/web`'s.
 */
type DenialReason = MeetingParticipationDenialReason;

/**
 * THE REPOSITORY BINDING for the shared owning-party rule.
 *
 * ⚠ THESE ARE THE SAME THREE `@balo/db` FINDERS THIS MODULE ALREADY IMPORTED, PASSED IN
 * RATHER THAN IMPORTED ANEW — and that is deliberate, not incidental. This gate's test mocks
 * `@balo/db` with a FACTORY LITERAL naming exactly six repositories, and a vitest factory
 * mock throws on any export the factory omits. Importing a ready-bound
 * `resolveMeetingContextOwner` from `@balo/db` would therefore turn all 27 of its tests red
 * for a refactor that changes no behaviour. Injecting the already-mocked functions is what
 * lets `authorize-meeting-participation.test.ts` stay green COMPLETELY UNCHANGED — which is
 * the behaviour-preservation proof for this delegation.
 *
 * Each finder already filters `deleted_at IS NULL`, discharging the obligation
 * `MeetingContextOwnerReads` assigns to its injector.
 */
const OWNING_PARTY_READS = {
  findEngagement: (engagementId: string) => engagementsRepository.findById(engagementId),
  findProjectRequest: (projectRequestId: string) =>
    projectRequestsRepository.findById(projectRequestId),
  findRelationship: (relationshipId: string) =>
    requestExpertRelationshipsRepository.findById(relationshipId),
} satisfies MeetingContextOwnerReads;

/**
 * Per-context-type LOAD of the owning party — TOTAL over the six non-`admin` labels.
 *
 * ⚠ THE SWITCH ITSELF NOW LIVES IN `@balo/shared/meetings`'s `resolveContextOwner`, ONCE.
 * `@balo/db`'s `resolveMeetingContextOwner` delegates to the SAME core, so "which party owns
 * this meeting context" has exactly one definition across both apps — CLAUDE.md's
 * `relationshipDeniesHosting` discipline ("never write a second definition") applied to a
 * second rule. What stays here is what must: the LOGGING (a service concern — a repository
 * that notified would read against `repositories-never-notify.test.ts`'s spirit) and the
 * COMPILE-TIME WITNESS (below).
 *
 * Deliberately judgement-free (the `loadSubject` precedent): it reports which company owns
 * the row and says nothing about whether the caller may see it. The injected reads all
 * filter `deleted_at IS NULL`, so `undefined` (missing OR soft-deleted) is the single
 * not-found outcome.
 *
 * ⚠ `request_interaction` COSTS TWO READS, and there is no shortcut — see the core's
 * docblock. A `request_expert_relationships` row names an expert and a REQUEST, not a
 * company; inferring tenancy from the expert would authorize by DELIVERY IDENTITY on the
 * membership axis, which is the axis confusion CLAUDE.md forbids.
 */
async function loadOwningParty(
  subject: PrimaryMeetingContext
): Promise<MeetingContextOwner | undefined> {
  const result = await resolveContextOwner(subject, OWNING_PARTY_READS);

  switch (result.outcome) {
    case 'resolved':
      return result.owner;

    // Missing OR soft-deleted, indistinguishable by construction.
    case 'not_found':
      return undefined;

    default: {
      // Compile-time exhaustiveness over the SIX holder-bearing labels, KEPT AT THIS GATE
      // ON PURPOSE. `admin` cannot reach here — `PrimaryMeetingContext.contextType` is
      // `MeetingContextTypeWithHolder`, and `selectPrimaryMeetingContext` drops admin rows —
      // so this arm is unreachable today, but a SEVENTH non-admin label widens
      // `UnhandledMeetingContextType` away from `never` and stops `pnpm --filter api
      // typecheck` right here until an arm is consciously written.
      //
      // ⚠ WHY THE WITNESS LIVES HERE: **LOGGING LOCALITY**, not a gap in CI coverage.
      // An earlier version of this comment claimed a witness planted in `@balo/shared` /
      // `@balo/db` "would fail SILENTLY". That is FALSE, and it was verified false by probe:
      // both packages' `main`/`types`/`exports` point at RAW `./src/*.ts`, so THIS app's
      // `tsc --noEmit` compiles them as part of its own program. A deliberate type error added
      // to `packages/shared/src/meetings/context-owner.ts` or to
      // `packages/db/src/repositories/_shared/meeting-context-owner.ts` is reported verbatim
      // by `pnpm --filter api typecheck` (and by `apps/web`'s `check-types` for the shared
      // one). The witness sits here because the `log.warn` beside it does — logging is a
      // service concern, and the core stays pure.
      //
      // ⚠ SCOPE, SO THIS IS NOT OVERCORRECTED: only files REACHABLE FROM THIS APP'S IMPORT
      // GRAPH are pulled in. `@balo/db`'s 29 pre-existing baseline errors do not fail this
      // command because all four of their files are test-only and unimported here. An
      // imported production module IS checked; an unimported file is checked by nothing
      // (neither package has its own `typecheck` script — memory
      // `reference_db_shared_no_typecheck_lint_scripts`).
      //
      // Fails CLOSED rather than throwing: this module is an authorization gate, and a
      // caller must never have to catch to stay safe.
      const exhaustive: never = result.contextType;
      log.warn({ contextType: exhaustive }, 'Unhandled meeting context type — failing closed');
      return undefined;
    }
  }
}

/** The single fail-closed exit. The SHAPE goes here; the wire gets one literal. */
function deny(
  reason: DenialReason,
  fields: Readonly<Record<string, string | number | null>>
): { ok: false; code: 'meeting_not_found' } {
  log.warn({ ...fields, reason }, 'Meeting participation denied');
  return { ok: false, code: 'meeting_not_found' };
}

/**
 * ⚠⚠ THE REPOSITORY BINDING (BAL-466, D3). Every entry is a function this module ALREADY
 * imported, passed in rather than imported anew — the same discipline `OWNING_PARTY_READS`
 * states, for the same reason: it is what keeps `authorize-meeting-participation.test.ts`'s
 * six-export `@balo/db` factory mock green with ZERO edits.
 */
const PARTICIPATION_READS = {
  findMeeting: (meetingId: string) => meetingsRepository.findById(meetingId),
  listMeetingContexts: (meetingId: string) => meetingContextsRepository.listByMeeting(meetingId),
  resolveOwner: loadOwningParty,
  findCompanyMemberRole: (companyId: string, userId: string) =>
    partyMembershipsRepository.getMemberRole('company', companyId, userId),
  // ⚠ `manage_engagement` — the ADMINISTRATIVE token, never `host_meetings`. Pinned by a test.
  //
  // ⚠ Calling `hasEngagementCapability` here is safe SPECIFICALLY because step 3 already
  // resolved this context's owning party from its own row — the tenancy obligation that
  // seam's header block assigns to its callers. It is NOT safe to call on an unvetted
  // `contextId`; `resolveHostContext` is an identity oracle.
  holdsEngagementCapability: (userId: string, subject: PrimaryMeetingContext) =>
    hasEngagementCapability({ id: userId }, ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT, subject),
} satisfies MeetingParticipationReads<Meeting>;

/**
 * Fail-closed, two-axis authorization for acting on a meeting's participant roster.
 *
 * ⚠⚠ THIN WRAPPER (BAL-466, D3). The RULE lives in `@balo/shared/meetings`'s
 * `resolveMeetingParticipation`, shared with `apps/web`'s in-call money surface. This module
 * keeps: the pgEnum drift-guard witnesses above (they depend on `@balo/db` types and cannot
 * move), `OWNING_PARTY_READS` + `loadOwningParty` (the logging locality for the owning-party
 * exhaustiveness witness), and `deny` (this app's own log voice).
 *
 * Returns the actor's SIDE plus the meeting, the primary context and the owning party, so
 * the caller threads all four onward and none is read twice.
 */
export async function authorizeMeetingParticipation(
  input: AuthorizeMeetingParticipationInput
): Promise<AuthorizeMeetingParticipationResult> {
  const result = await resolveMeetingParticipation(input, PARTICIPATION_READS);
  if (result.outcome === 'denied') {
    return deny(result.reason, result.fields);
  }
  const { side, meeting, subject, companyId, expertProfileId } = result;
  return { ok: true, side, meeting, subject, companyId, expertProfileId };
}
