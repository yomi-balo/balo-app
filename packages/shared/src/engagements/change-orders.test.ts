import { describe, it, expect } from 'vitest';
import { applyBaloFee } from '../pricing';
import {
  CHANGE_ORDER_STALE_BUSINESS_DAYS,
  changeOrderMinutesDelta,
  clientPriceChangeCents,
  deriveProjectSettlement,
} from './change-orders';

describe('CHANGE_ORDER_STALE_BUSINESS_DAYS', () => {
  it('is five', () => {
    expect(CHANGE_ORDER_STALE_BUSINESS_DAYS).toBe(5);
  });
});

describe('clientPriceChangeCents', () => {
  it('grosses a negative delta up by the fee', () => {
    expect(clientPriceChangeCents(1_250_000, 350_000, 2500)).toBe(-1_125_000);
  });

  it('is zero when the price does not move', () => {
    expect(clientPriceChangeCents(777, 777, 2500)).toBe(0);
  });

  it('is not the fee applied to the delta when halves round differently', () => {
    // 6 -> 8 and 4 -> 5 client cents, so the movement is -3; the fee on -2 rounds to -2.
    expect(clientPriceChangeCents(6, 4, 2500)).toBe(-3);
    expect(applyBaloFee(-2, 2500)).toBe(-2);
  });
});

describe('deriveProjectSettlement', () => {
  it('derives the A$9,000 reduction on A$12,500 at 2500 bps', () => {
    const s = deriveProjectSettlement({
      acceptedPriceCents: 1_250_000,
      approvedDeltasInOrder: [-900_000],
      baloFeeBps: 2500,
      upfrontDueClientCents: 0,
    });
    expect(s.approved).toEqual([
      { expertDeltaCents: -900_000, clientDeltaCents: -1_125_000, marginDeltaCents: -225_000 },
    ]);
    expect(s.accepted).toEqual({
      expertCents: 1_250_000,
      clientCents: 1_562_500,
      marginCents: 312_500,
    });
    expect(s.current.expertCents).toBe(350_000);
    expect(s.finalInvoiceClientCents).toBe(437_500);
    expect(s.creditRequiredClientCents).toBe(0);
  });

  it('telescopes the client deltas to the whole movement', () => {
    const deltas = [-3, 7, -5, 11, -1];
    const s = deriveProjectSettlement({
      acceptedPriceCents: 1001,
      approvedDeltasInOrder: deltas,
      baloFeeBps: 2500,
      upfrontDueClientCents: 0,
    });
    const sum = s.approved.reduce((acc, row) => acc + row.clientDeltaCents, 0);
    expect(sum).toBe(s.current.clientCents - s.accepted.clientCents);
    const marginSum = s.approved.reduce((acc, row) => acc + row.marginDeltaCents, 0);
    expect(marginSum).toBe(s.current.marginCents - s.accepted.marginCents);
  });

  it('reports the accepted price as current when nothing is approved', () => {
    const s = deriveProjectSettlement({
      acceptedPriceCents: 100_000,
      approvedDeltasInOrder: [],
      baloFeeBps: 2500,
      upfrontDueClientCents: 50_000,
    });
    expect(s.approved).toEqual([]);
    expect(s.current).toEqual(s.accepted);
    expect(s.finalInvoiceClientCents).toBe(75_000);
  });

  it('requires a credit when the final invoice is below zero', () => {
    const s = deriveProjectSettlement({
      acceptedPriceCents: 1_000_000,
      approvedDeltasInOrder: [-800_000],
      baloFeeBps: 2500,
      upfrontDueClientCents: 600_000,
    });
    expect(s.finalInvoiceClientCents).toBe(250_000 - 600_000);
    expect(s.creditRequiredClientCents).toBe(350_000);
  });
});

describe('changeOrderMinutesDelta', () => {
  it('adds an add, subtracts a remove and diffs an edit', () => {
    expect(
      changeOrderMinutesDelta([
        { op: 'add', estimatedMinutes: 120, beforeEstimatedMinutes: null },
        { op: 'remove', estimatedMinutes: null, beforeEstimatedMinutes: 60 },
        { op: 'edit', estimatedMinutes: 90, beforeEstimatedMinutes: 30 },
      ])
    ).toBe(120);
  });

  it('treats missing estimates as zero and an empty list as zero', () => {
    expect(changeOrderMinutesDelta([])).toBe(0);
    expect(
      changeOrderMinutesDelta([{ op: 'edit', estimatedMinutes: null, beforeEstimatedMinutes: 45 }])
    ).toBe(-45);
  });
});
