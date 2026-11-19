import type { CallNowPresence } from '@balo/analytics/events';
import type {
  CallNowDisplayReason,
  CallRingPlacement,
  CallRingReach,
  CallRingStatus,
  CallSide,
} from '@balo/shared/meetings';

/** What the case's party card shows for Call now: the action, or the one quiet line that explains. */
export type CallNowEntry = 'button' | 'busy' | 'outside_hours';

/** The confirm dialog's facts. `client_terms` is the client lens, `expert_notice` the expert's. */
export type CallNowConfirmView =
  | {
      kind: 'client_terms';
      engagementId: string;
      expertProfileId: string;
      calleeOnline: boolean;
      /** `From A$x.xx/min · 15-minute minimum`, or `null` when the expert has no rate. */
      rateLine: string | null;
      inPlaceCandidate: { meetingId: string; scheduledStartIso: string } | null;
      /** The expert can be booked in the page, so "Book a time" has somewhere to go. */
      bookInPage: boolean;
    }
  | { kind: 'expert_notice'; engagementId: string };

/** Everything the case page needs to render the entry and its confirm. Never derived in web. */
export interface CaseCallNowView {
  entry: CallNowEntry;
  /** The other side's short name: the expert's first name, or the client company. */
  calleeLabel: string;
  /** The "Online" indicator, client lens only. */
  onlineBadge: boolean;
  /**
   * The api's `calleeOnline`, on both arms: the analytics `callee_presence`. On the expert arm the
   * api never reports real client presence, so this is `false` by construction.
   */
  calleeOnline: boolean;
  /** Set only for `outside_hours`, so the line can name the callee's local time. */
  calleeTimeZone: string | null;
  /** Non-null exactly when `entry === 'button'`. */
  confirm: CallNowConfirmView | null;
}

/** What the caller's call room knows about the ring it was sent to. */
export interface CallNowCallerView {
  ringId: string;
  engagementId: string;
  meetingId: string;
  calleeLabel: string;
  copyArm: CallSide;
  bookInPage: boolean;
  status: CallRingStatus;
  expiresAtIso: string;
  reachedBy: CallRingReach;
  /** The entry tap's attempt id, or `null` for a ring started before attempt ids were persisted. */
  attemptId: string | null;
  /** The callee's presence when the call started; always `offline` for an expert caller. */
  calleePresence: CallNowPresence;
}

/**
 * What the call room shows a callee who must answer: the caller's name and, for a client callee,
 * the rate line. `wait` is someone else at the company (a colleague, a viewer who lost the case, a
 * ring that is not theirs). `retry` is a read that FAILED, so the viewer may well be the real
 * callee: the room shows a neutral "Connecting…" and asks again rather than telling them the call
 * is for someone else.
 */
export type CallNowAnswerView =
  | { kind: 'answer'; callerName: string; rateLine: string | null }
  | { kind: 'wait' }
  | { kind: 'retry' };

/** The funding refusals a start or an answer can answer with, as the api names them. */
export type CallNowFundingCode = 'account_on_hold' | 'booking_unfunded' | 'booking_reserved';

/** The read view as the api sends it, parsed. */
export interface CallNowViewRead {
  canCallNow: boolean;
  reason: CallNowDisplayReason | null;
  calleeOnline: boolean;
  calleeTimeZone: string | null;
  inPlaceCandidate: { meetingId: string; scheduledStartIso: string } | null;
}

/** The ring read as the api sends it, parsed. */
export interface CallNowRingRead {
  ringId: string;
  meetingId: string;
  engagementId: string;
  status: CallRingStatus;
  placement: CallRingPlacement | null;
  expiresAt: string;
  role: 'caller' | 'callee' | null;
  awaitsAnswer: boolean;
  meetingEnded: boolean;
  reachedBy: CallRingReach;
  /** `null` for the callee, and for a ring started before attempt ids were persisted. */
  attemptId: string | null;
  /** `offline` when the api sent none (an older api) or the caller is an expert. */
  calleePresenceAtStart: CallNowPresence;
}

export interface CallNowStartRead {
  ringId: string;
  meetingId: string;
  placement: CallRingPlacement;
  expiresAt: string;
}

/** `GET /call-now/incoming` for a live ring, parsed. `callerSide` is the CALLER's side. */
export interface IncomingRingRead {
  ringId: string;
  meetingId: string;
  engagementId: string;
  callerSide: CallSide;
  placement: CallRingPlacement | null;
  reachedBy: CallRingReach;
  expiresAt: string;
  startedAt: string;
  awaitsAnswer: boolean;
}

/**
 * What the call toast needs to render a live ring for the signed-in callee. `lens` is the
 * CALLEE's side, and `rateLine` is non-null for a client callee only, so an expert is never sent a
 * money string.
 */
export interface IncomingCallView {
  ringId: string;
  meetingId: string;
  engagementId: string;
  lens: CallSide;
  callerLabel: string;
  caseTitle: string | null;
  rateLine: string | null;
  expiresAtIso: string;
  startedAtIso: string;
  awaitsAnswer: boolean;
  joinPath: string;
}
