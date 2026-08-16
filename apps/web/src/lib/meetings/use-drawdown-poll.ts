'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DrawdownState } from '@balo/shared/credit';
import type { GetMeetingDrawdownResult, MeetingBalancePanelActions } from './meeting-panels';

/**
 * BAL-403 — the in-call BALANCE slot's poll. Follows `use-guest-roster-poll.tsx` and
 * `use-meeting-state-poll.ts`, with ONE deliberate divergence.
 *
 * ── ⚠⚠ THE DIVERGENCE: IT POLLS WHILE THE PANEL IS CLOSED ───────────────────────────────────
 *
 * `useGuestRosterPoll` lives INSIDE `PeoplePanel`, so *"the panel being MOUNTED is the whole
 * bound"* (`use-guest-roster-poll.tsx:17-19`) — BAL-436's cadence rule. That rule is exactly
 * wrong here: this poll's entire purpose is to *cause* the panel to open on an escalation, so it
 * must run whenever the slot is REGISTERED, not whenever it happens to be open. It therefore
 * lives in `MeetingFrameInner`, above `FramePanel`, and its bound is registration plus the
 * frame's own lifetime. This is a real divergence from a shipped convention, stated here rather
 * than silently — see ADR candidate #2 in the BAL-403 plan (a docblock was judged sufficient).
 *
 * ── Contract ──────────────────────────────────────────────────────────────────────────────────
 *
 *   · Enabled ⇔ `balance !== null`. Disabled ⇒ no timer, no fetch, `state: null, status: 'idle'`.
 *   · One immediate read on mount (or on becoming enabled), then the schedule.
 *   · Baseline interval `DRAWDOWN_POLL_INTERVAL_MS` (30s); URGENT `DRAWDOWN_POLL_URGENT_INTERVAL_MS`
 *     (10s) once the LAST SUCCESSFUL `state.key` is `'grace' | 'near' | 'wrap'` — never a locally
 *     computed threshold.
 *   · Hidden tab ⇒ the timer is cleared; resume fires an IMMEDIATE fetch, never a delayed one.
 *   · A retryable failure spends one of `DRAWDOWN_MAX_CONSECUTIVE_POLL_FAILURES` (8) lives; a
 *     terminal one spends them all, which is what stops the schedule immediately.
 *   · At the failure cap: the timer is cleared, the LAST KNOWN state survives, and `status`
 *     becomes `'error'` — never a toast, because the condition persists.
 *   · ⚠⚠ FIX ROUND 1 (W2) — A NON-RETRYABLE VERDICT (`retryable: false`) IS DIFFERENT FROM THE
 *     CAP: it FAIL-CLOSES, clearing `state` / `sessionId` immediately rather than keeping the
 *     last-known-good. ⚠ THIS IS NOT A MEMBERSHIP DENIAL — `get-meeting-drawdown-state.ts` only
 *     emits `retryable: false` when `enterCallAction` itself fails (an expired session, or an
 *     invalid `meetingId`); a membership / audience denial instead folds into the SAME `{
 *     success: true, state: null }` shape as a genuine vanish, so it never reaches this branch —
 *     see `use-drawdown-poll.ts`'s `applyResult` below and `resolve-in-call-drawdown.ts`'s
 *     docblock for exactly what collapses there. Rendering the company's funding state in a
 *     browser whose session/meetingId no longer resolves is the wrong default regardless of
 *     cause. Last-known-good survives ONLY the retryable-cap path above.
 *   · ⚠⚠ FIX ROUND 1 (C2) — `retry()` IS EXPOSED so a caller can make the error card's "try
 *     again" copy literally true. It resets the failure cap AND the `stoppedRef` latch and fires
 *     an immediate `tick()` — the same shape the mount effect uses.
 *   · ⚠⚠ FIX ROUND 2 (R6) — `retry()` IS NOW GUARDED, THROTTLED, AND RESETS `lastKeyRef` TOO.
 *     Round 1's version was NOT a harmless no-op while disabled: `tick()` itself no-ops on a
 *     `null` balance, but `retry()` called `setStatus('loading')` BEFORE that no-op, stranding
 *     the hook in `'loading'` forever with nothing left to move it out. It also reset
 *     `failureCountRef` on every call with no throttle — a burst of clicks spent fresh lives
 *     unbounded on the app's most-polled read — and it left `lastKeyRef` untouched, so a
 *     recovered poll could resume on the URGENT 10s cadence from a STALE pre-failure key, despite
 *     its own comment claiming parity with the mount effect (which DOES reset it). `retry()` now
 *     (a) no-ops before touching `status` when unmounted or `balance` is `null`, (b) is
 *     re-entry-guarded by a short in-flight latch so a double-click cannot double-spend the
 *     counter, and (c) resets `lastKeyRef.current = null` alongside the other refs — genuine
 *     parity with the mount effect this time.
 *   · Terminal stop: `state.status ∈ {'ended','cancelled'}`, OR a SUCCESS answers `state: null`
 *     (the session vanished mid-call — a success, not a failure). ⚠ `'wrapped'` is DELIBERATELY
 *     kept OUTSIDE the terminal set and kept polling — settlement genuinely may still move the
 *     state, and a stale meter is worse than a few extra requests. This is the conservative
 *     choice (Decision OQ3); whoever owns settlement can cheaply refute it later.
 *   · `isMountedRef` guards every async resolution; the unmount cleanup clears the timer;
 *     `tickRef` re-entry means the schedule is never restarted by a changing callback identity.
 *
 * ⚠ NEVER NAMES `lens` — this file sits inside the invariant's `CALL_LIB_FILES` allow-list
 * (`meeting-call-no-lens-gate.test.ts`), which bans the substring in every scanned module. This
 * hook branches on `state.key` / `state.status` only, which is sufficient for the poll tier.
 */

export const DRAWDOWN_POLL_INTERVAL_MS = 30_000;
export const DRAWDOWN_POLL_URGENT_INTERVAL_MS = 10_000;
export const DRAWDOWN_MAX_CONSECUTIVE_POLL_FAILURES = 8;

/** ⚠ THE TIER INPUT IS THE LAST SUCCESSFUL `state.key` ONLY — never a locally-computed threshold. */
const URGENT_KEYS: ReadonlySet<DrawdownState['key']> = new Set(['grace', 'near', 'wrap']);

export type DrawdownPollStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DrawdownPollState {
  /** ⚠ `null` UNTIL THE FIRST SUCCESS, or once the session vanishes — and it SURVIVES a later
   * transport failure, deliberately (last-known-good). */
  readonly state: DrawdownState | null;
  /** Travels with `state`; `null` whenever `state` is. Never crosses any OTHER interface. */
  readonly sessionId: string | null;
  readonly status: DrawdownPollStatus;
  /**
   * BAL-403 fix round 1 (C2) — resets the failure cap and the stopped latch, then fetches
   * immediately. The one real recovery path the error card's "Try again" button can offer.
   */
  readonly retry: () => void;
}

export interface UseDrawdownPollInput {
  /** `null` ⇒ the slot is unregistered — the whole hook becomes a no-op. */
  readonly balance: MeetingBalancePanelActions | null;
}

function isDocumentVisible(): boolean {
  return globalThis.document?.visibilityState !== 'hidden';
}

/** `'wrapped'` is deliberately excluded — see the module docblock. */
function isTerminalStatus(state: DrawdownState): boolean {
  return state.status === 'ended' || state.status === 'cancelled';
}

export function useDrawdownPoll({ balance }: UseDrawdownPollInput): DrawdownPollState {
  const enabled = balance !== null;

  const [state, setState] = useState<DrawdownState | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<DrawdownPollStatus>(enabled ? 'loading' : 'idle');

  const balanceRef = useRef(balance);
  const failureCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const stoppedRef = useRef(false);
  const lastKeyRef = useRef<DrawdownState['key'] | null>(null);
  const tickRef = useRef<() => void>(() => {});
  /** BAL-403 fix round 2 (R6) — blocks `retry()` re-entry until the in-flight fetch settles. */
  const retryInFlightRef = useRef(false);

  useEffect(() => {
    balanceRef.current = balance;
  }, [balance]);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedule = useCallback((): void => {
    clearTimer();
    if (stoppedRef.current || !isDocumentVisible()) return;
    const key = lastKeyRef.current;
    const delay =
      key !== null && URGENT_KEYS.has(key)
        ? DRAWDOWN_POLL_URGENT_INTERVAL_MS
        : DRAWDOWN_POLL_INTERVAL_MS;
    timerRef.current = setTimeout(() => tickRef.current(), delay);
  }, [clearTimer]);

  const stop = useCallback((): void => {
    stoppedRef.current = true;
    clearTimer();
  }, [clearTimer]);

  /** Interpret one poll answer. ⚠ THE ONE PLACE STATE, SESSION ID AND THE SCHEDULE ALL MEET. */
  const applyResult = useCallback(
    (result: GetMeetingDrawdownResult): void => {
      // ⚠⚠ R6 — CLEARED UNCONDITIONALLY, FIRST. Any tick settling (scheduled or `retry()`-fired)
      // releases the latch, whether or not the result below is actually applied.
      retryInFlightRef.current = false;
      if (!isMountedRef.current || stoppedRef.current) return;

      if (result.success) {
        failureCountRef.current = 0;

        if (result.state === null) {
          // ⚠⚠ THE INERT / VANISHED PATH — A SUCCESS, AND TERMINAL. The credit session that fed
          // this poll is gone (soft-deleted, cancelled between polls, or never existed). Stop
          // rather than keep asking a question with no more answer.
          lastKeyRef.current = null;
          setState(null);
          setSessionId(null);
          setStatus('ready');
          stop();
          return;
        }

        lastKeyRef.current = result.state.key;
        setState(result.state);
        setSessionId(result.sessionId);
        setStatus('ready');

        if (isTerminalStatus(result.state)) {
          stop();
          return;
        }
        schedule();
        return;
      }

      if (!result.retryable) {
        // ⚠⚠ W2 — A VERDICT, NOT A BLIP: spends every remaining life, stops the schedule, and
        // FAIL-CLOSES. Unlike the retryable cap below, this does NOT keep last-known-good.
        // ⚠ NOT A MEMBERSHIP DENIAL — this arm fires only on an expired session or an invalid
        // `meetingId` (see `get-meeting-drawdown-state.ts`); a membership denial arrives on the
        // `success: true, state: null` branch above instead, indistinguishable from a genuine
        // vanish. Rendering stale state in a browser whose session no longer resolves is the
        // wrong default regardless of cause.
        failureCountRef.current = DRAWDOWN_MAX_CONSECUTIVE_POLL_FAILURES;
        lastKeyRef.current = null;
        setState(null);
        setSessionId(null);
        setStatus('error');
        stop();
        return;
      }

      failureCountRef.current += 1;
      if (failureCountRef.current >= DRAWDOWN_MAX_CONSECUTIVE_POLL_FAILURES) {
        // ⚠ GIVING UP ON THE SCHEDULE, NOT ON THE PERSON. The last-known `state` stays rendered;
        // the panel shows a degraded line, never a toast — the condition persists.
        setStatus('error');
        stop();
        return;
      }
      schedule();
    },
    [schedule, stop]
  );

  const tick = useCallback((): void => {
    const current = balanceRef.current;
    if (current === null) return;
    // ⚠ DELIBERATELY NOT `void`-PREFIXED (SonarCloud S3735 / this repo's shipped position —
    // see `use-meeting-state-poll.ts`).
    current
      .loadDrawdownState()
      .then(applyResult)
      .catch(() => {
        // ⚠⚠ THE TRANSPORT ARM. A Server Action can reject before any server answers — see
        // `use-meeting-state-poll.ts`'s identical note. Spends a life exactly like `ok: false`.
        if (!isMountedRef.current || stoppedRef.current) return;
        applyResult({
          success: false,
          error: 'Could not reach the balance check.',
          retryable: true,
        });
      });
  }, [applyResult]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  /** Mount (or becoming enabled): one immediate read, then the schedule. */
  useEffect(() => {
    isMountedRef.current = true;
    if (!enabled) {
      setStatus('idle');
      return;
    }
    stoppedRef.current = false;
    failureCountRef.current = 0;
    lastKeyRef.current = null;
    setStatus('loading');
    tickRef.current();
    return () => {
      isMountedRef.current = false;
      clearTimer();
    };
    // ⚠ `[enabled]` IS THE WHOLE DEPENDENCY LIST, DELIBERATELY — mirrors `use-meeting-state-poll`'s
    // `[enabled]` effect. `tickRef` keeps the latest closure reachable, so re-running this on
    // every `tick` identity change would restart the schedule on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  /** ⚠ PAUSE WHEN HIDDEN; RESUME WITH AN IMMEDIATE FETCH, not with a delay. */
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, clearTimer]);

  /**
   * BAL-403 fix round 1 (C2) — the ONE real recovery path. Re-arms the stopped latch and the
   * failure counter, then fires an immediate read — the same shape the mount effect uses. A
   * caller mid-render sees `status: 'loading'` while it resolves, exactly like the first mount.
   *
   * BAL-403 fix round 2 (R6) — see the module docblock. Guarded on `balance`, throttled by
   * `retryInFlightRef`, and resets `lastKeyRef` too.
   */
  const retry = useCallback((): void => {
    // ⚠⚠ R6 — UNMOUNTED, OR THE SLOT IS UNREGISTERED. `tick()` itself no-ops on a `null`
    // balance, but this check runs BEFORE `setStatus('loading')` — the bug round 1 shipped was
    // flipping the status first and no-oping the fetch after, stranding the hook in `'loading'`.
    if (!isMountedRef.current || balanceRef.current === null) return;
    // ⚠⚠ R6 — A SHORT IN-FLIGHT LATCH. `retry()` is a click handler with no throttle of its own;
    // without this, a burst of clicks each reset `failureCountRef` to 0 and fired a fresh fetch,
    // unbounded, on the app's most-polled read.
    if (retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    stoppedRef.current = false;
    failureCountRef.current = 0;
    // ⚠⚠ R6 — RESET THE KEY TOO. Leaving a stale pre-failure key meant a recovered poll could
    // resume on the URGENT 10s cadence rather than the baseline — this is the parity with the
    // mount effect this function's own comment already claimed but did not deliver.
    lastKeyRef.current = null;
    setStatus('loading');
    tickRef.current();
  }, []);

  return { state, sessionId, status, retry };
}
