import { describe, it, expect } from 'vitest';
import { resolveBuyerCurrency, resolveDisplayQuote } from './display-fx';

describe('display-fx', () => {
  describe('resolveBuyerCurrency', () => {
    it('defaults to the AUD home market (no region signal exists yet)', () => {
      expect(resolveBuyerCurrency()).toBe('AUD');
    });
  });

  describe('resolveDisplayQuote', () => {
    it('returns null for an AUD buyer so the indicative FX is hidden everywhere', () => {
      // AUD buyer is charged in their own currency — no "≈ local" figure is meaningful.
      expect(resolveDisplayQuote('AUD')).toBeNull();
    });

    it('returns the quote itself for a non-AUD buyer (follow-up localisation)', () => {
      expect(resolveDisplayQuote('USD')).toBe('USD');
      expect(resolveDisplayQuote('GBP')).toBe('GBP');
      expect(resolveDisplayQuote('EUR')).toBe('EUR');
    });
  });
});
