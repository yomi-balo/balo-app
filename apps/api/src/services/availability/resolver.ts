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

  // ── Step 1: Bound the window ───────────────────────────────────
  // Truncate `now` to the next minute so the earliest result is a clean instant.
  const rangeStart = ceilToNextMinute(now);
  const rangeEnd = new Date(rangeStart.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  if (rangeStart >= rangeEnd) {
    return { earliestAvailableAt: null };
  }

  // ── Step 2: Group rules by dayOfWeek ───────────────────────────
  const rulesByDow = new Map<number, ResolverRule[]>();
  for (const rule of rules) {
    const bucket = rulesByDow.get(rule.dayOfWeek);
    if (bucket) {
      bucket.push(rule);
    } else {
      rulesByDow.set(rule.dayOfWeek, [rule]);
    }
  }

  if (rulesByDow.size === 0) {
    return { earliestAvailableAt: null };
  }

  // ── Step 3: Expand rules per date in the expert's timezone ─────
  // We iterate dates in the expert's tz so a single rule on `dow = 1` (Mon)
  // produces the correct UTC instant on every Monday across DST transitions.
  const expanded: BusyBlock[] = [];

  const zonedNow = toZonedTime(rangeStart, timezone);
  const zonedEnd = toZonedTime(rangeEnd, timezone);

  // Build YYYY-MM-DD strings for every date the horizon touches in the tz.
  const dateCursor = new Date(zonedNow.getFullYear(), zonedNow.getMonth(), zonedNow.getDate());
  const lastDate = new Date(zonedEnd.getFullYear(), zonedEnd.getMonth(), zonedEnd.getDate());

  while (dateCursor <= lastDate) {
    const dow = dateCursor.getDay();
    const dayRules = rulesByDow.get(dow);

    if (dayRules) {
      const dateStr = formatDateOnly(dateCursor);
      for (const rule of dayRules) {
        const startTime = padTime(rule.startTime);
        const endTime = padTime(rule.endTime);
        const utcStart = fromZonedTime(`${dateStr}T${startTime}`, timezone);
        const utcEnd = fromZonedTime(`${dateStr}T${endTime}`, timezone);

        if (!Number.isFinite(utcStart.getTime()) || !Number.isFinite(utcEnd.getTime())) {
          continue;
        }
        if (utcEnd <= utcStart) {
          continue;
        }

        expanded.push({ startAt: utcStart, endAt: utcEnd });
      }
    }

    // Advance one day in local time. DST-safe: a +1d local jump is what we
    // want here because we're iterating local dates, not adding 24h to UTC.
    dateCursor.setDate(dateCursor.getDate() + 1);
  }

  // ── Step 4: Clip to window ─────────────────────────────────────
  const clipped: BusyBlock[] = [];
  for (const window of expanded) {
    if (window.endAt <= rangeStart || window.startAt >= rangeEnd) {
      continue;
    }
    clipped.push({
      startAt: window.startAt < rangeStart ? rangeStart : window.startAt,
      endAt: window.endAt > rangeEnd ? rangeEnd : window.endAt,
    });
  }

  if (clipped.length === 0) {
    return { earliestAvailableAt: null };
  }

  // ── Step 5: Merge overlapping rule windows ─────────────────────
  clipped.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const merged: BusyBlock[] = [];
  for (const window of clipped) {
    const last = merged[merged.length - 1];
    if (last && window.startAt <= last.endAt) {
      if (window.endAt > last.endAt) {
        last.endAt = window.endAt;
      }
    } else {
      merged.push({ startAt: window.startAt, endAt: window.endAt });
    }
  }

  // ── Step 6: Subtract busy intervals ────────────────────────────
  const busy: BusyBlock[] = [
    ...baloConsultations.map<BusyBlock>((c: ResolverConsultation) => ({
      startAt: c.startAt,
      endAt: c.endAt,
    })),
    ...busyBlocks,
  ].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  const free: BusyBlock[] = [];
  for (const window of merged) {
    free.push(...subtractBusy(window, busy));
  }

  // ── Step 7: Drop short gaps ────────────────────────────────────
  const minMs = minMinutes * 60 * 1000;
  const longEnough = free.filter((w) => w.endAt.getTime() - w.startAt.getTime() >= minMs);

  if (longEnough.length === 0) {
    return { earliestAvailableAt: null };
  }

  // ── Step 8: Return earliest ────────────────────────────────────
  longEnough.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const head = longEnough[0]!;
  // Defensive clamp in case step 1's ceil didn't catch a sub-rangeStart head.
  const earliest = head.startAt < now ? now : head.startAt;
  return { earliestAvailableAt: earliest };
}

// ── Helpers ────────────────────────────────────────────────────

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
      if (b.endAt <= seg.startAt || b.startAt >= seg.endAt) {
        next.push(seg);
        continue;
      }
      // Overlap: split into 0, 1, or 2 pieces.
      if (b.startAt > seg.startAt) {
        next.push({ startAt: seg.startAt, endAt: b.startAt });
      }
      if (b.endAt < seg.endAt) {
        next.push({ startAt: b.endAt, endAt: seg.endAt });
      }
    }
    segments = next;
    if (segments.length === 0) break;
  }

  return segments;
}
