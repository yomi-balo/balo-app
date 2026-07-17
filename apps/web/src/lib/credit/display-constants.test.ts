import { describe, it, expect } from 'vitest';
import {
  timeStr,
  formatAud,
  formatAudShort,
  formatIndicative,
  autoTopupConfigErrors,
  isAutoTopupConfigValid,
  RATE_PER_MIN_MINOR,
  MIN_AMOUNT_MINOR,
  MAX_AMOUNT_MINOR,
  GOAL_AMOUNT_MINOR,
  MIN_RELOAD_MINOR,
  MAX_RELOAD_MINOR,
  MAX_THRESHOLD_MINOR,
} from './display-constants';

describe('display-constants', () => {
  it('exposes the A$3/min presentation rate + slider bounds', () => {
    expect(RATE_PER_MIN_MINOR).toBe(300);
    expect(MIN_AMOUNT_MINOR).toBe(30_000);
    expect(MAX_AMOUNT_MINOR).toBe(1_000_000);
    expect(GOAL_AMOUNT_MINOR).toBe(500_000);
  });

  describe('timeStr', () => {
    it('formats A$1,000 as ~5 hr 33 min at A$3/min', () => {
      expect(timeStr(100_000)).toBe('5 hr 33 min');
    });
    it('shows minutes-only under an hour', () => {
      expect(timeStr(9_000)).toBe('30 min');
    });
    it('drops the minutes when a whole number of hours', () => {
      expect(timeStr(GOAL_AMOUNT_MINOR)).toMatch(/hr/);
      expect(timeStr(18_000)).toBe('1 hr');
    });
  });

  describe('formatAud / formatAudShort', () => {
    it('formats full AUD with two fraction digits', () => {
      expect(formatAud(100_000)).toBe('A$1,000.00');
    });
    it('formats short AUD as whole dollars', () => {
      expect(formatAudShort(500_000)).toBe('A$5,000');
    });
  });

  describe('formatIndicative', () => {
    it('renders a rounded local-currency estimate with the right symbol', () => {
      expect(formatIndicative(100_000, 'USD', 0.642)).toBe('US$642');
      expect(formatIndicative(100_000, 'GBP', 0.5)).toBe('£500');
      expect(formatIndicative(100_000, 'EUR', 0.6)).toBe('€600');
    });
  });

  describe('autoTopupConfigErrors', () => {
    it('returns no errors for non-auto modes (the figures are irrelevant)', () => {
      expect(autoTopupConfigErrors('notify_only', 0, 999_999_999)).toEqual({});
      expect(autoTopupConfigErrors('keep_going', 0, 0)).toEqual({});
    });

    it('flags a reload below the A$50 floor', () => {
      const errors = autoTopupConfigErrors('auto_topup', MIN_RELOAD_MINOR - 1, 0);
      expect(errors.reload).toMatch(/Minimum top-up is/i);
    });

    it('flags a reload above the A$10,000 ceiling', () => {
      const errors = autoTopupConfigErrors('auto_topup', MAX_RELOAD_MINOR + 1, 0);
      expect(errors.reload).toMatch(/or below/i);
    });

    it('flags a reload below the threshold ("Add" must be ≥ "When below")', () => {
      const errors = autoTopupConfigErrors('auto_topup', 30_000, 40_000);
      expect(errors.reload).toMatch(/at least the "when below" amount/i);
    });

    it('flags a threshold above the ceiling', () => {
      const errors = autoTopupConfigErrors('auto_topup', 30_000, MAX_THRESHOLD_MINOR + 1);
      expect(errors.threshold).toMatch(/or below/i);
    });

    it('accepts a valid combination', () => {
      expect(autoTopupConfigErrors('auto_topup', 30_000, 5_000)).toEqual({});
    });
  });

  describe('isAutoTopupConfigValid', () => {
    it('is true for a valid combination and false for an invalid one', () => {
      expect(isAutoTopupConfigValid('auto_topup', 30_000, 5_000)).toBe(true);
      expect(isAutoTopupConfigValid('auto_topup', 0, 5_000)).toBe(false);
      expect(isAutoTopupConfigValid('notify_only', 0, 0)).toBe(true);
    });
  });
});
