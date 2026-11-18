'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { track, CALL_NOW_EVENTS } from '@/lib/analytics';
import type { BookingFundingRequest } from '@/lib/booking/actions/booking-funding-types';
import type { MemberJoinResponse } from '@/lib/meetings/join-api-client';
import { answerCallNowRingAction } from '@/app/(call)/meetings/[meetingId]/call/_actions/answer-call-now-ring';
import { CALL_NOW_COPY } from './call-now-copy';
import { callNowFundingRequest } from './call-now-funding';

/** BAL-651 — what the answer's funding gate needs, once the api has refused for credit. */
export interface AnswerFundingState {
  readonly ringId: string;
  readonly engagementId: string;
  readonly request: BookingFundingRequest;
}

/**
 * The join's `answer_required` answer names the ring and nothing else, so the answer notice and the
 * ended toast cannot name the person calling. The neutral label reads as a sentence start in both.
 */
export const ANSWER_CALLER_LABEL = 'Your expert';

export interface CallNowAnswerOptions {
  /** The commit opened the room: hand over the grant it returned. */
  readonly onOpened: (grant: MemberJoinResponse) => void;
  /** The api refused for credit: the funding step takes the room's place. */
  readonly onFunding: () => void;
  /** The join named a ring to answer: the Answer notice takes the room's place. */
  readonly onRequired: () => void;
  /** Anything else that leaves the room unopened and the person on the case-less notice. */
  readonly onUnavailable: () => void;
}

export interface CallNowAnswer {
  readonly answerRingId: string | null;
  /** The join answered `answer_required`; nothing is committed until the Answer click. */
  readonly offerAnswer: (ringId: string | undefined) => void;
  readonly answering: boolean;
  readonly answerFunding: AnswerFundingState | null;
  readonly commitAnswer: (ringId: string) => Promise<boolean>;
  readonly handleAnswer: () => void;
  readonly handleFundingBack: () => void;
  readonly handleFundingBook: () => void;
}

/**
 * BAL-651 — THE CLIENT'S COMMIT ON AN EXPERT-STARTED RING, and the one place it runs. The join
 * answered `409 call_answer_required {ringId}` and the client then pressed Answer on the call page —
 * that click, never the page load, is the commit. It opens the room with the grant the commit
 * returns. A refusal for credit opens the funding step in place of the room; a ring that is no
 * longer ringing says so and goes back to the case; anything else is the ordinary unavailable
 * card.
 */
export function useCallNowAnswer({
  onOpened,
  onFunding,
  onRequired,
  onUnavailable,
}: Readonly<CallNowAnswerOptions>): CallNowAnswer {
  const router = useRouter();
  /** The ring the client has been asked to answer; only the Answer click commits it. */
  const [answerRingId, setAnswerRingId] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);
  const [answerFunding, setAnswerFunding] = useState<AnswerFundingState | null>(null);
  /** A funding gate was opened and has not yet been reported resolved. */
  const gateOpenRef = useRef(false);

  /** Reports the funding gate's end once, however many exits race for it. */
  const resolveGate = useCallback((via: 'top_up' | 'abandoned'): void => {
    if (!gateOpenRef.current) return;
    gateOpenRef.current = false;
    track(CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, { via });
  }, []);

  /** Resolves `true` only when the room opened. */
  const commitAnswer = useCallback(
    async (ringId: string): Promise<boolean> => {
      const result = await answerCallNowRingAction({ ringId });
      if (result.ok) {
        resolveGate('top_up');
        setAnswerFunding(null);
        onOpened(result.grant);
        return true;
      }
      const { engagementId, expertProfileId } = result;
      if (
        result.code === 'funding' &&
        engagementId !== undefined &&
        expertProfileId !== undefined
      ) {
        gateOpenRef.current = true;
        setAnswerFunding({
          ringId,
          engagementId,
          request: callNowFundingRequest({ expertProfileId, engagementId, nowMs: Date.now() }),
        });
        onFunding();
        return false;
      }
      resolveGate('abandoned');
      if (result.code === 'ring_not_ringing' && engagementId !== undefined) {
        toast(CALL_NOW_COPY.answerEndedToast(ANSWER_CALLER_LABEL));
        router.push(`/cases/${engagementId}`);
        return false;
      }
      onUnavailable();
      return false;
    },
    [router, resolveGate, onOpened, onFunding, onUnavailable]
  );

  const offerAnswer = useCallback(
    (ringId: string | undefined): void => {
      if (ringId === undefined) {
        onUnavailable();
        return;
      }
      setAnswerRingId(ringId);
      onRequired();
    },
    [onRequired, onUnavailable]
  );

  const handleAnswer = useCallback((): void => {
    if (answerRingId === null) return;
    setAnswering(true);
    commitAnswer(answerRingId)
      .catch(onUnavailable)
      .finally(() => setAnswering(false));
  }, [answerRingId, commitAnswer, onUnavailable]);

  const handleFundingBack = useCallback((): void => {
    resolveGate('abandoned');
    if (answerFunding !== null) router.push(`/cases/${answerFunding.engagementId}`);
  }, [resolveGate, answerFunding, router]);

  const handleFundingBook = useCallback((): void => {
    resolveGate('abandoned');
    if (answerFunding !== null) router.push(`/cases/${answerFunding.engagementId}?book=1`);
  }, [resolveGate, answerFunding, router]);

  return {
    answerRingId,
    offerAnswer,
    answering,
    answerFunding,
    commitAnswer,
    handleAnswer,
    handleFundingBack,
    handleFundingBook,
  };
}
