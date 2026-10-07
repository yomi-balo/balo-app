/**
 * BAL-134 / ADR-1049 — THE MEETING LIFECYCLE'S PURE CORE.
 *
 * Three things live here, and nothing else:
 *
 *   1. {@link MEETING_TRANSITIONS} — the legal-edge map (§4.1), plus
 *      {@link assertMeetingTransition}. Total, pure, and asserted by all three
 *      `meetingsRepository` status mutators against their own compare-and-set FROM sets.
 *   2. {@link resolveTerminalRule} — which of the six SYSTEM termination rules (§4.2)
 *      applies to a meeting, or `null`. The human End is a further path — user-initiated
 *      and therefore not resolvable from facts; see that function's docblock.
 *   3. {@link resolveWaitingPhase} — the server-computed waiting-stage label.
 *
 * ⚠⚠ THIS MODULE READS NO CLOCK, NO ENV AND NO DATABASE. `now` and `timers` are INJECTED on
 * every call. That is not stylistic: `@balo/shared/meetings` is client-reachable (BAL-403's
 * in-session panel imports from this exact subpath), and it is what lets the precedence table
 * below be executed as a table-driven test with instants stated in whole minutes.
 *
 * ⚠ IT ALSO MEASURES NO SPAN. No rule here reads a DURATION of presence — only booleans,
 * instants and the injected thresholds. `computeMeetingClocks` (`index.ts`) is the one
 * definition of the two spans and it is a MONEY number; restating that math here would be a
 * second definition of it (and would trip the SonarCloud duplication gate). Rule 4 once took
 * `expertPresentMs` as a parameter to compare against the no-show floor, and that comparison
 * turned out to be a stranding hole rather than a safeguard — see {@link TerminalRuleInput}.
 */

import { MAX_SESSION_MINUTES } from '../pricing';
import type { MeetingTimers } from './timers';

/**
 * The five `meeting_status` labels, restated in a package that cannot import a pgEnum.
 *
 * ⚠ IT IS A HAND-RESTATED LIST, exactly like `MEETING_CONTEXT_PRECEDENCE`'s, and it carries
 * the same obligation: `apps/api` plants an `AssertNever` drift guard against the real
 * `MeetingStatus`, so a SIXTH label added to the database fails `pnpm typecheck` until it is
 * given both an entry in {@link MEETING_TRANSITIONS} and a decision in the rules below.
 */
export type MeetingLifecycleStatus =
  | 'scheduled'
  | 'waiting_for_participants'
  | 'in_progress'
  | 'ended'
  | 'cancelled';

/**
 * THE LEGAL-EDGE MAP (§4.1).
 *
 * ⚠ HOW IT IS ENFORCED, STATED EXACTLY — an earlier draft of this docblock claimed "every
 * writer calls {@link assertMeetingTransition} before it writes", and that was FALSE: nothing
 * in production called it at all. What is true now: each of the three `meetingsRepository`
 * status mutators (`markWaitingForParticipants`, `markInProgress`, `endMeeting`) asserts
 * EVERY status in its own compare-and-set FROM set against this map, once per call. The
 * assertion is therefore a guard on the WRITER'S DECLARED EDGE SET rather than on one row's
 * observed status — which is the strongest thing a CAS-shaped writer can check, because it
 * never reads the row before it writes.
 *
 * The two guards stay independent on purpose: this one catches a WRITER whose FROM set drifted
 * away from the map, the CAS catches a RACE.
 *
 * ⚠ `waiting_for_participants → scheduled` IS DECLARED LEGAL AND IS DELIBERATELY NOT
 * IMPLEMENTED (D12). `repositories/meetings.ts` named this edge as BAL-134's to STATE; it is
 * stated here and nowhere else, because wiring it into `updateSchedule` means deciding what
 * happens to the presence rows from the pre-reschedule attempt — a BILLING question that is
 * BAL-412's, on a route BAL-409/BAL-411 own. What makes the omission SAFE is that every rule
 * in {@link resolveTerminalRule} carries an explicit wall-clock precondition anchored on
 * `scheduledStart` (or on {@link venueAbsenceAnchor}, never earlier than it), so a meeting
 * rescheduled into the future matches NO rule and its stale status is inert.
 *
 * ⚠ `scheduled → in_progress` IS REAL, NOT A SHORTCUT. A same-instant double-join takes a
 * meeting straight there without ever being OBSERVED as `waiting_for_participants`. Requiring
 * the intermediate state would leave such a meeting at `scheduled` — and therefore matched by
 * the MISSED-CALL rule, which would end a call that is actually running.
 *
 * ⚠ BOTH TERMINAL STATES HAVE AN EMPTY EDGE LIST, and `endMeeting`'s compare-and-set excludes
 * both. A new TERMINAL label must be added to BOTH places.
 */
export const MEETING_TRANSITIONS: Readonly<
  Record<MeetingLifecycleStatus, readonly MeetingLifecycleStatus[]>
> = {
  scheduled: ['waiting_for_participants', 'in_progress', 'ended', 'cancelled'],
  waiting_for_participants: ['in_progress', 'ended', 'scheduled'],
  in_progress: ['ended'],
  ended: [],
  cancelled: [],
};

/**
 * BAL-474 (D8.7, plan §H.2) — `true` for a TERMINAL meeting status: a label with NO outgoing edge
 * in {@link MEETING_TRANSITIONS} (today `ended` and `cancelled`).
 *
 * ⚠ DERIVED, NEVER A RESTATED LABEL LIST. A new terminal label added to the map (with an empty
 * edge list, as the map's docblock requires) is terminal here automatically — the same exclusion
 * `meetingsRepository.endMeeting`'s compare-and-set applies. `endMeeting`'s D6.4 presence check
 * reads it so an already-terminal meeting answers the idempotent "already ended" success, never
 * the "not joined" refusal.
 */
export function isTerminalMeetingStatus(status: MeetingLifecycleStatus): boolean {
  return MEETING_TRANSITIONS[status].length === 0;
}

/** `true` when `from → to` is an edge of {@link MEETING_TRANSITIONS}. Total and pure. */
export function isLegalMeetingTransition(
  from: MeetingLifecycleStatus,
  to: MeetingLifecycleStatus
): boolean {
  return MEETING_TRANSITIONS[from].includes(to);
}

/**
 * Thrown by {@link assertMeetingTransition}. A WRITER BUG, not a runtime condition — a lost
 * race answers `undefined` from the repository's compare-and-set and never reaches here.
 */
export class IllegalMeetingTransitionError extends Error {
  constructor(
    public readonly from: MeetingLifecycleStatus,
    public readonly to: MeetingLifecycleStatus
  ) {
    super(`Illegal meeting transition: ${from} → ${to}`);
    this.name = 'IllegalMeetingTransitionError';
  }
}

/**
 * Throw unless `from → to` is legal.
 *
 * ⚠ A SELF-EDGE IS ILLEGAL AND THAT IS DELIBERATE: no label lists itself, so
 * `assertMeetingTransition('ended', 'ended')` throws. A second termination is expressed as the
 * repository's CAS matching zero rows (→ D10's idempotent `200`), never as a legal no-op edge.
 */
export function assertMeetingTransition(
  from: MeetingLifecycleStatus,
  to: MeetingLifecycleStatus
): void {
  if (!isLegalMeetingTransition(from, to)) {
    throw new IllegalMeetingTransitionError(from, to);
  }
}

// ── PRESENCE FACTS ────────────────────────────────────────────────────────────────────────

/** The three `meeting_presence.party` labels the rules branch on. */
export type LifecyclePresenceParty = 'expert' | 'client' | 'observer';

/** One `meeting_presence` row reduced to what the lifecycle rules need. */
export interface LifecyclePresenceInterval {
  /**
   * ⚠ SERVER-DERIVED. A guest's row derives this through `presencePartyForGuest`, never from
   * the guest's own `party` column — see THE MONEY RULE in `guest-participation.ts`.
   */
  readonly party: LifecyclePresenceParty;
  readonly joinedAt: Date;
  /** `null` = still in the room. */
  readonly leftAt: Date | null;
}

/**
 * The STRUCTURAL facts every terminal rule reads. Deliberately booleans and instants only —
 * NO DURATIONS. The one duration that matters, `expertPresentMs`, is `computeMeetingClocks`'s
 * answer and a settlement input; no rule here reads it, and rule 4's removed floor comparison
 * is why (see {@link TerminalRuleInput}).
 */
export interface PresenceFacts {
  /** Has an `expert` interval EVER existed? Rule 3's whole precondition. */
  readonly expertEverPresent: boolean;
  /** Is an `expert` interval OPEN right now? Rules 2 and 4 split on exactly this. */
  readonly expertOpen: boolean;
  /**
   * Has a `client` interval EVER existed?
   *
   * ⚠ `observer` DOES NOT COUNT, ON EITHER SIDE. A Balo staffer, a link-share attendee and an
   * expert-side colleague are all `observer`, and none of them makes a meeting billable
   * (`computeMeetingClocks` excludes `observer` from both sides of the intersection). Counting
   * one here would convert a `no_show_client` — nothing owed — into a settled consultation.
   */
  readonly clientSideEverPresent: boolean;
  /** Is ANY interval open? `false` ⇒ the room is empty. */
  readonly anyOpen: boolean;
  /**
   * The latest `left_at` across every interval, or `null` when none has closed. ⚠ Meaningless
   * while {@link anyOpen} is `true`; both rules that read it require an empty room first.
   */
  readonly lastLeftAt: Date | null;
  /** The FIRST expert join. `null` when no expert ever joined. */
  readonly expertFirstJoinedAt: Date | null;
}

/** One interval's endpoints in ms — `null` when either is unusable. See {@link summarisePresence}. */
interface FiniteEndpoints {
  readonly joinedMs: number;
  /** `null` = still in the room. */
  readonly leftMs: number | null;
}

/**
 * Reduce one interval to finite millisecond endpoints, or `null` to SKIP it.
 *
 * ⚠ AN INTERVAL WITH A NON-FINITE ENDPOINT IS SKIPPED, matching `computeMeetingClocks`'s
 * `toSpans` guard byte for byte in intent: NaN has no position on the timeline, so letting one
 * through would make `lastLeftAt` depend on array order. The write seam rejects non-finite
 * instants (`InvalidPresenceTimestampError`), so this is defensive — but the two readers of
 * the same rows must not disagree about which rows exist.
 */
function finiteEndpoints(interval: LifecyclePresenceInterval): FiniteEndpoints | null {
  const joinedMs = interval.joinedAt.getTime();
  if (!Number.isFinite(joinedMs)) {
    return null;
  }
  if (interval.leftAt === null) {
    return { joinedMs, leftMs: null };
  }
  const leftMs = interval.leftAt.getTime();
  return Number.isFinite(leftMs) ? { joinedMs, leftMs } : null;
}

/** `Math.max` that treats `null` as "nothing seen yet" rather than as `0`. */
function laterOf(current: number | null, candidate: number): number {
  return current === null || candidate > current ? candidate : current;
}

/** `Math.min` that treats `null` as "nothing seen yet" rather than as `0`. */
function earlierOf(current: number | null, candidate: number): number {
  return current === null || candidate < current ? candidate : current;
}

/**
 * Reduce a meeting's live presence intervals to {@link PresenceFacts}. Order-independent.
 *
 * ⚠ THE PER-INTERVAL WORK IS SPLIT OUT ({@link finiteEndpoints}, {@link laterOf},
 * {@link earlierOf}) TO KEEP THIS UNDER SonarCloud's cognitive-complexity ceiling — the
 * accumulate-six-facts-in-one-pass shape trips `sonarjs/cognitive-complexity` when the null
 * handling is inlined. The semantics are unchanged; the fold is still one pass and still
 * order-independent.
 */
export function summarisePresence(intervals: readonly LifecyclePresenceInterval[]): PresenceFacts {
  let expertEverPresent = false;
  let expertOpen = false;
  let clientSideEverPresent = false;
  let anyOpen = false;
  let lastLeftMs: number | null = null;
  let expertFirstJoinedMs: number | null = null;

  for (const interval of intervals) {
    const endpoints = finiteEndpoints(interval);
    if (endpoints === null) {
      continue;
    }
    const { joinedMs, leftMs } = endpoints;

    if (leftMs === null) {
      anyOpen = true;
    } else {
      lastLeftMs = laterOf(lastLeftMs, leftMs);
    }

    if (interval.party === 'expert') {
      expertEverPresent = true;
      expertOpen = expertOpen || leftMs === null;
      expertFirstJoinedMs = earlierOf(expertFirstJoinedMs, joinedMs);
    } else if (interval.party === 'client') {
      clientSideEverPresent = true;
    }
  }

  return {
    expertEverPresent,
    expertOpen,
    clientSideEverPresent,
    anyOpen,
    lastLeftAt: lastLeftMs === null ? null : new Date(lastLeftMs),
    expertFirstJoinedAt: expertFirstJoinedMs === null ? null : new Date(expertFirstJoinedMs),
  };
}

/**
 * The instant the EXPERT-PRESENT CLOCK starts: `max(scheduled_start, expert first join)`.
 *
 * ⚠ THIS IS THE TICKET'S RULE VERBATIM, and it cuts both ways. An expert arriving at 09:55
 * for a 10:00 call is not credited for arriving early ON THIS CLOCK (the readers apply
 * `clampIntervalsToStart`, which raises a pre-start `joined_at`, so the `max` is belt-and-braces
 * there; the minutes an early expert spends WITH a client-side participant are a separate term of the
 * settlement — BAL-474 Rule A); an expert joining at 10:05 starts their own clock at 10:05, so their
 * no-show settles at 10:20, not 10:15.
 *
 * `null` when no expert has joined — there is no clock to start.
 */
export function expertClockStart(
  scheduledStart: Date,
  expertFirstJoinedAt: Date | null
): Date | null {
  if (expertFirstJoinedAt === null) {
    return null;
  }
  return expertFirstJoinedAt.getTime() > scheduledStart.getTime()
    ? expertFirstJoinedAt
    : scheduledStart;
}

// ── THE SIX SYSTEM TERMINAL RULES (§4.2) ─────────────────────────────────────────────────

/** Which system rule fired. The human End is not one of these — see {@link resolveTerminalRule}. */
export type MeetingTerminalRuleName =
  | 'idle_end'
  | 'no_show'
  | 'missed_call'
  | 'venue_unavailable'
  | 'abandoned_wait'
  | 'overrun_stop';

/** Which ceiling arm of the overrun stop fired. Only one exists today. */
export type OverrunStopArm = 'hard_ceiling';

/** The four `meeting_outcome` labels this feature writes. `null` = "BAL-412 resolves it". */
export type MeetingTerminalOutcome =
  | 'completed'
  | 'no_show_client'
  | 'missed_call'
  | 'venue_unavailable';

/** What a fired rule instructs the sweep to write. */
export interface MeetingTerminalDecision {
  readonly rule: MeetingTerminalRuleName;
  /**
   * ⚠ `null` IS A REAL, CORRECT VALUE — NOT "unknown" (D5). The ABANDONED-WAIT path leaves it
   * unset for exactly the reason the human End does: "the ender never sets the outcome"
   * (ADR-1049), and BAL-412 resolves it from `meeting_presence`. The other four system paths
   * are DEFINED by their outcome in the ADR's own table, so they carry one.
   */
  readonly outcome: MeetingTerminalOutcome | null;
  /** The overrun stop's ceiling arm; `null` for every other rule. */
  readonly arm: OverrunStopArm | null;
  /**
   * The instant this rule BECAME due: the same expression the predicate compares `now` against,
   * so it is `<= now` whenever the rule fired. A sweep that reaches a meeting late (a stranded
   * one) backdates its terminal write to this instant rather than to the tick that noticed.
   */
  readonly dueAt: Date;
}

/**
 * Everything a terminal rule reads. Nothing is derived from a clock this module owns.
 *
 * ⚠ THERE IS NO `expertPresentMs` HERE ANY MORE, AND ITS ABSENCE IS THE FIX. It existed for
 * exactly one guard — rule 4's `expertPresentMs < NO_SHOW_FLOOR_MS` — and that guard was a
 * STRANDING HOLE: an expert who crossed the floor and then left matched rule 2 (needs an OPEN
 * interval) and rule 4 (needs to be BELOW the floor) and nothing else, forever. The reconciler
 * makes that state ordinary rather than exotic — it closes a dropped-`left` interval at the
 * SWEEP'S `now`, inflating the measured span by up to a full tick — so a clean abandonment at
 * 14:30 recorded at 15:00 crossed the floor and stranded. The taxonomy is now TOTAL over an
 * EMPTY room instead (see {@link resolveTerminalRule}), and the duration is BAL-412's to price.
 */
export interface TerminalRuleInput {
  readonly status: MeetingLifecycleStatus;
  readonly scheduledStart: Date;
  /** The booked end; the overrun stop's ceiling is measured from it. */
  readonly scheduledEnd: Date;
  readonly presence: PresenceFacts;
  readonly timers: MeetingTimers;
  readonly now: Date;
  /**
   * BAL-581 — when this meeting's call room BECAME READY (`meetingVenueReadyAt`, which applies
   * the one venue predicate `isMeetingVenueReady`), or `null` while it is not ready. An INSTANT,
   * never the row: this module stays clock-, env- and DB-free.
   */
  readonly venueReadyAt: Date | null;
}

/**
 * BAL-581 — THE VENUE ABSENCE ANCHOR: the instant "nobody delivering turned up" is measured
 * from. `max(scheduledStart, venueReadyAt)` — an expert cannot be absent from a room that did
 * not exist. `null` when the venue is not ready: there is nothing to be absent FROM, and the
 * venue-unavailable rule (not the missed call) owns that meeting.
 *
 * ⚠ The `max` keeps this anchor from ever landing before `scheduledStart`, exactly as
 * `expertClockStart` does: a meeting rescheduled into the future still matches no absence
 * rule. Consumed by rule 3, the expert-absent alert (arm site AND fire-time recheck) and
 * `resolveWaitingPhase` — ONE definition, so the three can never disagree.
 */
export function venueAbsenceAnchor(scheduledStart: Date, venueReadyAt: Date | null): Date | null {
  if (venueReadyAt === null) return null;
  return venueReadyAt.getTime() > scheduledStart.getTime() ? venueReadyAt : scheduledStart;
}

/**
 * The instant an `in_progress` meeting that still has an open interval is force-ended:
 * `max(scheduledEnd, scheduledStart + MAX_SESSION_MINUTES) + overrunStopGraceMs`. The meter
 * stops drawing at `MAX_SESSION_MINUTES`, so a meeting booked shorter than that still ends by
 * the meter's own limit plus grace; a longer booking ends at its own end plus grace.
 */
export function overrunStopCeiling(
  scheduledStart: Date,
  scheduledEnd: Date,
  timers: MeetingTimers
): Date {
  const meterLimitMs = scheduledStart.getTime() + MAX_SESSION_MINUTES * 60_000;
  return new Date(Math.max(scheduledEnd.getTime(), meterLimitMs) + timers.overrunStopGraceMs);
}

/** `true` for the two PRE-`in_progress` statuses rules 3, 4 and 5 all require. */
function isPreInProgress(status: MeetingLifecycleStatus): boolean {
  return status === 'scheduled' || status === 'waiting_for_participants';
}

/**
 * When an EMPTY room's idle window starts: the LATER of the last leave and the scheduled start.
 *
 * ⚠ TWO ANCHORS, AND BOTH HALVES ARE LOAD-BEARING.
 *
 *   · `lastLeftAt` is the real answer — the instant the room actually emptied.
 *   · `scheduledStart` is the FLOOR, and it is what keeps D12 safe. A meeting rescheduled INTO
 *     THE FUTURE carries presence rows from the pre-reschedule attempt whose `left_at` is in the
 *     past; anchoring on those alone would terminate a call that has not happened yet. Rule 2
 *     carries the same second gate for the same reason.
 *   · `lastLeftAt === null` on an EMPTY room means there is no interval at all — a degenerate
 *     state (nothing reaches `in_progress` without two open intervals) that would otherwise be
 *     rule-less FOREVER. Falling back to `scheduledStart` makes the taxonomy total there too.
 */
function emptyWindowStartMs(input: TerminalRuleInput): number {
  const lastLeftMs = input.presence.lastLeftAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return Math.max(lastLeftMs, input.scheduledStart.getTime());
}

/** The instant an EMPTY room's idle window has fully elapsed (rules 1 and 4). */
function emptyWindowDueAt(input: TerminalRuleInput): Date {
  return new Date(emptyWindowStartMs(input) + input.timers.idleEndEmptyMs);
}

/** `true` when nobody is in the room and the idle window has fully elapsed. */
function roomEmptyPastWindow(input: TerminalRuleInput): boolean {
  if (input.presence.anyOpen) {
    return false;
  }
  return input.now.getTime() >= emptyWindowDueAt(input).getTime();
}

/** Rule 1 — IDLE END. The only rule that requires `in_progress`. */
function idleEndApplies(input: TerminalRuleInput): boolean {
  return input.status === 'in_progress' && roomEmptyPastWindow(input);
}

/**
 * Rule 6 — OVERRUN STOP. An `in_progress` meeting somebody is STILL IN at the ceiling.
 * Disjoint from rule 1 by `anyOpen` (rule 1 needs an empty room) and from rules 2–5 by status.
 */
function overrunStopApplies(input: TerminalRuleInput): boolean {
  if (input.status !== 'in_progress' || !input.presence.anyOpen) {
    return false;
  }
  return input.now.getTime() >= overrunStopDueAt(input).getTime();
}

/** Rule 6's due instant — {@link overrunStopCeiling} over the input's own facts. */
function overrunStopDueAt(input: TerminalRuleInput): Date {
  return overrunStopCeiling(input.scheduledStart, input.scheduledEnd, input.timers);
}

/**
 * Rule 2 — NO-SHOW. The expert is STILL HOLDING the room and no client ever came.
 *
 * ⚠ VENUE-SAFE BY CONSTRUCTION (BAL-581) — measured from the expert's first join,
 * which cannot precede a ready room (a presence interval can only exist in a room that exists).
 * A room repaired late still settles this rule from the expert's actual join, never from the
 * scheduled start. This says nothing about WHAT the rule charges — see `resolveShape` in
 * `meeting-settlement.ts` (BAL-474): the meeting's terminal path opens a session on behalf of the
 * booker when none exists, so a client who never joins IS charged the flat floor this rule's
 * shape (`no_show_client`) carries, and the expert who waited is paid it.
 */
function noShowApplies(input: TerminalRuleInput): boolean {
  const dueAt = noShowDueAt(input);
  return dueAt !== null && input.now.getTime() >= dueAt.getTime();
}

/**
 * Rule 2's due instant, or `null` when its structural guards do not hold (so the rule can
 * never fire). The predicate and the decision's `dueAt` both read this one expression.
 */
function noShowDueAt(input: TerminalRuleInput): Date | null {
  const { presence, timers, scheduledStart } = input;
  if (
    input.status !== 'waiting_for_participants' ||
    !presence.expertOpen ||
    presence.clientSideEverPresent
  ) {
    return null;
  }
  const clockStart = expertClockStart(scheduledStart, presence.expertFirstJoinedAt);
  if (clockStart === null) {
    // Unreachable: `expertOpen` implies an expert interval, which implies a first join. Guarded
    // rather than asserted — `noUncheckedIndexedAccess` discipline applied to a nullable.
    return null;
  }
  // ⚠ TWO WALL-CLOCK GATES, AND THE SECOND IS **IMPLIED BY THE FIRST** as long as
  // `expertClockStart` is a `max` over `scheduledStart` — stated honestly rather than sold as
  // independent. It is written out anyway because it is the guard that survives a refactor:
  // anchoring the clock purely on the expert's join (a change somebody will propose) silently
  // re-opens D12's hazard, where a meeting rescheduled into the FUTURE with a still-open
  // expert interval trips the no-show on a call that has not happened yet.
  const floorFromClock = clockStart.getTime() + timers.noShowFloorMs;
  const floorFromSchedule = scheduledStart.getTime() + timers.noShowFloorMs;
  return new Date(Math.max(floorFromClock, floorFromSchedule));
}

/**
 * Rule 3 — MISSED CALL. The room EXISTED for the full salvage window and no expert ever came.
 *
 * ⚠ "NEVER JOINED", NOT "IS NOT HERE NOW". An expert who joins at 10:09 against a 10:10
 * threshold disarms this rule PERMANENTLY (edge case 13) — the salvage window worked, and
 * whatever happens next is rule 2's or rule 4's, never this one's.
 *
 * ⚠ BAL-581 — NARROWED TO A READY VENUE. Anchored on {@link venueAbsenceAnchor}, never bare
 * `scheduledStart`: an expert cannot be recorded absent from a room that was never provisioned.
 * A `null` anchor is rule 5's meeting, never this one's — see the guard below.
 */
function missedCallApplies(input: TerminalRuleInput): boolean {
  const dueAt = missedCallDueAt(input);
  return dueAt !== null && input.now.getTime() >= dueAt.getTime();
}

/** Rule 3's due instant, or `null` when its structural guards do not hold. */
function missedCallDueAt(input: TerminalRuleInput): Date | null {
  const { presence, timers } = input;
  if (!isPreInProgress(input.status) || presence.expertEverPresent) {
    return null;
  }
  const anchor = venueAbsenceAnchor(input.scheduledStart, input.venueReadyAt);
  if (anchor === null) {
    // No room yet — rule 5's meeting, never this one's. THIS is the guard that stops Balo's
    // provisioning failure being recorded as the expert's no-show.
    return null;
  }
  return new Date(anchor.getTime() + timers.missedCallTerminationMs);
}

/**
 * Rule 5 — VENUE UNAVAILABLE (BAL-581). The call room was never ready, so nobody COULD join.
 *
 * ⚠ Its three guards are exactly the three that keep it disjoint:
 *   · pre-`in_progress` — disjoint from rule 1 by status;
 *   · `!expertEverPresent` — disjoint from rules 2 and 4 by presence (both require the expert
 *     DID join). Physically implied by "no room", stated so disjointness does not rest on
 *     physics;
 *   · `venueReadyAt === null` — disjoint from rule 3, which requires a ready venue.
 * Anchored on `scheduledStart` (there is no venue instant to anchor on), at the SAME threshold
 * rule 3 uses, so a never-provisioned meeting still ends at the missed-call window — but with
 * the TRUE outcome, not a mislabelled `missed_call`. Money: no room ⇒ no admission ⇒ no credit
 * session ⇒ nothing to settle.
 */
function venueUnavailableApplies(input: TerminalRuleInput): boolean {
  const dueAt = venueUnavailableDueAt(input);
  return dueAt !== null && input.now.getTime() >= dueAt.getTime();
}

/** Rule 5's due instant, or `null` when its structural guards do not hold. */
function venueUnavailableDueAt(input: TerminalRuleInput): Date | null {
  if (!isPreInProgress(input.status) || input.presence.expertEverPresent) {
    return null;
  }
  if (input.venueReadyAt !== null) {
    return null;
  }
  return new Date(input.scheduledStart.getTime() + input.timers.missedCallTerminationMs);
}

/**
 * Rule 4 — ABANDONED WAIT (D9). The expert turned up, the consultation never started, and the
 * room is now EMPTY.
 *
 * ⚠⚠ THIS RULE IS THE TAXONOMY'S CATCH-ALL FOR A PRE-`in_progress` EMPTY ROOM, AND ITS THREE
 * GUARDS ARE EXACTLY THE THREE THAT KEEP IT DISJOINT — no more:
 *
 *   · a PRE-`in_progress` status, so rule 1 (which owns `in_progress`) cannot also fire;
 *   · `expertEverPresent`, so rules 3 and 5 (which both require the expert NEVER joined)
 *     cannot also fire. Without it a client-only no-show would terminate at `lastLeftAt +
 *     5min` instead of at the `MISSED_CALL_TERMINATION_MS` threshold, silently re-labelling a
 *     `missed_call`, or with no room ever provisioned, a `venue_unavailable`;
 *   · an EMPTY room, so rule 2 (which requires an OPEN expert interval) cannot also fire.
 *
 * ⚠ THE TWO GUARDS THAT WERE REMOVED, AND WHY EACH WAS A STRANDING HOLE — do not put them back:
 *
 *   · `expertPresentMs < NO_SHOW_FLOOR_MS`. An expert who crossed the floor and THEN left
 *     matched nothing at all: rule 2 needs them still OPEN, rule 4 needed them BELOW the floor.
 *     The meeting sat non-terminal forever with a hold never released, and after 24h the sweep's
 *     lookback floor took it out of the in-window batch (the stranded arm, BAL-584, picks a
 *     past-floor pre-live meeting up whether or not it holds an open interval). Not exotic
 *     either — the reconciler closes a dropped-`left` at the SWEEP'S `now`, so a clean 14:30
 *     abandonment recorded at 15:00 crossed the floor and stranded.
 *   · `!clientSideEverPresent`. A client who joined and left BEFORE the expert arrived (so the
 *     two were never simultaneously present and `markInProgress` never fired) left a
 *     `waiting_for_participants` meeting that rule 2 refused (a client HAD been present) and
 *     rule 4 refused for the same reason. Same permanent stranding, different route in.
 *
 * `outcome` stays NULL on this path (D5/D9): who owes what after a wait nobody completed is a
 * money question, and BAL-412 answers it from `meeting_presence`. Removing a guard therefore
 * widens WHICH meetings reach a terminal state — never what any of them is charged.
 */
function abandonedWaitApplies(input: TerminalRuleInput): boolean {
  if (!isPreInProgress(input.status)) {
    return false;
  }
  if (!input.presence.expertEverPresent) {
    return false;
  }
  return roomEmptyPastWindow(input);
}

/**
 * ⚠⚠ THE PRECEDENCE TABLE, AND WHY THE ORDER IS ALMOST DECORATION.
 *
 * ADR-1049 names ordering as a build risk. **The six rules are not merely ordered — they are
 * MUTUALLY EXCLUSIVE BY PRECONDITION**, which is a stronger property than an order:
 *
 *   · #1 vs everything — #1 is the ONLY rule that requires `in_progress`; #2/#3/#4/#5 all
 *     require a pre-`in_progress` status. *Disjoint by status.* This is exactly ADR-1049's "idle
 *     end is scoped to reached-`in_progress`-then-empty, never 'is empty'".
 *   · #3 vs #2 and #4 — #3 requires the expert NEVER joined; both others require they DID.
 *     *Disjoint by presence.*
 *   · #2 vs #4 — #2 requires an OPEN expert interval, #4 requires an EMPTY ROOM.
 *     *Disjoint by presence.*
 *   · #5 vs everything (BAL-581) — #5 by status, exactly like #3 (both require pre-`in_progress`
 *     and the expert NEVER joined); #5 vs #3 is disjoint by VENUE — #3 requires a READY venue,
 *     #5 requires its ABSENCE. #5 vs #2/#4 is disjoint by presence, same as #3.
 *
 *   · #6 vs everything — #6 requires `in_progress` like #1 but ALSO an OPEN interval, which #1
 *     forbids (*disjoint by presence*); #2–#5 all require a pre-`in_progress` status
 *     (*disjoint by status*).
 *
 * The fixed order below exists so the sweep stays DETERMINISTIC if a future change ever breaks
 * that disjointness, and `lifecycle.test.ts` asserts disjointness directly rather than trusting
 * this paragraph.
 *
 * ── ⚠⚠ TOTALITY, WHICH IS THE PROPERTY THAT ACTUALLY MATTERS ─────────────────────────────
 *
 * Disjointness stops two rules firing. **TOTALITY stops ZERO rules firing**, and that is the
 * failure mode with teeth: a non-terminal meeting nothing can ever terminate is never settled,
 * its credit hold is never released, no human remains to press End, and after 24h the sweep's
 * `listLifecycleCandidates` lookback floor takes it out of the in-window batch. The stranded arm
 * (BAL-584) picks EVERY past-floor non-terminal meeting up, pre-live ones included and whatever
 * their presence rows, so a meeting whose last interval the reconciler just closed stays selected
 * until a rule falls due. This invariant is what makes that set drain itself. The taxonomy
 * stranded exactly that way twice before this was written down (see
 * {@link abandonedWaitApplies}'s removed-guard block).
 *
 * **The invariant, stated so it can be executed rather than believed:** for every NON-TERMINAL
 * status, once the ROOM IS EMPTY and every window has elapsed, SOME rule fires.
 *
 *   · `in_progress` + empty ⇒ #1, always (its only other condition is the window).
 *   · `scheduled` / `waiting_for_participants` + empty ⇒ #3 when the expert never came and the
 *     room was ready, #5 when it never was, #4 when the expert came — exhaustive over
 *     `(expertEverPresent × venue ready)`.
 *
 * ⚠ AND WHAT IS LEFT, NAMED RATHER THAN LEFT AS A GAP: a room somebody is STILL IN matches
 * nothing but #2 until the ceiling. An occupied `in_progress` meeting is bounded by #6 at
 * {@link overrunStopCeiling}, whatever the webhooks and the reconciler are doing, so it can no
 * longer stay open forever. The residual is a PRE-`in_progress` room that is still OCCUPIED, for
 * example one the expert holds after a client left: it matches no rule. That is an ACCEPTED GAP
 * (BAL-584 decision 3), not an oversight: while somebody is in the room Daily's platform-wide map
 * lists it, so the stranded arm spends no per-room read on it. Once the room empties, whether
 * through a delivered leave webhook or the reconciler closing the interval, the meeting is still
 * selected and the rule that applies (rule 4 when the expert has been present) fires when due.
 * `lifecycle.test.ts` executes the invariant over a status × presence-shape matrix.
 *
 * ⚠ THE SEVENTH PATH — THE HUMAN END — IS NOT RESOLVABLE HERE AND MUST NOT BE ADDED. It has no
 * presence gate and no wall-clock gate; its only precondition is that a `canEndMeeting` holder
 * pressed a button, which is a fact about a REQUEST, not about a meeting. It lives in
 * `apps/api`'s end service, is CAS-guarded, and if it lands first the meeting is terminal and
 * every rule here returns `null` on the next tick.
 *
 * @returns the ONE rule that fired, or `null` when the meeting is not (yet) terminable.
 */
export function resolveTerminalRule(input: TerminalRuleInput): MeetingTerminalDecision | null {
  if (idleEndApplies(input)) {
    return { rule: 'idle_end', outcome: 'completed', arm: null, dueAt: emptyWindowDueAt(input) };
  }
  if (overrunStopApplies(input)) {
    return {
      rule: 'overrun_stop',
      outcome: 'completed',
      arm: 'hard_ceiling',
      dueAt: overrunStopDueAt(input),
    };
  }
  const noShowAt = noShowDueAt(input);
  if (noShowAt !== null && input.now.getTime() >= noShowAt.getTime()) {
    return { rule: 'no_show', outcome: 'no_show_client', arm: null, dueAt: noShowAt };
  }
  const missedCallAt = missedCallDueAt(input);
  if (missedCallAt !== null && input.now.getTime() >= missedCallAt.getTime()) {
    return { rule: 'missed_call', outcome: 'missed_call', arm: null, dueAt: missedCallAt };
  }
  const venueUnavailableAt = venueUnavailableDueAt(input);
  if (venueUnavailableAt !== null && input.now.getTime() >= venueUnavailableAt.getTime()) {
    return {
      rule: 'venue_unavailable',
      outcome: 'venue_unavailable',
      arm: null,
      dueAt: venueUnavailableAt,
    };
  }
  if (abandonedWaitApplies(input)) {
    // ⚠ NO OUTCOME (D5/D9). BAL-412 resolves it from the presence rows, exactly as for a human
    // end. `meeting_outcome_requires_ended` is one-directional, so `ended` with a NULL outcome
    // is legal and is precisely what this path writes.
    return { rule: 'abandoned_wait', outcome: null, arm: null, dueAt: emptyWindowDueAt(input) };
  }
  return null;
}

/**
 * ⚠ EVERY RULE, AS DATA — for the disjointness proof and for nothing else.
 *
 * `lifecycle.test.ts` evaluates all six predicates against one scenario and asserts AT MOST
 * ONE holds. Exporting the predicate list is what makes that a real proof rather than a
 * restatement of {@link resolveTerminalRule}'s if-chain.
 */
export const MEETING_TERMINAL_PREDICATES: ReadonlyArray<{
  readonly rule: MeetingTerminalRuleName;
  readonly applies: (input: TerminalRuleInput) => boolean;
}> = [
  { rule: 'idle_end', applies: idleEndApplies },
  { rule: 'no_show', applies: noShowApplies },
  { rule: 'missed_call', applies: missedCallApplies },
  { rule: 'venue_unavailable', applies: venueUnavailableApplies },
  { rule: 'abandoned_wait', applies: abandonedWaitApplies },
  { rule: 'overrun_stop', applies: overrunStopApplies },
];

// ── BACKDATING A LATE TERMINAL WRITE (BAL-584) ────────────────────────────────────────────

/**
 * The latest instant any presence interval records — the max over every finite `joinedAt` and
 * `leftAt`. `null` when there is none. Non-finite endpoints are skipped exactly as
 * {@link summarisePresence} skips them (an interval with either endpoint unusable is dropped
 * whole), so the two readers of the same rows agree on which rows exist.
 */
export function latestPresenceInstant(
  intervals: readonly LifecyclePresenceInterval[]
): Date | null {
  let latestMs: number | null = null;
  for (const interval of intervals) {
    const endpoints = finiteEndpoints(interval);
    if (endpoints === null) {
      continue;
    }
    latestMs = laterOf(latestMs, endpoints.joinedMs);
    if (endpoints.leftMs !== null) {
      latestMs = laterOf(latestMs, endpoints.leftMs);
    }
  }
  return latestMs === null ? null : new Date(latestMs);
}

/**
 * How far BEFORE a stored `joined_at` a recorded Daily leave may sit and still be taken as that
 * interval's own. The stored `joined_at` comes from the webhook and Daily's `join_time` from its
 * session history; the two clocks differ by seconds, so a leave inside this slack is the same
 * visit, while one earlier belongs to a previous visit by the same claim.
 */
export const STRANDED_LEAVE_SKEW_MS = 60_000;

/** What {@link strandedReconcileCloseAt} reads. */
export interface StrandedReconcileCloseInput {
  /** The stored interval's `joined_at`. */
  readonly joinedAt: Date;
  /** Daily's recorded leave for this interval's claim, or `null` when Daily has no entry. */
  readonly recordedLeaveAt: Date | null;
  readonly status: MeetingLifecycleStatus;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly timers: MeetingTimers;
  readonly now: Date;
}

/**
 * The instant the reconciler closes ONE open interval of a STRANDED meeting at.
 *
 * A dropped `participant.left` leaves an interval open for days, and closing it at the tick that
 * noticed would record all of those days as presence (and, on a pre-live meeting, settle a charge
 * for them). So the close lands where the participant actually left:
 *
 *  - Daily's recorded leave, when it is no earlier than {@link STRANDED_LEAVE_SKEW_MS} before
 *    `joinedAt` (an earlier one is a previous visit), capped at `now`;
 *  - otherwise, when Daily does not know, the booked end: `min(now, scheduledEnd)`.
 *
 * For an `in_progress` meeting the instant is also capped at {@link overrunStopCeiling}, so better
 * information never records more presence than the overrun-stop path would have.
 *
 * Never earlier than `joinedAt`; the presence writer's own clamps still apply on top.
 */
export function strandedReconcileCloseAt(input: StrandedReconcileCloseInput): Date {
  const { joinedAt, recordedLeaveAt, status, scheduledStart, scheduledEnd, timers, now } = input;
  const usable =
    recordedLeaveAt !== null &&
    recordedLeaveAt.getTime() >= joinedAt.getTime() - STRANDED_LEAVE_SKEW_MS;
  const chosenMs = usable
    ? Math.min(recordedLeaveAt.getTime(), now.getTime())
    : Math.min(scheduledEnd.getTime(), now.getTime());
  const cappedMs =
    status === 'in_progress'
      ? Math.min(chosenMs, overrunStopCeiling(scheduledStart, scheduledEnd, timers).getTime())
      : chosenMs;
  return new Date(Math.max(cappedMs, joinedAt.getTime()));
}

/** What {@link strandedEndedAt} reads. */
export interface StrandedEndedAtInput {
  /** The fired rule's {@link MeetingTerminalDecision.dueAt}. */
  readonly dueAt: Date;
  readonly now: Date;
  /** {@link latestPresenceInstant} over the meeting's live intervals. */
  readonly latestPresenceAt: Date | null;
  readonly startedAt: Date | null;
}

/**
 * The `ended_at` a STRANDED meeting's terminal write records: `min(now, max(dueAt,
 * latestPresenceAt, startedAt))`, the instant the rule became due rather than the tick that
 * noticed.
 *
 * ⚠ THE `max` FLOOR keeps `ended_at` from sitting before something the meeting already
 * recorded: someone rejoined after the due instant, a close was clamped up to its `joined_at`,
 * or `markInProgress` stamped `started_at` late. The `min(now, …)` cap is defensive — a due
 * instant is `<= now` whenever its rule fired.
 */
export function strandedEndedAt(input: StrandedEndedAtInput): Date {
  const floorMs = Math.max(
    input.dueAt.getTime(),
    input.latestPresenceAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    input.startedAt?.getTime() ?? Number.NEGATIVE_INFINITY
  );
  return new Date(Math.min(input.now.getTime(), floorMs));
}

// ── THE SERVER-COMPUTED WAITING PHASE (§7.1) ──────────────────────────────────────────────

/**
 * How far the wait has run — the LABEL the browser renders, computed HERE.
 *
 * ⚠⚠ THE CLIENT NEVER SEES A THRESHOLD. That is the acceptance criterion verbatim ("all timing
 * is server-authoritative; the client renders a mirror") and it structurally prevents the
 * server/browser drift an env override would otherwise create.
 *
 * ⚠ THE FOUR LABELS ARE `apps/web`'s `WaitingPhase`, RESTATED. `waiting-copy.ts` already ships
 * all four for both parties and is test-pinned; this is the producer that ticket was written
 * against. The two must stay identical — `apps/web` assigns this value straight into that
 * type, so a divergence is a compile error there.
 */
export type MeetingWaitingPhase = 'pre-start' | 'running' | 'near' | 'settled';

/** Everything {@link resolveWaitingPhase} reads. Same injected-clock discipline as above. */
export interface WaitingPhaseInput {
  readonly status: MeetingLifecycleStatus;
  readonly scheduledStart: Date;
  readonly presence: PresenceFacts;
  readonly timers: MeetingTimers;
  readonly now: Date;
  /** BAL-581 — same field, same semantics as {@link TerminalRuleInput.venueReadyAt}. */
  readonly venueReadyAt: Date | null;
}

/**
 * The waiting stage's phase, from the meeting's own state.
 *
 * The progression is ANCHORED ON WHOEVER IS MISSING, which is why it is a 2×4 matrix rather
 * than one timeline:
 *
 *   · THE EXPERT IS MISSING → anchor {@link venueAbsenceAnchor} (BAL-581), alert at
 *     `expertAbsentAlertMs` past it. This is the progression whose end is a MISSED CALL (or,
 *     while the venue is never ready, a VENUE UNAVAILABLE).
 *   · THE EXPERT IS PRESENT AND THE CLIENT IS MISSING → anchor the EXPERT-PRESENT CLOCK START,
 *     alert at `clientAbsentNudgeMs`. This is the progression whose end is a NO-SHOW.
 *
 * ⚠ `settled` COMES ONLY FROM A TERMINAL STATUS, never from "we passed the threshold". A
 * meeting sitting one tick past its termination threshold has NOT settled — the sweep has not
 * run — and telling a waiting client "nothing was charged" before that is true would be a
 * money claim made on a guess. `near` is the honest answer in that window.
 *
 * ⚠ `in_progress` IS `running`, not a waiting phase at all: both parties are in the room and
 * the waiting stage is not rendered. It is answered rather than thrown so the state route is
 * total.
 */
export function resolveWaitingPhase(input: WaitingPhaseInput): MeetingWaitingPhase {
  const { status, scheduledStart, presence, timers, now } = input;

  if (status === 'ended' || status === 'cancelled') {
    return 'settled';
  }
  if (status === 'in_progress') {
    return 'running';
  }
  if (now.getTime() < scheduledStart.getTime()) {
    // Before the start nothing is wrong yet — R3's reading of the shipped `pre-start` copy.
    return 'pre-start';
  }

  const clockStart = expertClockStart(scheduledStart, presence.expertFirstJoinedAt);
  if (presence.expertOpen && clockStart !== null) {
    // THE EXPERT IS HERE, THE CLIENT IS NOT — anchored on the expert-present clock start.
    return now.getTime() >= clockStart.getTime() + timers.clientAbsentNudgeMs ? 'near' : 'running';
  }
  // THE EXPERT IS MISSING — measured from the venue absence anchor (the instant the room
  // existed, never before the start), the SAME instant the ops alert fires from, so `near`'s
  // "we've flagged this to the Balo team" is true when it renders. `?? scheduledStart` is
  // defensive only: a member cannot be admitted to a room that is not ready.
  const anchor = venueAbsenceAnchor(scheduledStart, input.venueReadyAt) ?? scheduledStart;
  return now.getTime() >= anchor.getTime() + timers.expertAbsentAlertMs ? 'near' : 'running';
}
