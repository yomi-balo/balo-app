'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getTopUpCreditStatusAction } from '@/lib/credit/actions';

/**
 * The receipt's "did the credit actually land?" poll.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────────────────────
 *
 * The webhook that credits a top-up is ASYNCHRONOUS BY DESIGN — Stripe delivers
 * `payment_intent.succeeded` out of band, and the handler makes several serial Stripe calls
 * before it writes the ledger. So at the instant the browser's `confirmPayment` resolves, the
 * wallet has NOT moved yet. The receipt used to paper over that with client arithmetic
 * (`previous + amount + promo`), which cannot tell credited from not-credited: in the real
 * incident it asserted "Your balance is now A$1,000.00" while the top-bar chip on the same
 * screen read A$0.00, because the wallet was genuinely never credited.
 *
 * This hook asks the wallet. Its answer is the one signal that closes both halves: the receipt
 * renders a verified state instead of an assertion, and the `pending → credited` transition is
 * what the caller hangs its `router.refresh()` on, which re-runs the `(dashboard)` layout and
 * repaints the chip from the same uncached DB read.
 *
 * ── CONTRACT (follows `@/lib/meetings/use-drawdown-poll`) ────────────────────────────────────
 *
 *   · One IMMEDIATE read on mount, then a SELF-RE-ARMING `setTimeout` — never `setInterval`. A
 *     fixed interval would stack requests whenever a read outlives its own period.
 *   · `TOPUP_POLL_FAST_INTERVAL_MS` (2s) for the first `TOPUP_POLL_FAST_TICKS` (5) scheduled
 *     reads — the window the webhook almost always lands in — then
 *     `TOPUP_POLL_SLOW_INTERVAL_MS` (5s).
 *   · HARD STOP at `TOPUP_POLL_WINDOW_MS` (45s) from mount, ~13 reads total. The cost is bounded
 *     and paid only by a buyer sitting on the receipt.
 *   · Hidden tab ⇒ the timer is CLEARED; resume fires an IMMEDIATE fetch, never a delayed one.
 *     The deadline is WALL-CLOCK on purpose: the webhook lands (or doesn't) regardless of
 *     whether anyone is looking, so hidden time is genuinely spent.
 *   · TERMINAL on `credited`, on `unauthorized` (retrying cannot change a capability answer),
 *     and at the cap. Everything else — `pending`, `error`, and a transport-level rejection —
 *     spends a tick and keeps going.
 *   · NO TOAST FROM A TICK. The hook reports state; the caller decides what to say, once.
 *
 * ⚠ `balanceMinor` IS ONLY EVER A SERVER READ OF THE ACTOR'S OWN WALLET. It stays `null` until
 * the first successful read, so the caller can show its own placeholder — and it is NEVER
 * derived from the purchase amount here or anywhere downstream. That arithmetic is the bug.
 *
 * ⚠ AN `error` NEVER OVERWRITES A GOOD BALANCE. `{ status: 'error' }` carries no figure by
 * design; a blip must not repaint a real balance as `0`.
 */

export const TOPUP_POLL_FAST_INTERVAL_MS = 2_000;
export const TOPUP_POLL_SLOW_INTERVAL_MS = 5_000;
/** How many SCHEDULED reads run at the fast cadence before it relaxes. */
export const TOPUP_POLL_FAST_TICKS = 5;
/** Wall-clock budget from mount. Reached without a `credited` ⇒ `'unconfirmed'`. */
export const TOPUP_POLL_WINDOW_MS = 45_000;

/**
 *  · `pending`     — still asking. The honest FIRST PAINT: the webhook is asynchronous, so
 *                    "not confirmed yet" is the normal case, not an error.
 *  · `credited`    — the actor's own wallet carries the `manual_purchase:{piId}` entry.
 *  · `unconfirmed` — terminal WITHOUT confirmation (the window closed, or the read said
 *                    `unauthorized`). The money is safe; the balance is not yet provable.
 */
export type TopUpCreditPollStatus = 'pending' | 'credited' | 'unconfirmed';

export interface TopUpCreditPollState {
  readonly status: TopUpCreditPollStatus;
  /** The wallet's own balance from the last SUCCESSFUL read; `null` until one lands. */
  readonly balanceMinor: number | null;
}

function isDocumentVisible(): boolean {
  return globalThis.document?.visibilityState !== 'hidden';
}

export function useTopUpCreditPoll(paymentIntentId: string): TopUpCreditPollState {
  const [status, setStatus] = useState<TopUpCreditPollStatus>('pending');
  const [balanceMinor, setBalanceMinor] = useState<number | null>(null);

  const isMountedRef = useRef(true);
  const stoppedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Successful or failed, every settled read counts toward the cadence tier. */
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
    (final: TopUpCreditPollStatus): void => {
      stoppedRef.current = true;
      clearTimer();
      if (isMountedRef.current) setStatus(final);
    },
    [clearTimer]
  );

  /**
   * Re-arm the ONE outstanding timer, or give up if the wall-clock budget is spent.
   * ⚠ `Math.min(delay, remaining)` lands the last read exactly ON the deadline rather than
   * skipping it — the webhook's slowest honest tail is the case worth one final look.
   */
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

  /** Interpret one answer. ⚠ THE ONE PLACE STATUS, BALANCE AND THE SCHEDULE ALL MEET. */
  const applyResult = useCallback(
    (result: Awaited<ReturnType<typeof getTopUpCreditStatusAction>>): void => {
      if (!isMountedRef.current || stoppedRef.current) return;
      readCountRef.current += 1;

      if (result.status === 'credited') {
        setBalanceMinor(result.balanceMinor);
        stop('credited');
        return;
      }
      if (result.status === 'unauthorized') {
        // A capability answer will not change on the next tick. Stop without ever claiming a
        // balance — the caller's copy says the money is safe, which remains true.
        stop('unconfirmed');
        return;
      }
      if (result.status === 'pending') {
        setBalanceMinor(result.balanceMinor);
      }
      // `'error'` deliberately falls through WITHOUT touching `balanceMinor` — it carries no
      // figure, and a blip must not repaint a real balance as 0.
      schedule();
    },
    [schedule, stop]
  );

  const tick = useCallback((): void => {
    // ⚠ DELIBERATELY NOT `void`-PREFIXED (SonarCloud S3735 / this repo's shipped position —
    // see `use-drawdown-poll.ts`).
    getTopUpCreditStatusAction(paymentIntentId)
      .then(applyResult)
      .catch(() => {
        // ⚠ THE TRANSPORT ARM. A Server Action can reject before any server answers. Spend a
        // tick exactly like `{ status: 'error' }` — same reasoning, same non-claim.
        applyResult({ status: 'error' });
      });
  }, [paymentIntentId, applyResult]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  /** Mount: open the wall-clock budget, read once immediately, then hand over to the schedule. */
  useEffect(() => {
    isMountedRef.current = true;
    stoppedRef.current = false;
    readCountRef.current = 0;
    deadlineRef.current = Date.now() + TOPUP_POLL_WINDOW_MS;
    setStatus('pending');
    setBalanceMinor(null);
    tickRef.current();
    return () => {
      isMountedRef.current = false;
      clearTimer();
    };
    // ⚠ `[paymentIntentId]` IS THE WHOLE DEPENDENCY LIST, DELIBERATELY — mirrors
    // `use-drawdown-poll`'s `[enabled]` effect. `tickRef` keeps the latest closure reachable, so
    // re-running this on every `tick` identity change would restart the schedule each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentIntentId]);

  /** ⚠ PAUSE WHEN HIDDEN; RESUME WITH AN IMMEDIATE FETCH, not with a delay. */
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

  return { status, balanceMinor };
}
