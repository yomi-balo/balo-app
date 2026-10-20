'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import { readBookingFundingAction } from '@/lib/booking/actions/read-booking-funding';
import type {
  BookingFundingRequest,
  BookingFundingView,
} from '@/lib/booking/actions/booking-funding-types';

type FundingStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface RefreshOptions {
  /** `'refuse'` re-reads a covered hold as a refusal, so a failed heal reproduces its fallback. */
  readonly onCoveredHold?: 'defer' | 'refuse';
}

export interface UseBookingFunding {
  readonly status: FundingStatus;
  readonly view: BookingFundingView | null;
  /**
   * Re-run the read for the current request. Updates the hook's state and returns the view, or
   * `null` when the read threw or was superseded by a newer request.
   */
  readonly refresh: (options?: RefreshOptions) => Promise<BookingFundingView | null>;
}

/** Everything the verdict depends on, as one comparable string. */
function requestKey(request: BookingFundingRequest | null): string | null {
  if (request === null) return null;
  const { expertProfileId, slot, caseChoice } = request;
  return JSON.stringify([
    expertProfileId,
    slot.startIso,
    slot.endIso,
    slot.durationMinutes,
    caseChoice.kind,
    caseChoice.kind === 'new' ? (caseChoice.companyId ?? null) : caseChoice.engagementId,
  ]);
}

/**
 * The read-only funding pre-flight for the booking in front of the client.
 *
 * It runs on mount and again whenever the expert, the slot, the company or the case changes. A
 * `null` request means there is nothing to check yet. An answer that arrives after a newer read
 * began is dropped, so a slow answer for an old slot can never repaint the block.
 */
export function useBookingFunding(request: BookingFundingRequest | null): UseBookingFunding {
  const key = requestKey(request);
  const [status, setStatus] = useState<FundingStatus>(key === null ? 'idle' : 'loading');
  const [view, setView] = useState<BookingFundingView | null>(null);
  /** The request key the held `view`/`status` answer; any other key is still being read. */
  const [answeredKey, setAnsweredKey] = useState<string | null>(null);

  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  });
  const sequenceRef = useRef(0);

  const read = useCallback(
    async (options: RefreshOptions | undefined): Promise<BookingFundingView | null> => {
      const current = requestRef.current;
      if (current === null) return null;
      const readKey = requestKey(current);
      sequenceRef.current += 1;
      const sequence = sequenceRef.current;
      try {
        const answer = await readBookingFundingAction({
          ...current,
          ...(options?.onCoveredHold === undefined ? {} : { onCoveredHold: options.onCoveredHold }),
        });
        if (sequence !== sequenceRef.current) return null;
        setView(answer);
        setStatus('ready');
        setAnsweredKey(readKey);
        return answer;
      } catch (error) {
        Sentry.captureException(error, {
          tags: { feature: 'booking', step: 'funding_preflight' },
        });
        if (sequence !== sequenceRef.current) return null;
        setView(null);
        setStatus('error');
        setAnsweredKey(readKey);
        return null;
      }
    },
    []
  );

  useEffect(() => {
    if (key === null) {
      sequenceRef.current += 1;
      setView(null);
      setStatus('idle');
      return;
    }
    setView(null);
    setStatus('loading');
    read(undefined).catch(() => undefined);
    return () => {
      sequenceRef.current += 1;
    };
  }, [key, read]);

  const refresh = useCallback((options?: RefreshOptions) => read(options), [read]);

  // Until the held answer is for THIS request, the read is still running: a stale answer for the
  // previous slot, company or case is never shown or acted on, not even for one render.
  const answered = key === null || answeredKey === key;
  let derivedStatus: FundingStatus = 'loading';
  if (key === null) derivedStatus = 'idle';
  else if (answered) derivedStatus = status;
  return { status: derivedStatus, view: answered ? view : null, refresh };
}
