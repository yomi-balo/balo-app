import { describe, it, expect } from 'vitest';
import { formatPhoneForDisplay } from './format';

describe('formatPhoneForDisplay', () => {
  it('formats a valid E.164 number internationally', () => {
    expect(formatPhoneForDisplay('+61406431059')).toBe('+61 406 431 059');
  });

  it('passes an unparseable value through as stored', () => {
    expect(formatPhoneForDisplay('not-a-number')).toBe('not-a-number');
  });
});
