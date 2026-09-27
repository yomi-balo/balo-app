/**
 * BAL-134 / ADR-1049 (D3, D6, D7) — WHO MAY END A MEETING, AS ONE PURE RULE.
 *
 * ⚠⚠⚠ THE SHARPEST TRAP IN THIS FEATURE, STATED FIRST: `canEndMeeting` IS **NOT** `isOwner`,
 * AND THE TWO MUST NEVER BE MERGED, RENAMED INTO EACH OTHER, OR WIDENED TOWARDS EACH OTHER.
 *
 *   · `JoinGrant.isOwner` is `hasEngagementCapability(HOST_MEETINGS)` and is the **only** input
 *     to the Daily meeting token's `is_owner` property (`join-meeting.ts` feeds that exact
 *     boolean into the mint). Daily `is_owner` confers VENDOR-LEVEL ROOM POWERS — eject and
 *     recording control. Widening it to client principals would hand those powers to the
 *     PAYING SIDE of the transaction. No ADR authorizes that, and ADR-1049's "this is what
 *     BAL-435's bare `isOwner` prop becomes" is UNSAFE AS WRITTEN and must not be implemented
 *     as a rename.
 *   · `JoinGrant.canEndMeeting` — the SIXTH field, computed independently by this module, used
 *     ONLY to decide whether the End control renders and whether `POST /meetings/:id/end` is
 *     accepted. It NEVER reaches a Daily token.
 *
 * They diverge the moment `isClientPrincipal` is true, which is the ordinary case for every
 * client-booked consultation. Neither is redundant.
 *
 * ── THE TWO AXES, AND WHY THE CLIENT ARM IS `CONSUME_CREDITS` (D6) ────────────────────────
 *
 * The composition of the two axes is `apps/api`'s (`services/meetings/authorize-end-meeting.ts`
 * is the ONE place they are resolved); this module holds the pure combination rule so neither
 * app can fork it. The reasoning is recorded there, and in one line here so a reader of this
 * file is not left guessing: the CLIENT arm is the MEMBERSHIP axis, company scope,
 * `CONSUME_CREDITS` — "the party whose money is being spent may stop the spend" — and the
 * EXPERT arm is the ENGAGEMENT axis, `HOST_MEETINGS`, i.e. the same verdict `isOwner` carries.
 *
 * PURE and dependency-free. Trivially small — but it is the ONE definition, which is the whole
 * reason it is a module rather than an inline `a || b`.
 */

/**
 * WHO ended a meeting — the `meeting_ended_by` pgEnum's three labels, restated in a package
 * that cannot import a pgEnum.
 *
 * ⚠ `apps/api` plants an `AssertNever` drift guard against `@balo/db`'s `MeetingEndedBy`, so a
 * fourth label added to the database fails `pnpm typecheck` until it is given a decision here.
 *
 *   · `client_principal` — a human on the CLIENT side pressed End.
 *   · `expert_host`      — the delivering expert (or their agency owner/admin) pressed End.
 *   · `system_idle`      — ALL FIVE system paths (idle end, no-show, missed call,
 *                          venue-unavailable, abandoned wait). ⚠ ONE label for five rules,
 *                          deliberately: `ended_by` answers "was this a person or the system?",
 *                          and WHICH system rule fired is answered by `outcome` plus the
 *                          `meeting.ended` audit row. A fifth label per rule would duplicate
 *                          `outcome` and then disagree with it.
 */
export type MeetingEndedBy = 'client_principal' | 'expert_host' | 'system_idle';

/** The two independently-resolved axes. Both are SERVER verdicts; neither is request input. */
export interface EndAuthorityInput {
  /**
   * `hasEngagementCapability(actor, HOST_MEETINGS, subject)` — the delivering expert plus
   * their agency `owner`/`admin`. ⚠ Never agency role `expert`, never a guest, never a lens.
   */
  readonly isExpertHost: boolean;
  /**
   * `roleHasCapability(companyRole, CONSUME_CREDITS)` for the BOOKING company.
   *
   * ⚠ A GUEST IS STRUCTURALLY FALSE HERE, and that is the narrowing that matters: a guest has
   * no `company_members` row at all, so `getMemberRole` answers `undefined` and every
   * membership token fails closed. Guests see Leave only (edge case 24) — delivered by the
   * shape of the data, not by a token check.
   */
  readonly isClientPrincipal: boolean;
}

/**
 * May this actor end the meeting?
 *
 * ⚠ THE OR IS THE WHOLE RULE, AND BOTH ARMS BEING TRUE IS LEGAL rather than a contradiction —
 * the pure core takes no view on whether one person can hold both. (In practice the two arms
 * are mutually exclusive: `authorizeMeetingParticipation` reaches its expert arm ONLY when the
 * actor holds no company membership. That is asserted as a test in `apps/api`, not relied on
 * here.)
 */
export function canEndMeeting(input: EndAuthorityInput): boolean {
  return input.isExpertHost || input.isClientPrincipal;
}

/**
 * WHICH human label to stamp on `meetings.ended_by`, or `null` when the actor may not end.
 *
 * ⚠ THE EXPERT ARM WINS A TIE, and the choice is recorded rather than arbitrary: `ended_by`
 * describes the DELIVERY-SIDE fact BAL-412 and the recap read, and somebody holding
 * `HOST_MEETINGS` ended the call AS the host. The tie is unreachable today (see
 * {@link canEndMeeting}), so this is a decision about an impossible state — made explicitly so
 * that if the participation gate is ever widened, the answer is already written down.
 */
export function endedByForActor(input: EndAuthorityInput): MeetingEndedBy | null {
  if (input.isExpertHost) {
    return 'expert_host';
  }
  if (input.isClientPrincipal) {
    return 'client_principal';
  }
  return null;
}

/**
 * BAL-474 (D6.4, ADR-1040 Amendment 7 §C step 7, ADR-1049 end-authority note) — the typed refusal
 * `endMeeting` returns when a CLIENT principal presses End without ever having been present in the
 * meeting (no `party = 'client'` presence row of their own). ONE literal for both apps: `apps/api`
 * maps it to HTTP 409, `apps/web`'s End action maps it to its own toast copy.
 *
 * ⚠ It closes the "free cancellation after the start" escape in END AUTHORISATION, not in
 * settlement: a client who never joined cannot turn the expert's wait into a zero-shape
 * settlement, so the `no_show` rule fires at the floor as normal. It is reachable only AFTER
 * tenancy and end authority are proven (so it is not an existence oracle), and it is never shown
 * for an already-ended meeting — that is the idempotent success (D8.7). Expert-side End is
 * unchanged: the expert arm wins a tie ({@link endedByForActor}), so a `HOST_MEETINGS` holder is
 * never presence-checked.
 */
export const MEETING_END_NOT_JOINED_CODE = 'meeting_not_joined' as const;

/**
 * BAL-474 (R6-C6) — the refusal for an End pressed BEFORE the meeting's scheduled start (`409
 * meeting_not_started`, `end-meeting.ts`). Under billing Rule A an early call is billed, so people will try to end
 * it; the web End action gives this refusal its own copy (`END_MEETING_NOT_STARTED_COPY`).
 */
export const MEETING_END_NOT_STARTED_CODE = 'meeting_not_started' as const;

/**
 * The two `endMeeting` refusals that are a FRICTION signal rather than a denial — the `reason` of the
 * `meeting_end_refused` server event. Derived from the two code constants so a new friction refusal is added
 * once, here, and every consumer follows.
 */
export type MeetingEndRefusalReason =
  | typeof MEETING_END_NOT_JOINED_CODE
  | typeof MEETING_END_NOT_STARTED_CODE;
