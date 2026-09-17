'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * BAL-513 fix round 2 (F7) — the minimum gap between two focus-triggered `router.refresh()`
 * calls. Guards against a server round trip on every alt-tab; ~30s is generous relative to how
 * often a viewer would plausibly re-focus this tab while genuinely checking on a meeting.
 */
export const FOCUS_REFRESH_MIN_INTERVAL_MS = 30_000;

/**
 * BAL-566 — extracted VERBATIM from `expert/calendar/_components/calendar-shell.tsx` (BAL-513
 * F7) so the dashboard Up next card can adopt the same focus-refresh behaviour without a second
 * copy. `calendar-shell.tsx` now calls this hook and deletes its inline effect.
 *
 * `status` on a Server-Component-rendered page is frozen as at that page's LAST SERVER RENDER.
 * The lifecycle sweep (`apps/api/src/jobs/meeting-lifecycle-sweep.ts`, every minute) can move a
 * meeting to `ended` AND delete its Daily room ~10 minutes after the room empties, while a
 * client-side join window is still showing a live, joinable card for longer than that. A pure
 * `now` tick only moves the clock; it never refetches, so it cannot see the status change.
 *
 * ⚠⚠ EVENT-DRIVEN, NEVER PERIODIC. This is deliberately NOT wired onto a tick interval — that
 * would be exactly the "client-side polling" both `join-window.ts` and the BAL-566 plan name as
 * a Non-goal: a schedule that fires whether or not anyone is looking. `window` `focus` and
 * `document` `visibilitychange → 'visible'` are the two DOM signals for "a human just looked at
 * this tab" — refreshing on them serves the "came back to rejoin/re-check" scenario directly,
 * and only when it plausibly occurs, never on a timer.
 *
 * `router.refresh()` re-runs the Server Component tree and hands the caller fresh props (fresh
 * `status`, `href`s, etc.) — it never touches any client-held `now`, so a caller's own tick-based
 * memoisation is unaffected by this hook entirely.
 *
 * ⚠ RATE-LIMITED VIA A REF, NOT STATE (`minIntervalMs`). A state-backed guard would itself force
 * a re-render on every focus, which is exactly the cost this guard exists to avoid. Alt-tabbing
 * back and forth cannot trigger more than one refresh per interval.
 *
 * ⚠ A MITIGATION, NOT A GUARANTEE. Status stays stale for as long as the tab remains
 * continuously focused — this only reconciles it at the moments a human plausibly looks again.
 */
export function useRefreshOnFocus(minIntervalMs: number = FOCUS_REFRESH_MIN_INTERVAL_MS): void {
  const router = useRouter();
  const lastFocusRefreshAtRef = useRef(0);
  useEffect(() => {
    function refreshIfDue(): void {
      const nowMs = Date.now();
      if (nowMs - lastFocusRefreshAtRef.current < minIntervalMs) return;
      lastFocusRefreshAtRef.current = nowMs;
      router.refresh();
    }
    function handleVisibilityChange(): void {
      if (globalThis.document.visibilityState === 'visible') refreshIfDue();
    }
    globalThis.window.addEventListener('focus', refreshIfDue);
    globalThis.document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      globalThis.window.removeEventListener('focus', refreshIfDue);
      globalThis.document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [router, minIntervalMs]);
}
