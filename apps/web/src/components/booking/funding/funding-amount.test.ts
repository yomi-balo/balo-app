import { describe, expect, it } from 'vitest';
import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import { buildAmountChips, otherAmountHint, parseOtherAmount } from './funding-amount';

describe('buildAmountChips', () => {
  it('puts the suggested amount first and keeps only the tiers above it', () => {
    expect(buildAmountChips(60_000)).toEqual([60_000, 100_000, 500_000]);
  });

  it('keeps every tier when the suggestion is below them all', () => {
    expect(buildAmountChips(10_000)).toEqual([10_000, 30_000, 100_000, 500_000]);
  });

  it('drops a tier equal to the suggestion rather than listing it twice', () => {
    expect(buildAmountChips(100_000)).toEqual([100_000, 500_000]);
  });

  it('offers just the suggestion when it is at or above the largest tier', () => {
    expect(buildAmountChips(500_000)).toEqual([500_000]);
  });
});

describe('parseOtherAmount', () => {
  const MIN = 30_000;

  it.each([
    ['', 'Enter an amount.'],
    ['   ', 'Enter an amount.'],
    ['abc', 'Enter an amount.'],
    ['.', 'Enter an amount.'],
    ['200', 'Enter at least A$300.'],
    ['10000.01', 'One top-up can be up to A$10,000.'],
    ['20000', 'One top-up can be up to A$10,000.'],
    ['350', 'Use A$100 steps, like A$400.'],
    ['400.50', 'Use A$100 steps, like A$400.'],
    ['1249', 'Use A$100 steps, like A$1,200.'],
    ['9999', 'Use A$100 steps, like A$10,000.'],
  ])('rejects %j with the matching message', (raw, error) => {
    expect(parseOtherAmount(raw, MIN)).toEqual({ ok: false, error });
  });

  it('accepts the minimum, the maximum and any whole hundred between', () => {
    expect(parseOtherAmount('300', MIN)).toEqual({ ok: true, amountMinor: 30_000 });
    expect(parseOtherAmount('10000', MIN)).toEqual({ ok: true, amountMinor: 1_000_000 });
    expect(parseOtherAmount('1200', MIN)).toEqual({ ok: true, amountMinor: 120_000 });
  });

  it('ignores decoration around the digits', () => {
    expect(parseOtherAmount(' A$1,200 ', MIN)).toEqual({ ok: true, amountMinor: 120_000 });
    expect(parseOtherAmount('400.00', MIN)).toEqual({ ok: true, amountMinor: 40_000 });
  });

  it('derives the step message from the top-up step, never a typed amount', () => {
    const result = parseOtherAmount('350', MIN);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(`A$${TOP_UP_LIMITS_MINOR.step / 100} steps`),
    });
  });

  it('never suggests an example below the minimum the booking needs', () => {
    expect(parseOtherAmount('640.40', 64_000)).toEqual({
      ok: false,
      error: 'Use A$100 steps, like A$700.',
    });
  });

  it('checks the minimum before the step, so a small odd amount reads as too small', () => {
    expect(parseOtherAmount('250', MIN)).toEqual({ ok: false, error: 'Enter at least A$300.' });
  });
});

describe('otherAmountHint', () => {
  it('states the range and the step', () => {
    expect(otherAmountHint(60_000)).toBe('Between A$600 and A$10,000, in A$100 steps.');
  });
});
