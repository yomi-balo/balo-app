import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockSettlementTermsFor } = vi.hoisted(() => ({ mockSettlementTermsFor: vi.fn() }));
vi.mock('@balo/db', () => ({
  engagementChangeOrdersRepository: {
    settlementTermsFor: (...a: unknown[]) => mockSettlementTermsFor(...a),
  },
}));

import { loadProjectSettlement } from './change-order-settlement';

const ENGAGEMENT_ID = 'a0000000-0000-4000-8000-000000000001';

function terms(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pricingMethod: 'fixed',
    acceptedPriceCents: 1_000_000,
    depositCents: null,
    baloFeeBps: 2500,
    currency: 'aud',
    installments: [{ pct: 25 }, { pct: 75 }],
    approvedDeltas: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadProjectSettlement', () => {
  it('takes the first installment of the fee-grossed ACCEPTED price as the upfront amount', async () => {
    mockSettlementTermsFor.mockResolvedValue(terms());

    const settlement = await loadProjectSettlement(ENGAGEMENT_ID);

    expect(mockSettlementTermsFor).toHaveBeenCalledWith(ENGAGEMENT_ID);
    expect(settlement.accepted).toEqual({
      expertCents: 1_000_000,
      clientCents: 1_250_000,
      marginCents: 250_000,
    });
    expect(settlement.upfrontClientCents).toBe(312_500);
    expect(settlement.finalInvoiceClientCents).toBe(937_500);
    expect(settlement.creditRequiredClientCents).toBe(0);
  });

  it('walks the approved deltas in decision order', async () => {
    mockSettlementTermsFor.mockResolvedValue(
      terms({
        approvedDeltas: [
          { orderId: 'a', decidedAt: new Date('2026-10-01'), priceDeltaCents: 100_000 },
          { orderId: 'b', decidedAt: new Date('2026-10-02'), priceDeltaCents: -50_000 },
        ],
      })
    );

    const settlement = await loadProjectSettlement(ENGAGEMENT_ID);

    expect(settlement.approved.map((row) => row.expertDeltaCents)).toEqual([100_000, -50_000]);
    expect(settlement.current.expertCents).toBe(1_050_000);
  });

  it('owes a credit when a cut takes the price below what was invoiced upfront', async () => {
    mockSettlementTermsFor.mockResolvedValue(
      terms({
        installments: [{ pct: 100 }],
        approvedDeltas: [
          { orderId: 'a', decidedAt: new Date('2026-10-01'), priceDeltaCents: -400_000 },
        ],
      })
    );

    const settlement = await loadProjectSettlement(ENGAGEMENT_ID);

    expect(settlement.upfrontClientCents).toBe(1_250_000);
    expect(settlement.finalInvoiceClientCents).toBe(-500_000);
    expect(settlement.creditRequiredClientCents).toBe(500_000);
  });

  it('uses the grossed-up deposit as the upfront amount on time and materials', async () => {
    mockSettlementTermsFor.mockResolvedValue(
      terms({ pricingMethod: 'tm', depositCents: 200_000, installments: [] })
    );

    const settlement = await loadProjectSettlement(ENGAGEMENT_ID);

    expect(settlement.upfrontClientCents).toBe(250_000);
  });

  it('treats a fixed project with no installments as invoiced in full up front', async () => {
    mockSettlementTermsFor.mockResolvedValue(terms({ installments: [] }));

    expect((await loadProjectSettlement(ENGAGEMENT_ID)).upfrontClientCents).toBe(1_250_000);
  });
});
