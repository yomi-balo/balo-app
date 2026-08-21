/**
 * BAL-236 — interval → stepped start grid.
 *
 * `freeIntervalsInRange` (`./resolver.ts`) emits variable-length free intervals; the picker
 * needs a grid of START TIMES, each carrying the largest ladder duration ([15, 30, 45, 60])
 * that still fits from that start. That conversion is new and lives entirely in this file.
 *
 * ⚠ PURE. No DB, env, clock or logging — `now` is always injected by the caller.
 *
 * Why the advertised grid cannot outrun the booking gate: every emitted `start` lies inside a
 * free interval returned by `freeIntervalsInRange`, and `start + maxDurationMinutes ≤
 * intervalEnd` by construction, so for every ladder duration `d ≤ maxDurationMinutes` the
 * window `[start, start+d)` lies wholly inside a free interval — the exact set
 * `isWindowBookable` scans (see `slot-grid-accepts.test.ts` for the pinned equivalence).
 * `leadGuardMinutes` closes the notice edge (BAL-236 plan §1.3): this grid is served from a
 * short-TTL response cache, so `isWindowBookable`'s own `minimumNoticeMinutes` check can
 * refuse a slot that was still valid when the cache was populated. Adding a guard band on TOP
 * of the expert's notice, sized to at least the cache TTL, closes that gap.
 *
 * Why stepping by milliseconds after one alignment is DST-safe: every offset transition in the
 * modern tzdb moves the clock by a whole multiple of 15 minutes (30 or 60; Lord Howe's 30 is
 * the smallest), so an aligned start remains aligned across a transition. Alignment is
 * re-derived per interval (not carried forward across intervals), so drift cannot accumulate.
 */
import { toZonedTime } from 'date-fns-tz';
import {
  MAX_SLOT_MINUTES,
  MIN_SLOT_MINUTES,
  SLOT_DURATION_LADDER,
  SLOT_STEP_MINUTES,
  type SlotDurationMinutes,
} from '@balo/shared/availability';
import { freeIntervalsInRange } from './resolver.js';
import type { BusyBlock, ResolverConsultation, ResolverRule } from './types.js';

export interface BookableSlot {
  /** UTC instant this slot may start at. */
  startAt: Date;
  /** Contiguous free minutes from `startAt`, floored to a ladder value. Always ∈
   *  SLOT_DURATION_LADDER. */
  maxDurationMinutes: SlotDurationMinutes;
}

export interface SlotGridInput {
  rules: ResolverRule[];
  baloConsultations: ResolverConsultation[];
  busyBlocks: BusyBlock[];
  overrideBlocks: BusyBlock[];
  /** IANA zone the START GRID aligns to — the EXPERT's, never the viewer's. */
  timezone: string;
  now: Date;
  horizonDays: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  minimumNoticeMinutes?: number;
  /** §1.3 — extra lead time on TOP of the expert's notice, because this grid is cached. */
  leadGuardMinutes?: number;
}

/** Steps 1–8: bound the window, take the ONE free-interval definition, slice it into starts. */
export function listBookableSlots(input: SlotGridInput): BookableSlot[] {
  const minimumNoticeMs =
    ((input.minimumNoticeMinutes ?? 0) + (input.leadGuardMinutes ?? 0)) * 60 * 1000;
  const rangeStart = new Date(Math.max(input.now.getTime(), input.now.getTime() + minimumNoticeMs));
  const rangeEnd = new Date(input.now.getTime() + input.horizonDays * 24 * 60 * 60 * 1000);
  if (rangeStart >= rangeEnd) return [];

  const free = freeIntervalsInRange({
    rules: input.rules,
    baloConsultations: input.baloConsultations,
    busyBlocks: input.busyBlocks,
    overrideBlocks: input.overrideBlocks,
    timezone: input.timezone,
    rangeStart,
    rangeEnd,
    bufferBeforeMs: (input.bufferBeforeMinutes ?? 0) * 60 * 1000,
    bufferAfterMs: (input.bufferAfterMinutes ?? 0) * 60 * 1000,
  });

  return gridFromFreeIntervals(free, input.timezone);
}

/** Step 8 alone. Exported so the grid maths is unit-testable without any resolver input. */
export function gridFromFreeIntervals(
  intervals: readonly BusyBlock[],
  timezone: string
): BookableSlot[] {
  const stepMs = SLOT_STEP_MINUTES * 60_000;
  const minMs = MIN_SLOT_MINUTES * 60_000;
  const slots: BookableSlot[] = [];

  for (const interval of intervals) {
    const endMs = interval.endAt.getTime();
    let cursor = alignToLocalSlotBoundary(interval.startAt, timezone).getTime();
    while (endMs - cursor >= minMs) {
      slots.push({
        startAt: new Date(cursor),
        maxDurationMinutes: floorToLadder(Math.floor((endMs - cursor) / 60_000)),
      });
      cursor += stepMs;
    }
  }

  slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return slots;
}

/** Smallest instant ≥ `instant` whose wall clock in `timezone` sits on a 15-min boundary. */
export function alignToLocalSlotBoundary(instant: Date, timezone: string): Date {
  const zoned = toZonedTime(instant, timezone);
  const intoStepMs =
    (zoned.getMinutes() % SLOT_STEP_MINUTES) * 60_000 +
    zoned.getSeconds() * 1_000 +
    zoned.getMilliseconds();
  if (intoStepMs === 0) return new Date(instant);
  return new Date(instant.getTime() + (SLOT_STEP_MINUTES * 60_000 - intoStepMs));
}

/** Largest ladder value ≤ `rawMinutes`; caller guarantees `rawMinutes >= MIN_SLOT_MINUTES`. */
export function floorToLadder(rawMinutes: number): SlotDurationMinutes {
  const capped = Math.min(rawMinutes, MAX_SLOT_MINUTES);
  let best: SlotDurationMinutes = MIN_SLOT_MINUTES;
  for (const rung of SLOT_DURATION_LADDER) {
    if (rung <= capped) {
      best = rung;
    }
  }
  return best;
}
