/**
 * BAL-581 — THE VENUE REPAIR CHECKPOINT SCHEDULE. Pure, stateless, deterministic:
 * given a meeting's `createdAt`/`scheduledStart` and `now`, says whether a repair attempt is
 * due THIS tick, and whether it is the FINAL one before the cutoff.
 *
 * ⚠⚠ NO NEW COLUMN, NO REDIS KEY. The schedule is re-derived from `created_at` and
 * `scheduled_start` on every call — a reschedule of a roomless meeting therefore re-derives the
 * around-start series for free, and the whole "attempt count so far" state that a stateful
 * design would need to track never exists to get out of sync.
 *
 * ── THE CHECKPOINT SET ────────────────────────────────────────────────────────────────────
 *
 * The union of three series, each filtered to `createdAt < checkpoint < cutoff`:
 *   · booking-anchored  — {@link AFTER_BOOKING_MINUTES} minutes after `createdAt`. Heals a
 *     transient failure within minutes and a short outage within hours.
 *   · daily             — once every {@link DAILY_REPAIR_INTERVAL_MS} after `createdAt`, for a
 *     long-lead booking that would otherwise wait weeks for its next start-anchored checkpoint.
 *   · start-anchored    — {@link AROUND_START_MINUTES} minutes around `scheduledStart`, densest
 *     near the start — the last chance to salvage the call.
 *
 * ── THE ONE-TICK CATCH-UP ─────────────────────────────────────────────────────────────────
 *
 * A checkpoint is DUE in a tick whose minute bucket is the checkpoint's own bucket OR the bucket
 * immediately after it — so a cron tick that runs a few seconds late, or a deploy that skips one
 * tick, still fires the checkpoint on the very next tick. The two ticks that see the same
 * checkpoint compute the SAME `checkpointBucket`, hence the SAME BullMQ jobId
 * (`jobs/meeting-venue-repair.ts`'s `buildJobId(..., 'c' + checkpointBucket)`), so the retained
 * job from the first tick silently dedupes the second — no double attempt, no extra Daily call.
 * A tick that is late by TWO OR MORE buckets loses that one checkpoint permanently; the next
 * scheduled checkpoint (finite or daily) still fires normally.
 *
 * ── VOLUME BOUND ──────────────────────────────────────────────────────────────────────────
 *
 * Per `scheduled_start` VALUE: at most `AFTER_BOOKING_MINUTES.length +
 * AROUND_START_MINUTES.length` (9 + 11 = 20) finite attempts, plus
 * `⌊(cutoff − created_at) / 1 day⌋` daily attempts. Each reschedule of a still-roomless meeting
 * adds at most `AROUND_START_MINUTES.length` (11) further start-anchored attempts, because the
 * start series is re-derived from the CURRENT `scheduledStart` on every call — there is no
 * bound on reschedule COUNT, only on the cost of each one. During a vendor outage every
 * affected meeting fails AT MOST ONCE per checkpoint (never a tight retry loop), and only the
 * FINAL checkpoint before the cutoff escalates to `log.error` + Sentry — so the outage
 * costs one loud event per meeting, not one per attempt.
 */
import type { MeetingTimers } from '@balo/shared/meetings';

const MS_PER_MINUTE = 60_000;

/** The producer's cadence. A checkpoint is "due" in the tick whose minute bucket contains it. */
export const VENUE_REPAIR_TICK_MS = MS_PER_MINUTE;

/** A repair may only START while `now` is strictly before this margin's cutoff. */
export const VENUE_REPAIR_CUTOFF_MARGIN_MS = 2 * MS_PER_MINUTE;

/** Booking-anchored checkpoints, in minutes after `createdAt`. */
export const AFTER_BOOKING_MINUTES = [2, 5, 15, 30, 60, 120, 240, 480, 960] as const;

/** Then once per day after `createdAt` — a long-lead meeting never waits weeks after an outage. */
export const DAILY_REPAIR_INTERVAL_MS = 24 * 60 * MS_PER_MINUTE;

/** Start-anchored checkpoints, in minutes relative to `scheduledStart`. */
export const AROUND_START_MINUTES = [-180, -60, -30, -15, -8, -4, -2, 0, 2, 4, 6] as const;

export interface VenueRepairScheduleInput {
  readonly now: Date;
  readonly createdAt: Date;
  readonly scheduledStart: Date;
  readonly timers: MeetingTimers;
}

export interface DueVenueRepair {
  /** `Math.floor(checkpointMs / VENUE_REPAIR_TICK_MS)` — the jobId token. */
  readonly checkpointBucket: number;
  /** True when no later checkpoint exists before the cutoff — the only escalating failure. */
  readonly final: boolean;
}

/** `Math.floor(ms / VENUE_REPAIR_TICK_MS)` — shared by the schedule and the producer. */
export function bucketOf(ms: number): number {
  return Math.floor(ms / VENUE_REPAIR_TICK_MS);
}

/** `scheduledStart + missedCallTerminationMs − VENUE_REPAIR_CUTOFF_MARGIN_MS`. EXCLUSIVE. */
export function venueRepairCutoff(scheduledStart: Date, timers: MeetingTimers): Date {
  return new Date(
    scheduledStart.getTime() + timers.missedCallTerminationMs - VENUE_REPAIR_CUTOFF_MARGIN_MS
  );
}

/** The instant from which a meeting is in the producer's candidate window. */
export function venueRepairCandidateStartAfter(now: Date, timers: MeetingTimers): Date {
  return new Date(now.getTime() - (timers.missedCallTerminationMs - VENUE_REPAIR_CUTOFF_MARGIN_MS));
}

/**
 * The FINITE checkpoint instants (booking-anchored ∪ start-anchored), filtered to
 * `createdAt < checkpoint < cutoff`. Small and fixed-size (≤ 20 entries) — safe to materialise.
 */
function finiteCheckpoints(input: VenueRepairScheduleInput, cutoffMs: number): number[] {
  const createdMs = input.createdAt.getTime();
  const startMs = input.scheduledStart.getTime();
  const candidates = [
    ...AFTER_BOOKING_MINUTES.map((minutes) => createdMs + minutes * MS_PER_MINUTE),
    ...AROUND_START_MINUTES.map((minutes) => startMs + minutes * MS_PER_MINUTE),
  ];
  return candidates.filter((c) => c > createdMs && c < cutoffMs);
}

/**
 * The DAILY checkpoint instants whose own minute bucket is one of `buckets` — evaluated
 * arithmetically over the tiny window `buckets` spans, never by materialising the whole daily
 * series. `buckets` is always the two-bucket catch-up window, so this costs O(1) regardless of
 * how many days out the meeting is.
 */
function dailyCheckpointsInBuckets(
  createdMs: number,
  cutoffMs: number,
  buckets: readonly number[]
): number[] {
  const bucketSet = new Set(buckets);
  const windowStartMs = Math.min(...buckets) * VENUE_REPAIR_TICK_MS;
  const windowEndMs = (Math.max(...buckets) + 1) * VENUE_REPAIR_TICK_MS;
  const jMin = Math.max(1, Math.floor((windowStartMs - createdMs) / DAILY_REPAIR_INTERVAL_MS));
  const jMax = Math.floor((windowEndMs - createdMs) / DAILY_REPAIR_INTERVAL_MS);

  const results: number[] = [];
  for (let j = jMin; j <= jMax; j += 1) {
    const c = createdMs + j * DAILY_REPAIR_INTERVAL_MS;
    if (c < cutoffMs && bucketSet.has(bucketOf(c))) {
      results.push(c);
    }
  }
  return results;
}

/**
 * The LATEST checkpoint bucket strictly before the cutoff — the bucket that decides `final`.
 * `null` only when neither series has a checkpoint before the cutoff at all (a meeting booked
 * with no room left for even one attempt — e.g. booked past its own cutoff).
 */
function lastCheckpointBucketBefore(
  input: VenueRepairScheduleInput,
  cutoffMs: number
): number | null {
  const createdMs = input.createdAt.getTime();
  const finite = finiteCheckpoints(input, cutoffMs);
  const lastFiniteMs = finite.length > 0 ? Math.max(...finite) : null;

  const jLast = Math.floor((cutoffMs - 1 - createdMs) / DAILY_REPAIR_INTERVAL_MS);
  const lastDailyMs = jLast >= 1 ? createdMs + jLast * DAILY_REPAIR_INTERVAL_MS : null;

  const candidates = [lastFiniteMs, lastDailyMs].filter((ms): ms is number => ms !== null);
  if (candidates.length === 0) return null;
  return bucketOf(Math.max(...candidates));
}

/**
 * The checkpoint due in THIS tick, or `null`.
 *
 * DUE ⇔ some checkpoint's bucket ∈ {bucket(now) − 1, bucket(now)} (the one-tick catch-up — see
 * the module docblock). Returns the LATEST due bucket when both the fresh and catch-up buckets
 * have a checkpoint. `now >= cutoff` ⇒ `null` unconditionally — a repair may not START
 * past the cutoff, even to catch up a checkpoint that fell just inside it.
 *
 * `final` ⇔ the returned checkpoint IS the last one strictly before the cutoff.
 */
export function dueVenueRepair(input: VenueRepairScheduleInput): DueVenueRepair | null {
  const cutoffMs = venueRepairCutoff(input.scheduledStart, input.timers).getTime();
  const nowMs = input.now.getTime();
  if (nowMs >= cutoffMs) return null;

  const createdMs = input.createdAt.getTime();
  const nowBucket = bucketOf(nowMs);
  const catchUpBucket = nowBucket - 1;
  const catchUpWindow = [catchUpBucket, nowBucket];

  const finite = finiteCheckpoints(input, cutoffMs);
  const daily = dailyCheckpointsInBuckets(createdMs, cutoffMs, catchUpWindow);

  const dueBuckets = [...finite, ...daily]
    .map(bucketOf)
    .filter((bucket) => bucket === nowBucket || bucket === catchUpBucket);
  if (dueBuckets.length === 0) return null;

  const dueBucket = Math.max(...dueBuckets);
  const lastBucket = lastCheckpointBucketBefore(input, cutoffMs);
  return { checkpointBucket: dueBucket, final: dueBucket === lastBucket };
}
