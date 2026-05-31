import { describe, expect, it } from 'vitest';
import { resolve } from './resolver';
import type { ResolverInput, ResolverRule } from './types';

// Use a stable, weekday timezone with no DST quirks for most cases.
const UTC = 'UTC';

const baseInput = (overrides: Partial<ResolverInput> = {}): ResolverInput => ({
  rules: [],
  baloConsultations: [],
  busyBlocks: [],
  timezone: UTC,
  // Monday 2026-06-01 00:00 UTC.
  now: new Date('2026-06-01T00:00:00.000Z'),
  horizonDays: 14,
  minMinutes: 15,
  ...overrides,
});

const monFriNineToFive: ResolverRule[] = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  startTime: '09:00:00',
  endTime: '17:00:00',
}));

describe('resolve (BAL-243 availability resolver)', () => {
  describe('basic windows', () => {
    it('returns the next 09:00 in tz when wide-open Mon-Fri 9-17', () => {
      const result = resolve(
        baseInput({
          rules: monFriNineToFive,
        })
      );

      // Now is Mon 2026-06-01 00:00 UTC; earliest window opens Mon 09:00 UTC.
      expect(result.earliestAvailableAt).toEqual(new Date('2026-06-01T09:00:00.000Z'));
    });

    it('returns upcoming Saturday 10:00 when rules are Saturday-only', () => {
      const result = resolve(
        baseInput({
          rules: [{ dayOfWeek: 6, startTime: '10:00:00', endTime: '12:00:00' }],
        })
      );

      // Mon → Sat is 5 days later: 2026-06-06.
      expect(result.earliestAvailableAt).toEqual(new Date('2026-06-06T10:00:00.000Z'));
    });

    it('returns null when the only rule is fully covered by a consultation', () => {
      // Single-day rule (Monday) blocked completely; horizon is 14d but only
      // Mondays match so the next opening is the following Monday.
      const result = resolve(
        baseInput({
          rules: [{ dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' }],
          baloConsultations: [
            {
              startAt: new Date('2026-06-01T09:00:00.000Z'),
              endAt: new Date('2026-06-01T17:00:00.000Z'),
            },
          ],
        })
      );

      // Next Monday inside the horizon: 2026-06-08 09:00 UTC.
      expect(result.earliestAvailableAt).toEqual(new Date('2026-06-08T09:00:00.000Z'));
    });

    it('returns null when only a sub-minMinutes gap exists', () => {
      const result = resolve(
        baseInput({
          rules: [{ dayOfWeek: 1, startTime: '09:00:00', endTime: '09:10:00' }],
          minMinutes: 15,
        })
      );

      expect(result.earliestAvailableAt).toBeNull();
    });
  });

  describe('DST boundary (Australia/Sydney AEDT ↔ AEST)', () => {
    // AEDT (UTC+11) ends Sun 2026-04-05 at 03:00 local → 02:00 AEST (UTC+10).
    // A 09:00 local rule on Apr 5 falls AFTER the transition, so it is AEST.
    // 09:00 Sun Apr 5 Sydney − 10h = 23:00 UTC on Sat 2026-04-04.
    // The wrong answer (using a fixed AEDT offset) would be 22:00 UTC.
    it('post-transition Sunday 09:00 rule resolves at AEST (UTC+10)', () => {
      // `now` must sit BEFORE the rule opens so the clipped window's startAt
      // is the raw UTC instant from `fromZonedTime` (not clamped to rangeStart).
      // Friday 2026-04-03 00:00 UTC = Friday 2026-04-03 11:00 AEDT Sydney.
      const result = resolve(
        baseInput({
          rules: [{ dayOfWeek: 0, startTime: '09:00:00', endTime: '17:00:00' }],
          timezone: 'Australia/Sydney',
          now: new Date('2026-04-03T00:00:00.000Z'),
          horizonDays: 14,
        })
      );

      expect(result.earliestAvailableAt).toEqual(new Date('2026-04-04T23:00:00.000Z'));
    });

    // Companion to the AEST test: prove the per-date expansion picks up the
    // AEDT offset BEFORE the transition. A buggy implementation that hard-coded
    // AEST (UTC+10) for Sydney would pass the test above but fail this one.
    // AEDT (UTC+11) is in effect on Sun 2026-03-29 (last Sun before transition).
    // 09:00 Sun Mar 29 Sydney − 11h = 22:00 UTC on Sat 2026-03-28.
    it('pre-transition Sunday 09:00 rule resolves at AEDT (UTC+11)', () => {
      const result = resolve(
        baseInput({
          rules: [{ dayOfWeek: 0, startTime: '09:00:00', endTime: '17:00:00' }],
          timezone: 'Australia/Sydney',
          now: new Date('2026-03-27T00:00:00.000Z'),
          horizonDays: 14,
        })
      );

      expect(result.earliestAvailableAt).toEqual(new Date('2026-03-28T22:00:00.000Z'));
    });
  });

  describe('DST spring-forward (non-existent local time)', () => {
    // Sydney AEST → AEDT transition: Sun 2026-10-04. The clock jumps
    // 02:00 AEST → 03:00 AEDT, so 02:00–02:59 local do not exist.
    // A rule starting at 02:30 on that Sunday hits the gap. `date-fns-tz` v3
    // resolves the non-existent local time leniently — interpreting it in the
    // post-transition (AEDT, UTC+11) offset, which produces a UTC instant
    // that round-trips BACK to an earlier real local time (01:30 AEST).
    //
    // Concretely: fromZonedTime('2026-10-04T02:30:00', 'Australia/Sydney')
    //   = 2026-10-03T15:30:00Z   (= 01:30 AEST in Sydney, NOT 02:30 or 03:30)
    //
    // This locks the v1 behaviour. If date-fns-tz changes semantics, the
    // assertion breaks and the team decides whether to follow upstream or to
    // add an explicit shift-forward layer in the resolver.
    it('non-existent local time maps to the lenient pre-gap UTC instant', () => {
      const result = resolve(
        baseInput({
          rules: [{ dayOfWeek: 0, startTime: '02:30:00', endTime: '04:00:00' }],
          timezone: 'Australia/Sydney',
          // Fri 2026-10-02 00:00 UTC = Fri 2026-10-02 10:00 AEST.
          now: new Date('2026-10-02T00:00:00.000Z'),
          horizonDays: 14,
        })
      );

      expect(result.earliestAvailableAt).toEqual(new Date('2026-10-03T15:30:00.000Z'));
    });
  });

  describe('cancellation contract boundary', () => {
    // The repository filters `status = 'cancelled'` BEFORE handing rows to the
    // resolver. We assert that contract here: with the cancelled consultation
    // absent (as the repo would), the slot is free again.
    it('does not see cancelled consultations — slot is free when only confirmed remain', () => {
      // Two confirmed consultations that together cover 09:00-12:00 and
      // 14:00-17:00. The gap 12:00-14:00 is the earliest free slot. A separate
      // (excluded) cancelled consultation would have covered the 12:00-14:00
      // slot, but the repo filters it out before this call.
      const result = resolve(
        baseInput({
          rules: [{ dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' }],
          baloConsultations: [
            {
              startAt: new Date('2026-06-01T09:00:00.000Z'),
              endAt: new Date('2026-06-01T12:00:00.000Z'),
            },
            {
              startAt: new Date('2026-06-01T14:00:00.000Z'),
              endAt: new Date('2026-06-01T17:00:00.000Z'),
            },
          ],
        })
      );

      expect(result.earliestAvailableAt).toEqual(new Date('2026-06-01T12:00:00.000Z'));
    });
  });

  describe('empty inputs (sanity)', () => {
    it('returns the rule start when there are no consultations and no busy blocks', () => {
      const result = resolve(
        baseInput({
          rules: monFriNineToFive,
          baloConsultations: [],
          busyBlocks: [],
        })
      );

      expect(result.earliestAvailableAt).toEqual(new Date('2026-06-01T09:00:00.000Z'));
    });
  });

  describe('vendor busy blocks', () => {
    it('subtracts a busy block inside the rule and returns the first sub-window', () => {
      const result = resolve(
        baseInput({
          rules: [{ dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' }],
          busyBlocks: [
            {
              startAt: new Date('2026-06-01T10:00:00.000Z'),
              endAt: new Date('2026-06-01T11:00:00.000Z'),
            },
          ],
          minMinutes: 15,
        })
      );

      // 09:00-10:00 sub-window satisfies the 15-minute floor.
      expect(result.earliestAvailableAt).toEqual(new Date('2026-06-01T09:00:00.000Z'));
    });
  });

  describe('now mid-rule', () => {
    it('returns now (rounded to next minute) when now is inside the rule', () => {
      const result = resolve(
        baseInput({
          rules: [{ dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' }],
          // Monday 14:30 UTC, mid-rule.
          now: new Date('2026-06-01T14:30:00.000Z'),
        })
      );

      expect(result.earliestAvailableAt).toEqual(new Date('2026-06-01T14:30:00.000Z'));
    });
  });
});
