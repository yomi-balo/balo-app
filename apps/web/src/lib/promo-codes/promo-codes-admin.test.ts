import { describe, it, expect, vi, beforeEach } from 'vitest';

import { makePromo, makePromoRecord as makeRecord } from '@/test/fixtures/promo-codes';

// Mock the repository seam so the loader body runs against controlled reads (mirrors the
// engagements-oversight loader-test precedent). The fixtures' `@balo/db` reference is a
// type-only import (erased), so it coexists with this runtime mock.
const { mockList, mockListAllRedemptions } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockListAllRedemptions: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  promoCodesRepository: {
    list: (...args: unknown[]) => mockList(...args),
    listAllRedemptions: (...args: unknown[]) => mockListAllRedemptions(...args),
  },
}));

import { loadPromoCodesAdmin } from './promo-codes-admin';

// A fixed clock so every derived status is deterministic (run under TZ=UTC).
const NOW = new Date('2026-07-16T12:00:00.000Z');

beforeEach(() => {
  mockList.mockReset();
  mockListAllRedemptions.mockReset();
});

describe('loadPromoCodesAdmin', () => {
  it('issues both reads and returns an empty, all-zero DTO when there are no codes', async () => {
    mockList.mockResolvedValue([]);
    mockListAllRedemptions.mockResolvedValue([]);

    const dto = await loadPromoCodesAdmin(NOW);

    expect(dto.isEmpty).toBe(true);
    expect(dto.rows).toEqual([]);
    expect(dto.counts.active + dto.counts.deactivated + dto.counts.expired).toBe(0);
    // Both reads are issued (they run concurrently via Promise.all).
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockListAllRedemptions).toHaveBeenCalledTimes(1);
  });

  // The loader's job is WIRING: hand both reads + the injected clock to the pure fold and
  // return its DTO. The fold itself (status precedence, counts, actor labels) is exhaustively
  // covered by promo-codes-view.test.ts, so this uses a lean, distinct scenario.
  it('hands both reads and the injected clock to the fold, grouping redemptions onto their code', async () => {
    mockList.mockResolvedValue([
      makePromo({ id: 'p-live', code: 'LIVE1' }),
      makePromo({ id: 'p-off', code: 'OFF1', status: 'deactivated' }),
    ]);
    mockListAllRedemptions.mockResolvedValue([
      makeRecord({ id: 'r-1', promoCodeId: 'p-live' }),
      makeRecord({ id: 'r-2', promoCodeId: 'p-live', companyName: 'Globex Traders' }),
    ]);

    const dto = await loadPromoCodesAdmin(NOW);

    expect(dto.isEmpty).toBe(false);
    expect(dto.rows.map((r) => r.id)).toEqual(['p-live', 'p-off']);
    expect(dto.counts.active).toBe(1);
    expect(dto.counts.deactivated).toBe(1);

    const live = dto.rows.find((r) => r.id === 'p-live');
    expect(live?.displayStatus).toBe('active');
    expect(live?.redemptions.map((rd) => rd.id)).toEqual(['r-1', 'r-2']);
    expect(live?.redemptions[0]?.actorLabel).toBe('Dana Whitfield');
    // Serialisable across the RSC boundary — ISO strings, no Date leaks.
    expect(live?.redemptions[0]?.redeemedAtIso).toBe('2026-07-10T00:00:00.000Z');

    const off = dto.rows.find((r) => r.id === 'p-off');
    expect(off?.displayStatus).toBe('deactivated');
    expect(off?.redemptions).toEqual([]);
  });

  it('derives an at-cap in-window code as exhausted from the injected clock', async () => {
    mockList.mockResolvedValue([makePromo({ redeemedCount: 100, perCodeRedemptionCap: 100 })]);
    mockListAllRedemptions.mockResolvedValue([]);

    const dto = await loadPromoCodesAdmin(NOW);

    expect(dto.counts.exhausted).toBe(1);
    const [row] = dto.rows;
    expect(row?.displayStatus).toBe('exhausted');
    expect(row?.remaining).toBe(0);
    expect(row?.redeemable).toBe(false);
  });
});
