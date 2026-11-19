import 'server-only';

import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';
import { errorMessage, log } from '@/lib/logging';
import { getCallNowRing } from './call-now-api-client';
import { readCallNowRateLine } from './call-now-rate-line';
import { readExpertFirstName } from './load-call-now-caller-view';
import type { CallNowAnswerView } from './call-now-types';

const WAIT: CallNowAnswerView = { kind: 'wait' };
const RETRY: CallNowAnswerView = { kind: 'retry' };

/**
 * What the call room shows when the join answers `answer_required`. `answer` ONLY when the ring read
 * names this viewer as the ring's callee, the ring is this room's own meeting and it still awaits
 * their answer.
 *
 * ⚠ `wait` MEANS "THIS CALL IS FOR SOMEONE ELSE" and is never a dead end. The ring read is
 * party-scoped by the api, so a colleague of the person being called gets a `404`, and so does a
 * viewer who lost the case; a ring that is not the viewer's to answer, or not this room's meeting,
 * is `wait` too.
 *
 * ⚠ `retry` IS A FAILED READ, NOT A VERDICT. A non-404 ring read, a case-access read or a name read
 * that throws says nothing about who the viewer is, so telling a real callee "this is for someone
 * else" would be a lie. The room shows a neutral "Connecting…" and re-attempts the join, which
 * asks again. Only non-404 failures are logged.
 *
 * The caller's name and the rate are read here, server-side, for the callee: the join's
 * `answer_required` answer names the ring and nothing else.
 */
export async function loadCallNowAnswerView(input: {
  ringId: string;
  meetingId: string;
  userId: string;
}): Promise<CallNowAnswerView> {
  const { ringId, meetingId, userId } = input;
  try {
    const ringResult = await getCallNowRing(ringId);
    if (!ringResult.ok) {
      if (ringResult.status !== 404) {
        log.warn('Call room could not read the ring to answer', {
          ringId,
          status: ringResult.status,
        });
        return RETRY;
      }
      return WAIT;
    }
    const ring = ringResult.data;
    if (ring.role !== 'callee' || !ring.awaitsAnswer || ring.meetingId !== meetingId) return WAIT;

    const access = await resolveCaseAccess(ring.engagementId, userId);
    if (access === null) return WAIT;

    const [callerName, rateLine] = await Promise.all([
      readExpertFirstName(access.expertProfileId),
      readCallNowRateLine(access.expertProfileId),
    ]);
    return { kind: 'answer', callerName, rateLine };
  } catch (error) {
    log.warn('Call room could not load its answer view', {
      ringId,
      error: errorMessage(error),
    });
    return RETRY;
  }
}
