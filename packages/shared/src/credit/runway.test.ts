import { describe, it, expect } from 'vitest';
import { minutesOfRunway, type RunwayInputs } from './runway';

const RATE = 100; // A$1.00/min
const FLOOR = 15;

function inputs(overrides: Partial<RunwayInputs> = {}): RunwayInputs {
  return {
    balanceMinor: 3_000,
    ratePerMinuteMinor: RATE,
    floorMinutes: FLOOR,
    minutesAlreadyDrawn: 2,
    ...overrides,
  };
}

describe('minutesOfRunway (BAL-412, D6 — the ONE implementation)', () => {
  it('the ticket worked example: rate=100, floor=15, drawn=2, balance=3000 → 17 (not 30)', () => {
    expect(minutesOfRunway(inputs())).toBe(17);
  });

  it('floor already fully consumed (drawn ≥ floor) reduces EXACTLY to floor(balance/rate)', () => {
    // The uncorrected formula's value for comparison — the two must agree past the floor.
    const uncorrected = Math.floor(3_000 / RATE);
    expect(minutesOfRunway(inputs({ minutesAlreadyDrawn: FLOOR }))).toBe(uncorrected);
    expect(minutesOfRunway(inputs({ minutesAlreadyDrawn: FLOOR + 10 }))).toBe(uncorrected);
  });

  it('never OVERSTATES — the corrected figure is always ≤ the uncorrected one', () => {
    const scenarios: ReadonlyArray<Partial<RunwayInputs>> = [
      { balanceMinor: 100, minutesAlreadyDrawn: 0 },
      { balanceMinor: 1_500, minutesAlreadyDrawn: 5 },
      { balanceMinor: 10_000, minutesAlreadyDrawn: 1 },
      { balanceMinor: 3_000, minutesAlreadyDrawn: 14 },
    ];
    for (const scenario of scenarios) {
      const merged = inputs(scenario);
      const uncorrected = Math.floor(merged.balanceMinor / merged.ratePerMinuteMinor);
      expect(minutesOfRunway(merged)).toBeLessThanOrEqual(uncorrected);
    }
  });

  it('discretionary ≤ 0 (balance cannot cover the unconsumed floor) → 0', () => {
    // unconsumed = 13, committed = 1300 > 900 balance.
    expect(minutesOfRunway(inputs({ balanceMinor: 900 }))).toBe(0);
  });

  it('rate ≤ 0 → 0', () => {
    expect(minutesOfRunway(inputs({ ratePerMinuteMinor: 0 }))).toBe(0);
    expect(minutesOfRunway(inputs({ ratePerMinuteMinor: -1 }))).toBe(0);
  });

  it('balance ≤ 0 → 0', () => {
    expect(minutesOfRunway(inputs({ balanceMinor: 0 }))).toBe(0);
    expect(minutesOfRunway(inputs({ balanceMinor: -500 }))).toBe(0);
  });

  it('a negative minutesAlreadyDrawn is clamped to 0 (the full floor is treated as unconsumed)', () => {
    expect(minutesOfRunway(inputs({ minutesAlreadyDrawn: -5 }))).toBe(
      minutesOfRunway(inputs({ minutesAlreadyDrawn: 0 }))
    );
  });

  it('zero floor minutes is a no-op — identical to the uncorrected formula at every draw', () => {
    const uncorrected = Math.floor(3_000 / RATE);
    expect(minutesOfRunway(inputs({ floorMinutes: 0, minutesAlreadyDrawn: 0 }))).toBe(uncorrected);
  });
});
