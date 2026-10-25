import { describe, expect, it } from 'vitest';

import { currencySymbol, formatHours, signedHours, signedMoney } from './change-order-format';

describe('change-order-format', () => {
  it('formats hours and signed deltas', () => {
    expect(formatHours(3360)).toBe('56 hrs');
    expect(formatHours(90)).toBe('1.5 hrs');
    expect(signedHours(600)).toBe('+10 hrs');
    expect(signedHours(-120)).toBe('-2 hrs');
    expect(formatHours(60)).toBe('1 hr');
    expect(signedHours(0)).toBe('no change');
  });

  it('formats signed money', () => {
    expect(signedMoney(250000, 'aud')).toBe('+A$2,500');
    expect(signedMoney(-90000, 'aud')).toBe('-A$900');
  });

  it('names the currency symbol', () => {
    expect(currencySymbol('aud')).toBe('A$');
    expect(currencySymbol('usd')).toBe('$');
  });
});
