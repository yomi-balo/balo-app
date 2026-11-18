'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { track, CALL_NOW_EVENTS } from '@/lib/analytics';
import type { WaitingCallingView } from '@/lib/meetings/waiting-copy';
import { CALL_NOW_COPY, START_FAILURE_COPY } from './call-now-copy';
import type { CallNowCallerView } from './call-now-types';
import { useCallNowRing } from './use-call-now-ring';

export interface CallNowCallerRoom {
  /** Set once the ring ended without a call: the room swaps the frame for the end card. */
  readonly endedOutcome: 'unanswered' | 'declined' | null;
  /** Present only while the ring is `ringing`; the waiting stage shows "Calling" from it. */
  readonly calling: WaitingCallingView | null;
}

function ignore(): void {}

/**
 * Everything the call room does for the person who placed a Call now: watch the ring, offer
 * "Stop calling", and leave for the case once the ring is stopped. `null` for an ordinary join, so
 * nothing polls, ticks or renders for anyone but the caller.
 *
 * ⚠ THE STATUS IS THE SERVER'S ANSWER. A stop that loses a race to a connect comes back
 * `connected` and nothing here moves: no toast, no abandon event, no navigation, and the frame
 * proceeds. Only a real `stopped` toasts, tracks the abandon and leaves for the case.
 */
export function useCallNowCallerRoom(callNowCaller: CallNowCallerView | null): CallNowCallerRoom {
  const router = useRouter();
  const { status, remainingSeconds, lost, stopping, stop } = useCallNowRing(
    callNowCaller === null
      ? null
      : {
          ringId: callNowCaller.ringId,
          status: callNowCaller.status,
          expiresAtIso: callNowCaller.expiresAtIso,
        }
  );

  const handleStop = useCallback((): void => {
    stop().then((result) => {
      if (!result.ok) {
        toast.error(START_FAILURE_COPY.failed);
        return;
      }
      if (result.status === 'stopped') {
        toast.success(CALL_NOW_COPY.stoppedToast);
        track(CALL_NOW_EVENTS.ATTEMPT_ABANDONED, { step: 'calling' });
      }
    }, ignore);
  }, [stop]);

  const stoppedEngagementId =
    status === 'stopped' && callNowCaller !== null ? callNowCaller.engagementId : null;
  useEffect(() => {
    if (stoppedEngagementId !== null) router.push(`/cases/${stoppedEngagementId}`);
  }, [stoppedEngagementId, router]);

  const lostEngagementId = lost && callNowCaller !== null ? callNowCaller.engagementId : null;
  useEffect(() => {
    if (lostEngagementId === null) return;
    toast.error(CALL_NOW_COPY.ringLostToast);
    router.push(`/cases/${lostEngagementId}`);
  }, [lostEngagementId, router]);

  const calling = useMemo<WaitingCallingView | null>(() => {
    if (callNowCaller === null || status !== 'ringing') return null;
    return {
      copyArm: callNowCaller.copyArm,
      calleeLabel: callNowCaller.calleeLabel,
      reachedBy: callNowCaller.reachedBy,
      remainingSeconds,
      onStop: handleStop,
      stopping,
    };
  }, [callNowCaller, status, remainingSeconds, handleStop, stopping]);

  const endedOutcome = status === 'unanswered' || status === 'declined' ? status : null;
  return { endedOutcome, calling };
}
