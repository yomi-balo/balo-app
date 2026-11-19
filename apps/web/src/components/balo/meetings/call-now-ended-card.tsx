'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { CircleSlash } from 'lucide-react';
import type { CallSide } from '@balo/shared/meetings';
import { Button } from '@/components/ui/button';
import { CALL_NOW_COPY } from '@/lib/call-now/call-now-copy';
import { trackCallNowBookInstead } from '@/lib/call-now/use-call-now-caller-room';
import { useCallNowSurface } from '@/lib/call-now/use-call-now-surface';
import { MeetingAvatar } from './meeting-avatar';

export interface CallNowEndedCardProps {
  /** How the ring ended without a call: nobody picked up, or the other side said not now. */
  readonly outcome: 'unanswered' | 'declined';
  readonly calleeLabel: string;
  /** The caller's side: the client copy says nothing was charged, the expert copy nothing was counted. */
  readonly copyArm: CallSide;
  /** The client can book the expert in the case page, so "Book a time" has somewhere to go. */
  readonly bookInPage: boolean;
  readonly engagementId: string;
  /**
   * The entry tap's attempt id, for the book-instead event. `null` for a ring started before attempt
   * ids were persisted: the card then tracks nothing.
   */
  readonly attemptId: string | null;
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
}

/** Declined leaves no missed-call item, so only the unanswered body says the call will be seen. */
function endedBody(
  outcome: CallNowEndedCardProps['outcome'],
  copyArm: CallSide,
  calleeLabel: string
): string {
  if (outcome === 'declined') {
    return copyArm === 'client' ? CALL_NOW_COPY.declinedClient : CALL_NOW_COPY.declinedExpert;
  }
  return copyArm === 'client'
    ? CALL_NOW_COPY.noAnswerClient(calleeLabel)
    : CALL_NOW_COPY.noAnswerExpert(calleeLabel);
}

/**
 * The caller's end state when a Call now ring ran out or was declined, in the call room's own
 * shell. It replaces the frame, so it wins over any ended notice. A quiet fact, not a failure:
 * nothing was charged and the caller is offered the one useful next step. Only an unanswered call
 * says the other side will see it: a declined one leaves no missed-call item behind. There is no
 * "Cancel": nothing is left to cancel.
 */
export function CallNowEndedCard({
  outcome,
  calleeLabel,
  copyArm,
  bookInPage,
  engagementId,
  attemptId,
  headingRef,
}: Readonly<CallNowEndedCardProps>): React.JSX.Element {
  const surface = useCallNowSurface();
  const handleBookInstead = useCallback((): void => {
    trackCallNowBookInstead({ attemptId, callerSide: copyArm, surface });
  }, [attemptId, copyArm, surface]);

  const title =
    outcome === 'declined'
      ? CALL_NOW_COPY.declinedTitle(calleeLabel)
      : CALL_NOW_COPY.noAnswerTitle(calleeLabel);
  const body = endedBody(outcome, copyArm, calleeLabel);
  const casePath = `/cases/${engagementId}`;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="relative">
        <MeetingAvatar name={calleeLabel} size={72} />
        <span className="bg-card absolute -right-1 -bottom-1 flex h-[26px] w-[26px] items-center justify-center rounded-full">
          <CircleSlash className="text-warning h-[18px] w-[18px]" aria-hidden="true" />
        </span>
      </div>

      <div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-foreground text-lg font-semibold outline-none"
        >
          {title}
        </h1>
        <output
          aria-live="polite"
          className="text-muted-foreground mx-auto mt-1 block max-w-[360px] text-sm leading-relaxed"
        >
          {body}
        </output>
      </div>

      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row-reverse">
        {copyArm === 'client' && bookInPage ? (
          <Button asChild className="min-h-11 w-full sm:w-auto">
            <Link href={`${casePath}?book=1`} onClick={handleBookInstead}>
              {CALL_NOW_COPY.bookInstead}
            </Link>
          </Button>
        ) : null}
        <Button asChild variant="outline" className="min-h-11 w-full sm:w-auto">
          <Link href={casePath}>{CALL_NOW_COPY.backToCase}</Link>
        </Button>
      </div>
    </div>
  );
}
