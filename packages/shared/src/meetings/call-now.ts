/**
 * BAL-649 / ADR-1058 — CALL NOW'S PURE CORE.
 *
 * What lives here: the ring windows, the typed ring vocabulary, the facts the lifecycle reads
 * about a ring, the gate chain that decides whether Call now is offered, and the small calendar
 * helpers the in-place path needs.
 *
 * ⚠ THIS MODULE READS NO CLOCK, NO ENV AND NO DATABASE — `now` is injected, exactly like
 * `lifecycle.ts` and `timers.ts`, because `@balo/shared/meetings` is client-reachable. The
 * env-overridable form of the two ring windows lives in `apps/api/src/config/call-now-timers.ts`.
 */

import type { LifecyclePresenceInterval } from './lifecycle';

/** How long a ring rings when the callee is reached in the app. */
export const CALL_NOW_RING_MS = 45_000;

/** How long a ring rings when the callee was also reached by SMS. Wired by BAL-652. */
export const CALL_NOW_RING_SMS_MS = 120_000;

/** The created meeting's window: the 15-minute floor, the design's "estimate at the floor". */
export { MIN_MEETING_MINUTES as CALL_NOW_SCHEDULED_MINUTES } from './bounds';

/**
 * The expert's local hours during which a client may ring an offline expert: `[startHour,
 * endHour)`, 8 am to 8 pm.
 */
export const CALL_HOURS = { startHour: 8, endHour: 20 } as const;

/** After a callee declines a caller, that caller may not ring that callee again for this long. */
export const CALL_NOW_DECLINE_COOLDOWN_MS = 2 * 60_000;

/**
 * The four `meeting_rings` enum families, restated in a package that cannot import a pgEnum.
 *
 * ⚠ HAND-RESTATED LISTS, with the same obligation as `MeetingLifecycleStatus`: `apps/api`
 * plants an `AssertNever` drift witness against each real pgEnum, so a label added to the
 * database fails `pnpm typecheck` until it is added here.
 */
export type CallRingStatus = 'ringing' | 'connected' | 'unanswered' | 'declined' | 'stopped';
export type CallRingPlacement = 'new_meeting' | 'in_place';
export type CallRingReach = 'app' | 'sms';
export type CallSide = 'client' | 'expert';

/** A ring status that is final: every status except `ringing`. */
export type CallRingTerminalStatus = Exclude<CallRingStatus, 'ringing'>;

/** One `meeting_rings` row reduced to what the lifecycle rules need. */
export interface CallRingFacts {
  readonly placement: CallRingPlacement;
  readonly status: CallRingStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** `null` while the ring has not reached a terminal status. */
  readonly endedAt: Date | null;
}

/**
 * What the lifecycle knows about a meeting's Call now history.
 *
 * `origin` is derived, never stored on `meetings`: a meeting is `call_now` exactly when one of
 * its rings created it (`placement = 'new_meeting'`). `ring` is the latest ring by `createdAt`.
 */
export interface CallNowFacts {
  readonly origin: 'booked' | 'call_now';
  readonly ring: CallRingFacts | null;
}

/** The facts of a meeting that no ring ever touched. */
export const NO_CALL_NOW_FACTS: CallNowFacts = { origin: 'booked', ring: null };

/** Derive {@link CallNowFacts} from every ring row of one meeting, in any order. */
export function callNowFactsFromRings(rings: readonly CallRingFacts[]): CallNowFacts {
  let latest: CallRingFacts | null = null;
  let createdMeeting = false;
  for (const ring of rings) {
    if (ring.placement === 'new_meeting') {
      createdMeeting = true;
    }
    if (latest === null || ring.createdAt.getTime() > latest.createdAt.getTime()) {
      latest = ring;
    }
  }
  return { origin: createdMeeting ? 'call_now' : 'booked', ring: latest };
}

/** `true` while the ring is still ringing AND its window has not elapsed. */
export function isRingLive(ring: CallRingFacts, now: Date): boolean {
  return ring.status === 'ringing' && now.getTime() < ring.expiresAt.getTime();
}

/** The statuses whose ring ended without the callee connecting. */
const UNCONNECTED_TERMINAL: ReadonlySet<CallRingStatus> = new Set([
  'unanswered',
  'declined',
  'stopped',
]);

/**
 * How long a Daily token minted ONLY because of a live Call now ring outlives that ring's
 * `expires_at`, and so how long after a failed ring ends its parties can still connect with it.
 * {@link clipUnansweredRingIntervals} widens each ring's attempt window by the same amount.
 */
export const RING_TOKEN_GRACE_MS = 60_000;

/**
 * Clip the presence a failed in-place ring left behind to the booking's join window, so neither
 * the lifecycle nor settlement counts ring-time presence as attendance at the booking.
 *
 * An interval, open or closed, that JOINED inside an `in_place` ring's attempt window
 * (`[createdAt, max(endedAt, expiresAt) + RING_TOKEN_GRACE_MS]`, for a ring that ended
 * `unanswered`, `declined` or `stopped`; a token minted during the ring stays valid until
 * `expiresAt + RING_TOKEN_GRACE_MS` even when the ring was declined or stopped early) has its `joinedAt` raised to `windowOpensAt`, the instant the booking's join window
 * opens (`joinWindowOpensAt(scheduledStart)`). One that left at or before `windowOpensAt` is
 * dropped. A join that is already at or after `windowOpensAt` is never lowered, and an interval that
 * joined outside every attempt window is returned untouched.
 */
export function clipUnansweredRingIntervals<T extends LifecyclePresenceInterval>(
  intervals: readonly T[],
  rings: readonly CallRingFacts[],
  windowOpensAt: Date
): T[] {
  const attempts = rings.flatMap((ring) =>
    ring.placement === 'in_place' && ring.endedAt !== null && UNCONNECTED_TERMINAL.has(ring.status)
      ? [
          {
            fromMs: ring.createdAt.getTime(),
            toMs: Math.max(ring.endedAt.getTime(), ring.expiresAt.getTime()) + RING_TOKEN_GRACE_MS,
          },
        ]
      : []
  );
  if (attempts.length === 0) {
    return [...intervals];
  }
  const opensMs = windowOpensAt.getTime();
  const clipped: T[] = [];
  for (const interval of intervals) {
    const joinedMs = interval.joinedAt.getTime();
    const joinedDuringAttempt = attempts.some(
      (attempt) => joinedMs >= attempt.fromMs && joinedMs <= attempt.toMs
    );
    if (!joinedDuringAttempt || joinedMs >= opensMs) {
      clipped.push(interval);
    } else if (interval.leftAt === null || interval.leftAt.getTime() > opensMs) {
      clipped.push({ ...interval, joinedAt: windowOpensAt });
    }
  }
  return clipped;
}

/** One zone's calendar fields at an instant, or `null` for an unusable zone or instant. */
function localParts(
  at: Date,
  timeZone: string
): {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: number;
} | null {
  if (!Number.isFinite(at.getTime())) {
    return null;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const pick = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? '';
    const hour = Number.parseInt(pick('hour'), 10);
    if (Number.isNaN(hour)) {
      return null;
    }
    return { year: pick('year'), month: pick('month'), day: pick('day'), hour };
  } catch {
    return null;
  }
}

/**
 * Is `now` inside {@link CALL_HOURS} in `timeZone`?
 *
 * ⚠ FAILS CLOSED: an unusable zone answers `false`, so a callee whose zone cannot be read is
 * never rung out of hours by mistake.
 */
export function isWithinCallHours(now: Date, timeZone: string): boolean {
  const local = localParts(now, timeZone);
  if (local === null) {
    return false;
  }
  return local.hour >= CALL_HOURS.startHour && local.hour < CALL_HOURS.endHour;
}

/** Do `a` and `b` fall on the same calendar day in `timeZone`? `false` for an unusable zone. */
export function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const left = localParts(a, timeZone);
  const right = localParts(b, timeZone);
  if (left === null || right === null) {
    return false;
  }
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

/** A meeting an in-place ring could ride. */
export interface InPlaceMeetingCandidate {
  readonly id: string;
  readonly status: string;
  readonly scheduledStart: Date;
}

/**
 * The case's earliest `scheduled` meeting that starts after `now` on the same local day as
 * `now` in `timeZone`, or `null`.
 */
export function selectInPlaceCandidate(
  meetings: readonly InPlaceMeetingCandidate[],
  now: Date,
  timeZone: string
): { readonly meetingId: string; readonly scheduledStart: Date } | null {
  let best: InPlaceMeetingCandidate | null = null;
  for (const meeting of meetings) {
    if (
      meeting.status !== 'scheduled' ||
      meeting.scheduledStart.getTime() <= now.getTime() ||
      !isSameLocalDay(meeting.scheduledStart, now, timeZone)
    ) {
      continue;
    }
    if (best === null || meeting.scheduledStart.getTime() < best.scheduledStart.getTime()) {
      best = meeting;
    }
  }
  return best === null ? null : { meetingId: best.id, scheduledStart: best.scheduledStart };
}

/** Every fact the availability gate chain reads. Resolved by the caller, never here. */
export interface CallNowGateFacts {
  readonly callerSide: CallSide;
  readonly caseOpen: boolean;
  /** `expert_profiles.available_for_work`. Read only for client callers. */
  readonly expertAvailableForWork: boolean;
  /** Whether a callee exists who is a different person from the caller. */
  readonly calleeResolved: boolean;
  /** The callee declined a ring from this caller within {@link CALL_NOW_DECLINE_COOLDOWN_MS}. */
  readonly calleeRecentlyDeclinedCaller: boolean;
  readonly calleeInLiveMeeting: boolean;
  /** A ring is live on this case, for either side. */
  readonly ringLiveOnCase: boolean;
  /**
   * A meeting on this case (other than a ringing ring's own) is live, or is `scheduled` and its
   * join window has opened. Its own Join is the way in, so Call now is not offered beside it.
   */
  readonly bookingStartingOnCase: boolean;
  /** Another live session is open for the client company. */
  readonly companyHasOtherLiveSession: boolean;
  readonly calleeOnline: boolean;
  /** The expert's own local hour is inside {@link CALL_HOURS}. */
  readonly expertWithinCallHours: boolean;
}

/** Why Call now is refused. The union order is the gate order. */
export type CallNowRefusal =
  | 'case_closed'
  | 'expert_paused'
  | 'callee_unavailable'
  | 'recently_declined'
  | 'ring_in_progress'
  | 'booking_starting'
  | 'company_in_call'
  | 'callee_busy'
  | 'outside_hours';

/** The two refusals the UI explains; every other refusal hides the action. */
export type CallNowDisplayReason = 'busy' | 'outside_hours';

export type CallNowAvailability =
  | { readonly canCallNow: true }
  | {
      readonly canCallNow: false;
      readonly refusal: CallNowRefusal;
      readonly reason: CallNowDisplayReason | null;
    };

function refused(
  refusal: CallNowRefusal,
  reason: CallNowDisplayReason | null
): CallNowAvailability {
  return { canCallNow: false, refusal, reason };
}

/**
 * Walk the gates in order; the first failing gate wins. The same function backs the read view and
 * the enforcement on `POST`, so the two cannot disagree.
 */
export function resolveCallNowAvailability(facts: CallNowGateFacts): CallNowAvailability {
  const callerIsClient = facts.callerSide === 'client';
  if (!facts.caseOpen) return refused('case_closed', null);
  if (callerIsClient && !facts.expertAvailableForWork) return refused('expert_paused', null);
  if (!facts.calleeResolved) return refused('callee_unavailable', null);
  if (facts.calleeRecentlyDeclinedCaller) return refused('recently_declined', null);
  if (facts.ringLiveOnCase) return refused('ring_in_progress', null);
  if (facts.bookingStartingOnCase) return refused('booking_starting', null);
  if (facts.companyHasOtherLiveSession) return refused('company_in_call', null);
  if (facts.calleeInLiveMeeting) return refused('callee_busy', 'busy');
  if (callerIsClient && !facts.calleeOnline && !facts.expertWithinCallHours) {
    return refused('outside_hours', 'outside_hours');
  }
  return { canCallNow: true };
}

/** The outcome a finished ring reports to analytics. An unanswered ring is a `no_answer`. */
export type CallRingAnalyticsOutcome = 'connected' | 'no_answer' | 'declined' | 'stopped';

export function ringAnalyticsOutcome(status: CallRingTerminalStatus): CallRingAnalyticsOutcome {
  return status === 'unanswered' ? 'no_answer' : status;
}
