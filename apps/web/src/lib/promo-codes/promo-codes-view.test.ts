import { describe, it, expect } from 'vitest';
import { makePromo, makePromoRecord as makeRecord } from '@/test/fixtures/promo-codes';
import {
  deriveRemaining,
  derivePromoStatus,
  derivePromoCounts,
  derivePromoCodesDTO,
  groupRedemptionsByCode,
  promoRowMatchesFilter,
  formatMinorAud,
  dollarsToMinor,
  type PromoCodeAdminRow,
} from './promo-codes-view';

// A fixed clock so every derived-status test is deterministic (run under TZ=UTC).
const NOW = new Date('2026-07-16T12:00:00.000Z');

describe('formatMinorAud', () => {
  it('renders minor units as two-decimal AUD', () => {
    expect(formatMinorAud(5000)).toBe('A$50.00');
    expect(formatMinorAud(5010)).toBe('A$50.10');
    expect(formatMinorAud(1999)).toBe('A$19.99');
    expect(formatMinorAud(0)).toBe('A$0.00');
  });

  it('groups thousands', () => {
    expect(formatMinorAud(250000)).toBe('A$2,500.00');
  });
});

describe('dollarsToMinor', () => {
  it('converts dollars to an integer minor value, rounding away float drift', () => {
    expect(dollarsToMinor(50)).toBe(5000);
    expect(dollarsToMinor(50.1)).toBe(5010);
    expect(dollarsToMinor(19.99)).toBe(1999);
    expect(dollarsToMinor(0.01)).toBe(1);
  });

  it('round-trips cleanly with formatMinorAud', () => {
    expect(formatMinorAud(dollarsToMinor(50.1))).toBe('A$50.10');
    expect(formatMinorAud(dollarsToMinor(19.99))).toBe('A$19.99');
  });
});

describe('deriveRemaining', () => {
  it('is cap minus redeemed', () => {
    expect(deriveRemaining(100, 30)).toBe(70);
  });

  it('never goes negative', () => {
    expect(deriveRemaining(10, 25)).toBe(0);
  });

  it('is the full cap for an unredeemed code', () => {
    expect(deriveRemaining(100, 0)).toBe(100);
  });
});

describe('derivePromoStatus precedence (deactivated > expired > exhausted > scheduled > active)', () => {
  it('is deactivated regardless of window or count', () => {
    const row = makePromo({
      status: 'deactivated',
      validFrom: new Date('2026-07-01T00:00:00.000Z'),
      validUntil: new Date('2026-08-01T00:00:00.000Z'),
      redeemedCount: 100,
      perCodeRedemptionCap: 100,
    });
    expect(derivePromoStatus(row, NOW)).toBe('deactivated');
  });

  it('is expired (over exhausted) once past valid_until', () => {
    const row = makePromo({
      validUntil: new Date('2026-07-10T00:00:00.000Z'),
      redeemedCount: 100,
      perCodeRedemptionCap: 100,
    });
    expect(derivePromoStatus(row, NOW)).toBe('expired');
  });

  it('is exhausted when in-window and the cap is reached', () => {
    const row = makePromo({ redeemedCount: 100, perCodeRedemptionCap: 100 });
    expect(derivePromoStatus(row, NOW)).toBe('exhausted');
  });

  it('is scheduled when in-window, under cap, but before valid_from', () => {
    const row = makePromo({
      validFrom: new Date('2026-07-20T00:00:00.000Z'),
      validUntil: new Date('2026-08-20T00:00:00.000Z'),
      redeemedCount: 0,
    });
    expect(derivePromoStatus(row, NOW)).toBe('scheduled');
  });

  it('is active when in-window, under cap, and past valid_from', () => {
    expect(derivePromoStatus(makePromo(), NOW)).toBe('active');
  });

  it('treats valid_until as exclusive (now === valid_until is expired)', () => {
    const row = makePromo({ validUntil: NOW });
    expect(derivePromoStatus(row, NOW)).toBe('expired');
  });
});

describe('groupRedemptionsByCode', () => {
  it('groups records by promo code, preserving input order', () => {
    const records = [
      makeRecord({ id: 'r-a', promoCodeId: 'p-1' }),
      makeRecord({ id: 'r-b', promoCodeId: 'p-2' }),
      makeRecord({ id: 'r-c', promoCodeId: 'p-1' }),
    ];
    const grouped = groupRedemptionsByCode(records);
    expect(grouped.get('p-1')?.map((r) => r.id)).toEqual(['r-a', 'r-c']);
    expect(grouped.get('p-2')?.map((r) => r.id)).toEqual(['r-b']);
  });

  it('returns an empty map for no records', () => {
    expect(groupRedemptionsByCode([]).size).toBe(0);
  });

  it('derives the actor label from the person name, and null when there is no human actor', () => {
    const grouped = groupRedemptionsByCode([
      makeRecord({ id: 'r-named' }),
      makeRecord({
        id: 'r-system',
        redeemedByUserId: null,
        redeemedByFirstName: null,
        redeemedByLastName: null,
      }),
    ]);
    const rows = grouped.get('p-1') ?? [];
    expect(rows[0]?.actorLabel).toBe('Dana Whitfield');
    expect(rows[0]?.grantedLabel).toBe('A$50.00');
    expect(rows[1]?.actorLabel).toBeNull();
  });

  it('falls back to "A teammate" when a user redeemed but has no name on record', () => {
    const grouped = groupRedemptionsByCode([
      makeRecord({ redeemedByFirstName: null, redeemedByLastName: null }),
    ]);
    expect((grouped.get('p-1') ?? [])[0]?.actorLabel).toBe('A teammate');
  });
});

describe('derivePromoCodesDTO', () => {
  it('folds codes + redemptions into rows, attaches grouped redemptions, and counts', () => {
    const promos = [
      makePromo({ id: 'p-active', code: 'ACTIVE1' }),
      makePromo({
        id: 'p-exp',
        code: 'EXPIRED1',
        validUntil: new Date('2026-07-10T00:00:00.000Z'),
      }),
      makePromo({ id: 'p-off', code: 'OFF1', status: 'deactivated' }),
    ];
    const records = [makeRecord({ id: 'r-1', promoCodeId: 'p-active' })];

    const dto = derivePromoCodesDTO(promos, records, NOW);

    expect(dto.isEmpty).toBe(false);
    expect(dto.rows).toHaveLength(3);
    expect(dto.counts).toEqual({
      active: 1,
      scheduled: 0,
      expired: 1,
      exhausted: 0,
      deactivated: 1,
    });
    const activeRow = dto.rows.find((r) => r.id === 'p-active');
    expect(activeRow?.redemptions).toHaveLength(1);
    expect(activeRow?.grantLabel).toBe('A$50.00');
    expect(activeRow?.redeemable).toBe(true);
    // An unredeemed code carries the full remaining cap and no redemptions.
    const offRow = dto.rows.find((r) => r.id === 'p-off');
    expect(offRow?.remaining).toBe(100);
    expect(offRow?.redemptions).toHaveLength(0);
    expect(offRow?.redeemable).toBe(false);
  });

  it('marks an all-empty set as isEmpty', () => {
    const dto = derivePromoCodesDTO([], [], NOW);
    expect(dto.isEmpty).toBe(true);
    expect(dto.rows).toHaveLength(0);
    expect(dto.counts).toEqual({
      active: 0,
      scheduled: 0,
      expired: 0,
      exhausted: 0,
      deactivated: 0,
    });
  });

  it('computes remaining and usage percentage from the redeemed_count column', () => {
    const dto = derivePromoCodesDTO(
      [makePromo({ redeemedCount: 30, perCodeRedemptionCap: 100 })],
      [],
      NOW
    );
    const [row] = dto.rows;
    expect(row?.remaining).toBe(70);
    expect(row?.usedPct).toBe(30);
  });
});

describe('promoRowMatchesFilter', () => {
  const row = { displayStatus: 'active' } as PromoCodeAdminRow;

  it('matches everything under "all"', () => {
    expect(promoRowMatchesFilter(row, 'all')).toBe(true);
  });

  it('matches only the exact display status otherwise', () => {
    expect(promoRowMatchesFilter(row, 'active')).toBe(true);
    expect(promoRowMatchesFilter(row, 'expired')).toBe(false);
  });
});

describe('derivePromoCounts', () => {
  it('counts each display status', () => {
    const rows = [
      { displayStatus: 'active' },
      { displayStatus: 'active' },
      { displayStatus: 'scheduled' },
      { displayStatus: 'exhausted' },
    ] as PromoCodeAdminRow[];
    expect(derivePromoCounts(rows)).toEqual({
      active: 2,
      scheduled: 1,
      expired: 0,
      exhausted: 1,
      deactivated: 0,
    });
  });
});
