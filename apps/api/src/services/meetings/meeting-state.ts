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
  meetingPresenceRepository,
  meetingsRepository,
  type MeetingEndedBy as DbMeetingEndedBy,
  type MeetingStatus as DbMeetingStatus,
} from '@balo/db';
import {
  computeMeetingClocks,
  resolveWaitingPhase,
  summarisePresence,
  type MeetingClocks,
  type MeetingEndedBy,
  type MeetingLifecycleStatus,
  type MeetingTimers,
  type MeetingViewerRole,
  type MeetingWaitingPhase,
} from '@balo/shared/meetings';
import { authorizeMeetingParticipation } from './authorize-meeting-participation.js';

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
  readonly clocks: MeetingClocks;
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
      }),
      clocks: computeMeetingClocks(intervals, ceiling),
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
