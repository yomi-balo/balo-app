/**
 * BAL-134 (§7.1) — THE READ BEHIND `GET /meetings/:meetingId/state`. The one polled endpoint
 * the in-call mirror is fed from.
 *
 * ⚠⚠ `phase` IS **SERVER-COMPUTED** AND THE CLIENT NEVER SEES A THRESHOLD. That is the
 * acceptance criterion verbatim — "all timing is server-authoritative; the client renders a
 * mirror" — and it is also what structurally prevents drift: the timers carry env overrides
 * (D8), so a browser bundle computing its own phase from shipped defaults would disagree with
 * an overridden server, silently and only in the environment that was overridden.
 *
 * ⚠ IT CARRIES NO MONEY FIGURE, NO TOKEN, NO `roomUrl` AND NO `participantId`. The clocks are
 * DURATIONS — the measurement BAL-412 will later settle from — and nothing here is a credential
 * or a price. `MeetingClockSlot` renders elapsed time only; the BAL-403 precedent forbids a
 * live cost meter, and this payload could not feed one even if somebody tried.
 *
 * ⚠ MEMBER-ONLY, and that matches the shipped structural boundary rather than adding one: the
 * two GUEST surfaces mount no `MeetingRouteContextProvider`, so they already read `EMPTY` and
 * render neutral copy. No new guest surface is opened here.
 */
import {
  companiesRepository,
  meetingPresenceRepository,
  meetingsRepository,
  usersRepository,
  type MeetingEndedBy as DbMeetingEndedBy,
  type MeetingStatus as DbMeetingStatus,
} from '@balo/db';
import { billingBasisMs, caseClosedBeforeStart, caseClosureNames } from '@balo/shared/credit';
import { createLogger } from '@balo/shared/logging';
import {
  clampIntervalsToStart,
  coPresentMsBefore,
  computeMeetingClocks,
  expertPresentFromStartMs,
  meetingVenueReadyAt,
  resolveWaitingPhase,
  summarisePresence,
  type MeetingClocks,
  type MeetingEndedBy,
  type MeetingLifecycleStatus,
  type MeetingTimers,
  type MeetingViewerRole,
  type MeetingWaitingPhase,
} from '@balo/shared/meetings';
import { resolveCaseBillingSubject } from '../credit-session/case-billing-subject.js';
import { authorizeMeetingParticipation } from './authorize-meeting-participation.js';
import { deliveringExpertUserId } from './delivering-party.js';

const log = createLogger('meeting-state');

/**
 * ⚠⚠ THE DRIFT GUARDS FOR `@balo/shared/meetings`'s HAND-RESTATED ENUM LABELS.
 *
 * `MeetingLifecycleStatus` and `MeetingEndedBy` restate two pgEnums in a package that cannot
 * import one. These `AssertNever`s make a SIXTH `meeting_status` label — or a FOURTH
 * `meeting_ended_by` label — fail `pnpm typecheck` RIGHT HERE until it is given an entry in
 * `MEETING_TRANSITIONS` and a decision in the terminal rules. The `AssertMeetingContextLabelsMatch`
 * idiom from `authorize-meeting-participation.ts`, split per direction so neither branch forms a
 * `never | never` union (S6571).
 *
 * ⚠ IT IS ALSO WHAT LETS THIS MODULE ASSIGN `meetings.status` STRAIGHT ONTO
 * `MeetingLifecycleStatus` WITH NO CAST. A cast would silently paper over exactly the drift
 * these three lines exist to stop.
 */
type MissingStatusLabel = Exclude<DbMeetingStatus, MeetingLifecycleStatus>;
type StrayStatusLabel = Exclude<MeetingLifecycleStatus, DbMeetingStatus>;
type MissingEndedByLabel = Exclude<DbMeetingEndedBy, MeetingEndedBy>;
type StrayEndedByLabel = Exclude<MeetingEndedBy, DbMeetingEndedBy>;
type AssertNever<T extends never> = T;
export type AssertMeetingLifecycleLabelsMatch = [
  AssertNever<MissingStatusLabel>,
  AssertNever<StrayStatusLabel>,
  AssertNever<MissingEndedByLabel>,
  AssertNever<StrayEndedByLabel>,
];

export interface CaseClosureView {
  readonly closedByFirstName: string | null;
  readonly companyName: string | null;
}

/** ⚠ ONE DENIAL LITERAL. There is no `403` anywhere on `/meetings/*`. */
export type MeetingStateErrorCode = 'meeting_not_found';

export interface MeetingStateView {
  readonly status: MeetingLifecycleStatus;
  /** ⚠ `null` is a REAL value on the two human paths and the abandoned wait (D5). */
  readonly outcome: string | null;
  readonly endedBy: MeetingEndedBy | null;
  /** ⚠ THE GATE'S OWN VERDICT, never a lens and never request input. */
  readonly viewerRole: MeetingViewerRole;
  /** ⚠ SERVER-COMPUTED. See the module docblock. */
  readonly phase: MeetingWaitingPhase;
  /**
   * The two clocks over presence CLAMPED to the scheduled start (BAL-134's R10 rule, applied at read
   * time since BAL-474 Rule A stores presence at its true instants) — bit-for-bit what this route always
   * sent, so an older web build keeps showing today's values.
   */
  readonly clocks: MeetingClocks;
  /**
   * BAL-474 (Rule A, D13) — what the bill would be RIGHT NOW, pre-floor and pre-cap, plus whether it is
   * still growing. `soFarMs` is {@link billingBasisMs}: the time the expert and a client-side participant
   * were really TOGETHER before the start, plus BAL-412's from-start figure (a lone expert's own wait from
   * the start is what the amber "counted" chip shows). `running` is `expertOpen && (clientOpen || now >=
   * start)`: the chip ticks only while the room is producing time. Optional on the web parse, so either
   * deploy order is safe.
   */
  readonly billingClock: { readonly soFarMs: number; readonly running: boolean };
  /**
   * BAL-474 (R6-C3, owner-approved) — the case-closed-before-the-start read the expert's waiting and ended
   * screens render, or `null`. `null` is the overwhelmingly common answer.
   *
   * ⚠ IT IS COMPUTED ONLY WHEN ALL OF THESE HOLD, and never on a live `in_progress` poll: the viewer is the
   * DELIVERING expert; no client-side participant was ever present; the meeting is pre-`in_progress`, or
   * `ended` with outcome `no_show_client`. Then `resolveCaseBillingSubject(…, { requireActive: false })` →
   * `caseClosedBeforeStart` → the closer's FIRST name and the company's name (two primary-key reads). Both
   * names are individually nullable (an inactivity-sweep close has no human closer).
   */
  readonly caseClosure: CaseClosureView | null;
  /**
   * The instant the clocks were measured at.
   *
   * ⚠ LOAD-BEARING FOR THE BROWSER'S TICKER, not decoration: `MeetingClockSlot` interpolates
   * between polls and DRIFT-CORRECTS against this, which is what lets the mirror look live
   * without ever being an input to settlement.
   */
  readonly asOf: string;
  /**
   * The no-show floor in WHOLE MINUTES, taken from the **ENV-RESOLVED** timers (D8) — never from
   * `DEFAULT_MEETING_TIMERS`.
   *
   * ⚠⚠ IT EXISTS SO THE BROWSER STOPS HARD-CODING "15". `noShowFloorMs` is env-overridable
   * (`MEETING_NO_SHOW_FLOOR_MINUTES`), so a literal in the bundle drifts SILENTLY from an
   * overridden server — visible only in the environment that was overridden, which is the one
   * place nobody is looking. This is a MINUTE COUNT for a sentence, not a threshold: the browser
   * still never computes a phase from it (see the module docblock).
   *
   * ⚠ THE VALUE IS DERIVED FROM `timers`, WHICH IS INJECTED — this module still reads no
   * environment, and a test can therefore state an override directly.
   */
  readonly noShowFloorMinutes: number;
  /**
   * The server's presence observation, PROJECTED to the single fact the mirror may know.
   *
   * ⚠⚠ `expertOpen` IS "AN EXPERT INTERVAL IS OPEN **RIGHT NOW**", NOT "AN EXPERT EVER JOINED".
   * The browser's fallback — `expertFirstJoinedAt !== null` — is a fact about the PAST that never
   * becomes false again, so an expert whose interval CLOSED (network drop, killed tab, closed
   * laptop) kept a ticking amber "counted" chip on screen against an `expertPresentMs` the server
   * had already FROZEN. That over-states credited time on the exact surface this ticket exists to
   * make honest.
   *
   * ⚠ PROJECTED FIELD BY FIELD, NEVER SPREAD. `PresenceFacts` also carries `anyOpen`,
   * `clientOpen` and `expertFirstJoinedAt`; spreading it would silently widen the wire shape of a
   * payload a browser polls every ten seconds, and would couple the contract to an internal type
   * that exists to serve the phase rules.
   */
  readonly presence: { readonly expertOpen: boolean };
}

export type GetMeetingStateResult =
  | { readonly ok: true; readonly state: MeetingStateView }
  | { readonly ok: false; readonly code: MeetingStateErrorCode };

export interface GetMeetingStateInput {
  readonly meetingId: string;
  readonly userId: string;
  /** The ENV-RESOLVED timers (D8) — injected, so this module reads no environment. */
  readonly timers: MeetingTimers;
  readonly now?: Date;
}

const MS_PER_MINUTE = 60_000;

/** The statuses R6-C3 can be true in, before the cheap presence gate: pre-start, or the voided no-show end. */
function caseClosureCanApply(status: MeetingLifecycleStatus, outcome: string | null): boolean {
  if (status === 'ended') {
    return outcome === 'no_show_client';
  }
  return status === 'scheduled' || status === 'waiting_for_participants';
}

/**
 * BAL-474 (R6-C3) — see {@link MeetingStateView.caseClosure}. The gates are ordered cheapest-first and run
 * BEFORE any read, so a live `in_progress` poll (and every client viewer) costs nothing here. Never throws
 * into the poll: a failed read degrades to `null` (the expert then sees the ordinary waiting copy).
 */
async function readCaseClosure(input: {
  readonly meetingId: string;
  readonly userId: string;
  readonly viewerRole: MeetingViewerRole;
  readonly status: MeetingLifecycleStatus;
  readonly outcome: string | null;
  readonly clientSideEverPresent: boolean;
  readonly scheduledStart: Date;
}): Promise<CaseClosureView | null> {
  if (
    input.viewerRole !== 'expert' ||
    input.clientSideEverPresent ||
    !caseClosureCanApply(input.status, input.outcome)
  ) {
    return null;
  }
  try {
    const subject = await resolveCaseBillingSubject(input.meetingId, { requireActive: false });
    if (subject === undefined || !caseClosedBeforeStart(subject, input.scheduledStart)) {
      return null;
    }
    // The DELIVERING expert only: an agency admin who can act on the meeting is not who the sentence is for.
    if ((await deliveringExpertUserId(subject.expertProfileId)) !== input.userId) {
      return null;
    }
    const [closer, company] = await Promise.all([
      subject.closedByUserId === null
        ? undefined
        : usersRepository.findNamesByIds([subject.closedByUserId]),
      companiesRepository.findNameById(subject.companyId),
    ]);
    return caseClosureNames(closer?.[0], company);
  } catch (error) {
    log.warn(
      {
        meetingId: input.meetingId,
        userId: input.userId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Case-closure read failed — rendering the ordinary waiting copy'
    );
    return null;
  }
}

/**
 * Milliseconds → the WHOLE MINUTES the wire carries.
 *
 * ⚠⚠ FLOORED AT `1`, AND THAT GUARD IS LOAD-BEARING RATHER THAN DEFENSIVE DECORATION. The web
 * parser validates this field as `z.number().int().positive()`, and a failed field fails the
 * WHOLE `safeParse` — which degrades to `snapshot === null`, i.e. no phase, no chip, NO MIRROR AT
 * ALL for every participant in the call. A sub-30-second floor (`MEETING_NO_SHOW_FLOOR_MINUTES`
 * accepts any positive number, including `0.4`) would otherwise round to `0` and blank a live
 * call's status for everyone. Rounding — not truncating — so `90s` reads as the `2` a person
 * would say, and never as `1`.
 */
function toWholeMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / MS_PER_MINUTE));
}

/**
 * The meeting's live state for one authorized viewer.
 *
 * ⚠ THE CLOCK CEILING IS EXPLICIT. `meetingPresenceRepository.clocks` would resolve its own
 * ceiling (`ended_at` for a terminal meeting, the wall clock otherwise); passing `now` makes
 * the number and `asOf` agree BY CONSTRUCTION, so a browser interpolating from `asOf` can never
 * start ahead of the value it was given. For a TERMINAL meeting `ended_at` still wins, because
 * every open interval was closed inside `endMeeting`'s transaction — there is nothing left for
 * `now` to over-measure.
 */
export async function getMeetingState(input: GetMeetingStateInput): Promise<GetMeetingStateResult> {
  const { meetingId, userId, timers } = input;
  const now = input.now ?? new Date();

  const authorized = await authorizeMeetingParticipation({ meetingId, userId });
  if (!authorized.ok) {
    return { ok: false, code: 'meeting_not_found' };
  }

  // ⚠ RE-READ RATHER THAN REUSING `authorized.meeting`. The gate's row was fetched before the
  // presence read; on a polled endpoint that races the sweep, reporting a `waiting_for_
  // participants` status beside clocks taken after a termination would be a visibly
  // inconsistent frame. One read, immediately before the presence read, is the closest this can
  // get without a transaction it does not need.
  const meeting = (await meetingsRepository.findById(meetingId)) ?? authorized.meeting;
  const rows = await meetingPresenceRepository.listByMeeting(meetingId);
  const intervals = rows.map((row) => ({
    party: row.party,
    joinedAt: row.joinedAt,
    leftAt: row.leftAt,
  }));

  // ⚠ NO CAST — the drift guards above are what make this assignment safe.
  const status: MeetingLifecycleStatus = meeting.status;
  const presence = summarisePresence(intervals);
  const ceiling = status === 'ended' && meeting.endedAt !== null ? meeting.endedAt : now;
  // Rule A — presence is stored at its true instants: the clocks are over start-CLAMPED intervals, the
  // pre-start time together is over the RAW ones.
  const clocks = computeMeetingClocks(
    clampIntervalsToStart(intervals, meeting.scheduledStart),
    ceiling
  );
  const caseClosure = await readCaseClosure({
    meetingId,
    userId,
    viewerRole: authorized.side,
    status,
    outcome: meeting.outcome,
    clientSideEverPresent: presence.clientSideEverPresent,
    scheduledStart: meeting.scheduledStart,
  });
  // R6F-4a — the chip's together term drops the delivering expert's own invited guests, exactly as settlement's
  // does (one definition: `meetingPresenceRepository.omitExpertInvitedGuestRows`), so the chip and the bill agree.
  const togetherIntervals = await meetingPresenceRepository.omitExpertInvitedGuestRows(
    rows,
    async () =>
      (await resolveCaseBillingSubject(meetingId, { requireActive: false }))?.expertProfileId ??
      null
  );
  const clientOpen = intervals.some(
    (interval) => interval.party === 'client' && interval.leftAt === null
  );
  const billingClock = {
    soFarMs: billingBasisMs({
      expertPresentFromStartMs: expertPresentFromStartMs(
        intervals,
        meeting.scheduledStart,
        ceiling
      ),
      togetherBeforeStartMs: coPresentMsBefore(togetherIntervals, meeting.scheduledStart, ceiling),
    }),
    running:
      presence.expertOpen && (clientOpen || now.getTime() >= meeting.scheduledStart.getTime()),
  };

  return {
    ok: true,
    state: {
      status,
      outcome: meeting.outcome,
      endedBy: meeting.endedBy,
      viewerRole: authorized.side,
      phase: resolveWaitingPhase({
        status,
        scheduledStart: meeting.scheduledStart,
        presence,
        timers,
        now,
        // BAL-581 — the same anchor the terminal rules and the ops alert use, so `near`'s
        // "flagged to the Balo team" renders exactly when that alert fires.
        venueReadyAt: meetingVenueReadyAt(meeting),
      }),
      clocks,
      billingClock,
      caseClosure,
      asOf: now.toISOString(),
      // ⚠ FROM THE INJECTED (ENV-RESOLVED) TIMERS — never `DEFAULT_MEETING_TIMERS`, which is what
      // would re-introduce the drift D8 exists to prevent, just one layer further in.
      noShowFloorMinutes: toWholeMinutes(timers.noShowFloorMs),
      // ⚠ THE SAME `summarisePresence` RESULT THE PHASE WAS COMPUTED FROM, so the chip and the
      // sentence can never disagree about whether the expert is in the room.
      presence: { expertOpen: presence.expertOpen },
    },
  };
}
