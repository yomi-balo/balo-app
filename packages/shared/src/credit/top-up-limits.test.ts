import { describe, expect, it } from 'vitest';
import { TOP_UP_LIMITS_MINOR } from './top-up-limits';

/**
 * BAL-474 (plan AD-16) — the values are PINNED: the web slider, the purchase-intent route's
 * defence-in-depth bounds and the "a top-up of {amount} or more" copy all read them, so changing
 * one is a product decision that must be made deliberately, here.
 */
describe('TOP_UP_LIMITS_MINOR', () => {
  it('is A$300 minimum, A$10,000 maximum, in A$100 steps (AUD minor units)', () => {
    expect(TOP_UP_LIMITS_MINOR).toEqual({ min: 30_000, max: 1_000_000, step: 10_000 });
  });

  it('the minimum and maximum both sit on a step', () => {
    expect(TOP_UP_LIMITS_MINOR.min % TOP_UP_LIMITS_MINOR.step).toBe(0);
    expect(TOP_UP_LIMITS_MINOR.max % TOP_UP_LIMITS_MINOR.step).toBe(0);
    expect(TOP_UP_LIMITS_MINOR.min).toBeLessThan(TOP_UP_LIMITS_MINOR.max);
  });
});
