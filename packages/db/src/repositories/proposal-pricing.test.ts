import { describe, it, expect } from 'vitest';
import { deriveTmTotalCents, sumEstimatedMinutes } from './proposal-pricing';

/**
 * Unit tests for the pure T&M pricing helpers (BAL-294). Mocks nothing —
 * `proposal-pricing.ts` has no `db` import and no I/O. Price/effort calculation is
 * the "ALWAYS test" category (rounding edges, zero/empty, large sums). This module
 * is the single source of truth for the T&M total, shared by the coherence guard
 * and the web composer, so the math is locked here.
 */

describe('deriveTmTotalCents', () => {
  it('derives 90 min at A$180/hr (18_000c) → A$270 (27_000c)', () => {
    // 90/60 × 18_000 = 1.5 × 18_000 = 27_000 — exact.
    expect(deriveTmTotalCents(90, 18_000)).toBe(27_000);
  });

  it('rounds 50 min at A$100/hr (10_000c) → 8_333c (round(8333.33…))', () => {
    // 50/60 × 10_000 = 8333.33… → rounds to 8_333.
    expect(deriveTmTotalCents(50, 10_000)).toBe(8_333);
  });

  it('rounds half away from zero (10 min at 10_000c → 1_667c)', () => {
    // 10/60 × 10_000 = 1666.66… → 1_667.
    expect(deriveTmTotalCents(10, 10_000)).toBe(1_667);
  });

  it('returns 0 for zero minutes', () => {
    expect(deriveTmTotalCents(0, 18_000)).toBe(0);
  });

  it('returns 0 for a zero rate', () => {
    expect(deriveTmTotalCents(600, 0)).toBe(0);
  });

  it('handles exactly one hour (60 min → the full rate)', () => {
    expect(deriveTmTotalCents(60, 18_000)).toBe(18_000);
  });

  it('handles large sums without precision loss (6_000h = 360_000 min at 25_000c)', () => {
    // 360_000/60 × 25_000 = 6_000 × 25_000 = 150_000_000c (A$1.5M).
    expect(deriveTmTotalCents(360_000, 25_000)).toBe(150_000_000);
  });

  it('rounds a fractional-hour large sum (125 min at 33_333c → 69_443c)', () => {
    // 125/60 × 33_333 = 2.0833… × 33_333 = 69_443.75 → 69_444.
    expect(deriveTmTotalCents(125, 33_333)).toBe(69_444);
  });
});

describe('sumEstimatedMinutes', () => {
  it('sums present minutes', () => {
    expect(sumEstimatedMinutes([{ estimatedMinutes: 30 }, { estimatedMinutes: 90 }])).toBe(120);
  });

  it('treats null effort as 0', () => {
    expect(sumEstimatedMinutes([{ estimatedMinutes: 60 }, { estimatedMinutes: null }])).toBe(60);
  });

  it('returns 0 for an empty milestone list', () => {
    expect(sumEstimatedMinutes([])).toBe(0);
  });

  it('returns 0 when every milestone is null', () => {
    expect(sumEstimatedMinutes([{ estimatedMinutes: null }, { estimatedMinutes: null }])).toBe(0);
  });

  it('sums a large mixed set', () => {
    expect(
      sumEstimatedMinutes([
        { estimatedMinutes: 100_000 },
        { estimatedMinutes: null },
        { estimatedMinutes: 260_000 },
      ])
    ).toBe(360_000);
  });

  it('composes with deriveTmTotalCents end-to-end', () => {
    const total = deriveTmTotalCents(
      sumEstimatedMinutes([{ estimatedMinutes: 30 }, { estimatedMinutes: 60 }]),
      18_000
    );
    // 90 min → 27_000c.
    expect(total).toBe(27_000);
  });
});
