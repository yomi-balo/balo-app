import 'server-only';

import { log } from '@/lib/logging';
import { getCallNowRing } from './call-now-api-client';

/**
 * The meeting a callee's answer must not count against itself (BAL-651), resolved server-side from
 * the ring the viewer names: the funding pre-flight takes a ring id, never a meeting id from the
 * browser.
 *
 * It is the ring's own meeting only when the viewer is that ring's callee, the ring still awaits
 * their answer and it belongs to the case being checked. The ring read is party-scoped by the api,
 * and every other arm — an unreadable ring, a caller, a ring that no longer awaits an answer, a
 * ring on another case — excludes nothing (fail closed), so a forged or stale ring id can only make
 * the pre-flight stricter.
 */
export async function resolveRingMeetingToExclude(input: {
  userId: string;
  ringId: string;
  engagementId: string;
}): Promise<string | undefined> {
  const { userId, ringId, engagementId } = input;
  const ring = await getCallNowRing(ringId);
  if (!ring.ok) {
    log.warn('Booking funding pre-flight ignored an unreadable ring', { userId, ringId });
    return undefined;
  }
  const { role, awaitsAnswer, engagementId: ringEngagementId, meetingId } = ring.data;
  if (role !== 'callee' || !awaitsAnswer || ringEngagementId !== engagementId) {
    log.warn('Booking funding pre-flight ignored a ring that is not this viewer’s to answer', {
      userId,
      ringId,
    });
    return undefined;
  }
  return meetingId;
}
