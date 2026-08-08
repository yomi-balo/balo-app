import { describe, expect, it } from 'vitest';
import {
  MAX_BOOKING_HORIZON_DAYS,
  MAX_MEETING_MINUTES,
  MIN_MEETING_MINUTES,
  validateBookingWindow,
} from './bounds.js';

/**
 * BAL-129 / D10. Every case injects `now` explicitly — the module reads no clock, and a
 * test that relied on the real one would be the first place that guarantee rotted.
 */

const NOW = new Date('2026-09-07T00:00:00.000Z');

/** An instant `minutes` after `NOW`. */
function after(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

/** An instant `days` after `NOW`. */
function days(count: number): Date {
  return new Date(NOW.getTime() + count * 86_400_000);
}

describe('the bounds themselves', () => {
  it('pins the product numbers', () => {
    // These are load-bearing for the zero-hold contexts (kickoff / discovery carry no credit
    // hold), so a silent widening is a real availability-DoS regression, not a tweak.
    expect(MIN_MEETING_MINUTES).toBe(15);
    expect(MAX_MEETING_MINUTES).toBe(480);
    expect(MAX_BOOKING_HORIZON_DAYS).toBe(365);
  });

  it('keeps the scheduled-window ceiling deliberately wider than the 240-minute session cap', () => {
    // They bound different things — a SCHEDULED window vs a CONNECTED session. If someone
    // ever "unifies" them, this is the line that objects.
    expect(MAX_MEETING_MINUTES).toBeGreaterThan(240);
  });
});

describe('validateBookingWindow — valid windows', () => {
  it('accepts a well-formed future window', () => {
    expect(validateBookingWindow(after(60), after(120), NOW)).toBeNull();
  });

  it('accepts exactly MIN_MEETING_MINUTES', () => {
    expect(validateBookingWindow(after(60), after(60 + MIN_MEETING_MINUTES), NOW)).toBeNull();
  });

  it('accepts exactly MAX_MEETING_MINUTES', () => {
    expect(validateBookingWindow(after(60), after(60 + MAX_MEETING_MINUTES), NOW)).toBeNull();
  });

  it('accepts a start exactly MAX_BOOKING_HORIZON_DAYS out', () => {
    const start = days(MAX_BOOKING_HORIZON_DAYS);
    expect(validateBookingWindow(start, new Date(start.getTime() + 3_600_000), NOW)).toBeNull();
  });

  it('accepts a start one millisecond in the future', () => {
    const start = new Date(NOW.getTime() + 1);
    expect(validateBookingWindow(start, new Date(start.getTime() + 30 * 60_000), NOW)).toBeNull();
  });
});

describe('validateBookingWindow — each violation, at its exact boundary', () => {
  it('rejects an end before the start', () => {
    expect(validateBookingWindow(after(120), after(60), NOW)).toBe('end_before_start');
  });

  it('rejects a zero-length window (end === start)', () => {
    expect(validateBookingWindow(after(60), after(60), NOW)).toBe('end_before_start');
  });

  it('rejects a start exactly at `now` — a booking must be in the future', () => {
    expect(validateBookingWindow(NOW, after(60), NOW)).toBe('start_not_future');
  });

  it('rejects a start in the past', () => {
    expect(validateBookingWindow(after(-60), after(60), NOW)).toBe('start_not_future');
  });

  it('rejects one minute under the floor (14 minutes)', () => {
    expect(validateBookingWindow(after(60), after(74), NOW)).toBe('duration_below_minimum');
  });

  it('rejects one minute over the ceiling (481 minutes)', () => {
    expect(validateBookingWindow(after(60), after(60 + MAX_MEETING_MINUTES + 1), NOW)).toBe(
      'duration_above_maximum'
    );
  });

  it('rejects a start one day beyond the horizon (366 days)', () => {
    const start = days(MAX_BOOKING_HORIZON_DAYS + 1);
    expect(validateBookingWindow(start, new Date(start.getTime() + 3_600_000), NOW)).toBe(
      'start_beyond_horizon'
    );
  });
});

describe('validateBookingWindow — a non-finite instant FAILS CLOSED', () => {
  /**
   * ⚠ THE REGRESSION THIS BLOCK EXISTS FOR. Every comparison in the validator is NaN-blind
   * (`NaN <= NaN` is `false`), so before the guard an Invalid Date fell through all five
   * rules and the function returned `null` — reporting garbage as a VALID window. Not
   * reachable through `POST /meetings` (strict `.datetime()` at the Zod boundary), but this
   * is exported public API and BAL-409/410/411 may parse with `z.coerce.date()`.
   */
  const INVALID = new Date('not-a-date');

  it.each([
    { label: 'an Invalid start', args: [INVALID, after(120), NOW] as const },
    { label: 'an Invalid end', args: [after(60), INVALID, NOW] as const },
    { label: 'an Invalid now', args: [after(60), after(120), INVALID] as const },
    { label: 'all three Invalid', args: [INVALID, INVALID, INVALID] as const },
  ])('reports invalid_instant for $label — never null', ({ args }) => {
    expect(validateBookingWindow(...args)).toBe('invalid_instant');
  });

  it('reports invalid_instant AHEAD of every other violation', () => {
    // The guard is first on purpose: with a non-finite operand the other five rules cannot be
    // evaluated meaningfully, so there is no "more specific" code to prefer.
    expect(validateBookingWindow(INVALID, INVALID, NOW)).toBe('invalid_instant');
  });

  it('rejects the Postgres-representable instants JavaScript cannot hold', () => {
    // `'infinity'` and instants past JS's ±8.64e15 ms range both yield an Invalid Date — the
    // same failure documented on `computeMeetingClocks`'s span guard, where Postgres
    // `'infinity'` / pg's min-max timestamps round-trip to NaN through postgres-js.
    expect(validateBookingWindow(new Date('infinity'), after(120), NOW)).toBe('invalid_instant');
    expect(validateBookingWindow(after(60), new Date(8.64e15 + 1), NOW)).toBe('invalid_instant');
  });
});

describe('validateBookingWindow — precedence when several rules break at once', () => {
  /**
   * The order is part of the contract: the same defect must always report the same stable
   * code, rather than one that depends on how many other rules the window happens to break.
   */
  it('reports end_before_start ahead of start_not_future', () => {
    expect(validateBookingWindow(after(-60), after(-120), NOW)).toBe('end_before_start');
  });

  it('reports start_not_future ahead of duration_below_minimum', () => {
    expect(validateBookingWindow(after(-60), after(-55), NOW)).toBe('start_not_future');
  });

  it('reports duration_below_minimum ahead of start_beyond_horizon', () => {
    const start = days(MAX_BOOKING_HORIZON_DAYS + 10);
    expect(validateBookingWindow(start, new Date(start.getTime() + 60_000), NOW)).toBe(
      'duration_below_minimum'
    );
  });

  it('reports duration_above_maximum ahead of start_beyond_horizon', () => {
    const start = days(MAX_BOOKING_HORIZON_DAYS + 10);
    expect(
      validateBookingWindow(
        start,
        new Date(start.getTime() + (MAX_MEETING_MINUTES + 1) * 60_000),
        NOW
      )
    ).toBe('duration_above_maximum');
  });
});
