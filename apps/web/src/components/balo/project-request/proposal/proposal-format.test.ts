import { describe, it, expect } from 'vitest';
import { formatProposalAmount, minutesToHoursLabel } from './proposal-format';

describe('formatProposalAmount', () => {
  it('formats whole-dollar amounts without cents', () => {
    expect(formatProposalAmount(1_000_000, 'aud')).toBe('A$10,000');
    expect(formatProposalAmount(0, 'aud')).toBe('A$0');
  });

  it('keeps two decimals when there are cents', () => {
    expect(formatProposalAmount(1_000_050, 'aud')).toBe('A$10,000.50');
    expect(formatProposalAmount(5, 'aud')).toBe('A$0.05');
  });

  it('never rounds a mismatch away', () => {
    expect(formatProposalAmount(1_000_001, 'aud')).not.toBe(formatProposalAmount(1_000_000, 'aud'));
  });
});

describe('minutesToHoursLabel', () => {
  it('trims a trailing .0 and keeps up to two decimals', () => {
    expect(minutesToHoursLabel(60)).toBe('1');
    expect(minutesToHoursLabel(90)).toBe('1.5');
    expect(minutesToHoursLabel(0)).toBe('0');
    expect(minutesToHoursLabel(20)).toBe('0.33');
  });
});
