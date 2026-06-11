import { describe, it, expect } from 'vitest';
import {
  centsToDollars,
  dollarsToCents,
  formatCurrency,
  formatWholeCurrency,
  formatBudgetRange,
} from './currency';

describe('centsToDollars / dollarsToCents', () => {
  it('round-trips cents to dollars and back', () => {
    expect(centsToDollars(4500000)).toBe(45000);
    expect(dollarsToCents(45000)).toBe(4500000);
  });

  it('rounds dollars to the nearest cent', () => {
    expect(dollarsToCents(2.005)).toBe(201);
  });
});

describe('formatCurrency', () => {
  it('formats cents with the platform symbol and two decimals', () => {
    expect(formatCurrency(200)).toBe('A$2.00');
  });
});

describe('formatWholeCurrency', () => {
  it('formats minor units as grouped whole dollars with the AUD symbol', () => {
    expect(formatWholeCurrency(7_800_000, 'aud')).toBe('A$78,000');
  });

  it('drops cents (rounds toward the whole dollar)', () => {
    expect(formatWholeCurrency(7_800_099, 'aud')).toBe('A$78,001');
  });

  it('renders zero as a grouped whole amount', () => {
    expect(formatWholeCurrency(0, 'aud')).toBe('A$0');
  });

  it('honours a non-AUD currency code', () => {
    expect(formatWholeCurrency(1_000_000, 'usd')).toBe('$10,000');
  });

  it('accepts an upper-cased currency code', () => {
    expect(formatWholeCurrency(4_500_000, 'AUD')).toBe('A$45,000');
  });
});

describe('formatBudgetRange', () => {
  it('formats both amounts as a whole-dollar en-dash range', () => {
    expect(formatBudgetRange(4500000, 7000000, 'aud')).toBe('A$45,000 – A$70,000');
  });

  it('collapses an equal min/max to a single amount', () => {
    expect(formatBudgetRange(5000000, 5000000, 'aud')).toBe('A$50,000');
  });

  it('renders "From" when only the minimum is set', () => {
    expect(formatBudgetRange(4500000, null, 'aud')).toBe('From A$45,000');
  });

  it('renders "Up to" when only the maximum is set', () => {
    expect(formatBudgetRange(null, 7000000, 'aud')).toBe('Up to A$70,000');
  });

  it('returns null when both amounts are null', () => {
    expect(formatBudgetRange(null, null, 'aud')).toBeNull();
  });

  it('drops cents (coarse whole-dollar display)', () => {
    expect(formatBudgetRange(4599900, null, 'aud')).toBe('From A$45,999');
  });

  it('honours a non-AUD currency code', () => {
    expect(formatBudgetRange(1000000, 2000000, 'usd')).toBe('$10,000 – $20,000');
  });

  it('accepts an upper-cased currency code', () => {
    expect(formatBudgetRange(1000000, null, 'AUD')).toBe('From A$10,000');
  });
});
