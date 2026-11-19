import type { CallRingStatus } from '@balo/shared/meetings';
import { memberCallPath } from '@/lib/meetings/member-call-path';

export interface RingLandingFacts {
  readonly status: CallRingStatus;
  readonly meetingId: string;
  readonly engagementId: string;
  readonly expiresAt: string;
  /** The viewer is a client callee who must answer an expert-started ring before joining. */
  readonly awaitsAnswer: boolean;
  /** The ring's meeting has ended or been cancelled. Only ever true for a connected ring. */
  readonly meetingEnded: boolean;
}

/**
 * Where the SMS link `/call-now/{ringId}` lands: the call room while the ring is live or already
 * connected, the case once it is over. A `ringing` row whose `expiresAt` has passed is over even
 * if the expiry sweep has not flipped its status yet. A client callee on an expert-started ring
 * lands on the case, where the answer toast commits them; the call room would hold their join. A
 * connected ring whose meeting has since ended lands on the case too.
 */
export function ringLandingPath(ring: RingLandingFacts, now: Date): string {
  const casePath = `/cases/${ring.engagementId}`;
  if (ring.awaitsAnswer) return casePath;
  if (ring.status === 'connected') {
    return ring.meetingEnded ? casePath : memberCallPath(ring.meetingId);
  }
  if (ring.status === 'ringing' && new Date(ring.expiresAt).getTime() > now.getTime()) {
    return memberCallPath(ring.meetingId);
  }
  return casePath;
}

/**
 * Where a caller lands after starting a call: the call room, carrying the ring so the room can
 * show "Calling" and the no-answer end states. `ringId` is a server-minted uuid, so it needs no
 * encoding. The room re-verifies it party-scoped against the api; the query is a hint, not a grant.
 */
export function callNowCallerPath(meetingId: string, ringId: string): string {
  return `${memberCallPath(meetingId)}?ring=${ringId}`;
}
