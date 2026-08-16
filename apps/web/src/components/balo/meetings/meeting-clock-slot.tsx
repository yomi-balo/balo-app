'use client';

import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import type { MeetingClocks } from '@balo/shared/meetings';
import { cn } from '@/lib/utils';

/**
 * BAL-435 (ruling R4) — THE TOP-BAR CLOCK CHIP. **Ships `● Live`. No duration.**
 *
 * ⚠⚠ **NO INTERVAL RUNS ON ANY STATE THIS TICKET PRODUCES**, AND THAT IS THE RULING, NOT AN
 * OVERSIGHT. BAL-435 emits only `live` and `not_started`; the `setInterval` below is armed
 * exclusively by the two SNAPSHOT arms (`billable` / `counted`), which nothing in this ticket can
 * reach. (The sentence used to read "there is no client-side interval timer in this ticket",
 * which was literally false of a file that ships one — dormant, but present.)
 * `meeting_presence` has ZERO production writers, and `computeMeetingClocks` derives
 * `expertPresentMs` from the FIRST expert join rather than from BAL-134's
 * `max(scheduled, join)` — so there is no server clock to mirror, and the primitive would not
 * yet answer correctly if there were. A locally-computed number on a surface whose sibling
 * numbers settle money is a promise the platform cannot keep.
 *
 * ⚠ ALL FOUR ARMS SHIP AND ALL FOUR ARE TESTED. **BAL-134 changes ONE PRODUCER LINE, not this
 * component** — which is the whole point of the type. The two currently-unreachable arms are
 * specified behaviour rather than dead code that would land as uncovered changed lines.
 *
 * ⚠⚠ `aria-live` IS **`off`**. A duration announced every second is a screen-reader denial of
 * service. The value is exposed as a STATIC `aria-label` for the user to query on demand.
 *
 * ⚠ ELAPSED TIME ONLY — **NEVER A LIVE COST METER** (BAL-403 precedent: the in-session panel
 * renders runway, never a charge).
 */

export type MeetingClockState =
  /** Nothing has started, or nothing is being charged. */
  | { readonly kind: 'not_started' }
  /** ⚠ THE ONLY VALUE BAL-435 PRODUCES. Presence, not duration. */
  | { readonly kind: 'live' }
  /** BAL-134 wires these two: a snapshot plus the instant it was taken. */
  | { readonly kind: 'billable'; readonly clocks: MeetingClocks; readonly asOf: Date }
  | { readonly kind: 'counted'; readonly clocks: MeetingClocks; readonly asOf: Date };

/** `mm:ss`, clamped at zero. ⚠ Never negative — a clock that runs backwards reads as a bug. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

const CHIP_BASE = 'shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs tabular-nums';

/**
 * ⚠ THE CHROME-ONLY ARMS MAY YIELD SPACE ON A PHONE. `Not started` and `● Live` restate what the
 * stage below already shows; on a 375px bar the meeting title is worth more.
 */
const CHIP_COMPACT_HIDDEN = 'hidden sm:flex';

/**
 * BAL-134 — ⚠⚠ **THE TWO DURATION ARMS RENDER AT EVERY WIDTH, AND THAT IS A MONEY DECISION.**
 *
 * `CHIP_BASE` used to carry `hidden … sm:flex` for all four arms, so below 640px the amber
 * "counted" chip **did not render at all** — an expert on a phone saw no clock whatsoever, which
 * is precisely the situation this ticket exists to fix and precisely the device an expert waiting
 * on a late client is most likely to be holding. The entire visible artifact of the TopBar fix
 * was absent exactly where it mattered most.
 *
 * `billable` joins it for the same reason: both arms report a span that settles money, unlike the
 * two above which report only chrome. The bar is safe for it — the chip is `shrink-0` inside a
 * `min-w-0` flex row whose title carries `truncate`, so the title gives way and nothing overflows.
 */
const CHIP_ALWAYS_VISIBLE = 'flex';

/**
 * ⚠ THE SNAPSHOT TICKS FROM `asOf`, so the chip stays honest across a slow render or a
 * backgrounded tab — it never accumulates its own drift.
 */
function useTickedElapsed(baseMs: number | null, asOf: Date | null): number {
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    if (asOf === null) {
      setNowMs(null);
      return;
    }
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [asOf]);

  if (baseMs === null || asOf === null) return 0;
  if (nowMs === null) return baseMs;
  return baseMs + Math.max(0, nowMs - asOf.getTime());
}

export function MeetingClockSlot({
  state,
}: Readonly<{ state: MeetingClockState }>): React.JSX.Element {
  const isSnapshot = state.kind === 'billable' || state.kind === 'counted';
  const baseMs = (() => {
    if (state.kind === 'billable') return state.clocks.billableMs;
    if (state.kind === 'counted') return state.clocks.expertPresentMs;
    return null;
  })();
  const elapsedMs = useTickedElapsed(baseMs, isSnapshot ? state.asOf : null);

  if (state.kind === 'not_started') {
    return (
      <span
        aria-live="off"
        aria-label="Not started"
        className={cn(CHIP_BASE, CHIP_COMPACT_HIDDEN, 'text-muted-foreground bg-white/6')}
      >
        Not started
      </span>
    );
  }

  if (state.kind === 'live') {
    return (
      <span
        aria-live="off"
        aria-label="Live"
        className={cn(CHIP_BASE, CHIP_COMPACT_HIDDEN, 'text-success bg-white/6')}
      >
        <span className="bg-success h-1.5 w-1.5 rounded-full" aria-hidden="true" />
        {/* ⚠ An expression, not bare text: the chip is `flex gap-1.5`, so a literal space would
            stack ON TOP of the gap. This also matches the `{elapsed}` arms below. */}
        {'Live'}
      </span>
    );
  }

  const elapsed = formatElapsed(elapsedMs);

  if (state.kind === 'billable') {
    return (
      <span
        aria-live="off"
        aria-label={`Elapsed ${elapsed}`}
        className={cn(CHIP_BASE, CHIP_ALWAYS_VISIBLE, 'text-muted-foreground bg-white/6')}
      >
        <span className="bg-success h-1.5 w-1.5 rounded-full" aria-hidden="true" />
        {elapsed}
      </span>
    );
  }

  // ⚠ THE `waiting-state-patch` TOP-BAR FIX: while the expert waits, their time IS counting and
  // the bar used to say "Not started". Amber, and it says "counted".
  return (
    <span
      aria-live="off"
      aria-label={`${elapsed} counted`}
      className={cn(CHIP_BASE, CHIP_ALWAYS_VISIBLE, 'bg-warning/15 text-warning')}
    >
      <Clock className="h-3 w-3" aria-hidden="true" />
      {elapsed} counted
    </span>
  );
}
