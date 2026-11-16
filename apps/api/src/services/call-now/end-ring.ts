/**
 * BAL-649 (ADR-1058) — ENDING A RING THAT DID NOT CONNECT: expiry, decline and stop.
 *
 * `meetingRingsRepository.endRing` is the whole write (the ring CAS, and for a `new_meeting` ring
 * the meeting's `no_answer` end, in one transaction). This service adds what must happen AFTER
 * that commit, each step best-effort:
 *   1. a meeting was ended → availability rebuild, Daily teardown, `meeting_ended`;
 *   2. an `in_place` ring → eject its caller and callee from the booked meeting's room (without a
 *      ban: both still have the booking there later), so their ring-time presence closes — unless
 *      the booking's own join window has opened, when they are legitimately in the room. The
 *      booked meeting itself is NEVER reconciled here: an unanswered ring leaves it exactly as it
 *      was, `scheduled`, cancellable and reschedulable;
 *   3. the ring's domain event; 4. `call_now_ring_ended` and the log line.
 *
 * ⚠⚠ NEVER `settleSessionlessCaseMeeting`, `enqueueRecordingStop` OR A CREDIT-HOLD RELEASE. An
 * unanswered call opens no session and records nothing, so there is no money to settle and
 * nothing to stop (AC1).
 *
 * ⚠ IDEMPOTENT. Every transition out of `ringing` is a compare-and-set, so a repeat, a decline
 * after connect, or an expiry after a stop all miss and answer `{ ended: false, status }` having
 * changed nothing and fired nothing.
 *
 * ⚠ IMPORT DIRECTION: `presence-writer` reaches ring ends only through `connect-ring`, never
 * through this module.
 */
import {
  meetingRingsRepository,
  meetingsRepository,
  type Meeting,
  type MeetingRing,
  type MeetingRingPlacement,
  type MeetingRingReach,
  type MeetingRingSide,
  type MeetingRingStatus,
} from '@balo/db';
import { withinJoinWindow } from '@balo/shared/engagements';
import { createLogger } from '@balo/shared/logging';
import {
  dailyParticipantIdFor,
  dailyRoomNameForMeeting,
  type CallRingPlacement,
  type CallRingReach,
  type CallRingStatus,
  type CallSide,
} from '@balo/shared/meetings';
import { dailyParticipantEjector } from '../daily/rooms.js';
import { publishCallEvent, trackRingEnded, type CallRingEvent } from './call-now-events.js';
import { runNoAnswerTail, type CallNowLogger } from './post-commit.js';

const moduleLog = createLogger('call-now-end-ring');

/**
 * ⚠ THE DRIFT WITNESSES for `@balo/shared/meetings`'s hand-restated ring vocabularies. Each pair
 * makes a label added to (or removed from) the pgEnum fail `pnpm --filter api typecheck` right
 * here until `call-now.ts` follows — split per direction so neither branch forms a
 * `never | never` union (S6571), the `authorize-meeting-participation.ts` idiom.
 */
type AssertNever<T extends never> = T;
export type AssertRingStatusMatches = [
  AssertNever<Exclude<MeetingRingStatus, CallRingStatus>>,
  AssertNever<Exclude<CallRingStatus, MeetingRingStatus>>,
];
export type AssertRingPlacementMatches = [
  AssertNever<Exclude<MeetingRingPlacement, CallRingPlacement>>,
  AssertNever<Exclude<CallRingPlacement, MeetingRingPlacement>>,
];
export type AssertRingReachMatches = [
  AssertNever<Exclude<MeetingRingReach, CallRingReach>>,
  AssertNever<Exclude<CallRingReach, MeetingRingReach>>,
];
export type AssertRingSideMatches = [
  AssertNever<Exclude<MeetingRingSide, CallSide>>,
  AssertNever<Exclude<CallSide, MeetingRingSide>>,
];

export type EndRingTarget = 'unanswered' | 'declined' | 'stopped';

export type EndRingOutcome =
  | { ended: true; status: EndRingTarget; ring: MeetingRing; endedMeeting: Meeting | null }
  | { ended: false; status: CallRingStatus | null };

export interface EndRingInput {
  ringId: string;
  to: EndRingTarget;
  /** The decliner or stopper; `null` on expiry and on a system end. */
  actorUserId: string | null;
  now: Date;
  /**
   * `false` suppresses the ring's domain event. Only the start path passes it, when it stops a
   * ring it never announced (room provisioning failed before `call.ringing`).
   */
  announce?: boolean;
  log?: CallNowLogger;
}

/** The event each ending announces. A stop announces to the callee (decision 11). */
const EVENT_FOR_END: Readonly<Record<EndRingTarget, CallRingEvent>> = {
  unanswered: 'call.no_answer',
  declined: 'call.declined',
  stopped: 'call.stopped',
};

/**
 * An `in_place` ring ended without connecting: take its caller and callee out of the booked
 * meeting's room so their ring-time presence closes and the booking reads as if nobody had rung.
 *
 * ⚠ `ban: false`. Both people have the booking in this same room later; a ban would lock them out
 * of it. ⚠ Best-effort: the ring end has committed, and a failed eject only leaves an interval
 * open until they leave on their own.
 *
 * ⚠ SKIPPED once the booking's own join window is open (`withinJoinWindow`, i.e. from
 * `scheduled_start − CASE_JOIN_WINDOW_MINUTES`): the two people are then legitimately in their own
 * consultation, and ejecting them would cut a call they are entitled to be on.
 */
async function ejectInPlaceParties(
  ring: MeetingRing,
  now: Date,
  log: CallNowLogger
): Promise<void> {
  try {
    const meeting = await meetingsRepository.findById(ring.meetingId);
    if (meeting === undefined || meeting.dailyRoomName === null) {
      return;
    }
    if (withinJoinWindow(now, meeting.scheduledStart)) {
      log.info(
        { ringId: ring.id, meetingId: ring.meetingId },
        'Call now in-place eject skipped — the booking’s own join window is open'
      );
      return;
    }
    const roomName = meeting.dailyRoomName;
    if (roomName !== dailyRoomNameForMeeting(ring.meetingId)) {
      log.warn(
        { ringId: ring.id, meetingId: ring.meetingId, roomName },
        'Stamped Daily room name disagrees with the derived one — not ejecting the ring parties'
      );
      return;
    }
    await dailyParticipantEjector.ejectParticipants(
      roomName,
      [
        dailyParticipantIdFor('user', ring.callerUserId),
        dailyParticipantIdFor('user', ring.calleeUserId),
      ],
      { ban: false }
    );
  } catch (error) {
    log.warn(
      {
        ringId: ring.id,
        meetingId: ring.meetingId,
        error: error instanceof Error ? error.message : String(error),
      },
      'Call now in-place eject failed — the ring parties stay in the room until they leave'
    );
  }
}

export async function endRing(input: EndRingInput): Promise<EndRingOutcome> {
  const { ringId, to, actorUserId, now } = input;
  const log = input.log ?? moduleLog;

  const result = await meetingRingsRepository.endRing({ ringId, to, now, actorUserId });
  if (result === undefined) {
    const current = await meetingRingsRepository.findById(ringId);
    return { ended: false, status: current?.status ?? null };
  }

  const { ring, endedMeeting, expertProfileId } = result;

  if (endedMeeting === null) {
    if (ring.placement === 'in_place') {
      await ejectInPlaceParties(ring, now, log);
    }
  } else {
    await runNoAnswerTail({ meeting: endedMeeting, expertProfileId, now }, log);
  }

  if (input.announce !== false) {
    await publishCallEvent(EVENT_FOR_END[to], ring);
  }
  trackRingEnded(ring);
  log.info(
    {
      ringId: ring.id,
      meetingId: ring.meetingId,
      engagementId: ring.engagementId,
      status: ring.status,
      placement: ring.placement,
      ringSeconds: Math.round((now.getTime() - ring.createdAt.getTime()) / 1000),
    },
    'Call now ring ended'
  );
  return { ended: true, status: to, ring, endedMeeting };
}

/**
 * The lifecycle sweep's `no_answer` decision for ONE meeting. Returns whether the meeting ended.
 *
 * A meeting that still has a `ringing` ring is ended THROUGH that ring (`endRing('unanswered')`,
 * which ends the meeting only once the ring has expired). A meeting whose ring already ended but
 * which never started is ended directly by the repository.
 */
export async function terminateNoAnswerMeeting(input: {
  meetingId: string;
  now: Date;
  log?: CallNowLogger;
}): Promise<boolean> {
  const { meetingId, now } = input;
  const log = input.log ?? moduleLog;

  const ringing = await meetingRingsRepository.findRingingForMeeting(meetingId);
  if (ringing !== undefined) {
    const outcome = await endRing({
      ringId: ringing.id,
      to: 'unanswered',
      actorUserId: null,
      now,
      log,
    });
    return outcome.ended && outcome.endedMeeting !== null;
  }

  const ended = await meetingRingsRepository.endNoAnswerMeeting({ meetingId, endedAt: now });
  if (ended === undefined) {
    return false;
  }
  await runNoAnswerTail(
    { meeting: ended.meeting, expertProfileId: ended.expertProfileId, now },
    log
  );
  log.info({ meetingId }, 'Call now meeting ended as no_answer by the lifecycle backstop');
  return true;
}
