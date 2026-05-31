import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import type {
  BusyBlock,
  ResolverConsultation,
  ResolverInput,
  ResolverResult,
  ResolverRule,
} from './types.js';

/**
 * Pure, provider-agnostic earliest-availability resolver.
 *
 * Algorithm (BAL-243 plan §4.3):
 *   1. Bound window to `[now, now + horizonDays)`.
 *   2. Group rules by `dayOfWeek`.
 *   3. Per-date expand rules into UTC using `fromZonedTime` (DST-correct).
 *   4. Clip windows to the bounded range.
 *   5. Merge overlapping/adjacent rule windows on the same day.
 *   6. Subtract busy intervals (consultations ++ vendor busy blocks).
 *   7. Drop sub-windows shorter than `minMinutes`.
 *   8. Return `earliestAvailableAt = head?.startAt ?? null`.
 *
 * Pure: no DB, no env, no I/O, no logging. The wire-up service in
 * `./resolve-and-cache.ts` is the impure adapter.
 *
 * DST: during spring-forward (e.g. a 02:30 rule on the day the clock jumps
 * 02:00 → 03:00) the local instant does not exist. `fromZonedTime` v3 resolves
 * this leniently — it interprets the wall-clock value using the post-transition
 * offset, which round-trips to an earlier real local time (e.g. Sydney
 * 2026-10-04 02:30 → 2026-10-03T15:30:00Z, which is 01:30 AEST). For an expert
 * with a rule starting in the skipped hour on the DST-flip day, this means
 * the slot opens up to one hour earlier than the wall-clock value suggests —
 * accepted for v1 (locked by `resolver.test.ts > DST spring-forward`).
 */
export function resolve(input: ResolverInput): ResolverResult {
  const { rules, baloConsultations, busyBlocks, timezone, now, horizonDays, minMinutes } = input;

  const { rangeStart, rangeEnd } = boundWindow(now, horizonDays);
  if (rangeStart >= rangeEnd) {
    return { earliestAvailableAt: null };
  }

  const rulesByDow = groupRulesByDayOfWeek(rules);
  if (rulesByDow.size === 0) {
    return { earliestAvailableAt: null };
  }

  const expanded = expandRulesInRange(rulesByDow, rangeStart, rangeEnd, timezone);
  const clipped = clipToWindow(expanded, rangeStart, rangeEnd);
  if (clipped.length === 0) {
    return { earliestAvailableAt: null };
  }

  const merged = mergeOverlapping(clipped);
  const busy = combineBusyIntervals(baloConsultations, busyBlocks);

  const free: BusyBlock[] = [];
  for (const window of merged) {
    free.push(...subtractBusy(window, busy));
  }

  const minMs = minMinutes * 60 * 1000;
  const longEnough = free.filter((w) => w.endAt.getTime() - w.startAt.getTime() >= minMs);
  if (longEnough.length === 0) {
    return { earliestAvailableAt: null };
  }

  longEnough.sort(compareByStart);
  const head = longEnough[0];
  if (!head) {
    return { earliestAvailableAt: null };
  }
  // Defensive clamp in case step 1's ceil didn't catch a sub-rangeStart head.
  return { earliestAvailableAt: laterOf(head.startAt, now) };
}

// ── Step helpers ───────────────────────────────────────────────

function boundWindow(now: Date, horizonDays: number): { rangeStart: Date; rangeEnd: Date } {
  // Truncate `now` to the next minute so the earliest result is a clean instant.
  const rangeStart = ceilToNextMinute(now);
  const rangeEnd = new Date(rangeStart.getTime() + horizonDays * 24 * 60 * 60 * 1000);
  return { rangeStart, rangeEnd };
}

function groupRulesByDayOfWeek(rules: ResolverRule[]): Map<number, ResolverRule[]> {
  const byDow = new Map<number, ResolverRule[]>();
  for (const rule of rules) {
    const bucket = byDow.get(rule.dayOfWeek);
    if (bucket) {
      bucket.push(rule);
    } else {
      byDow.set(rule.dayOfWeek, [rule]);
    }
  }
  return byDow;
}

/**
 * Iterate dates in the expert's timezone so a single rule on `dow = 1` (Mon)
 * produces the correct UTC instant on every Monday across DST transitions.
 */
function expandRulesInRange(
  rulesByDow: Map<number, ResolverRule[]>,
  rangeStart: Date,
  rangeEnd: Date,
  timezone: string
): BusyBlock[] {
  const expanded: BusyBlock[] = [];
  const zonedNow = toZonedTime(rangeStart, timezone);
  const zonedEnd = toZonedTime(rangeEnd, timezone);

  const dateCursor = new Date(zonedNow.getFullYear(), zonedNow.getMonth(), zonedNow.getDate());
  const lastDate = new Date(zonedEnd.getFullYear(), zonedEnd.getMonth(), zonedEnd.getDate());

  while (dateCursor <= lastDate) {
    const dayRules = rulesByDow.get(dateCursor.getDay());
    if (dayRules) {
      const dateStr = formatDateOnly(dateCursor);
      for (const rule of dayRules) {
        const window = expandRuleOnDate(rule, dateStr, timezone);
        if (window) expanded.push(window);
      }
    }
    // Advance one day in local time. DST-safe: a +1d local jump is what we
    // want here because we're iterating local dates, not adding 24h to UTC.
    dateCursor.setDate(dateCursor.getDate() + 1);
  }
  return expanded;
}

function expandRuleOnDate(rule: ResolverRule, dateStr: string, timezone: string): BusyBlock | null {
  const startTime = padTime(rule.startTime);
  const endTime = padTime(rule.endTime);
  const utcStart = fromZonedTime(`${dateStr}T${startTime}`, timezone);
  const utcEnd = fromZonedTime(`${dateStr}T${endTime}`, timezone);

  if (!Number.isFinite(utcStart.getTime()) || !Number.isFinite(utcEnd.getTime())) {
    return null;
  }
  if (utcEnd <= utcStart) {
    return null;
  }
  return { startAt: utcStart, endAt: utcEnd };
}

function clipToWindow(windows: BusyBlock[], rangeStart: Date, rangeEnd: Date): BusyBlock[] {
  const clipped: BusyBlock[] = [];
  for (const window of windows) {
    if (window.endAt <= rangeStart || window.startAt >= rangeEnd) continue;
    clipped.push({
      startAt: laterOf(window.startAt, rangeStart),
      endAt: earlierOf(window.endAt, rangeEnd),
    });
  }
  return clipped;
}

function mergeOverlapping(windows: BusyBlock[]): BusyBlock[] {
  windows.sort(compareByStart);
  const merged: BusyBlock[] = [];
  for (const window of windows) {
    const last = merged.at(-1);
    if (last && window.startAt <= last.endAt) {
      if (window.endAt > last.endAt) {
        last.endAt = window.endAt;
      }
    } else {
      merged.push({ startAt: window.startAt, endAt: window.endAt });
    }
  }
  return merged;
}

function combineBusyIntervals(
  consultations: ResolverConsultation[],
  busyBlocks: BusyBlock[]
): BusyBlock[] {
  return [
    ...consultations.map<BusyBlock>((c) => ({ startAt: c.startAt, endAt: c.endAt })),
    ...busyBlocks,
  ].sort(compareByStart);
}

/**
 * Subtract every busy interval from a single open window, producing 0..N
 * sub-windows. Standard interval-difference; busy is pre-sorted by startAt.
 */
function subtractBusy(window: BusyBlock, busy: BusyBlock[]): BusyBlock[] {
  let segments: BusyBlock[] = [{ startAt: window.startAt, endAt: window.endAt }];

  for (const b of busy) {
    if (b.endAt <= window.startAt) continue;
    if (b.startAt >= window.endAt) break;

    const next: BusyBlock[] = [];
    for (const seg of segments) {
      next.push(...subtractBusyFromSegment(seg, b));
    }
    segments = next;
    if (segments.length === 0) break;
  }

  return segments;
}

/** Subtract one busy interval from one segment → 0, 1, or 2 sub-segments. */
function subtractBusyFromSegment(seg: BusyBlock, busy: BusyBlock): BusyBlock[] {
  if (busy.endAt <= seg.startAt || busy.startAt >= seg.endAt) {
    return [seg];
  }
  const pieces: BusyBlock[] = [];
  if (busy.startAt > seg.startAt) {
    pieces.push({ startAt: seg.startAt, endAt: busy.startAt });
  }
  if (busy.endAt < seg.endAt) {
    pieces.push({ startAt: busy.endAt, endAt: seg.endAt });
  }
  return pieces;
}

// ── Primitives ─────────────────────────────────────────────────

function compareByStart(a: BusyBlock, b: BusyBlock): number {
  return a.startAt.getTime() - b.startAt.getTime();
}

function laterOf(a: Date, b: Date): Date {
  return new Date(Math.max(a.getTime(), b.getTime()));
}

function earlierOf(a: Date, b: Date): Date {
  return new Date(Math.min(a.getTime(), b.getTime()));
}

/** Round `d` up to the next whole minute (UTC). */
function ceilToNextMinute(d: Date): Date {
  const ms = d.getTime();
  const minuteMs = 60 * 1000;
  const remainder = ms % minuteMs;
  if (remainder === 0) return new Date(ms);
  return new Date(ms + (minuteMs - remainder));
}

/** Format a local `Date` as `YYYY-MM-DD` (uses local getters; caller controls tz). */
function formatDateOnly(d: Date): string {
  const yyyy = d.getFullYear().toString().padStart(4, '0');
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Normalise `'HH:mm'` to `'HH:mm:ss'`. Postgres `time` returns `'09:00:00'` already. */
function padTime(t: string): string {
  return t.length === 5 ? `${t}:00` : t;
}
