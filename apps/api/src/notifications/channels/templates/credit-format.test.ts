import { describe, it, expect } from 'vitest';
import { formatAudMinor, formatExpiryDateLong, formatExpiryDateShort } from './credit-format.js';

describe('formatAudMinor', () => {
  it('formats whole-dollar minor units with two fraction digits', () => {
    expect(formatAudMinor(34700)).toBe('A$347.00');
  });

  it('formats sub-dollar and thousands-grouped amounts', () => {
    expect(formatAudMinor(5)).toBe('A$0.05');
    expect(formatAudMinor(123456)).toBe('A$1,234.56');
  });

  it('degrades a non-finite amount to A$0.00 (never NaN)', () => {
    expect(formatAudMinor(Number.NaN)).toBe('A$0.00');
  });
});

describe('formatExpiryDateLong', () => {
  it('renders the long UTC date (en-GB)', () => {
    expect(formatExpiryDateLong('2027-07-12T00:00:00.000Z')).toBe('12 July 2027');
  });

  it('is stable at a UTC midnight boundary (no local-timezone drift)', () => {
    expect(formatExpiryDateLong('2027-01-01T00:00:00.000Z')).toBe('1 January 2027');
  });

  it('degrades an unparseable input to "the expiry date"', () => {
    expect(formatExpiryDateLong('not-a-date')).toBe('the expiry date');
  });
});

describe('formatExpiryDateShort', () => {
  it('renders the short UTC date (en-GB)', () => {
    expect(formatExpiryDateShort('2027-07-12T00:00:00.000Z')).toBe('12 Jul 2027');
  });

  it('degrades an unparseable input to "the expiry date"', () => {
    expect(formatExpiryDateShort('')).toBe('the expiry date');
  });
});
