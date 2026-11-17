import type { CallRingStatus } from '@balo/shared/meetings';
import { memberCallPath } from '@/lib/meetings/member-call-path';

export interface RingLandingFacts {
  readonly status: CallRingStatus;
  readonly meetingId: string;
  readonly engagementId: string;
  readonly expiresAt: string;
}

/**
 * Where the SMS link `/call-now/{ringId}` lands: the call room while the ring is live or already
 * connected, the case once it is over. A `ringing` row whose `expiresAt` has passed is over even
 * if the expiry sweep has not flipped its status yet.
 */
export function ringLandingPath(ring: RingLandingFacts, now: Date): string {
  if (ring.status === 'connected') return memberCallPath(ring.meetingId);
  if (ring.status === 'ringing' && new Date(ring.expiresAt).getTime() > now.getTime()) {
    return memberCallPath(ring.meetingId);
  }
  return `/cases/${ring.engagementId}`;
}
