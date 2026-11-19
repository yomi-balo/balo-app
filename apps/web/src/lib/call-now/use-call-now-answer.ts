'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { track, CALL_NOW_EVENTS } from '@/lib/analytics';
import type { BookingFundingRequest } from '@/lib/booking/actions/booking-funding-types';
import type { MemberJoinResponse } from '@/lib/meetings/join-api-client';
import { answerCallNowRingAction } from '@/app/(call)/meetings/[meetingId]/call/_actions/answer-call-now-ring';
import { readCallNowAnswerViewAction } from '@/app/(call)/meetings/[meetingId]/call/_actions/read-call-now-answer-view';
import { CALL_NOW_COPY, START_FAILURE_COPY } from './call-now-copy';
import { takeAnswerIntent } from './answer-intent';
import { callNowFundingRequest } from './call-now-funding';
import type { CallNowFundingCode } from './call-now-types';

/** BAL-651 — what the answer's funding gate needs, once the api has refused for credit. */
export interface AnswerFundingState {
  readonly ringId: string;
  readonly engagementId: string;
  readonly request: BookingFundingRequest;
  /** The api's refusal: the ONE source of the gate-shown event's `reason`. */
  readonly fundingCode: CallNowFundingCode;
}

/** Who is calling, and at what rate: loaded server-side for the callee before Answer is shown. */
export interface AnswerNoticeFacts {
  readonly callerName: string;
  readonly rateLine: string | null;
}

/** Names the caller in the ended toast if the commit somehow runs before the notice was loaded. */
const FALLBACK_CALLER_NAME = 'The caller';

export interface CallNowAnswerOptions {
  /** The room's own meeting: the server only offers Answer for a ring that belongs to it. */
  readonly meetingId: string;
  /** The commit opened the room: hand over the grant it returned. */
  readonly onOpened: (grant: MemberJoinResponse) => void;
  /** The api refused for credit: the funding step takes the room's place. */
  readonly onFunding: () => void;
  /** The viewer is the ring's callee: the Answer notice takes the room's place. */
  readonly onRequired: () => void;
  /** The viewer is anyone else (a colleague): wait in the room until the call connects. */
  readonly onAwaitConnect: () => void;
  /**
   * The read that says who the viewer is FAILED: a neutral "Connecting…" while the join is
   * re-attempted, so a real callee recovers to Answer and is never told the call is someone else's.
   */
  readonly onConnecting: () => void;
  /** Anything else that leaves the room unopened and the person on the case-less notice. */
  readonly onUnavailable: () => void;
}

export interface CallNowAnswer {
  readonly answerRingId: string | null;
  /** The caller's name and the rate for the Answer notice; `null` until the callee is confirmed. */
  readonly answerNotice: AnswerNoticeFacts | null;
  /**
   * The join answered `answer_required`. Asks the server who the viewer is to this ring: nothing is
   * committed until the Answer click, and only the ring's callee is ever offered it.
   */
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
 * answered `409 call_answer_required {ringId}`; the room asks the server who the viewer is to that
 * ring. The ring's own callee then presses Answer on the call page — that click, never the page
 * load, is the commit — and it opens the room with the grant the commit returns. Anyone else (a
 * colleague) is told to wait, and is never shown Answer.
 *
 * A refusal for credit opens the funding step in place of the room; a ring that is no longer
 * ringing says so and goes back to the case; a transient failure toasts and keeps the notice for a
 * retry, without reporting the funding gate as abandoned; anything else is the ordinary
 * unavailable card.
 */
export function useCallNowAnswer({
  meetingId,
  onOpened,
  onFunding,
  onRequired,
  onAwaitConnect,
  onConnecting,
  onUnavailable,
}: Readonly<CallNowAnswerOptions>): CallNowAnswer {
  const router = useRouter();
  /** The ring the client has been asked to answer; only the Answer click commits it. */
  const [answerRingId, setAnswerRingId] = useState<string | null>(null);
  const [answerNotice, setAnswerNotice] = useState<AnswerNoticeFacts | null>(null);
  const [answering, setAnswering] = useState(false);
  const [answerFunding, setAnswerFunding] = useState<AnswerFundingState | null>(null);
  /** A funding gate was opened and has not yet been reported resolved. */
  const gateOpenRef = useRef(false);
  /** The caller's name for the ended toast, in a ref so the commit's identity never churns. */
  const callerNameRef = useRef<string | null>(null);

  /** Reports the funding gate's end once, however many exits race for it. */
  const resolveGate = useCallback((via: 'top_up' | 'abandoned'): void => {
    if (!gateOpenRef.current) return;
    gateOpenRef.current = false;
    track(CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, { via });
  }, []);

  /** Resolves `true` only when the room opened. */
  const commitAnswer = useCallback(
    async (ringId: string): Promise<boolean> => {
      /** The funding step only re-answers once its top-up completed, and it is the only open gate. */
      const afterTopUp = gateOpenRef.current;
      const result = await answerCallNowRingAction({ ringId });
      if (result.ok) {
        resolveGate('top_up');
        setAnswerFunding(null);
        onOpened(result.grant);
        return true;
      }
      const { engagementId, expertProfileId, fundingCode } = result;
      if (
        result.code === 'funding' &&
        engagementId !== undefined &&
        expertProfileId !== undefined &&
        fundingCode !== undefined
      ) {
        gateOpenRef.current = true;
        setAnswerFunding({
          ringId,
          engagementId,
          fundingCode,
          request: callNowFundingRequest({
            expertProfileId,
            engagementId,
            nowMs: Date.now(),
            ringId,
          }),
        });
        onFunding();
        return false;
      }
      if (
        result.code === 'failed' ||
        result.code === 'rate_limited' ||
        result.code === 'funding_unavailable'
      ) {
        // The ring is still ringing: keep the Answer notice (or the open funding gate) for a retry.
        toast.error(START_FAILURE_COPY[result.code]);
        return false;
      }
      if (result.code === 'ring_not_ringing' && engagementId !== undefined) {
        const callerName = callerNameRef.current ?? FALLBACK_CALLER_NAME;
        resolveGate(afterTopUp ? 'top_up' : 'abandoned');
        toast(
          afterTopUp
            ? CALL_NOW_COPY.answerEndedAfterTopUpToast(callerName)
            : CALL_NOW_COPY.answerEndedToast(callerName)
        );
        router.push(`/cases/${engagementId}`);
        return false;
      }
      resolveGate('abandoned');
      onUnavailable();
      return false;
    },
    [router, resolveGate, onOpened, onFunding, onUnavailable]
  );

  /** Read through a ref so `offerAnswer`'s identity never follows the callers' inline callbacks. */
  const commitAnswerRef = useRef(commitAnswer);
  useEffect(() => {
    commitAnswerRef.current = commitAnswer;
  }, [commitAnswer]);

  const offerAnswer = useCallback(
    (ringId: string | undefined): void => {
      if (ringId === undefined) {
        onUnavailable();
        return;
      }
      readCallNowAnswerViewAction({ ringId, meetingId }).then((view) => {
        if (view.kind === 'answer') {
          callerNameRef.current = view.callerName;
          setAnswerRingId(ringId);
          setAnswerNotice({ callerName: view.callerName, rateLine: view.rateLine });
          onRequired();
          if (takeAnswerIntent(meetingId) === ringId) {
            setAnswering(true);
            commitAnswerRef
              .current(ringId)
              .catch(onUnavailable)
              .finally(() => setAnswering(false));
          }
          return;
        }
        if (view.kind === 'wait') {
          onAwaitConnect();
          return;
        }
        onConnecting();
      }, onConnecting);
    },
    [meetingId, onRequired, onAwaitConnect, onConnecting, onUnavailable]
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
    answerNotice,
    offerAnswer,
    answering,
    answerFunding,
    commitAnswer,
    handleAnswer,
    handleFundingBack,
    handleFundingBook,
  };
}
