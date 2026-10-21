'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getWalletMandateStatusAction } from '@/lib/credit/actions';
import {
  TOPUP_POLL_FAST_INTERVAL_MS,
  TOPUP_POLL_FAST_TICKS,
  TOPUP_POLL_SLOW_INTERVAL_MS,
  TOPUP_POLL_WINDOW_MS,
} from '@/components/billing/top-up/use-topup-credit-poll';

/**
 *  · `pending`     — still asking. A mandate becomes active only on the `setup_intent.succeeded`
 *                    webhook, so "not active yet" is the normal first answer.
 *  · `active`      — the wallet reports an active mandate. The only state that lets a booking go on.
 *  · `failed`      — the wallet reports the setup failed.
 *  · `unconfirmed` — terminal without confirmation: the window closed, or the read was refused.
 */
export type MandateActivePollStatus = 'pending' | 'active' | 'failed' | 'unconfirmed';

function isDocumentVisible(): boolean {
  return globalThis.document?.visibilityState !== 'hidden';
}

/**
 * Asks the wallet whether its mandate is live, on the credit poll's contract: an immediate first
 * read, then a self-re-arming timeout (fast, then slow), a wall-clock deadline, a pause while the
 * tab is hidden with an immediate read on resume. `active`, `failed` and `unauthorized` are
 * terminal; `pending`, `error` and a rejected call spend a tick. A client return from Stripe is
 * never read as active, only the wallet is. The hook reports state and never toasts.
 */
export function useMandateActivePoll(): MandateActivePollStatus {
  const [status, setStatus] = useState<MandateActivePollStatus>('pending');

  const isMountedRef = useRef(true);
  const stoppedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readCountRef = useRef(0);
  const deadlineRef = useRef(0);
  const tickRef = useRef<() => void>(() => {});

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stop = useCallback(
    (final: MandateActivePollStatus): void => {
      stoppedRef.current = true;
      clearTimer();
      if (isMountedRef.current) setStatus(final);
    },
    [clearTimer]
  );

  const schedule = useCallback((): void => {
    clearTimer();
    if (stoppedRef.current) return;
    const remaining = deadlineRef.current - Date.now();
    if (remaining <= 0) {
      stop('unconfirmed');
      return;
    }
    if (!isDocumentVisible()) return;
    const delay =
      readCountRef.current <= TOPUP_POLL_FAST_TICKS
        ? TOPUP_POLL_FAST_INTERVAL_MS
        : TOPUP_POLL_SLOW_INTERVAL_MS;
    timerRef.current = setTimeout(() => tickRef.current(), Math.min(delay, remaining));
  }, [clearTimer, stop]);

  const applyResult = useCallback(
    (result: Awaited<ReturnType<typeof getWalletMandateStatusAction>>): void => {
      if (!isMountedRef.current || stoppedRef.current) return;
      readCountRef.current += 1;
      if (result.status === 'active') {
        stop('active');
        return;
      }
      if (result.status === 'failed') {
        stop('failed');
        return;
      }
      if (result.status === 'unauthorized') {
        stop('unconfirmed');
        return;
      }
      schedule();
    },
    [schedule, stop]
  );

  const tick = useCallback((): void => {
    getWalletMandateStatusAction()
      .then(applyResult)
      .catch(() => applyResult({ status: 'error' }));
  }, [applyResult]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    isMountedRef.current = true;
    stoppedRef.current = false;
    readCountRef.current = 0;
    deadlineRef.current = Date.now() + TOPUP_POLL_WINDOW_MS;
    setStatus('pending');
    tickRef.current();
    return () => {
      isMountedRef.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (stoppedRef.current) return;
      if (!isDocumentVisible()) {
        clearTimer();
        return;
      }
      tickRef.current();
    };
    globalThis.document?.addEventListener('visibilitychange', onVisibilityChange);
    return () => globalThis.document?.removeEventListener('visibilitychange', onVisibilityChange);
  }, [clearTimer]);

  return status;
}
