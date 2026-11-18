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
      /** `A$x.xx/min · 15-minute minimum`, or `null` when the expert has no rate. */
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
}

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
}

export interface CallNowStartRead {
  ringId: string;
  meetingId: string;
  placement: CallRingPlacement;
  expiresAt: string;
}
