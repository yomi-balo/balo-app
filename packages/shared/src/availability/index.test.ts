import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_CACHE_TTL_SECONDS,
  AVAILABILITY_LEAD_GUARD_MINUTES,
  DEFAULT_AVAILABILITY_WINDOW_DAYS,
  MAX_AVAILABILITY_WINDOW_DAYS,
  MAX_SLOT_MINUTES,
  MIN_SLOT_MINUTES,
  SLOT_DURATION_LADDER,
  SLOT_STEP_MINUTES,
} from './index';

describe('SLOT_DURATION_LADDER', () => {
  it('is exactly [15, 30, 45, 60] and is ascending', () => {
    expect(SLOT_DURATION_LADDER).toEqual([15, 30, 45, 60]);
    const sorted = [...SLOT_DURATION_LADDER].sort((a, b) => a - b);
    expect(SLOT_DURATION_LADDER).toEqual(sorted);
  });
});

describe('MIN_SLOT_MINUTES / MAX_SLOT_MINUTES', () => {
  it('equal the ladder ends (guards the two from drifting apart)', () => {
    expect(MIN_SLOT_MINUTES).toBe(SLOT_DURATION_LADDER[0]);
    expect(MAX_SLOT_MINUTES).toBe(SLOT_DURATION_LADDER.at(-1));
  });
});

describe('SLOT_STEP_MINUTES', () => {
  it('divides every ladder value', () => {
    for (const d of SLOT_DURATION_LADDER) {
      expect(d % SLOT_STEP_MINUTES).toBe(0);
    }
  });
});

describe('window-size invariants', () => {
  it('DEFAULT_AVAILABILITY_WINDOW_DAYS <= MAX_AVAILABILITY_WINDOW_DAYS', () => {
    expect(DEFAULT_AVAILABILITY_WINDOW_DAYS).toBeLessThanOrEqual(MAX_AVAILABILITY_WINDOW_DAYS);
  });

  it('⚠ the computed/cached width IS the advertise horizon — no third calendar horizon', () => {
    // apiroc skill, Constraint 6. The two shipped horizons are 14 (advertise) and 365
    // (booking). A value above 14 here is a THIRD one and needs an ADR-1021 amendment, not a
    // constant edit.
    expect(MAX_AVAILABILITY_WINDOW_DAYS).toBe(14);
    expect(DEFAULT_AVAILABILITY_WINDOW_DAYS).toBe(MAX_AVAILABILITY_WINDOW_DAYS);
  });
});

describe('§1.3 cache lead-guard invariant', () => {
  /**
   * ⚠ TWO CACHE LAYERS, NOT ONE — Redis (`AVAILABILITY_CACHE_TTL_SECONDS`) AND the browser's
   * own `max-age`, which the route sets to the same TTL. Worst-case machine-side staleness is
   * `TTL * 2`; the `+ 60` is one minute for latency, clock skew and think-time. The earlier
   * one-layer form (`>= TTL`) was satisfied literally by a guard of 2 while the measured margin
   * was exactly 120s — zero headroom. `slot-grid-accepts.test.ts` pins the same number at the
   * seam that actually uses it.
   */
  it('AVAILABILITY_LEAD_GUARD_MINUTES * 60 >= AVAILABILITY_CACHE_TTL_SECONDS * 2 + 60', () => {
    expect(AVAILABILITY_LEAD_GUARD_MINUTES * 60).toBeGreaterThanOrEqual(
      AVAILABILITY_CACHE_TTL_SECONDS * 2 + 60
    );
  });
});
