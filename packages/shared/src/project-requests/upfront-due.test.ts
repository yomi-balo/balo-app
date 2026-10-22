import { describe, it, expect } from 'vitest';
import { upfrontDueCents } from './upfront-due';

describe('upfrontDueCents', () => {
  it('fixed: the first installment is due now', () => {
    expect(
      upfrontDueCents({
        pricingMethod: 'fixed',
        priceCents: 1_740_000,
        depositCents: null,
        installments: [{ pct: 30 }, { pct: 70 }],
      })
    ).toBe(522_000);
  });

  it('fixed: rounds the first installment to whole cents', () => {
    expect(
      upfrontDueCents({
        pricingMethod: 'fixed',
        priceCents: 1_001,
        depositCents: null,
        installments: [{ pct: 33 }, { pct: 67 }],
      })
    ).toBe(330);
  });

  it('fixed: with no installments the whole total is due now', () => {
    expect(
      upfrontDueCents({
        pricingMethod: 'fixed',
        priceCents: 500_000,
        depositCents: null,
        installments: [],
      })
    ).toBe(500_000);
  });

  it('fixed: a 0% first installment leaves nothing due upfront', () => {
    expect(
      upfrontDueCents({
        pricingMethod: 'fixed',
        priceCents: 500_000,
        depositCents: null,
        installments: [{ pct: 0 }, { pct: 100 }],
      })
    ).toBe(0);
  });

  it('tm: the deposit is due now', () => {
    expect(
      upfrontDueCents({
        pricingMethod: 'tm',
        priceCents: 900_000,
        depositCents: 200_000,
        installments: [{ pct: 50 }],
      })
    ).toBe(200_000);
  });

  it('tm: no deposit leaves nothing due upfront', () => {
    expect(
      upfrontDueCents({
        pricingMethod: 'tm',
        priceCents: 900_000,
        depositCents: null,
        installments: [],
      })
    ).toBe(0);
  });
});
