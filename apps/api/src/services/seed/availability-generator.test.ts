import { describe, it, expect } from 'vitest';
import { fromZonedTime } from 'date-fns-tz';
import { archetypeForIndex, generateAvailabilityPlan } from './availability-generator.js';
import { DEFAULT_SEED } from './constants.js';
import type { Archetype, AvailabilityPlan } from './types.js';

const BASELINE = new Date('2026-05-31T00:00:00.000Z'); // a Sunday in UTC
const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = 'Australia/Sydney';

function makeExperts(count: number): { id: string; index: number; timezone: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `profile-${index}`,
    index,
    timezone: TZ,
  }));
}

function plan(count: number, seed = DEFAULT_SEED): AvailabilityPlan[] {
  return generateAvailabilityPlan({ experts: makeExperts(count), seed, baselineNow: BASELINE });
}

describe('archetypeForIndex — exact distribution', () => {
  it('produces the documented 24/12/9/9/6 split for count=60', () => {
    const counts: Record<Archetype, number> = {
      WIDE_OPEN: 0,
      SPARSE: 0,
      NEXT_WEEK: 0,
      TODAY_ONLY: 0,
      BOOKED_SOLID: 0,
    };
    for (let i = 0; i < 60; i++) {
      counts[archetypeForIndex(i, 60)] += 1;
    }
    expect(counts).toEqual({
      WIDE_OPEN: 24,
      SPARSE: 12,
      NEXT_WEEK: 9,
      TODAY_ONLY: 9,
      BOOKED_SOLID: 6,
    });
  });

  it('is deterministic and proportional for an arbitrary count', () => {
    const counts: Record<Archetype, number> = {
      WIDE_OPEN: 0,
      SPARSE: 0,
      NEXT_WEEK: 0,
      TODAY_ONLY: 0,
      BOOKED_SOLID: 0,
    };
    for (let i = 0; i < 100; i++) {
      counts[archetypeForIndex(i, 100)] += 1;
    }
    expect(counts).toEqual({
      WIDE_OPEN: 40, // indices 0-39
      SPARSE: 20, // indices 40-59
      NEXT_WEEK: 15, // indices 60-74
      TODAY_ONLY: 15, // indices 75-89
      BOOKED_SOLID: 10, // indices 90-99
    });
  });
});

describe('generateAvailabilityPlan — determinism', () => {
  it('produces deep-equal plans for the same inputs', () => {
    expect(plan(60)).toEqual(plan(60));
  });

  it('tags each plan with its archetype by index', () => {
    const plans = plan(60);
    for (const p of plans) {
      expect(p.archetype).toBe(archetypeForIndex(p.index, 60));
    }
  });
});

describe('generateAvailabilityPlan — WIDE_OPEN', () => {
  it('emits Mon–Fri 09:00–17:00 rules', () => {
    const wideOpen = plan(60).find((p) => p.archetype === 'WIDE_OPEN')!;
    const dows = wideOpen.rules.map((r) => r.dayOfWeek).sort((a, b) => a - b);
    expect(dows).toEqual([1, 2, 3, 4, 5]);
    for (const rule of wideOpen.rules) {
      expect(rule.startTime).toBe('09:00');
      expect(rule.endTime).toBe('17:00');
    }
  });
});

describe('generateAvailabilityPlan — window-aligned confirmed consultation', () => {
  it('places the first WIDE_OPEN expert’s confirmed consult inside one of its rule windows (in the expert tz)', () => {
    const plans = plan(60);
    const firstWideOpen = plans.find((p) => p.archetype === 'WIDE_OPEN')!;
    const confirmed = firstWideOpen.consultations.filter((c) => c.status === 'confirmed');
    expect(confirmed.length).toBe(1);
    const consult = confirmed[0]!;

    // Local Y-M-D and day-of-week of the consult start, in the expert tz.
    const localDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(consult.startAt);
    const weekdayShort = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      weekday: 'short',
    }).format(consult.startAt);
    const localDow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayShort);

    // For the rule whose dayOfWeek matches, expand its window on that local date
    // in the expert tz and check the consult is fully contained.
    const containedInSomeWindow = firstWideOpen.rules.some((rule) => {
      if (rule.dayOfWeek !== localDow) return false;
      const windowStart = fromZonedTime(`${localDateStr}T${rule.startTime}:00`, TZ);
      const windowEnd = fromZonedTime(`${localDateStr}T${rule.endTime}:00`, TZ);
      return (
        consult.startAt.getTime() >= windowStart.getTime() &&
        consult.endAt.getTime() <= windowEnd.getTime()
      );
    });

    expect(containedInSomeWindow).toBe(true);
  });
});

describe('generateAvailabilityPlan — busy block shape', () => {
  it('every busy block has Date bounds with startAt < endAt', () => {
    for (const p of plan(60)) {
      for (const b of p.busyBlocks) {
        expect(b.startAt).toBeInstanceOf(Date);
        expect(b.endAt).toBeInstanceOf(Date);
        expect(b.startAt.getTime()).toBeLessThan(b.endAt.getTime());
      }
    }
  });

  it('every consultation has start < end and a valid status', () => {
    for (const p of plan(60)) {
      for (const c of p.consultations) {
        expect(c.startAt.getTime()).toBeLessThan(c.endAt.getTime());
        expect(['confirmed', 'cancelled']).toContain(c.status);
      }
    }
  });
});

describe('generateAvailabilityPlan — cancelled edge case', () => {
  it('the first SPARSE expert carries one confirmed + one cancelled over the same slot', () => {
    const plans = plan(60);
    const firstSparse = plans.find((p) => p.archetype === 'SPARSE')!;
    const confirmed = firstSparse.consultations.filter((c) => c.status === 'confirmed');
    const cancelled = firstSparse.consultations.filter((c) => c.status === 'cancelled');
    expect(confirmed.length).toBe(1);
    expect(cancelled.length).toBe(1);
    expect(confirmed[0]!.startAt.getTime()).toBe(cancelled[0]!.startAt.getTime());
    expect(confirmed[0]!.endAt.getTime()).toBe(cancelled[0]!.endAt.getTime());
  });
});

describe('generateAvailabilityPlan — NEXT_WEEK', () => {
  it('covers [baseline, baseline+7d] with a busy block', () => {
    const nextWeek = plan(60).find((p) => p.archetype === 'NEXT_WEEK')!;
    expect(nextWeek.busyBlocks.length).toBeGreaterThan(0);
    const block = nextWeek.busyBlocks[0]!;
    expect(block.startAt.getTime()).toBe(BASELINE.getTime());
    expect(block.endAt.getTime()).toBe(BASELINE.getTime() + 7 * DAY_MS);
    // Still has weekday rules so availability opens up the following week.
    expect(nextWeek.rules.length).toBe(5);
  });
});

describe('generateAvailabilityPlan — BOOKED_SOLID', () => {
  it('busy block spans the entire 14-day horizon and beyond', () => {
    const booked = plan(60).find((p) => p.archetype === 'BOOKED_SOLID')!;
    const block = booked.busyBlocks[0]!;
    expect(block.startAt.getTime()).toBe(BASELINE.getTime());
    expect(block.endAt.getTime()).toBeGreaterThanOrEqual(BASELINE.getTime() + 14 * DAY_MS);
    expect(booked.rules.length).toBe(5);
  });
});

describe('generateAvailabilityPlan — TODAY_ONLY', () => {
  it('emits a single rule on the baseline local weekday', () => {
    const todayOnly = plan(60).find((p) => p.archetype === 'TODAY_ONLY')!;
    expect(todayOnly.rules.length).toBe(1);
    expect(todayOnly.busyBlocks.length).toBe(0);
    const rule = todayOnly.rules[0]!;
    expect(rule.dayOfWeek).toBeGreaterThanOrEqual(0);
    expect(rule.dayOfWeek).toBeLessThanOrEqual(6);
    expect(rule.startTime < rule.endTime).toBe(true);
  });
});
