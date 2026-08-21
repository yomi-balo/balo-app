import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_CACHE_TTL_SECONDS,
  AVAILABILITY_LEAD_GUARD_MINUTES,
  SLOT_DURATION_LADDER,
  SLOT_STEP_MINUTES,
} from '@balo/shared/availability';
import { listBookableSlots, type SlotGridInput } from './slot-grid.js';
import { isWindowBookable } from './resolver.js';
import type { BusyBlock, ResolverConsultation, ResolverRule } from './types.js';

/**
 * The worst-case gap between the instant a grid is computed and the instant `isWindowBookable`
 * is asked about one of its slots. TWO caches in series (Redis TTL + the browser's `max-age`,
 * both `AVAILABILITY_CACHE_TTL_SECONDS`) plus a minute of latency/skew/think-time — exactly the
 * quantity `AVAILABILITY_LEAD_GUARD_MINUTES` is sized against in `@balo/shared/availability`.
 */
const WORST_CASE_STALENESS_MS = AVAILABILITY_CACHE_TTL_SECONDS * 2 * 1000 + 60_000;

/**
 * BAL-236 — the advertise/accept pin (apiroc skill §9.6). For every slot `listBookableSlots`
 * returns, and every ladder duration `d <= maxDuration`, `isWindowBookable` over the SAME
 * inputs must return `true`. This is the test that prevents advertising a slot the booking
 * gate then refuses.
 *
 * ⚠ THE SAME-INSTANT CHECK ALONE IS VACUOUS. Asking `isWindowBookable` at `input.now` — the very
 * instant the grid was computed — can only prove "at time T, what was advertised at time T is
 * accepted", which is true by construction and cannot fail. The entire reason
 * `leadGuardMinutes` exists is that the gate runs LATER, off a cached grid, so this helper also
 * re-asks at `now + WORST_CASE_STALENESS_MS`. That second question is the one the guard band
 * answers; delete `leadGuardMinutes` from `expert-slots.ts` or shrink the constant below the
 * two-layer figure and the notice-band scenario below goes red.
 */
function assertAdvertiseAcceptEquivalence(input: SlotGridInput): void {
  const slots = listBookableSlots(input);
  expect(slots.length).toBeGreaterThan(0);

  for (const slot of slots) {
    for (const d of SLOT_DURATION_LADDER) {
      if (d > slot.maxDurationMinutes) continue;
      const end = new Date(slot.startAt.getTime() + d * 60_000);
      const accepted = isWindowBookable({
        rules: input.rules,
        baloConsultations: input.baloConsultations,
        busyBlocks: input.busyBlocks,
        overrideBlocks: input.overrideBlocks,
        timezone: input.timezone,
        now: input.now,
        start: slot.startAt,
        end,
        bufferBeforeMinutes: input.bufferBeforeMinutes,
        bufferAfterMinutes: input.bufferAfterMinutes,
        minimumNoticeMinutes: input.minimumNoticeMinutes,
      });
      expect(accepted).toBe(true);
    }
  }

  const [first] = slots;
  if (first === undefined) return;

  // ⚠ THE STALENESS RE-CHECK — the half the same-instant loop above cannot express. The first
  // slot is the one nearest the notice edge, so it is the only one staleness can push over it.
  const staleAccepted = isWindowBookable({
    rules: input.rules,
    baloConsultations: input.baloConsultations,
    busyBlocks: input.busyBlocks,
    overrideBlocks: input.overrideBlocks,
    timezone: input.timezone,
    now: new Date(input.now.getTime() + WORST_CASE_STALENESS_MS),
    start: first.startAt,
    end: new Date(first.startAt.getTime() + SLOT_STEP_MINUTES * 60_000),
    bufferBeforeMinutes: input.bufferBeforeMinutes,
    bufferAfterMinutes: input.bufferAfterMinutes,
    minimumNoticeMinutes: input.minimumNoticeMinutes,
  });
  expect(
    staleAccepted,
    'the first advertised slot must still be bookable after both cache layers have gone stale'
  ).toBe(true);

  // A start one step BEFORE the first emitted slot must be refused.
  const before = new Date(first.startAt.getTime() - SLOT_STEP_MINUTES * 60_000);
  const beforeAccepted = isWindowBookable({
    rules: input.rules,
    baloConsultations: input.baloConsultations,
    busyBlocks: input.busyBlocks,
    overrideBlocks: input.overrideBlocks,
    timezone: input.timezone,
    now: input.now,
    start: before,
    end: new Date(before.getTime() + 15 * 60_000),
    bufferBeforeMinutes: input.bufferBeforeMinutes,
    bufferAfterMinutes: input.bufferAfterMinutes,
    minimumNoticeMinutes: input.minimumNoticeMinutes,
  });
  expect(beforeAccepted).toBe(false);
}

describe('slot-grid / isWindowBookable equivalence (advertise/accept pin)', () => {
  const now = new Date('2026-06-01T00:00:00.000Z'); // Monday
  const weekdayRule: ResolverRule = { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' };
  const crossMidnightRule: ResolverRule = { dayOfWeek: 1, startTime: '22:00', endTime: '02:00' };

  it('plain rules, no busy sources', () => {
    assertAdvertiseAcceptEquivalence({
      rules: [weekdayRule],
      baloConsultations: [],
      busyBlocks: [],
      overrideBlocks: [],
      timezone: 'UTC',
      now,
      horizonDays: 7,
    });
  });

  it('rules + a Balo consultation', () => {
    const consultation: ResolverConsultation = {
      startAt: new Date('2026-06-01T10:00:00.000Z'),
      endAt: new Date('2026-06-01T11:00:00.000Z'),
    };
    assertAdvertiseAcceptEquivalence({
      rules: [weekdayRule],
      baloConsultations: [consultation],
      busyBlocks: [],
      overrideBlocks: [],
      timezone: 'UTC',
      now,
      horizonDays: 7,
    });
  });

  it('rules + a vendor busy block', () => {
    const busy: BusyBlock = {
      startAt: new Date('2026-06-01T13:00:00.000Z'),
      endAt: new Date('2026-06-01T14:00:00.000Z'),
    };
    assertAdvertiseAcceptEquivalence({
      rules: [weekdayRule],
      baloConsultations: [],
      busyBlocks: [busy],
      overrideBlocks: [],
      timezone: 'UTC',
      now,
      horizonDays: 7,
    });
  });

  it('rules + an override (time off) block', () => {
    const override: BusyBlock = {
      startAt: new Date('2026-06-01T09:00:00.000Z'),
      endAt: new Date('2026-06-01T12:00:00.000Z'),
    };
    assertAdvertiseAcceptEquivalence({
      rules: [weekdayRule],
      baloConsultations: [],
      busyBlocks: [],
      overrideBlocks: [override],
      timezone: 'UTC',
      now,
      horizonDays: 7,
    });
  });

  it('buffers > 0', () => {
    const busy: BusyBlock = {
      startAt: new Date('2026-06-01T13:00:00.000Z'),
      endAt: new Date('2026-06-01T14:00:00.000Z'),
    };
    assertAdvertiseAcceptEquivalence({
      rules: [weekdayRule],
      baloConsultations: [],
      busyBlocks: [busy],
      overrideBlocks: [],
      timezone: 'UTC',
      now,
      horizonDays: 7,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
    });
  });

  it('notice > 0', () => {
    assertAdvertiseAcceptEquivalence({
      rules: [weekdayRule],
      baloConsultations: [],
      busyBlocks: [],
      overrideBlocks: [],
      timezone: 'UTC',
      now,
      horizonDays: 7,
      minimumNoticeMinutes: 120,
    });
  });

  /**
   * ⚠ THE ONLY SCENARIO WHERE THE NEGATIVE PROBE MEANS ANYTHING. In every other case `now` is
   * `00:00` while the rules open at `09:00`, so "one step before the first slot" lands outside
   * published hours and the refusal proves nothing about the notice band — it re-tests the
   * weekly rules. Here the rules run `00:00`–`23:45` and `now` is `10:00`, INSIDE them, so the
   * only thing that can refuse `10:45` is the notice.
   *
   * `notice = 60 - guard` makes `now + notice + guard` land exactly on a 15-minute boundary
   * (11:00), so the first advertised slot is 11:00 and the step before it — 10:45 — falls
   * strictly inside the notice band (earliest acceptable start is 10:57). Written as an
   * expression, not a literal, so the pair cannot silently drift apart when the guard changes.
   */
  it('the notice band — with `now` INSIDE published hours, and a cached-grid staleness re-check', () => {
    assertAdvertiseAcceptEquivalence({
      rules: [{ dayOfWeek: 1, startTime: '00:00', endTime: '23:45' }],
      baloConsultations: [],
      busyBlocks: [],
      overrideBlocks: [],
      timezone: 'UTC',
      now: new Date('2026-06-01T10:00:00.000Z'),
      horizonDays: 1,
      minimumNoticeMinutes: 60 - AVAILABILITY_LEAD_GUARD_MINUTES,
      leadGuardMinutes: AVAILABILITY_LEAD_GUARD_MINUTES,
    });
  });

  it('a cross-midnight rule', () => {
    assertAdvertiseAcceptEquivalence({
      rules: [crossMidnightRule],
      baloConsultations: [],
      busyBlocks: [],
      overrideBlocks: [],
      timezone: 'UTC',
      now,
      horizonDays: 7,
    });
  });

  it('a DST-transition day (Australia/Sydney spring-forward)', () => {
    // 2026-10-04 is a Sunday in Sydney; use a Sunday rule so the expanded window covers the
    // transition night. dayOfWeek 0 = Sunday.
    const sundayRule: ResolverRule = { dayOfWeek: 0, startTime: '00:00', endTime: '06:00' };
    assertAdvertiseAcceptEquivalence({
      rules: [sundayRule],
      baloConsultations: [],
      busyBlocks: [],
      overrideBlocks: [],
      timezone: 'Australia/Sydney',
      now: new Date('2026-10-03T00:00:00.000Z'),
      horizonDays: 3,
    });
  });
});
