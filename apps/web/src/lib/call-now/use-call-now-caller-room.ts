'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { CallNowSurface } from '@balo/analytics/events';
import type { CallSide } from '@balo/shared/meetings';
import { track, CALL_NOW_EVENTS } from '@/lib/analytics';
import type { WaitingCallingView } from '@/lib/meetings/waiting-copy';
import { CALL_NOW_COPY, START_FAILURE_COPY } from './call-now-copy';
import type { CallNowCallerView } from './call-now-types';
import { useCallNowRing } from './use-call-now-ring';
import { useCallNowSurface } from './use-call-now-surface';

export interface CallNowCallerRoom {
  /** Set once the ring ended without a call: the room swaps the frame for the end card. */
  readonly endedOutcome: 'unanswered' | 'declined' | null;
  /** Present only while the ring is `ringing`; the waiting stage shows "Calling" from it. */
  readonly calling: WaitingCallingView | null;
}

function ignore(): void {}

/**
 * The end card's "Book a time", reported as the funnel's book-instead step. `no_answer` covers every
 * ended ring that did not connect, declined included. It lives here, beside the room's other
 * funnel event, so the call-surface components carry no side-named analytics property.
 */
export function trackCallNowBookInstead(input: {
  attemptId: string | null;
  callerSide: CallSide;
  surface: CallNowSurface;
}): void {
  const { attemptId, callerSide, surface } = input;
  if (attemptId === null) return;
  track(CALL_NOW_EVENTS.BOOK_INSTEAD_CLICKED, {
    attempt_id: attemptId,
    lens: callerSide,
    from: 'no_answer',
    surface,
  });
}

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
  const surface = useCallNowSurface();
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
        // A ring started before attempt ids were persisted has no attempt to close out.
        if (callNowCaller !== null && callNowCaller.attemptId !== null) {
          track(CALL_NOW_EVENTS.ABANDONED, {
            attempt_id: callNowCaller.attemptId,
            lens: callNowCaller.copyArm,
            callee_presence: callNowCaller.calleePresence,
            step: 'calling',
            via: 'stop_calling',
            surface,
          });
        }
      }
    }, ignore);
  }, [stop, callNowCaller, surface]);

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
