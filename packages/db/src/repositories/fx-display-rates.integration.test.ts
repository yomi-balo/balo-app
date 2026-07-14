import { describe, it, expect } from 'vitest';
import { fxDisplayRatesRepository } from './fx-display-rates';

/**
 * Integration tests for `fxDisplayRatesRepository` (BAL-376). Presentation-only rates:
 * one current row per (base, quote), last-write-wins. NEVER a balance figure (invariant
 * #8 — enforced by the credit-ledger/holds code never importing this module). No factory
 * needed (no FKs).
 */

describe('fxDisplayRatesRepository.upsert', () => {
  it('inserts a new rate, then last-write-wins on the same (base, quote) pair', async () => {
    const first = await fxDisplayRatesRepository.upsert({
      quote: 'GBP',
      rate: '0.52000000',
      asOf: new Date('2026-07-14T00:00:00Z'),
    });
    expect(first.base).toBe('AUD');
    expect(first.quote).toBe('GBP');
    expect(first.rate).toBe('0.52000000');

    const updated = await fxDisplayRatesRepository.upsert({
      quote: 'GBP',
      rate: '0.53000000',
      asOf: new Date('2026-07-15T00:00:00Z'),
    });
    // Same row (same id), rate replaced — no second GBP row.
    expect(updated.id).toBe(first.id);
    expect(updated.rate).toBe('0.53000000');

    const all = await fxDisplayRatesRepository.listLatest();
    expect(all.filter((r) => r.quote === 'GBP')).toHaveLength(1);
  });

  it('keeps distinct rows per quote currency', async () => {
    await fxDisplayRatesRepository.upsert({ quote: 'GBP', rate: '0.52', asOf: new Date() });
    await fxDisplayRatesRepository.upsert({ quote: 'EUR', rate: '0.61', asOf: new Date() });
    await fxDisplayRatesRepository.upsert({ quote: 'USD', rate: '0.66', asOf: new Date() });

    const all = await fxDisplayRatesRepository.listLatest();
    expect(all.map((r) => r.quote).sort()).toEqual(['EUR', 'GBP', 'USD']);
  });
});

describe('fxDisplayRatesRepository reads', () => {
  it('getLatest returns the current rate for a quote, or undefined when absent', async () => {
    await fxDisplayRatesRepository.upsert({
      quote: 'USD',
      rate: '0.66000000',
      asOf: new Date('2026-07-15T00:00:00Z'),
    });
    const usd = await fxDisplayRatesRepository.getLatest('USD');
    expect(usd?.rate).toBe('0.66000000');

    const eur = await fxDisplayRatesRepository.getLatest('EUR');
    expect(eur).toBeUndefined();
  });

  it('listLatest is ordered by quote', async () => {
    await fxDisplayRatesRepository.upsert({ quote: 'USD', rate: '0.66', asOf: new Date() });
    await fxDisplayRatesRepository.upsert({ quote: 'GBP', rate: '0.52', asOf: new Date() });
    const all = await fxDisplayRatesRepository.listLatest();
    expect(all.map((r) => r.quote)).toEqual(['GBP', 'USD']);
  });
});
